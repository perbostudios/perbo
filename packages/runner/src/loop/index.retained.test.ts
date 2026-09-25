import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LimitsTableSchema,
  attemptsFileName,
  hasAcceptanceCriteria,
  type Finding,
  type PlanContract,
  type RetainedBranch,
} from "@perbo/contracts";
import { scratchDirectories, type Repository } from "@perbo/test-support";
import { branchName } from "@perbo/workspace";
import { RunLockedError, acquireRunLock } from "../lock.js";
import { RunRefusedError } from "../refusal.js";
import { TicketRunConfigSchema, publishRetained, runTicket, type DecidedFinding } from "./index.js";
import { publish } from "./internal/deliver.js";
import { Ledger } from "./internal/ledger.js";
import { agentResult } from "./internal/test-support/fakes.js";
import { finding, makeContract, makeReview, withoutInstall } from "../test-support/records.js";
import { git, runnerRepository } from "../test-support/repository.js";

const scratch = scratchDirectories("perbo-runner-");

/** The ticket as it stands naming `branch` as its last run's, retained after that run ended `outcome`. */
const kept =
  (branch: string, outcome: "approved" | "escalated") =>
  (): RetainedBranch => ({ branch, outcome, refusal: null });

/**
 * D-NEW-publish-a-retained-branch-later: a run that ended approved or
 * escalated with publishing off retained its branch and opened nothing. A
 * person's press publishes it later through the run's own delivery, without
 * executing or reviewing again, and refuses a branch that is not what the
 * review judged.
 *
 * PRB-8's shape: approved, `publish: false`, the branch on this machine only.
 */

const TICKET_KEY = "PRB8";

function makeConfig(repositoryRoot: string) {
  const root = scratch("perbo-retained-");
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
    delivery_checks_bound_ms: 0,
    limits: LimitsTableSchema.parse({ organisation: "test", limits: { concurrent_local_attempts: 4 } }),
  });
}

/** An executor that writes the feature. */
const writesFeature = (async (request: { worktree: string }) => {
  mkdirSync(join(request.worktree, "src"), { recursive: true });
  writeFileSync(join(request.worktree, "src", "feature.ts"), "export const total = 1;\n");
  return agentResult();
}) as never;

/** A reviewer that returns `decision` on the commit it was handed. */
const reviewer = (decision: "approve" | "escalate" | "remediable", findings: Finding[] = []) =>
  (async (input: Record<string, unknown>) => ({
    artifact: makeReview({
      review_id: "rev_0000000000000008",
      decision,
      findings,
      coverage: [{ criterion_id: "ac_1", status: "met", verification_strength: "directly_verified" }],
      head_commit: (input.head_commit as string | undefined) ?? "def5678",
      changeset_id:
        (input.changeset as { changeset_id?: string } | undefined)?.changeset_id ?? "cs_0000000000000001",
    }),
    bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
  })) as never;

/** A product call the review stops for a person on. */
const productCall = finding({
  key: "3".repeat(64),
  rule_id: "product.preference",
  routing: "escalates",
  closure: "human",
  statement: "Whether totals round half-up or half-even is a product call.",
});

/** Run 1: the gate ends where `decision` takes it, and nothing is published. */
async function retainedRun(
  decision: "approve" | "escalate" = "approve",
  before?: (repo: Repository, contract: PlanContract) => void,
) {
  const repo = runnerRepository(scratch);
  const contract = makeContract();
  contract.base.base_commit = repo.head;
  const config = makeConfig(repo.dir);
  before?.(repo, contract);
  const first = await runTicket({
    config,
    contract,
    hooks: {
      agent: writesFeature,
      review: reviewer(decision, decision === "escalate" ? [productCall] : []),
    },
  });
  expect(first.outcome).toBe(decision === "approve" ? "approved" : "escalated");
  expect(first.pull_request).toBeNull();
  return { repo, contract, config, branch: first.workspace.branch, first };
}

