import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LimitsTableSchema,
  MaterializationManifestSchema,
  SecretIndex,
  type MaterializationManifest,
  type PlanContract,
} from "@perbo/contracts";
import type { AgentResult } from "../src/adapter.js";
import { BundleStore } from "../src/bundle.js";
import { EgressLog } from "../src/egress.js";
import { TicketRunConfigSchema, runTicket, type TicketRunConfig } from "../src/loop.js";
import { resolveResumeSource, sameCommit } from "../src/resume.js";
import { TRANSPORT_RETRY_DELAY_MS } from "../src/transport.js";
import { makeContract, makeReview } from "../src/test-support/records.js";
import type { Repository } from "@perbo/test-support";
import { runnerRepository } from "../src/test-support/repository.js";
import { scratch } from "./support.js";

/**
 * Resuming an attempt a ceiling cut (SCP-154).
 *
 * The first attempt in each of these is driven by a **real executor process** —
 * a script that writes a file and reports a charge past `attempt_cost_micros` —
 * so what stops it is the runner's own ceiling and what is retained is the
 * bundle the loop actually wrote. The second attempt's executor is a double,
 * because the question it answers is what the worktree and the brief contain
 * at the moment it is called.
 */

/** Nothing to install and nothing to copy: the fixture repository runs as it is. */
function manifest(repositoryRoot: string): MaterializationManifest {
  return MaterializationManifestSchema.parse({
    manifest_version: 1,
    repository_id: "repo_fixture",
    source_checkout: repositoryRoot,
    entries: [],
    install: {
      kind: "none",
      package_manager: "none",
      offline_preferred: true,
      lifecycle_scripts: { policy: "disabled", exception: null },
      command: ["node", "-e", "0"],
      pinned: true,
    },
    verify: { command: ["node", "-e", "0"], timeout_ms: 30_000 },
    isolation: {
      mode: "parallel",
      port_range_size: 4,
      port_range_start: 41_000,
      port_range_end: 41_999,
      database_schema_prefix: null,
    },
  });
}

/**
 * One store for every run of the ticket: the bundles, the attempts record and
 * the worktree root are what a second run of the same ticket reads, so sharing
 * them is the point rather than an economy.
 */
function makeConfig(input: {
  repositoryRoot: string;
  store: string;
  agentBinary: string;
  costCeilingMicros?: number;
  resumeFrom?: string;
}): TicketRunConfig {
  return TicketRunConfigSchema.parse({
    materialization_manifest: manifest(input.repositoryRoot),
    ticket_key: "SCP154",
    repository_root: input.repositoryRoot,
    base_ref: "main",
    worktree_root: join(input.store, "worktrees"),
    bundle_root: join(input.store, "bundles"),
    quarantine_root: join(input.store, "quarantine"),
    state_root: join(input.store, "state"),
    checks: [],
    agent_binary: input.agentBinary,
    model: "double",
    max_remediation_rounds: 0,
    ...(input.resumeFrom ? { resume_from: input.resumeFrom } : {}),
    limits: LimitsTableSchema.parse({
      organisation: "test",
      limits: {
        concurrent_local_attempts: 4,
        attempt_wall_clock_ms: 600_000,
        ...(input.costCeilingMicros === undefined
          ? {}
          // SCP-193: a cost ceiling now starts another attempt over the sealed
          // branch until the ticket budget is spent. These fixtures are about
          // one cut attempt and the diff it retained, so the budget is pinned
          // below what an attempt costs.
          : { attempt_cost_micros: input.costCeilingMicros, ticket_cost_micros: 1 }),
      },
    }),
  });
}

/** What the cut attempt writes, and what the retained diff therefore carries. */
const CARRIED_FILE = "src/carried.ts";
const CARRIED_BODY = "export const carried = 'from the attempt the ceiling cut';\n";

