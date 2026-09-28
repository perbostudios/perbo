import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DECISION_WORDS, LimitsTableSchema, gateClosedNote, type Finding, type PlanContract } from "@perbo/contracts";
import { scratchDirectories, type Repository } from "@perbo/test-support";
import { branchName } from "@perbo/workspace";
import type { AgentResult } from "../adapter.js";
import { EgressLog } from "../egress.js";
import { AnswersOwedError, TicketRunConfigSchema, runTicket, type DecidedFinding } from "./index.js";
import { finding, makeContract, makeReview, withoutInstall } from "../test-support/records.js";
import { git, runnerRepository } from "../test-support/repository.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * D-132: a person's answer to a
 * finding the review routed to them closes that finding.
 *
 * The case: the review requests changes on two findings only a person
 * can close — observations about the repository, `outcome: unknown` — and the
 * person answers both. A fresh review of the same commit would raise the same
 * two findings for the same person to answer again, so the answers are handed
 * to the loop and the run goes to delivery without a model call.
 */

const TICKET_KEY = "PRB13";

const agentDouble = (write: (worktree: string) => void) => {
  const calls: string[] = [];
  const run = async (request: {
    worktree: string;
    prompt: string;
    profile: { network_allow_list: readonly string[] };
  }): Promise<AgentResult> => {
    calls.push(request.prompt);
    write(request.worktree);
    return {
      invocation: {
        adapter: "double",
        binary_path: "/bin/true",
        binary_version: "0.0.0",
        binary_sha256: "0".repeat(64),
        model: "double",
        credential_class: "subscription",
        argv: ["-p", "<prompt>"],
        shape_sha256: "1".repeat(64),
        neutralisation: {
          suppressed_at_invocation: ["double"],
          withheld_from_worktree: [],
          asserted_empty: ["mcp_servers"],
          reported: { mcp_servers: [], plugins: [], skills: [], subagents: [], memory_paths: [] },
        },
      },
      commands: [],
      egress: new EgressLog(request.profile.network_allow_list),
      prohibited: [],
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 0,
        output_tokens: 5,
        cost_micros: 1234,
        cost_basis: "transport_reported",
        cost_partial: false,
        iterations: 1,
      },
      termination: { reason: "completed", detail: "" },
      final_message: null,
      transcript: ['{"type":"result","subtype":"success"}'],
    };
  };
  return { run, calls };
};

function makeConfig(repositoryRoot: string, over: Record<string, unknown> = {}) {
  const root = scratch("perbo-decided-");
  return TicketRunConfigSchema.parse({
    materialization_manifest: withoutInstall(repositoryRoot),
    ticket_key: TICKET_KEY,
    repository_root: repositoryRoot,
    base_ref: "main",
    worktree_root: join(root, "worktrees"),
    bundle_root: join(root, "bundles"),
    quarantine_root: join(root, "quarantine"),
    state_root: join(root, "state"),
    checks: [],
    agent_binary: "true",
    model: "double",
    max_remediation_rounds: 2,
    limits: LimitsTableSchema.parse({ organisation: "test", limits: { concurrent_local_attempts: 4 } }),
    ...over,
  });
}

/** Two findings only a person can close, as the review routes them. */
const forPerson: Finding[] = (
  [
    ["1", "lockfile", "The repository carries two lockfiles; which one is authoritative is not stated."],
    ["2", "ci", "No workflow runs the suite on a pull request."],
  ] as const
).map(([digit, symbol, statement]) =>
  finding({
    key: digit.repeat(64),
    rule_id: "repository.observation",
    criterion_id: null,
    blocking: true,
    blocking_reason: "semantic: a person decides",
    routing: "blocks",
    closure: "human",
    file: null,
    line: null,
    symbol,
    statement,
    outcome: "unknown",
  }),
);

/** A finding the executor closes, beside one a person decides. */
const escalating = finding({
  key: "3".repeat(64),
  rule_id: "product.preference",
  routing: "escalates",
  closure: "human",
  statement: "Whether totals round half-up or half-even is a product call.",
});
const remediable = finding({ key: "4".repeat(64), rule_id: "test.missing_for_criterion" });

/** A reviewer that records every call and states the commit it was handed. */
const reviewer = (seen: unknown[], decision: "changes_requested" | "escalate" | "remediable", findings: Finding[]) =>
  (async (input: Record<string, unknown>) => {
    seen.push(input);
    return {
      artifact: makeReview({
        review_id: "rev_0000000000000013",
        decision,
        findings,
        head_commit: (input.head_commit as string | undefined) ?? "def5678",
        changeset_id:
          (input.changeset as { changeset_id?: string } | undefined)?.changeset_id ??
          "cs_0000000000000001",
      }),
      bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
    };
  }) as never;