/** The push, the pull request and the merge step, recorded rather than reaching GitHub. */
function delivery() {
  const pushed: Array<{ branch: string; worktree: string }> = [];
  const opened: Array<{ branch: string; base_ref: string; title: string; body: string }> = [];
  return {
    pushed,
    opened,
    hooks: {
      push: (async (request: { branch: string; worktree: string }) => {
        pushed.push(request);
        return { pushed: true, detail: "recorded" };
      }) as never,
      open: (async (request: { branch: string; base_ref: string; title: string; body: string }) => {
        opened.push(request);
        return { url: "https://example.invalid/pull/8", number: 8 };
      }) as never,
      merge: (async () => ({ merged: false, stop: null, head_sha: null, detail: "a person merges" })) as never,
    },
  };
}

/** One commit on `branch`, made by hand in a worktree of its own. */
function commitOn(repo: Repository, branch: string, files: Record<string, string>): void {
  const path = join(scratch("perbo-by-hand-"), "wt");
  repo.git("worktree", "add", path, branch);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(path, name)), { recursive: true });
    writeFileSync(join(path, name), body);
  }
  git(path, "add", "-A");
  git(path, "commit", "-qm", `by hand: ${Object.keys(files).join(", ")}`);
  repo.git("worktree", "remove", "--force", path);
}