/**
 * An executor that writes one file, reports a charge past the cost ceiling and
 * then waits longer than any test here is allowed to take, so the runner's own
 * ceiling is the only thing that can end it.
 *
 * The wait is deliberately longer than the timeout on the tests below. A wait
 * that could elapse first would let a run where the ceiling never fired finish
 * anyway, and the assertions further down would then be reading an attempt that
 * stopped for a reason nobody tested. The runner spawns the executor into its
 * own process group and signals the group, so the wait costs nothing real.
 */
const OUTLIVES_THE_TEST_SECONDS = 120;

/** Long enough for a loaded machine, short enough that a hang is not a stall. */
const CUT_RUN_TIMEOUT_MS = 60_000;

function cuttingExecutor(dir: string): string {
  const binary = join(dir, "cut-executor");
  const line = (cost: number) =>
    JSON.stringify({
      type: "assistant",
      total_cost_usd: cost,
      message: { content: [], usage: { input_tokens: 100, output_tokens: 10 } },
    });
  writeFileSync(
    binary,
    `#!/bin/sh\ncase "$1" in --version) echo 'fake-executor 1.0.0'; exit 0 ;; esac\n` +
      `mkdir -p src\ncat > ${CARRIED_FILE} <<'BODY'\n${CARRIED_BODY}BODY\n` +
      `cat <<'JSON'\n${line(0.4)}\n${line(9.0)}\nJSON\nsleep ${OUTLIVES_THE_TEST_SECONDS}\n`,
    { mode: 0o755 },
  );
  return binary;
}

/**
 * The double the resumed attempt gets: it records what it was handed and stops.
 *
 * `terminations` answers the first invocations in order and every one after
 * them completes, so a caller that needs a transport failure before the work
 * lands can ask for one without a second double.
 */
function watchingExecutor(terminations: ReadonlyArray<AgentResult["termination"]> = []) {
  const seen: Array<{ worktree: string; prompt: string; carried: string | null }> = [];
  const run = async (request: {
    worktree: string;
    prompt: string;
    profile: { network_allow_list: readonly string[] };
  }): Promise<AgentResult> => {
    const path = join(request.worktree, CARRIED_FILE);
    seen.push({
      worktree: request.worktree,
      prompt: request.prompt,
      carried: existsSync(path) ? readFileSync(path, "utf8") : null,
    });
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
      termination: terminations[seen.length - 1] ?? { reason: "completed", detail: "" },
      final_message: null,
      transcript: ['{"type":"result","subtype":"success"}'],
    };
  };
  return { run, seen };
}

/** The one review these tests need: the gate is not what they are about. */
const approvingReview = async () => ({
  artifact: makeReview({ review_id: "rev_0000000000000154", decision: "approve" }),
  bundle: {
    prompt_version: "reviewer_v2",
    system_prompt: "s",
    turns: [],
    files_read: [],
    rejected_verdicts: [],
  },
});

/** The bundle files and the objects they reference, as bytes. */
function bundleBytes(store: string): Map<string, string> {
  const bytes = new Map<string, string>();
  for (const area of ["bundles", "objects"]) {
    const dir = join(store, "bundles", area);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      bytes.set(`${area}/${name}`, readFileSync(join(dir, name), "utf8"));
    }
  }
  return bytes;
}

const executionBundles = (store: string) =>
  readdirSync(join(store, "bundles", "bundles"))
    .map((name) => JSON.parse(readFileSync(join(store, "bundles", "bundles", name), "utf8")))
    .filter((bundle: { kind: string }) => bundle.kind === "execution");

/**
 * One run of the ticket, cut by `attempt_cost_micros`, and everything the next
 * run needs to resume it: the store, the cut attempt and its bundle.
 */