const closesEverything = (seen: unknown[]) =>
  (async (input: Record<string, unknown>) => {
    seen.push(input);
    const keys = (input.findings as Array<{ key: string }>).map((entry) => entry.key);
    return {
      prompt_version: "closure_verify_v1",
      per_finding: keys.map((finding_key) => ({ finding_key, status: "closed", pointer: "src/fix.ts" })),
      deterministic_failure: null,
      all_closed: true,
      open_keys: [],
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      cost_micros: 30,
      cost_basis: "provider_list_estimate",
    };
  }) as never;

const writeFeature = (worktree: string) => {
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(join(worktree, "src", "feature.ts"), "export const total = 1;\n");
};

/** An executor that closes what it is handed. */
const fixing = () =>
  agentDouble((worktree) => {
    mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(join(worktree, "src", "fix.ts"), "export const fixed = true;\n");
  });

/** Every call that would spend money fails the test. */
const noModel = {
  agent: (async () => {
    throw new Error("a decided delivery executes nothing");
  }) as never,
  review: (async () => {
    throw new Error("a decided delivery reviews nothing again");
  }) as never,
  verify: (async () => {
    throw new Error("a decided delivery verifies nothing");
  }) as never,
};

const decision = (
  key: string,
  note: string,
  at: Date = new Date(),
  choice: DecidedFinding["choice"] = "ship_as_is",
): DecidedFinding => ({
  finding_key: key,
  choice,
  review_id: null,
  note,
  author: "Owen <owen@example.com>",
  decided_at: at.toISOString(),
});

/** The first run: the review stops on the two findings routed to a person. */
async function stoppedForPerson(): Promise<{
  repo: Repository;
  contract: PlanContract;
  config: ReturnType<typeof makeConfig>;
  reviews: unknown[];
  first: Awaited<ReturnType<typeof runTicket>>;
}> {
  const repo = runnerRepository(scratch);
  const contract = makeContract();
  contract.base.base_commit = repo.head;
  const config = makeConfig(repo.dir);
  const reviews: unknown[] = [];
  const first = await runTicket({
    config,
    contract,
    hooks: {
      agent: agentDouble(writeFeature).run as never,
      review: reviewer(reviews, "changes_requested", forPerson),
    },
  });
  expect(first.outcome).toBe("changes_requested");
  expect(reviews).toHaveLength(1);
  return { repo, contract, config, reviews, first };
}