describe("publishing a retained branch later", () => {
  it("pushes the approved run's branch and opens its pull request with the review on record", async () => {
    const { contract, config, branch, first } = await retainedRun();
    const { pushed, opened, hooks } = delivery();

    const published = await publishRetained({ config, contract, retained: kept(branch, "approved"), hooks });

    expect(pushed.map((request) => request.branch)).toEqual([branch]);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.branch).toBe(branch);
    expect(opened[0]!.base_ref).toBe("main");
    expect(opened[0]!.title).toBe(`${TICKET_KEY}: ${contract.outcome}`);
    expect(opened[0]!.body).toContain("Verdict **approve**");
    // Under the attempt that sealed the judged commit, and at what it cost.
    expect(opened[0]!.body).toContain(`Attempt: \`${first.rounds[0]!.attempt.attempt_id}\``);
    expect(opened[0]!.body).toContain("across 1 attempt;");
    expect(published.pull_request).toEqual({ url: "https://example.invalid/pull/8", number: 8 });
    expect(published.detail).toContain("without executing or reviewing again");
  }, 90_000);

  it("lists the person's answers to an escalated run under Decided by a person", async () => {
    const { contract, config, branch } = await retainedRun("escalate");
    const { opened, hooks } = delivery();
    const answer: DecidedFinding = {
      finding_key: productCall.key,
      choice: "ship_as_is",
      review_id: null,
      note: "Half-even, as the ledger does.",
      author: "Owen <owen@example.com>",
      decided_at: new Date().toISOString(),
    };

    const published = await publishRetained({ config, contract, retained: kept(branch, "escalated"), decided: [answer], hooks });

    expect(opened[0]!.body).toContain("### Decided by a person");
    expect(opened[0]!.body).toContain("decided by Owen: Half-even, as the ledger does.");
    expect(opened[0]!.body).not.toContain("owen@example.com");
    expect(published.decided.map((row) => row.finding_key)).toEqual([productCall.key]);
  }, 90_000);

  it("refuses a branch that has moved past the commit the review judged, and pushes nothing", async () => {
    const { repo, contract, config, branch } = await retainedRun();
    commitOn(repo, branch, { "src/by-hand.ts": "export const byHand = true;\n" });
    const { pushed, opened, hooks } = delivery();

    const refused = publishRetained({ config, contract, retained: kept(branch, "approved"), hooks });

    await expect(refused).rejects.toThrow(RunRefusedError);
    await expect(refused).rejects.toThrow(/has moved past what the run judged/);
    expect(pushed).toEqual([]);
    expect(opened).toEqual([]);
  }, 90_000);

  it("refuses a branch carrying a commit the loop did not make, and pushes nothing", async () => {
    // A person's commit on the ticket's branch before the loop ran: the run
    // took the branch over and its review judged a head that carries it.
    const { contract, config, branch } = await retainedRun("approve", (repo, planned) => {
      const named = branchName({ ticket_key: TICKET_KEY, ticket_id: planned.ticket_id, outcome: planned.outcome });
      repo.git("branch", named, repo.head);
      commitOn(repo, named, { "src/person.ts": "export const person = true;\n" });
    });
    const { pushed, opened, hooks } = delivery();

    const refused = publishRetained({ config, contract, retained: kept(branch, "approved"), hooks });

    await expect(refused).rejects.toThrow(/carries 1 commit the loop did not make: [0-9a-f]{12} by hand: src\/person\.ts/);
    expect(pushed).toEqual([]);
    expect(opened).toEqual([]);
  }, 90_000);

  it("refuses where the base has moved past what the run judged, and pushes nothing", async () => {
    const { repo, contract, config, branch } = await retainedRun();
    writeFileSync(join(repo.dir, "README.md"), "the base moved\n");
    repo.git("add", "-A");
    repo.git("commit", "-qm", "the base moved");
    const { pushed, opened, hooks } = delivery();

    const refused = publishRetained({ config, contract, retained: kept(branch, "approved"), hooks });

    await expect(refused).rejects.toThrow(/main has moved to [0-9a-f]{12}, which .* does not carry/);
    expect(pushed).toEqual([]);
    expect(opened).toEqual([]);
  }, 90_000);

  it("refuses where no review of the ticket is on record, and pushes nothing", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    const branch = branchName({ ticket_key: TICKET_KEY, ticket_id: contract.ticket_id, outcome: contract.outcome });
    const { pushed, opened, hooks } = delivery();

    const refused = publishRetained({ config, contract, retained: kept(branch, "approved"), hooks });

    await expect(refused).rejects.toThrow(RunRefusedError);
    await expect(refused).rejects.toThrow(/no review of PRB8 is on record, so there is nothing to publish its branch under/);
    expect(pushed).toEqual([]);
    expect(opened).toEqual([]);
  }, 90_000);

  it("refuses where no attempt on the record sealed the commit the review judged, and pushes nothing", async () => {
    const { contract, config, branch } = await retainedRun();
    writeFileSync(
      join(config.state_root, attemptsFileName(contract.ticket_id)),
      `${JSON.stringify({ ticket_id: contract.ticket_id, attempts: [] }, null, 2)}\n`,
    );
    const { pushed, opened, hooks } = delivery();

    const refused = publishRetained({ config, contract, retained: kept(branch, "approved"), hooks });

    await expect(refused).rejects.toThrow(RunRefusedError);
    await expect(refused).rejects.toThrow(/no attempt on PRB8's record sealed [0-9a-f]+, the commit its review judged/);
    expect(pushed).toEqual([]);
    expect(opened).toEqual([]);
  }, 90_000);

  it("refuses where the base names no commit, so whether it moved cannot be read, and pushes nothing", async () => {
    const { contract, config, branch } = await retainedRun();
    const { pushed, opened, hooks } = delivery();

    const refused = publishRetained({
      config: { ...config, base_ref: "no-such-base" },
      contract,
      retained: kept(branch, "approved"),
      hooks,
    });

    await expect(refused).rejects.toThrow(RunRefusedError);
    await expect(refused).rejects.toThrow(
      /no-such-base names no commit in this checkout, so whether it moved past what the run judged cannot be read/,
    );
    expect(pushed).toEqual([]);
    expect(opened).toEqual([]);
  }, 90_000);

  it("is refused while a run of the ticket holds its run lock, and pushes nothing", async () => {
    const { contract, config, branch } = await retainedRun();
    const { pushed, opened, hooks } = delivery();
    const running = acquireRunLock({
      state_root: config.state_root,
      ticket_id: contract.ticket_id,
      ticket_key: TICKET_KEY,
      now: new Date(),
    });
    try {
      await expect(publishRetained({ config, contract, retained: kept(branch, "approved"), hooks })).rejects.toThrow(
        RunLockedError,
      );
    } finally {
      running.release();
    }
    expect(pushed).toEqual([]);
    expect(opened).toEqual([]);
  }, 90_000);

  it("reads the ticket under the run lock, and refuses what a run that started in between left, pushing nothing", async () => {
    const { contract, config } = await retainedRun();
    const { pushed, opened, hooks } = delivery();
    const whileReading: string[] = [];

    const refused = publishRetained({
      config,
      contract,
      retained: () => {
        // A run starting now is refused: the lock is already held.
        try {
          acquireRunLock({ state_root: config.state_root, ticket_id: contract.ticket_id, ticket_key: TICKET_KEY, now: new Date() }).release();
          whileReading.push("a run could start");
        } catch (error) {
          whileReading.push(error instanceof RunLockedError ? "locked" : String(error));
        }
        // What the ticket says now: a run since has opened its pull request.
        return { branch: null, outcome: null, refusal: `${TICKET_KEY} already has its pull request, https://example.invalid/pull/9` };
      },
      hooks,
    });

    await expect(refused).rejects.toThrow(RunRefusedError);
    await expect(refused).rejects.toThrow(
      `${TICKET_KEY} already has its pull request, https://example.invalid/pull/9. Nothing was pushed`,
    );
    expect(whileReading).toEqual(["locked"]);
    expect(pushed).toEqual([]);
    expect(opened).toEqual([]);
  }, 90_000);

  it("records the delivery while it still holds the run lock, so no run starts before the record says so", async () => {
    const { contract, config, branch } = await retainedRun();
    const { hooks } = delivery();
    const whileRecording: unknown[] = [];

    await publishRetained({
      config,
      contract,
      retained: kept(branch, "approved"),
      hooks,
      recordDelivery: (published) => {
        whileRecording.push(published.pull_request.url);
        // A run starting now is refused: the lock is still held.
        try {
          acquireRunLock({ state_root: config.state_root, ticket_id: contract.ticket_id, ticket_key: TICKET_KEY, now: new Date() }).release();
          whileRecording.push("a run could start");
        } catch (error) {
          whileRecording.push(error instanceof RunLockedError ? "locked" : error);
        }
      },
    });

    expect(whileRecording).toEqual(["https://example.invalid/pull/8", "locked"]);
    // And released once the record is written.
    acquireRunLock({ state_root: config.state_root, ticket_id: contract.ticket_id, ticket_key: TICKET_KEY, now: new Date() }).release();
  }, 90_000);
});