async function runCutByCostCeiling(): Promise<{
  repo: Repository;
  contract: PlanContract;
  store: string;
  branch: string;
  attempt_id: string;
  bundle_id: string;
  diff: string;
}> {
  const repo = runnerRepository(scratch);
  const contract = makeContract();
  contract.base.base_commit = repo.head;
  const store = scratch("perbo-resume-store-");

  const first = await runTicket({
    config: makeConfig({
      repositoryRoot: repo.dir,
      store,
      agentBinary: cuttingExecutor(scratch("perbo-resume-bin-")),
      costCeilingMicros: 5_000_000,
    }),
    contract,
  });

  expect(first.outcome).toBe("terminated");
  expect(first.rounds[0]?.attempt.termination.reason).toBe("cost_ceiling_exceeded");

  const [bundle] = executionBundles(store) as Array<{
    bundle_id: string;
    subject_id: string;
    artifacts: Array<{ name: string; sha256: string }>;
  }>;
  const diffRef = bundle?.artifacts.find((artifact) => artifact.name === "change.diff");
  expect(diffRef).toBeDefined();
  const diff = readFileSync(join(store, "bundles", "objects", diffRef!.sha256), "utf8");
  expect(diff).toContain(CARRIED_FILE);

  return {
    repo,
    contract,
    store,
    branch: first.workspace.branch,
    attempt_id: bundle!.subject_id,
    bundle_id: bundle!.bundle_id,
    diff,
  };
}

describe("a resume starts the next attempt from the cut attempt's retained diff", () => {
  it("has the diff's file in the worktree before the executor is called, and frames it as unverified", async () => {
    const cut = await runCutByCostCeiling();
    // The branch the cut attempt sealed onto is gone — a fresh checkout, or a
    // branch deleted after the ceiling ended the attempt. The retained
    // change.diff is the only surviving copy of the work, which is the state
    // this resume exists for.
    cut.repo.git("branch", "-D", "--", cut.branch);
    const before = bundleBytes(cut.store);

    const executor = watchingExecutor();
    const second = await runTicket({
      config: makeConfig({
        repositoryRoot: cut.repo.dir,
        store: cut.store,
        agentBinary: "true",
        resumeFrom: cut.bundle_id,
      }),
      contract: cut.contract,
      hooks: {
        agent: executor.run as never,
        review: approvingReview as never,
      },
    });

    // ac_1: the file the retained diff adds is in the worktree, with its bytes,
    // at the moment the executor is invoked.
    expect(executor.seen).toHaveLength(1);
    expect(executor.seen[0]?.carried).toBe(CARRIED_BODY);

    // ac_3: the brief says what that file is, and what it is not.
    const prompt = executor.seen[0]?.prompt ?? "";
    expect(prompt).toContain("previous attempt of this same ticket");
    expect(prompt).toContain(cut.attempt_id);
    expect(prompt).toContain(cut.bundle_id);
    expect(prompt).toContain("stopped part-way by a ceiling");
    expect(prompt).toContain("never checked and never reviewed by anyone");
    expect(prompt).toContain("Treat it as a draft to check, not as work to trust");

    // ac_3: the record names its predecessor and the bundle it came from.
    const attempt = second.rounds[0]!.attempt;
    expect(attempt.continues_attempt_id).toBe(cut.attempt_id);
    expect(attempt.resumed_from?.bundle_id).toBe(cut.bundle_id);
    expect(attempt.resumed_from?.attempt_id).toBe(cut.attempt_id);
    expect(attempt.resumed_from?.note).toContain(cut.bundle_id);
    expect(attempt.resumed_from?.note).toContain("change.diff");

    // ac_4: the cut attempt's bundle and its diff are exactly as they were, and
    // the resumed attempt's bundle is a new record that points at them.
    const after = bundleBytes(cut.store);
    for (const [name, bytes] of before) expect(after.get(name)).toBe(bytes);

    const bundles = executionBundles(cut.store) as Array<{
      bundle_id: string;
      subject_id: string;
      inputs: Record<string, unknown>;
      artifacts: Array<{ name: string; sha256: string }>;
    }>;
    expect(bundles).toHaveLength(2);
    const resumed = bundles.find((bundle) => bundle.subject_id === attempt.attempt_id);
    expect(resumed).toBeDefined();
    expect(resumed!.bundle_id).not.toBe(cut.bundle_id);
    expect(resumed!.inputs.resumed_from_bundle).toBe(cut.bundle_id);
    expect(resumed!.inputs.resumed_from_attempt).toBe(cut.attempt_id);

    // ac_1: the carried work is in the resumed attempt's own sealed change set,
    // not only in its worktree — the branch this run leaves behind holds it.
    const resumedDiffRef = resumed!.artifacts.find((artifact) => artifact.name === "change.diff");
    expect(resumedDiffRef).toBeDefined();
    const resumedDiff = readFileSync(
      join(cut.store, "bundles", "objects", resumedDiffRef!.sha256),
      "utf8",
    );
    expect(resumedDiff).toContain(CARRIED_FILE);
    expect(resumedDiff).toContain(CARRIED_BODY.trim());
    expect(second.rounds[0]?.attempt.head_commit).not.toBeNull();
  }, CUT_RUN_TIMEOUT_MS);

  it("is a clean no-op where the branch already carries the same work", async () => {
    const cut = await runCutByCostCeiling();
    // The branch is left alone this time, so the worktree the resume applies
    // into already holds the cut attempt's commit. `git apply --3way` resolves
    // an already-applied diff rather than failing on it, so the resume is
    // recorded and the executor still runs.
    const executor = watchingExecutor();
    const second = await runTicket({
      config: makeConfig({
        repositoryRoot: cut.repo.dir,
        store: cut.store,
        agentBinary: "true",
        resumeFrom: cut.bundle_id,
      }),
      contract: cut.contract,
      hooks: {
        agent: executor.run as never,
        review: approvingReview as never,
      },
    });

    expect(executor.seen[0]?.carried).toBe(CARRIED_BODY);
    expect(second.rounds[0]?.attempt.resumed_from?.bundle_id).toBe(cut.bundle_id);
  }, CUT_RUN_TIMEOUT_MS);
});