describe("a person's answers to the findings routed to them", () => {
  it("take the next run to delivery without executing or reviewing, on an unchanged branch", async () => {
    const { contract, config } = await stoppedForPerson();

    const answers = [
      decision(forPerson[0]!.key, "package-lock.json is authoritative; leave pnpm-lock alone."),
      decision(forPerson[1]!.key, "CI is out of scope for this ticket."),
    ];
    const second = await runTicket({ config, contract, decided: answers, hooks: noModel });

    expect(second.outcome).toBe("approved");
    expect(second.rounds).toEqual([]);
    expect(second.detail).toContain("nothing was executed or reviewed again");
    expect(second.decided.map((row) => row.finding_key).sort()).toEqual(
      forPerson.map((entry) => entry.key).sort(),
    );
    // The decisions are on the findings themselves: waived, with the words.
    for (const entry of forPerson) {
      const recorded = second.final_review!.findings.find((row) => row.key === entry.key)!;
      expect(recorded.status).toBe("waived");
      expect(recorded.routing).toBe("waived");
      expect(recorded.blocking).toBe(false);
      expect(recorded.waiver?.authorised_by).toBe("Owen <owen@example.com>");
    }
    expect(
      second.final_review!.findings.find((row) => row.key === forPerson[0]!.key)!.waiver!.reason,
    ).toBe("package-lock.json is authoritative; leave pnpm-lock alone.");
  }, 90_000);

  it("opens the pull request with the decisions and the person's words, under the run that made the change", async () => {
    const { contract, config } = await stoppedForPerson();
    const bodies: string[] = [];
    const second = await runTicket({
      config: { ...config, publish: true, delivery_checks_bound_ms: 0 },
      contract,
      decided: [
        decision(forPerson[0]!.key, "package-lock.json is authoritative."),
        decision(forPerson[1]!.key, "CI is out of scope for this ticket."),
      ],
      hooks: {
        ...noModel,
        push: (async () => ({ pushed: true, detail: "test" })) as never,
        open: (async (request: { body: string }) => {
          bodies.push(request.body);
          return { url: "https://example.invalid/pull/13", number: 13 };
        }) as never,
        merge: (async () => ({ merged: false, stop: null, head_sha: null, detail: "a person merges" })) as never,
      },
    });

    expect(second.outcome).toBe("approved");
    expect(second.pull_request?.number).toBe(13);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("### Decided by a person");
    expect(bodies[0]).toContain("decided by Owen: CI is out of scope for this ticket.");
    expect(bodies[0]).not.toContain("owen@example.com");
    expect(bodies[0]).not.toContain("### For you to decide");
  }, 90_000);

  it("opens the pull request under the run that sealed the judged commit, not a failed run after it", async () => {
    const { contract, config, first } = await stoppedForPerson();
    // Run 2 fails and seals nothing: the branch is still the judged commit.
    const failing = agentDouble(() => undefined);
    const failed = await runTicket({
      config,
      contract,
      hooks: {
        agent: (async (request: Parameters<typeof failing.run>[0]) => ({
          ...(await failing.run(request)),
          termination: { reason: "agent_error", detail: "the agent exited" },
        })) as never,
        review: noModel.review,
      },
    });
    expect(failed.outcome).toBe("terminated");

    const merges: Array<Record<string, unknown>> = [];
    const bodies: string[] = [];
    const third = await runTicket({
      config: { ...config, publish: true, delivery_checks_bound_ms: 0 },
      contract,
      decided: forPerson.map((entry) => decision(entry.key, "decided")),
      hooks: {
        ...noModel,
        push: (async () => ({ pushed: true, detail: "test" })) as never,
        open: (async (request: { body: string }) => {
          bodies.push(request.body);
          return { url: "https://example.invalid/pull/13", number: 13 };
        }) as never,
        merge: (async (request: Record<string, unknown>) => {
          merges.push(request);
          return { merged: false, stop: null, head_sha: null, detail: "a person merges" };
        }) as never,
      },
    });
    expect(third.outcome).toBe("approved");
    expect(merges[0]!["attempt_id"]).toBe(first.rounds[0]!.attempt.attempt_id);
    expect(bodies[0]).toContain("across 1 attempt;");
  }, 90_000);

  it("stops with the cause, and opens nothing, where no attempt on record sealed the judged commit", async () => {
    const { contract, config } = await stoppedForPerson();
    const path = join(config.state_root, `${contract.ticket_id}.attempts.json`);
    writeFileSync(path, readFileSync(path, "utf8").replace(/"head_commit": "[0-9a-f]+"/g, `"head_commit": "${"f".repeat(40)}"`));
    const opened: unknown[] = [];
    const second = await runTicket({
      config: { ...config, publish: true, delivery_checks_bound_ms: 0 },
      contract,
      decided: forPerson.map((entry) => decision(entry.key, "decided")),
      hooks: {
        ...noModel,
        push: (async () => ({ pushed: true, detail: "test" })) as never,
        open: (async (request: unknown) => {
          opened.push(request);
          return { url: "https://example.invalid/pull/13", number: 13 };
        }) as never,
      },
    });
    expect(second.outcome).toBe("terminated");
    expect(second.detail).toContain("no run to open the pull request under");
    expect(second.pull_request).toBeNull();
    expect(opened).toEqual([]);
  }, 90_000);

  it("is not taken while one finding routed to a person is still unanswered", async () => {
    const { contract, config, reviews } = await stoppedForPerson();
    const second = await runTicket({
      config,
      contract,
      decided: [decision(forPerson[0]!.key, "package-lock.json is authoritative.")],
      hooks: {
        agent: agentDouble(writeFeature).run as never,
        review: reviewer(reviews, "changes_requested", forPerson),
      },
    });
    expect(second.rounds.length).toBeGreaterThan(0);
    expect(reviews).toHaveLength(2);
    expect(second.outcome).toBe("changes_requested");
  }, 90_000);

  it("does not carry an answer taken before the review onto it", async () => {
    const before = new Date(Date.now() - 60_000);
    const { contract, config, reviews } = await stoppedForPerson();
    const second = await runTicket({
      config,
      contract,
      decided: forPerson.map((entry) => decision(entry.key, "an answer to an earlier review", before)),
      hooks: {
        agent: agentDouble(writeFeature).run as never,
        review: reviewer(reviews, "changes_requested", forPerson),
      },
    });
    expect(reviews).toHaveLength(2);
    expect(second.decided).toEqual([]);
  }, 90_000);

  it("reviews a branch that has moved since the review, answers or not", async () => {
    const { repo, contract, config, reviews } = await stoppedForPerson();
    sealOnBranch(repo, contract, { "src/by-hand.ts": "export const byHand = true;\n" });
    const second = await runTicket({
      config,
      contract,
      decided: forPerson.map((entry) => decision(entry.key, "decided")),
      hooks: {
        agent: agentDouble(writeFeature).run as never,
        review: reviewer(reviews, "changes_requested", forPerson),
      },
    });
    expect(reviews).toHaveLength(2);
    expect(second.rounds[0]!.kind).toBe("execute");
  }, 90_000);
});