/**
 * D-065 on a retained branch: a run whose remediation round closed one
 * finding, verified at a cost, and declined another escalates, and the pull
 * request published later is the one that run would have opened itself — the
 * closure verification counted in its cost and the declined finding left for
 * the person under "No determinable practice — for you to decide".
 */
describe("publishing a retained branch after a remediation round with a decline", () => {
  const declinedKey = "e".repeat(64);
  const reason = "whether archived rows belong in exports is a product call";

  /** Round 0 writes the feature; round 1 writes its test and declines the other finding. */
  const executor = (() => {
    let round = 0;
    return (async (request: { worktree: string }) => {
      const now = round++;
      if (now === 0) {
        mkdirSync(join(request.worktree, "src"), { recursive: true });
        writeFileSync(join(request.worktree, "src", "feature.ts"), "export const total = 1;\n");
        return agentResult();
      }
      mkdirSync(join(request.worktree, "src"), { recursive: true });
      writeFileSync(join(request.worktree, "src", "feature.test.ts"), "// exercises total()\n");
      return {
        ...agentResult(),
        transcript: [
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: `Fixing one.\nNO_PRACTICE ${declinedKey}: ${reason}` }] },
          }),
        ],
      };
    }) as never;
  });

  /** A verifier that closes what it is handed, at a price the body has to count. */
  const verifier = (async (input: { findings: Array<{ key: string }> }) => ({
    prompt_version: "closure_verify_v2",
    per_finding: input.findings.map((entry) => ({
      finding_key: entry.key,
      status: "closed",
      pointer: "src/feature.test.ts",
      idiomatic: "established_pattern",
      practice: "",
    })),
    deterministic_failure: null,
    all_closed: true,
    open_keys: [],
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    cost_micros: 12_300,
    cost_basis: "provider_list_estimate",
  })) as never;

  async function escalatedRun() {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    const first = await runTicket({
      config,
      contract,
      hooks: {
        agent: executor(),
        review: reviewer("remediable", [
          finding(),
          finding({ key: declinedKey, rule_id: "behaviour.incidental_change", statement: "Exports now include archived rows." }),
        ]),
        verify: verifier,
      },
    });
    expect(first.outcome).toBe("escalated");
    expect(first.pull_request).toBeNull();
    expect(first.rounds[1]?.declines).toEqual([{ finding_key: declinedKey, reason }]);
    return { repo, contract, config, branch: first.workspace.branch, first };
  }

  /** The body the run would have opened its own pull request with, through the same delivery and its own record. */
  async function publishingRunsBody(run: Awaited<ReturnType<typeof escalatedRun>>): Promise<string> {
    const { repo, contract, config, branch, first } = run;
    if (!hasAcceptanceCriteria(contract)) throw new Error("the contract has criteria");
    const ledger = new Ledger({ path: join(scratch("perbo-ledger-"), "attempts.json"), prior: null, ticketId: contract.ticket_id });
    for (const round of first.rounds) {
      ledger.addAttempt(round.attempt, null);
      ledger.addRound(round);
      ledger.addDeclines(round.declines);
    }
    const { opened, hooks } = delivery();
    const base = first.rounds[0]!.attempt.base_commit;
    await publish({
      config,
      contract,
      state: { workspace: { path: repo.dir, branch, base_commit: base }, baseCommit: base },
      attempts: ledger.attempts,
      verificationCosts: ledger.verificationCosts,
      declines: ledger.declines,
      rootAttemptId: first.rounds[0]!.attempt.root_attempt_id,
      finalReview: first.final_review!,
      detail: first.detail,
      push: hooks.push,
      open: hooks.open,
      merge: hooks.merge,
      onPullRequest: undefined,
      clock: () => new Date(),
      wait: async () => undefined,
      progress: () => undefined,
    });
    return opened[0]!.body;
  }

  const sections = (body: string): string[] => body.split(/\n(?=#{2,3} )/);

  it("opens the pull request the publishing run would have opened, section for section", async () => {
    const run = await escalatedRun();
    const { opened, hooks } = delivery();

    await publishRetained({ config: run.config, contract: run.contract, retained: kept(run.branch, "escalated"), hooks });

    const retained = opened[0]!.body;
    const expected = await publishingRunsBody(run);
    expect(sections(retained)).toEqual(sections(expected));
    expect(retained).toBe(expected);
    // What the two differ by when either is lost.
    expect(retained).toContain("### No determinable practice — for you to decide");
    expect(retained).toContain(`the executor declares **no determinable practice**: ${reason}`);
    expect(retained).toContain("closure verification 0.0123 USD");
  }, 90_000);

  it("refuses an escalated run whose remediation attempt's record does not say what it declined", async () => {
    const run = await escalatedRun();
    const path = join(run.config.state_root, attemptsFileName(run.contract.ticket_id));
    const record = JSON.parse(readFileSync(path, "utf8")) as { attempts: Array<Record<string, unknown>> };
    for (const attempt of record.attempts) delete attempt["declines"];
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    const { pushed, opened, hooks } = delivery();

    const refused = publishRetained({
      config: run.config,
      contract: run.contract,
      retained: kept(run.branch, "escalated"),
      hooks,
    });

    await expect(refused).rejects.toThrow(RunRefusedError);
    await expect(refused).rejects.toThrow(
      new RegExp(
        `PRB8's run ended escalated, and the record of ${run.first.rounds[1]!.attempt.attempt_id} does not say which ` +
          "findings its executor declined",
      ),
    );
    expect(pushed).toEqual([]);
    expect(opened).toEqual([]);
  }, 90_000);
});