/**
 * SCP-154 and SCP-172 in the same round 0: a resumed attempt whose model
 * transport gives up, and the one further attempt that failure buys.
 *
 * The two features meet at exactly one place — the further attempt runs in the
 * round's own worktree rather than a fresh one — so what it starts from is the
 * tree the resume already applied the retained diff into. This is the case that
 * exists only once both are on the branch, so it is run rather than reasoned
 * about.
 */
describe("a resumed round 0 whose model transport gives up", () => {
  it("retries in the same worktree, with the carried work still in it, as one round", async () => {
    const cut = await runCutByCostCeiling();
    // As in the first resume case: the branch the cut attempt sealed onto is
    // gone, so the retained diff is the only surviving copy of the work.
    cut.repo.git("branch", "-D", "--", cut.branch);

    const executor = watchingExecutor([
      { reason: "transport_unavailable", detail: "API Error (529 Overloaded)" },
    ]);
    const waited: number[] = [];
    const second = await runTicket({
      config: makeConfig({
        repositoryRoot: cut.repo.dir,
        store: cut.store,
        agentBinary: "true",
        resumeFrom: cut.bundle_id,
      }),
      contract: cut.contract,
      sleep: async (ms) => {
        waited.push(ms);
      },
      hooks: { agent: executor.run as never, review: approvingReview as never },
    });

    // One round, run twice: the transport failure buys an attempt, not a round.
    expect(waited).toEqual([TRANSPORT_RETRY_DELAY_MS]);
    expect(executor.seen).toHaveLength(2);
    expect(second.rounds).toHaveLength(1);
    expect(second.rounds[0]?.round).toBe(0);

    // The retry runs in the round's own worktree, and the carried file is in it
    // for both attempts: the diff is applied once for the round rather than
    // once per attempt, and the retry does not start from an empty tree.
    expect(executor.seen[1]?.worktree).toBe(executor.seen[0]?.worktree);
    expect(executor.seen[0]?.carried).toBe(CARRIED_BODY);
    expect(executor.seen[1]?.carried).toBe(CARRIED_BODY);
    // And it is briefed as a resume, because it is one.
    expect(executor.seen[1]?.prompt).toContain(cut.bundle_id);
    expect(executor.seen[1]?.prompt).toContain("Treat it as a draft to check, not as work to trust");

    const superseded = second.rounds[0]!.superseded_attempts;
    expect(superseded).toHaveLength(1);
    expect(superseded[0]?.termination.reason).toBe("transport_unavailable");

    // Both attempts of the round record where their tree came from, and the
    // chain runs cut attempt → transport failure → retry: each names the one
    // nearest to it rather than skipping to the resume.
    const attempt = second.rounds[0]!.attempt;
    expect(superseded[0]?.resumed_from?.bundle_id).toBe(cut.bundle_id);
    expect(superseded[0]?.continues_attempt_id).toBe(cut.attempt_id);
    expect(attempt.resumed_from?.bundle_id).toBe(cut.bundle_id);
    expect(attempt.continues_attempt_id).toBe(superseded[0]?.attempt_id);
    expect(attempt.worktree_path).toBe(superseded[0]?.worktree_path);
  }, CUT_RUN_TIMEOUT_MS);
});