describe("a person's answer that hands the finding to the executor", () => {
  const leavesOpen = (seen: Array<{ findings: Array<{ key: string }> }>) =>
    (async (input: { findings: Array<{ key: string }> }) => {
      seen.push(input);
      const keys = input.findings.map((entry) => entry.key);
      return {
        prompt_version: "closure_verify_v1",
        per_finding: keys.map((finding_key) => ({ finding_key, status: "open", pointer: null })),
        deterministic_failure: null,
        all_closed: false,
        open_keys: keys,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        cost_micros: 30,
        cost_basis: "provider_list_estimate",
      };
    }) as never;

  it("runs one round on it with the person's words as data, verifies it closed and delivers, reviewing nothing again", async () => {
    const { contract, config } = await stoppedForPerson();
    const agent = fixing();
    const verifications: Array<{ findings: Array<{ key: string }> }> = [];
    const second = await runTicket({
      config,
      contract,
      decided: [
        decision(forPerson[0]!.key, "Keep package-lock.json and delete pnpm-lock.yaml.", new Date(), "approach"),
        decision(forPerson[1]!.key, "Add a workflow that runs the suite on pull requests.", new Date(), "approach"),
      ],
      hooks: { agent: agent.run as never, review: noModel.review, verify: closesEverything(verifications) },
    });

    expect(second.rounds.map((round) => round.kind)).toEqual(["remediate"]);
    expect(agent.calls).toHaveLength(1);
    const brief = agent.calls[0]!;
    expect(brief).toContain('<perbo:decisions trust="user">');
    expect(brief).toContain("Keep package-lock.json and delete pnpm-lock.yaml.");
    expect(brief).toContain(forPerson[1]!.key);
    expect(verifications[0]!.findings.map((entry) => entry.key)).toEqual(forPerson.map((entry) => entry.key));
    expect(second.outcome).toBe("approved");
    for (const entry of forPerson) {
      const recorded = second.final_review!.findings.find((row) => row.key === entry.key)!;
      expect([recorded.status, recorded.outcome]).toEqual(["resolved", "fixed"]);
    }
    expect(second.decided.map((row) => row.choice)).toEqual(["approach", "approach"]);
  }, 90_000);

  it("hands only the ones left to it, beside one shipped as it is, and records each as what it was", async () => {
    const { contract, config } = await stoppedForPerson();
    const agent = fixing();
    const verifications: Array<{ findings: Array<{ key: string }> }> = [];
    const second = await runTicket({
      config,
      contract,
      decided: [
        decision(forPerson[0]!.key, DECISION_WORDS.let_it_decide, new Date(), "let_it_decide"),
        decision(forPerson[1]!.key, DECISION_WORDS.ship_as_is),
      ],
      hooks: { agent: agent.run as never, review: noModel.review, verify: closesEverything(verifications) },
    });

    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]).toContain(DECISION_WORDS.let_it_decide);
    expect(agent.calls[0]).toContain(forPerson[0]!.key);
    expect(agent.calls[0]).not.toContain(forPerson[1]!.key);
    expect(verifications[0]!.findings.map((entry) => entry.key)).toEqual([forPerson[0]!.key]);
    expect(second.outcome).toBe("approved");
    const status = (key: string) => second.final_review!.findings.find((row) => row.key === key)!.status;
    expect([status(forPerson[0]!.key), status(forPerson[1]!.key)]).toEqual(["resolved", "waived"]);
  }, 90_000);

  it("records nothing as closed that the round did not close", async () => {
    const { contract, config } = await stoppedForPerson();
    const second = await runTicket({
      config: { ...config, max_remediation_rounds: 1 },
      contract,
      decided: [
        decision(forPerson[0]!.key, "Keep package-lock.json.", new Date(), "approach"),
        decision(forPerson[1]!.key, DECISION_WORDS.ship_as_is),
      ],
      hooks: { agent: fixing().run as never, review: noModel.review, verify: leavesOpen([]) },
    });
    expect(second.outcome).toBe("escalated");
    expect(second.final_review!.findings.find((row) => row.key === forPerson[0]!.key)!.status).toBe("open");
    expect(second.decided.map((row) => row.finding_key)).not.toContain(forPerson[0]!.key);
  }, 90_000);

  it("delivers again on the same answers after a verified round, executing and reviewing nothing", async () => {
    const { contract, config } = await stoppedForPerson();
    const answers = [
      decision(forPerson[0]!.key, "Keep package-lock.json.", new Date(), "approach"),
      decision(forPerson[1]!.key, DECISION_WORDS.let_it_decide, new Date(), "let_it_decide"),
    ];
    const second = await runTicket({
      config,
      contract,
      decided: answers,
      hooks: { agent: fixing().run as never, review: noModel.review, verify: closesEverything([]) },
    });
    expect(second.outcome).toBe("approved");

    // The run stopped short of the pull request; the next one delivers on
    // the same answers and the round's verification, and asks nobody again.
    const third = await runTicket({ config, contract, decided: answers, hooks: noModel });
    expect(third.outcome).toBe("approved");
    expect(third.rounds).toEqual([]);
    expect(third.decided.map((row) => row.choice)).toEqual(["approach", "let_it_decide"]);
    for (const entry of forPerson) {
      const recorded = third.final_review!.findings.find((row) => row.key === entry.key)!;
      expect([recorded.status, recorded.outcome]).toEqual(["resolved", "fixed"]);
    }
  }, 90_000);

  it("does not hand a finding it already verified closed to the executor again", async () => {
    const { contract, config } = await stoppedForPerson();
    const handed = decision(forPerson[0]!.key, "Keep package-lock.json.", new Date(), "approach");
    const second = await runTicket({
      config,
      contract,
      decided: [handed],
      hooks: { agent: fixing().run as never, review: noModel.review, verify: closesEverything([]) },
    });
    // Closed by the round; the other is still the person's.
    expect(second.outcome).toBe("escalated");
    expect(second.detail).toContain(forPerson[1]!.key);

    const third = await runTicket({
      config,
      contract,
      decided: [handed, decision(forPerson[1]!.key, DECISION_WORDS.ship_as_is)],
      hooks: noModel,
    });
    expect(third.outcome).toBe("approved");
    expect(third.rounds).toEqual([]);
    const status = (key: string) => third.final_review!.findings.find((row) => row.key === key)!.status;
    expect([status(forPerson[0]!.key), status(forPerson[1]!.key)]).toEqual(["resolved", "waived"]);
  }, 90_000);
});

