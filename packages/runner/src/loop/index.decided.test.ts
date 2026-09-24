import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DECISION_WORDS, LimitsTableSchema, type Finding, type PlanContract } from "@perbo/contracts";
import { scratchDirectories, type Repository } from "@perbo/test-support";
import { branchName } from "@perbo/workspace";
import type { AgentResult } from "../adapter.js";
import { EgressLog } from "../egress.js";
import { TicketRunConfigSchema, runTicket, type DecidedFinding } from "./index.js";
import { finding, makeContract, makeReview, withoutInstall } from "../test-support/records.js";
import { git, runnerRepository } from "../test-support/repository.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * D-NEW-a-person-s-answer-closes-a-routed-finding: a person's answer to a
 * finding the review routed to them closes that finding.
 *
 * PRB-13's shape: the review requests changes on two findings only a person
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

/** Two findings only a person can close, as PRB-13's review routed them. */
const forPerson: Finding[] = [
  finding({
    key: "1".repeat(64),
    rule_id: "repository.observation",
    criterion_id: null,
    blocking: true,
    blocking_reason: "semantic: a person decides",
    routing: "blocks",
    closure: "human",
    file: null,
    line: null,
    symbol: "lockfile",
    statement: "The repository carries two lockfiles; which one is authoritative is not stated.",
    outcome: "unknown",
  }),
  finding({
    key: "2".repeat(64),
    rule_id: "repository.observation",
    criterion_id: null,
    blocking: true,
    blocking_reason: "semantic: a person decides",
    routing: "blocks",
    closure: "human",
    file: null,
    line: null,
    symbol: "ci",
    statement: "No workflow runs the suite on a pull request.",
    outcome: "unknown",
  }),
];

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
const reviewer = (seen: unknown[], decision: "changes_requested" | "escalate", findings: Finding[]) =>
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

/** Run 1 of PRB-13: the review stops on the two findings routed to a person. */
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
  const fixing = () =>
    agentDouble((worktree) => {
      mkdirSync(join(worktree, "src"), { recursive: true });
      writeFileSync(join(worktree, "src", "fix.ts"), "export const fixed = true;\n");
    });
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

  const fixing = () =>
    agentDouble((worktree) => {
      mkdirSync(join(worktree, "src"), { recursive: true });
      writeFileSync(join(worktree, "src", "fix.ts"), "export const fixed = true;\n");
    });

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

function sealOnBranch(repo: Repository, contract: PlanContract, files: Record<string, string>): string {
  const branch = branchName({ ticket_key: TICKET_KEY, ticket_id: contract.ticket_id, outcome: contract.outcome });
  const path = join(scratch("perbo-prior-"), "wt");
  repo.git("worktree", "add", path, branch);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(path, name)), { recursive: true });
    writeFileSync(join(path, name), body);
  }
  git(path, "add", "-A");
  git(path, "commit", "-qm", `by hand: ${Object.keys(files).join(", ")}`);
  const head = git(path, "rev-parse", "HEAD").trim();
  repo.git("worktree", "remove", "--force", path);
  return head;
}