describe("a resume refuses rather than applying a diff to the wrong tree", () => {
  it("refuses when the base commit has moved, names change.diff, and runs no executor", async () => {
    const cut = await runCutByCostCeiling();

    // The repository moved on: another change landed, and the ticket is now
    // pinned to that commit. The retained diff describes the tree at the older
    // one, so it is no longer a statement about what this run would start from.
    writeFileSync(join(cut.repo.dir, "src", "other.ts"), "export const other = 2;\n");
    cut.repo.git("add", "-A");
    cut.repo.git("commit", "-qm", "second");
    const moved = cut.repo.git("rev-parse", "HEAD").trim();
    expect(moved).not.toBe(cut.repo.head);
    const onMoved: PlanContract = {
      ...cut.contract,
      base: { ...cut.contract.base, base_commit: moved },
    };

    const executor = watchingExecutor();
    await expect(
      runTicket({
        config: makeConfig({
          repositoryRoot: cut.repo.dir,
          store: cut.store,
          agentBinary: "true",
          resumeFrom: cut.bundle_id,
        }),
        contract: onMoved,
        hooks: { agent: executor.run as never },
      }),
    ).rejects.toThrow(/change\.diff/);

    expect(executor.seen).toHaveLength(0);
    // Nothing was recorded and nothing was written over: the cut attempt's
    // bundle is still the only execution bundle in the store.
    expect(executionBundles(cut.store)).toHaveLength(1);
  }, CUT_RUN_TIMEOUT_MS);

  it("refuses a diff that no longer applies, naming the file", async () => {
    const cut = await runCutByCostCeiling();

    // The same file, changed by hand on the attempt branch after the ceiling
    // ended the attempt. The retained diff still says that file is added with
    // the bytes the cut attempt wrote, and the two cannot both be true: this is
    // the conflict `git apply --3way` refuses rather than guesses at.
    cut.repo.git("checkout", "-q", cut.branch);
    writeFileSync(
      join(cut.repo.dir, CARRIED_FILE),
      "export const carried = 'a person changed this by hand';\n",
    );
    cut.repo.git("add", "-A");
    cut.repo.git("commit", "-qm", "hand edit on the attempt branch");
    cut.repo.git("checkout", "-q", "main");

    const executor = watchingExecutor();
    await expect(
      runTicket({
        config: makeConfig({
          repositoryRoot: cut.repo.dir,
          store: cut.store,
          agentBinary: "true",
          resumeFrom: cut.bundle_id,
        }),
        contract: cut.contract,
        hooks: { agent: executor.run as never },
      }),
    ).rejects.toThrow(/change\.diff/);
    expect(executor.seen).toHaveLength(0);
  }, CUT_RUN_TIMEOUT_MS);
});