describe("a decided finding beside one the executor can close", () => {
  /** Run 1: the review escalates one finding and routes the other to the executor. */
  async function escalated() {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    const reviews: unknown[] = [];
    const first = await runTicket({
      config,
      contract,
      hooks: {
        agent: agentDouble(writeFeature).run as never,
        review: reviewer(reviews, "escalate", [escalating, remediable]),
      },
    });
    expect(first.outcome).toBe("escalated");
    return { contract, config, reviews };
  }

  it("remediates only the open one, and delivers once it is closed", async () => {
    const { contract, config, reviews } = await escalated();
    const agent = fixing();
    const verifications: Array<{ findings: Array<{ key: string }> }> = [];
    const second = await runTicket({
      config,
      contract,
      decided: [decision(escalating.key, "Half-even, as the ledger does.")],
      hooks: {
        agent: agent.run as never,
        review: reviewer(reviews, "escalate", [escalating, remediable]),
        verify: closesEverything(verifications),
      },
    });

    expect(reviews).toHaveLength(1);
    expect(second.rounds.map((round) => round.kind)).toEqual(["remediate"]);
    expect(agent.calls[0]).toContain(remediable.key);
    expect(agent.calls[0]).not.toContain(escalating.key);
    expect(verifications[0]!.findings.map((entry) => entry.key)).toEqual([remediable.key]);
    expect(second.outcome).toBe("approved");
    const decided = second.final_review!.findings.find((row) => row.key === escalating.key)!;
    expect(decided.status).toBe("waived");
    expect(decided.waiver?.reason).toBe("Half-even, as the ledger does.");
  }, 90_000);

  it("stays with the person when the one routed to them has no answer", async () => {
    const { contract, config, reviews } = await escalated();
    const second = await runTicket({
      config,
      contract,
      hooks: {
        agent: fixing().run as never,
        review: reviewer(reviews, "escalate", [escalating, remediable]),
        verify: closesEverything([]),
      },
    });
    expect(second.outcome).toBe("escalated");
    expect(second.detail).toContain(escalating.key);
    expect(second.decided).toEqual([]);
  }, 90_000);
});

/**
 * D-132: a run that ended `remediation_stalled` has shown the executor cannot
 * close what it left open, so those findings are the person's, and an answer
 * to one continues the next run exactly as an answer to an escalated finding
 * does: shipped as it is closes it, an approach runs one round scoped to it
 * with the person's words.
 */