describe("a resume refuses a recorded base too short to name one commit", () => {
  /**
   * The commit the resuming run starts from, and a diff against it.
   *
   * The bytes below are a real patch, but which patch is not the question here:
   * what these two ask is whether a recorded base establishes that the diff was
   * made against *this* tree, before anything is applied to it.
   */
  const HEAD = "0123456789abcdef0123456789abcdef01234567";
  const DIFF =
    "diff --git a/src/carried.ts b/src/carried.ts\nnew file mode 100644\n--- /dev/null\n" +
    "+++ b/src/carried.ts\n@@ -0,0 +1 @@\n+export const carried = 'unfinished';\n";

  /** A bundle written by the class the loop records with, in a store of its own. */
  function bundleRecordingBase(base_commit: string): { root: string; bundle_id: string } {
    const root = join(scratch("perbo-resume-base-"), "bundles");
    const { bundle } = new BundleStore({ root, retainContext: true }).write({
      kind: "execution",
      subject_id: "att_c07e0f1a2b3c4d5e",
      ticket_id: "ticket_SCP094",
      inputs: { base_commit, termination: "cost_ceiling_exceeded" },
      context_manifest: [],
      versions: { code: "stage-2", prompt: "executor_v6", policy: "local", model: "m", tool: "t" },
      usage: {
        input_tokens: 1000,
        output_tokens: 100,
        cost_micros: 5_000_000,
        cost_basis: "transport_reported",
        wall_clock_ms: 1000,
      },
      artifacts: [{ name: "change.diff", media_type: "text/x-diff", body: DIFF }],
      errors: [{ kind: "cost_ceiling_exceeded", message: "the attempt spent its budget" }],
      transitions: [],
      retention: { class: "raw_transcript", expires_at: null },
      secrets: new SecretIndex(),
      excluded_paths: [],
      deterministic: false,
      model_version_pinned: true,
      now: new Date("2026-09-03T09:00:00.000Z"),
    });
    return { root, bundle_id: bundle.bundle_id };
  }

  const resolve = (written: { root: string; bundle_id: string }) =>
    resolveResumeSource({
      bundle_root: written.root,
      bundle_id: written.bundle_id,
      ticket_id: "ticket_SCP094",
      base_commit: HEAD,
    });

  it("refuses a truncated base that happens to prefix the run's own commit", () => {
    // Four characters is not an abbreviation of anything: in a repository of any
    // size it prefixes commits this diff was never made against. Accepting it
    // because it prefixes the head would be the base-commit guard answering yes
    // to a question nobody could have answered.
    const written = bundleRecordingBase(HEAD.slice(0, 4));

    expect(() => resolve(written)).toThrow(/change\.diff/);
    expect(() => resolve(written)).toThrow(/is not a commit sha/);
    expect(() => resolve(written)).toThrow(HEAD.slice(0, 4));
    expect(sameCommit(HEAD.slice(0, 4), HEAD)).toBe(false);
  });

  it("accepts a genuine abbreviation of the commit the run starts from", () => {
    // Seven is what git will print, and what a contract may therefore pin. The
    // guard is a length rule, not a demand for the resolved sha.
    const written = bundleRecordingBase(HEAD.slice(0, 7));

    expect(resolve(written).base_commit).toBe(HEAD.slice(0, 7));
    expect(sameCommit(HEAD.slice(0, 7), HEAD)).toBe(true);
    // A seven-character prefix of a different commit is still a different
    // commit, and is refused where the run does not start on it.
    expect(sameCommit(HEAD.slice(0, 7), `f${HEAD.slice(1)}`)).toBe(false);
  });
});