describe("the findings a stalled refinement left open", () => {
  const [stuck, alsoStuck, closedEarly] = (
    [
      ["5", "verification.execution_missing", "No execution result establishes the browser assertions."],
      ["6", "verification.containment_proxy", "The containment assertion checks DOM ancestry only."],
      ["7", "criterion.not_met", "ac_22 is not met at 1280×800."],
    ] as const
  ).map(([digit, rule_id, statement]) => finding({ key: digit.repeat(64), rule_id, statement }));

  /** Closes what `closes` names of what it is handed, and records every call. */
  const verifier = (seen: string[][], closes: (round: number) => readonly string[]) =>
    (async (input: { findings: Array<{ key: string }> }) => {
      const keys = input.findings.map((entry) => entry.key);
      seen.push(keys);
      const closed = new Set(closes(seen.length));
      const open = keys.filter((key) => !closed.has(key));
      return {
        prompt_version: "closure_verify_v1",
        per_finding: keys.map((finding_key) => ({
          finding_key,
          status: closed.has(finding_key) ? "closed" : "not_closed",
          pointer: "src/fix.ts",
        })),
        deterministic_failure: null,
        all_closed: open.length === 0,
        open_keys: open,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        cost_micros: 30,
        cost_basis: "provider_list_estimate",
      };
    }) as never;

  /** Run 1: the review routes three findings to the executor; round 1 closes one, round 2 none. */
  async function stalled() {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    const verifications: string[][] = [];
    const first = await runTicket({
      config,
      contract,
      hooks: {
        agent: fixing().run as never,
        review: reviewer([], "remediable", [stuck!, alsoStuck!, closedEarly!]),
        verify: verifier(verifications, (round) => (round === 1 ? [closedEarly!.key] : [])),
      },
    });
    expect(first.outcome).toBe("remediation_stalled");
    expect(verifications).toHaveLength(2);
    // The row the CLI writes on the ticket for that run.
    const history = [{ at: new Date().toISOString(), note: gateClosedNote(first.outcome) }];
    return { repo, contract, config, history };
  }

  it("refuses the next run before anything starts where none of them is answered", async () => {
    const { contract, config, history } = await stalled();
    const run = runTicket({ config, contract, history, decided: [], hooks: noModel });
    await expect(run).rejects.toBeInstanceOf(AnswersOwedError);
    await expect(run).rejects.toThrow(
      new RegExp(
        `^PRB13's last run finished trying and left 2 finding\\(s\\) for you to answer \\(${stuck!.key.slice(0, 12)}, ` +
          `${alsoStuck!.key.slice(0, 12)}\\), none of them handed to the executor, so this run does not start: answer each ` +
          "with `perbo verdict PRB13 --decide <finding> --choice approach\\|let-it-decide\\|ship-as-is`",
      ),
    );
  }, 120_000);

  it("refuses it where one is shipped as it is and the other unanswered, and the answer given still stands", async () => {
    const { contract, config, history } = await stalled();
    const shipped = decision(stuck!.key, DECISION_WORDS.ship_as_is);
    await expect(runTicket({ config, contract, history, decided: [shipped], hooks: noModel })).rejects.toThrow(
      `left 1 finding(s) for you to answer (${alsoStuck!.key.slice(0, 12)})`,
    );
    const later = await runTicket({
      config,
      contract,
      history,
      decided: [shipped, decision(alsoStuck!.key, DECISION_WORDS.ship_as_is)],
      hooks: noModel,
    });
    expect(later.outcome).toBe("approved");
    expect(later.decided.map((row) => row.finding_key)).toEqual([stuck!.key, alsoStuck!.key]);
  }, 120_000);

  it("reviews afresh, and is not refused, where the branch has moved since", async () => {
    const { repo, contract, config, history } = await stalled();
    sealOnBranch(repo, contract, { "src/by-hand.ts": "export const byHand = true;\n" });
    const reviews: unknown[] = [];
    const second = await runTicket({
      config,
      contract,
      history,
      decided: [],
      hooks: { agent: fixing().run as never, review: reviewer(reviews, "changes_requested", []) },
    });
    expect(reviews).toHaveLength(1);
    expect(second.rounds[0]!.kind).toBe("execute");
  }, 120_000);

  it("runs one round scoped to the finding given an approach, ships the other, and delivers", async () => {
    const { contract, config, history } = await stalled();
    const agent = fixing();
    const verifications: string[][] = [];
    const second = await runTicket({
      config,
      contract,
      history,
      decided: [
        decision(stuck!.key, DECISION_WORDS.ship_as_is),
        decision(alsoStuck!.key, "Assert containment with bounding boxes, not ancestry.", new Date(), "approach"),
      ],
      hooks: { agent: agent.run as never, review: noModel.review, verify: verifier(verifications, () => [alsoStuck!.key]) },
    });

    expect(second.rounds.map((round) => round.kind)).toEqual(["remediate"]);
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]).toContain('<perbo:decisions trust="user">');
    expect(agent.calls[0]).toContain("Assert containment with bounding boxes, not ancestry.");
    expect(agent.calls[0]).not.toContain(stuck!.key);
    expect(verifications).toEqual([[alsoStuck!.key]]);
    expect(second.outcome).toBe("approved");
    const status = (key: string) => second.final_review!.findings.find((row) => row.key === key)!.status;
    expect([status(stuck!.key), status(alsoStuck!.key)]).toEqual(["waived", "resolved"]);
    expect(second.decided.map((row) => [row.finding_key, row.choice])).toEqual([
      [stuck!.key, "ship_as_is"],
      [alsoStuck!.key, "approach"],
    ]);
  }, 120_000);

  it("delivers without a round where every finding it left open is shipped as it is", async () => {
    const { contract, config, history } = await stalled();
    const second = await runTicket({
      config,
      contract,
      history,
      decided: [stuck!, alsoStuck!].map((entry) => decision(entry.key, DECISION_WORDS.ship_as_is)),
      hooks: noModel,
    });
    expect(second.outcome).toBe("approved");
    expect(second.rounds).toEqual([]);
    expect(second.detail).toContain("nothing was executed or reviewed again");
  }, 120_000);

  it("keeps a finding with no answer with the person after the round the others' answers scoped", async () => {
    const { contract, config, history } = await stalled();
    const verifications: string[][] = [];
    const second = await runTicket({
      config,
      contract,
      history,
      decided: [decision(alsoStuck!.key, "Assert with bounding boxes.", new Date(), "approach")],
      hooks: { agent: fixing().run as never, review: noModel.review, verify: verifier(verifications, () => [alsoStuck!.key]) },
    });
    expect(verifications).toEqual([[alsoStuck!.key]]);
    expect(second.outcome).toBe("escalated");
    expect(second.detail).toContain(stuck!.key);
  }, 120_000);
});

/**
 * D-065 beside D-132: a finding the executor declined in a round that then
 * stalled is not the person's to answer by a choice, since a principle is its
 * answer; the other finding it left open is. Answering that one delivers, or
 * runs the round it hands on, and the run ends `escalated` with the declined
 * finding left for the person.
 */
describe("a finding the executor declined in a refinement that stalled", () => {
  const [declined, open] = (
    [
      ["a", "fixture.choice", "Which fixture the suite loads is not settled."],
      ["b", "verification.execution_missing", "No execution result establishes the totals."],
    ] as const
  ).map(([digit, rule_id, statement]) => finding({ key: digit.repeat(64), rule_id, statement }));
  const reason = "which fixture the suite loads is a product call";

  /** Writes a new change every call, and declines `declined` whenever it is handed it. */
  const declining = () => {
    const calls: string[] = [];
    let count = 0;
    const inner = agentDouble((worktree) => {
      mkdirSync(join(worktree, "src"), { recursive: true });
      writeFileSync(join(worktree, "src", "fix.ts"), `export const fixed = ${++count};\n`);
    });
    const run = async (request: Parameters<typeof inner.run>[0]): Promise<AgentResult> => {
      calls.push(request.prompt);
      const result = await inner.run(request);
      return request.prompt.includes(declined!.key)
        ? {
            ...result,
            transcript: [JSON.stringify({ type: "result", subtype: "success", result: `NO_PRACTICE ${declined!.key}: ${reason}` })],
          }
        : result;
    };
    return { run, calls };
  };

  /** Records what each verification is handed and closes what `closes` names. */
  const verifier = (seen: string[][], closes: readonly string[]) =>
    (async (input: { findings: Array<{ key: string }> }) => {
      const keys = input.findings.map((entry) => entry.key);
      seen.push(keys);
      const open = keys.filter((key) => !closes.includes(key));
      return {
        prompt_version: "closure_verify_v1",
        per_finding: keys.map((finding_key) => ({
          finding_key,
          status: closes.includes(finding_key) ? "closed" : "not_closed",
          pointer: "src/fix.ts",
        })),
        deterministic_failure: null,
        all_closed: open.length === 0,
        open_keys: open,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        cost_micros: 30,
        cost_basis: "provider_list_estimate",
      };
    }) as never;

  /** Run 1: round 1 declines one finding and closes none of the other, so the run stalls. */
  async function stalledWithDecline() {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    const verifications: string[][] = [];
    const first = await runTicket({
      config,
      contract,
      hooks: {
        agent: declining().run as never,
        review: reviewer([], "remediable", [declined!, open!]),
        verify: verifier(verifications, []),
      },
    });
    expect(first.outcome).toBe("remediation_stalled");
    expect(verifications).toEqual([[open!.key]]);
    const history = [{ at: new Date().toISOString(), note: gateClosedNote(first.outcome) }];
    return { contract, config, history };
  }

  it("puts only the other finding to the person, and refuses a run until it is answered", async () => {
    const { contract, config, history } = await stalledWithDecline();
    await expect(runTicket({ config, contract, history, decided: [], hooks: noModel })).rejects.toThrow(
      `left 1 finding(s) for you to answer (${open!.key.slice(0, 12)})`,
    );
  }, 120_000);

  it("delivers on the other shipped as it is, executing nothing, and leaves the declined one to the person", async () => {
    const { contract, config, history } = await stalledWithDecline();
    const second = await runTicket({
      config,
      contract,
      history,
      decided: [decision(open!.key, DECISION_WORDS.ship_as_is)],
      hooks: noModel,
    });
    expect(second.rounds).toEqual([]);
    expect(second.outcome).toBe("escalated");
    expect(second.detail).toContain("nothing was executed or reviewed again");
    expect(second.detail).toContain(`the executor declined are yours to decide, and \`perbo principle add\` is the answer: ${declined!.key}`);
    expect(second.final_review!.findings.find((row) => row.key === declined!.key)!.status).toBe("open");
  }, 120_000);

  it("runs one round on the other handed on, never the declined one, and ends escalated once it is closed", async () => {
    const { contract, config, history } = await stalledWithDecline();
    const agent = declining();
    const verifications: string[][] = [];
    const second = await runTicket({
      config,
      contract,
      history,
      decided: [decision(open!.key, "Record the execution result the criterion names.", new Date(), "approach")],
      hooks: { agent: agent.run as never, review: noModel.review, verify: verifier(verifications, [open!.key]) },
    });
    expect(verifications).toEqual([[open!.key]]);
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]).not.toContain(declined!.key);
    expect(second.outcome).toBe("escalated");
    expect(second.detail).toContain(declined!.key);
  }, 120_000);
});

describe("an answer to a review that did not judge the whole change", () => {
  const tooLarge = finding({
    key: "9".repeat(64),
    rule_id: "changeset.too_large_to_review",
    criterion_id: null,
    blocking: true,
    routing: "blocks",
    closure: null,
    file: null,
    line: null,
    statement: "The diff is withheld for size.",
    outcome: "unknown",
  });
  const incomplete = (seen: unknown[]) =>
    (async (input: Record<string, unknown>) => {
      seen.push(input);
      return {
        artifact: makeReview({
          review_id: `rev_${String(seen.length).padStart(16, "0")}`,
          decision: "incomplete",
          findings: [tooLarge],
          coverage: [{ criterion_id: "ac_1", status: "cannot_determine" }],
          head_commit: (input.head_commit as string | undefined) ?? "def5678",
          changeset_id:
            (input.changeset as { changeset_id?: string } | undefined)?.changeset_id ?? "cs_0000000000000001",
        }),
        bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
      };
    }) as never;
  /** Two runs over an `incomplete` review, the second with the answer where there is one. */
  const twoRuns = async (answered: boolean) => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    await runTicket({
      config,
      contract,
      hooks: { agent: agentDouble(writeFeature).run as never, review: incomplete([]) },
    });
    const agent = agentDouble(writeFeature);
    const reviews: unknown[] = [];
    const verifies: unknown[] = [];
    const second = await runTicket({
      config,
      contract,
      ...(answered
        ? { decided: [decision(tooLarge.key, "Just pick.", new Date(Date.now() + 1000), "let_it_decide")] }
        : {}),
      hooks: {
        agent: agent.run as never,
        review: incomplete(reviews),
        verify: (async (input: unknown) => {
          verifies.push(input);
          throw new Error("no verification is due");
        }) as never,
      },
    });
    return { second, briefs: agent.calls, reviews: reviews.length, verifies: verifies.length };
  };

  it("takes the next run where an unanswered one goes: reviewed afresh, nothing handed or delivered", async () => {
    const answered = await twoRuns(true);
    const plain = await twoRuns(false);
    expect(answered.second.outcome).toBe("escalated");
    expect(answered.second.outcome).toBe(plain.second.outcome);
    expect(answered.second.rounds.map((round) => round.kind)).toEqual(plain.second.rounds.map((round) => round.kind));
    expect(answered.briefs).toHaveLength(plain.briefs.length);
    expect([answered.reviews, plain.reviews]).toEqual([1, 1]);
    expect(answered.verifies).toBe(0);
    expect(answered.second.decided).toEqual([]);
    expect(answered.second.pull_request).toBeNull();
    for (const brief of answered.briefs) expect(brief).not.toContain("perbo:decisions");
  }, 180_000);
});

function sealOnBranch(repo: Repository, contract: PlanContract, files: Record<string, string>): void {
  const branch = branchName({ ticket_key: TICKET_KEY, ticket_id: contract.ticket_id, outcome: contract.outcome });
  const path = join(scratch("perbo-prior-"), "wt");
  repo.git("worktree", "add", path, branch);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(path, name)), { recursive: true });
    writeFileSync(join(path, name), body);
  }
  git(path, "add", "-A");
  git(path, "commit", "-qm", `by hand: ${Object.keys(files).join(", ")}`);
  repo.git("worktree", "remove", "--force", path);
}
