import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LimitsTableSchema, type ChangeSet } from "@perbo/contracts";
import type { AgentResult } from "../src/adapter.js";
import { EgressLog } from "../src/egress.js";
import { TicketRunConfigSchema, runTicket, type TicketRunConfig } from "../src/loop.js";
import { carriedApprovals } from "../src/merge.js";
import { RunRefusedError } from "../src/refusal.js";
import {
  CONFLICT_PROMPT_VERSION,
  CONFLICT_PROMPT_WITH_MERGED_VERSION,
  conflictPrompt,
  conflictPromptVersion,
} from "../src/prompt.js";
import { git, makeContract, makeRepo, makeReview, scratch, withoutInstall } from "./support.js";

/**
 * SCP-227: a re-level run keeps an open branch level with its base without an
 * executor, and hands the merge a reason to carry the approval.
 *
 * Every run here is a real run of the loop against a real repository, with
 * the agent, the reviewer and the GitHub-side steps replaced by doubles that
 * record what they were asked. What is proven is what the loop does with a
 * branch that already reached `pr_open` when the base moves under it.
 */

const agentDouble = (write: (worktree: string) => void) => {
  const prompts: string[] = [];
  const run = async (request: {
    worktree: string;
    prompt: string;
    profile: { network_allow_list: readonly string[] };
  }): Promise<AgentResult> => {
    prompts.push(request.prompt);
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
        output_tokens: 5,
        cost_micros: 1234,
        cost_basis: "transport_reported",
        cost_partial: false,
        iterations: 1,
      },
      termination: { reason: "completed", detail: "" },
      transcript: ['{"type":"result","subtype":"success"}'],
    };
  };
  return { run, prompts };
};

const neverAgent = {
  run: async (): Promise<AgentResult> => {
    throw new Error("a re-level with nothing to resolve must not run an executor");
  },
};

function approving() {
  const calls: number[] = [];
  const review = (async (input: { changeset?: ChangeSet }) => {
    calls.push(1);
    return {
      artifact: makeReview({
        review_id: `rev_${String(calls.length).padStart(16, "0")}`,
        decision: "approve" as const,
        changeset_id: input.changeset?.changeset_id ?? "cs_0000000000000001",
      }),
      bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
    };
  }) as never;
  return { review, calls };
}

function makeConfig(repositoryRoot: string, over: Record<string, unknown> = {}): TicketRunConfig {
  const root = scratch("perbo-relevel-");
  return TicketRunConfigSchema.parse({
    materialization_manifest: withoutInstall(repositoryRoot),
    ticket_key: "AYO7",
    repository_root: repositoryRoot,
    base_ref: "main",
    worktree_root: join(root, "worktrees"),
    bundle_root: join(root, "bundles"),
    quarantine_root: join(root, "quarantine"),
    state_root: join(root, "state"),
    checks: [],
    agent_binary: "true",
    model: "double",
    max_remediation_rounds: 0,
    publish: true,
    limits: LimitsTableSchema.parse({ organisation: "test", limits: { concurrent_local_attempts: 4 } }),
    ...over,
  });
}

/**
 * The branch's change: the file the fixture repository already has, changed,
 * and a file of its own beside it — so a conflict on the first can be
 * resolved to the base's text while the ticket's own work survives in the
 * second. Git merges an overlapping hunk only where both sides' text is
 * identical, so a resolution that keeps an addition inside the conflicting
 * hunk is not one git can take.
 */
const FEATURE = "export const version = 2;\n";
const writeFeature = (worktree: string) => {
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(join(worktree, "src", "index.ts"), FEATURE);
  writeFileSync(join(worktree, "src", "feature.ts"), "export const branchOnly = 1;\n");
};

/** The GitHub-side doubles, each recording what it was asked. */
function github() {
  const pushes: string[] = [];
  const merges: Array<Record<string, unknown>> = [];
  const opened: string[] = [];
  return {
    pushes,
    merges,
    opened,
    hooks: {
      push: (async (request: { branch: string }) => {
        pushes.push(request.branch);
        return { pushed: true, detail: "test" };
      }) as never,
      open: (async (request: { branch: string }) => {
        opened.push(request.branch);
        return { url: "https://example.invalid/pull/7", number: 7 };
      }) as never,
      existing: (async () => ({ url: "https://example.invalid/pull/7", number: 7 })) as never,
      merge: (async (request: Record<string, unknown>) => {
        merges.push(request);
        return { merged: false, stop: { rule_id: "merge.switch_is_person", statement: "s" }, head_sha: null, detail: "person" };
      }) as never,
    },
  };
}

/** A `gh` that answers nothing, for the checks read after a push. */
function silentGh(): string {
  const root = scratch("perbo-relevel-gh-");
  const script = join(root, "gh");
  writeFileSync(script, ["#!/bin/sh", "exit 1", ""].join("\n"));
  chmodSync(script, 0o755);
  return root;
}

const originalPath = process.env.PATH;
const originalToken = process.env.GH_TOKEN;
afterEach(() => {
  process.env.PATH = originalPath;
  if (originalToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = originalToken;
});

const RUN_TIMEOUT_MS = 90_000;

/** A first run that leaves the branch at `pr_open`: one sealed commit, one approving review. */
async function firstRun(repo: { dir: string; head: string }) {
  const contract = makeContract();
  contract.base.base_commit = repo.head;
  const config = makeConfig(repo.dir);
  const gh = github();
  process.env.PATH = `${silentGh()}:${originalPath ?? ""}`;
  process.env.GH_TOKEN = "test-token";
  const result = await runTicket({
    config,
    contract,
    hooks: { agent: agentDouble(writeFeature).run as never, review: approving().review, ...gh.hooks },
  });
  expect(result.outcome).toBe("approved");
  return { contract, config, branch: result.workspace.branch };
}

/** Advance `main` in the repository with one commit touching `path`. */
function advanceMain(dir: string, path: string, content: string): string {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", `main moves: ${path}`);
  return git(dir, "rev-parse", "HEAD").trim();
}

describe("a re-level run", () => {
  it("says the branch is level and pays for nothing when the base has not moved", async () => {
    const repo = makeRepo();
    const { contract, config } = await firstRun(repo);
    const gh = github();
    const result = await runTicket({
      config: TicketRunConfigSchema.parse({ ...config, relevel: true }),
      contract,
      hooks: { agent: neverAgent.run as never, review: approving().review, ...gh.hooks },
    });
    expect(result.outcome).toBe("level");
    expect(result.rounds).toEqual([]);
    expect(gh.pushes).toEqual([]);
    expect(gh.merges).toEqual([]);
  }, RUN_TIMEOUT_MS);

  it("merges the base in, runs no executor and no review when the base touched nothing in scope, and pushes", async () => {
    const repo = makeRepo();
    const { contract, config, branch } = await firstRun(repo);
    const tip = advanceMain(repo.dir, "docs/notes.md", "unrelated\n");
    const gh = github();
    const reviewer = approving();
    const result = await runTicket({
      config: TicketRunConfigSchema.parse({ ...config, relevel: true }),
      contract,
      hooks: { agent: neverAgent.run as never, review: reviewer.review, ...gh.hooks },
    });
    expect(result.outcome).toBe("relevelled");
    expect(result.detail).toContain("nothing inside the contract's scope");
    expect(reviewer.calls).toEqual([]);
    expect(result.rounds).toEqual([]);
    expect(result.merged_base).toBe(tip);
    expect(gh.pushes).toEqual([branch]);
    // Found, never opened: the branch already has its pull request.
    expect(gh.opened).toEqual([]);
    expect(gh.merges).toHaveLength(1);
    expect(gh.merges[0]!["pull_request_number"]).toBe(7);
    expect(gh.merges[0]!["paths_allowed"]).toEqual(contract.scope.paths_allowed);
    // The branch carries the merge commit, with the attempt chain's trailer.
    const message = git(repo.dir, "log", "-1", "--format=%B", branch);
    expect(message).toMatch(/^AYO7: merge main into the attempt branch/);
    expect(message).toMatch(/Attempt: att_/);
    expect(git(repo.dir, "merge-base", "--is-ancestor", tip, branch)).toBe("");
  }, RUN_TIMEOUT_MS);

  it("reviews the merged change set afresh when the base touched the scope, and no executor runs", async () => {
    const repo = makeRepo();
    const { contract, config } = await firstRun(repo);
    advanceMain(repo.dir, "src/other.ts", "export const other = 2;\n");
    const gh = github();
    const reviewer = approving();
    const result = await runTicket({
      config: TicketRunConfigSchema.parse({ ...config, relevel: true }),
      contract,
      hooks: { agent: neverAgent.run as never, review: reviewer.review, ...gh.hooks },
    });
    expect(result.outcome).toBe("relevelled");
    expect(result.detail).toContain("a fresh review approved");
    expect(reviewer.calls).toHaveLength(1);
    expect(result.final_review?.decision).toBe("approve");
    expect(gh.pushes).toHaveLength(1);
  }, RUN_TIMEOUT_MS);

  it("tells the fresh review whether the base verified only where its verify measures it", async () => {
    const told: Record<string, Array<boolean | undefined>> = { measured: [], unmeasured: [] };
    for (const [name, verify] of [
      ["measured", ["node", "-e", "process.exit(0)"]],
      ["unmeasured", ["git", "status", "--porcelain"]],
    ] as const) {
      const repo = makeRepo();
      const { contract, config } = await firstRun(repo);
      advanceMain(repo.dir, "src/other.ts", "export const other = 2;\n");
      const gh = github();
      const reviewer = approving();
      const result = await runTicket({
        config: TicketRunConfigSchema.parse({
          ...config,
          relevel: true,
          materialization_manifest: { ...withoutInstall(repo.dir), verify: { command: [...verify], timeout_ms: 30_000 } },
        }),
        contract,
        hooks: {
          agent: neverAgent.run as never,
          review: (async (input: { baseVerified?: boolean }) => {
            told[name]!.push(input.baseVerified);
            return (reviewer.review as unknown as (input: unknown) => Promise<unknown>)(input);
          }) as never,
          ...gh.hooks,
        },
      });
      expect(result.outcome).toBe("relevelled");
    }
    // A real verify answers for the base; `git status --porcelain` passes on
    // any checkout, so the review is told nothing.
    expect(told["measured"]).toEqual([true]);
    expect(told["unmeasured"]).toEqual([undefined]);
  }, RUN_TIMEOUT_MS);

  it("pushes nothing when the fresh review does not approve, and leaves the merge commit local", async () => {
    const repo = makeRepo();
    const { contract, config, branch } = await firstRun(repo);
    const pushedBefore = git(repo.dir, "rev-parse", branch);
    advanceMain(repo.dir, "src/other.ts", "export const other = 2;\n");
    const gh = github();
    const escalating = (async (input: { changeset?: ChangeSet }) => ({
      artifact: makeReview({
        review_id: "rev_0000000000000009",
        decision: "escalate" as const,
        changeset_id: input.changeset?.changeset_id ?? "cs_0000000000000001",
      }),
      bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
    })) as never;
    const result = await runTicket({
      config: TicketRunConfigSchema.parse({ ...config, relevel: true }),
      contract,
      hooks: { agent: neverAgent.run as never, review: escalating, ...gh.hooks },
    });
    expect(result.outcome).toBe("escalated");
    expect(result.rounds).toEqual([]);
    expect(gh.pushes).toEqual([]);
    expect(gh.merges).toEqual([]);
    // The branch carries the merge commit locally; nothing published it.
    expect(git(repo.dir, "rev-parse", branch)).not.toBe(pushedBefore);
  }, RUN_TIMEOUT_MS);

  it("mints its attempt ids after every recorded run, so a re-level never collides with the last run's root", async () => {
    const repo = makeRepo();
    const { contract, config } = await firstRun(repo);
    advanceMain(repo.dir, "src/index.ts", "export const version = 3;\n");
    const gh = github();
    const resolver = agentDouble((worktree) => writeFileSync(join(worktree, "src", "index.ts"), "export const version = 3;\n"));
    // `runs_started` is what a `run --ticket` hands the loop; a re-level hands none.
    const result = await runTicket({
      config: TicketRunConfigSchema.parse({ ...config, relevel: true }),
      contract,
      hooks: { agent: resolver.run as never, review: approving().review, ...gh.hooks },
    });
    expect(result.outcome).toBe("approved");
    expect(result.rounds[0]!.attempt.root_attempt_id).not.toBe(result.rounds[0]!.attempt.continues_attempt_id);
    const attempts = JSON.parse(readFileSync(join(config.state_root, `${contract.ticket_id}.attempts.json`), "utf8")) as { attempts: Array<{ attempt_id: string }> };
    expect(new Set(attempts.attempts.map((attempt) => attempt.attempt_id)).size).toBe(attempts.attempts.length);
    expect(attempts.attempts.length).toBe(2);
  }, RUN_TIMEOUT_MS);

  it("hands a conflict to a round briefed with what merged, then reviews and publishes the resolution", async () => {
    const repo = makeRepo();
    const { contract, config } = await firstRun(repo);
    // The base changed the line the branch changed: a conflict whose
    // resolution takes the base's text, the ticket's own file untouched.
    const theirs = "export const version = 3;\n";
    advanceMain(repo.dir, "src/index.ts", theirs);
    const gh = github();
    const reviewer = approving();
    const resolver = agentDouble((worktree) => writeFileSync(join(worktree, "src", "index.ts"), theirs));
    const result = await runTicket({
      config: TicketRunConfigSchema.parse({
        ...config,
        relevel: true,
        relevel_context: [
          {
            ticket_key: "AYO-9",
            outcome: "total sums its inputs",
            criteria: ["total([1,2]) is 3 :: a unit test asserts it"],
            paths_allowed: ["src/**"],
          },
        ],
      }),
      contract,
      hooks: { agent: resolver.run as never, review: reviewer.review, ...gh.hooks },
    });
    expect(result.outcome, result.detail).toBe("approved");
    // One round, and it was the conflict round: the ticket's own brief never ran.
    expect(result.rounds.map((round) => round.kind)).toEqual(["resolve_conflict"]);
    expect(resolver.prompts).toHaveLength(1);
    expect(resolver.prompts[0]).toContain("AYO-9: total sums its inputs");
    expect(resolver.prompts[0]).toContain("total([1,2]) is 3");
    expect(resolver.prompts[0]).toContain("src/index.ts");
    // The resolution changed the change set, so it was reviewed afresh.
    expect(reviewer.calls).toHaveLength(1);
    expect(gh.pushes).toHaveLength(1);
    expect(gh.merges).toHaveLength(1);
    // The branch carries the resolution and is level with the base.
    const branch = result.workspace.branch;
    expect(git(repo.dir, "show", `${branch}:src/index.ts`)).toBe(theirs);
    expect(git(repo.dir, "show", `${branch}:src/feature.ts`)).toBe("export const branchOnly = 1;\n");
    expect(git(repo.dir, "merge-base", "--is-ancestor", "main", branch)).toBe("");
    expect(readFileSync(join(repo.dir, "src", "index.ts"), "utf8")).toBe(theirs);
  }, RUN_TIMEOUT_MS);
});

describe("a re-level beside the runs around it", () => {
  it("does not let a run after a conflict re-level mint the re-level's run number again", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    process.env.PATH = `${silentGh()}:${originalPath ?? ""}`;
    process.env.GH_TOKEN = "test-token";
    // Run 1, counted by the caller the way the CLI counts it.
    const first = await runTicket({
      config: TicketRunConfigSchema.parse({ ...config, runs_started: 1 }),
      contract,
      hooks: { agent: agentDouble(writeFeature).run as never, review: approving().review, ...github().hooks },
    });
    expect(first.outcome).toBe("approved");
    // A conflict re-level records its round under the record's next number.
    advanceMain(repo.dir, "src/index.ts", "export const version = 3;\n");
    const resolver = agentDouble((worktree) => writeFileSync(join(worktree, "src", "index.ts"), "export const version = 3;\n"));
    const relevel = await runTicket({
      config: TicketRunConfigSchema.parse({ ...config, relevel: true }),
      contract,
      hooks: { agent: resolver.run as never, review: approving().review, ...github().hooks },
    });
    expect(relevel.outcome).toBe("approved");
    // Run 2 as the CLI would count it from the ticket's history, which the
    // re-level never added to: it must mint after the record, not collide.
    const second = await runTicket({
      config: TicketRunConfigSchema.parse({ ...config, runs_started: 2 }),
      contract,
      hooks: { agent: agentDouble(writeFeature).run as never, review: approving().review, ...github().hooks },
    });
    expect(second.outcome).toBe("approved");
    const attempts = JSON.parse(readFileSync(join(config.state_root, `${contract.ticket_id}.attempts.json`), "utf8")) as { attempts: Array<{ attempt_id: string; root_attempt_id: string }> };
    expect(new Set(attempts.attempts.map((attempt) => attempt.attempt_id)).size).toBe(attempts.attempts.length);
    expect(new Set(attempts.attempts.map((attempt) => attempt.root_attempt_id)).size).toBe(3);
  }, RUN_TIMEOUT_MS * 2);

  it("re-levels from what the pull request has, not from a rejected merge left on the local branch", async () => {
    const repo = makeRepo();
    const { contract, config, branch } = await firstRun(repo);
    // What the pull request has: the branch as it was pushed.
    const pushedHead = git(repo.dir, "rev-parse", branch).trim();
    git(repo.dir, "update-ref", `refs/remotes/origin/${branch}`, pushedHead);
    advanceMain(repo.dir, "src/other.ts", "export const other = 2;\n");
    const escalating = (async (input: { changeset?: ChangeSet }) => ({
      artifact: makeReview({ review_id: "rev_0000000000000011", decision: "escalate" as const, changeset_id: input.changeset?.changeset_id ?? "cs_0000000000000001" }),
      bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
    })) as never;
    const rejected = await runTicket({
      config: TicketRunConfigSchema.parse({ ...config, relevel: true }),
      contract,
      hooks: { agent: neverAgent.run as never, review: escalating, ...github().hooks },
    });
    expect(rejected.outcome).toBe("escalated");
    expect(git(repo.dir, "rev-parse", branch).trim()).not.toBe(pushedHead);
    // By hand, again: the review now approves, and the run starts from the
    // pushed ref rather than calling the local merge commit level.
    const gh = github();
    const reviewer = approving();
    const again = await runTicket({
      config: TicketRunConfigSchema.parse({ ...config, relevel: true }),
      contract,
      hooks: { agent: neverAgent.run as never, review: reviewer.review, ...gh.hooks },
    });
    expect(again.outcome).toBe("relevelled");
    expect(reviewer.calls).toHaveLength(1);
    expect(gh.pushes).toEqual([branch]);
  }, RUN_TIMEOUT_MS * 2);

  it("re-levels a ticket whose history holds a run refused after its number was minted", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    process.env.PATH = `${silentGh()}:${originalPath ?? ""}`;
    process.env.GH_TOKEN = "test-token";
    const first = await runTicket({
      config: TicketRunConfigSchema.parse({ ...config, runs_started: 1 }),
      contract,
      hooks: { agent: agentDouble(writeFeature).run as never, review: approving().review, ...github().hooks },
    });
    expect(first.outcome).toBe("approved");
    // Run 2 is counted by the ticket's history and refused before an attempt
    // exists: its number is spent and nothing on the record says so.
    await expect(
      runTicket({
        config: TicketRunConfigSchema.parse({
          ...config,
          runs_started: 2,
          materialization_manifest: { ...withoutInstall(repo.dir), source_checkout: join(repo.dir, "nowhere") },
        }),
        contract,
        hooks: { agent: neverAgent.run as never, review: approving().review, ...github().hooks },
      }),
    ).rejects.toBeInstanceOf(RunRefusedError);
    const third = await runTicket({
      config: TicketRunConfigSchema.parse({ ...config, runs_started: 3 }),
      contract,
      hooks: { agent: agentDouble(writeFeature).run as never, review: approving().review, ...github().hooks },
    });
    expect(third.outcome).toBe("approved");
    // Roots 1 and 3 are on record. A re-level counts nothing itself, so the
    // record's count says 3 next: it has to find the first free number, and
    // find it again after the base moves once more. Conflicts, so each
    // re-level's round writes its root id on the record.
    for (const [theirs, outcome] of [
      ["export const version = 3;\n", "approved"],
      ["export const version = 4;\n", "relevelled"],
    ] as const) {
      advanceMain(repo.dir, "src/index.ts", theirs);
      const resolver = agentDouble((worktree) => writeFileSync(join(worktree, "src", "index.ts"), theirs));
      const relevel = await runTicket({
        config: TicketRunConfigSchema.parse({ ...config, relevel: true }),
        contract,
        hooks: { agent: resolver.run as never, review: approving().review, ...github().hooks },
      });
      expect(relevel.outcome, relevel.detail).toBe(outcome);
    }
    const attempts = JSON.parse(readFileSync(join(config.state_root, `${contract.ticket_id}.attempts.json`), "utf8")) as { attempts: Array<{ attempt_id: string; root_attempt_id: string }> };
    expect(new Set(attempts.attempts.map((attempt) => attempt.attempt_id)).size).toBe(attempts.attempts.length);
    expect(new Set(attempts.attempts.map((attempt) => attempt.root_attempt_id)).size).toBe(attempts.attempts.length);
  }, RUN_TIMEOUT_MS * 3);

  it("resets past a rejected conflict resolution the loop sealed, and re-levels from the pull request", async () => {
    const repo = makeRepo();
    const { contract, config, branch } = await firstRun(repo);
    const pushedHead = git(repo.dir, "rev-parse", branch).trim();
    git(repo.dir, "update-ref", `refs/remotes/origin/${branch}`, pushedHead);
    // A conflict, resolved by the loop's round and then rejected by the
    // review: the sealed resolution and the merge stay on the local branch,
    // unpushed, and the record's head is the merge.
    const theirs = "export const version = 3;\n";
    advanceMain(repo.dir, "src/index.ts", theirs);
    const resolver = agentDouble((worktree) => writeFileSync(join(worktree, "src", "index.ts"), theirs));
    // Changes requested, not an escalation: an escalated conflict re-level
    // still pushes, and this is the case where nothing is pushed.
    const rejecting = (async (input: { changeset?: ChangeSet }) => ({
      artifact: makeReview({ review_id: "rev_0000000000000012", decision: "changes_requested" as const, changeset_id: input.changeset?.changeset_id ?? "cs_0000000000000001" }),
      bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
    })) as never;
    const rejectedGh = github();
    const rejected = await runTicket({
      config: TicketRunConfigSchema.parse({ ...config, relevel: true }),
      contract,
      hooks: { agent: resolver.run as never, review: rejecting, ...rejectedGh.hooks },
    });
    expect(rejected.outcome).toBe("changes_requested");
    expect(rejectedGh.pushes).toEqual([]);
    expect(Number(git(repo.dir, "rev-list", "--count", `${pushedHead}..${branch}`).trim())).toBeGreaterThanOrEqual(2);
    // The next re-level starts from the pull request again: both commits are
    // the loop's own, so nothing here is a person's to keep.
    const gh = github();
    const again = await runTicket({
      config: TicketRunConfigSchema.parse({ ...config, relevel: true }),
      contract,
      hooks: { agent: resolver.run as never, review: approving().review, ...gh.hooks },
    });
    expect(again.outcome, again.detail).toBe("approved");
    expect(gh.pushes).toEqual([branch]);
    expect(git(repo.dir, "show", `${branch}:src/index.ts`)).toBe(theirs);
  }, RUN_TIMEOUT_MS * 2);

  it("refuses to re-level past a commit the loop did not make, and a branch that diverged from its pull request", async () => {
    const repo = makeRepo();
    const { contract, config, branch } = await firstRun(repo);
    const pushedHead = git(repo.dir, "rev-parse", branch).trim();
    git(repo.dir, "update-ref", `refs/remotes/origin/${branch}`, pushedHead);
    // A person's commit on the branch, not yet pushed: theirs to keep.
    git(repo.dir, "checkout", "-q", branch);
    writeFileSync(join(repo.dir, "src", "fix.ts"), "export const fix = 1;\n");
    git(repo.dir, "add", "-A");
    git(repo.dir, "commit", "-qm", "a person's fix, not yet pushed");
    const personal = git(repo.dir, "rev-parse", "HEAD").trim();
    git(repo.dir, "checkout", "-q", "main");
    advanceMain(repo.dir, "src/other.ts", "export const other = 2;\n");
    const gh = github();
    await expect(
      runTicket({
        config: TicketRunConfigSchema.parse({ ...config, relevel: true }),
        contract,
        hooks: { agent: neverAgent.run as never, review: approving().review, ...gh.hooks },
      }),
    ).rejects.toThrow(/carries 1 commit the loop did not make .*a person's fix, not yet pushed/);
    expect(git(repo.dir, "rev-parse", branch).trim()).toBe(personal);
    expect(gh.pushes).toEqual([]);
    // Diverged: the pull request is at a commit the checkout does not have.
    git(repo.dir, "update-ref", `refs/remotes/origin/${branch}`, git(repo.dir, "rev-parse", "main").trim());
    await expect(
      runTicket({
        config: TicketRunConfigSchema.parse({ ...config, relevel: true }),
        contract,
        hooks: { agent: neverAgent.run as never, review: approving().review, ...gh.hooks },
      }),
    ).rejects.toThrow(/has diverged from its pull request/);
    expect(git(repo.dir, "rev-parse", branch).trim()).toBe(personal);
    expect(gh.pushes).toEqual([]);
  }, RUN_TIMEOUT_MS * 2);
});

describe("carried approvals", () => {
  it("carries across a clean re-level that touched nothing in scope, and not otherwise", async () => {
    const repo = makeRepo();
    git(repo.dir, "checkout", "-q", "-b", "feature");
    writeFeature(repo.dir);
    git(repo.dir, "add", "-A");
    git(repo.dir, "commit", "-qm", "seal\n\nAttempt: att_0000000000000001");
    const approved = git(repo.dir, "rev-parse", "HEAD").trim();
    git(repo.dir, "checkout", "-q", "main");
    advanceMain(repo.dir, "docs/notes.md", "unrelated\n");
    git(repo.dir, "checkout", "-q", "feature");
    git(repo.dir, "merge", "-q", "--no-edit", "main");
    const head = git(repo.dir, "rev-parse", "HEAD").trim();

    const carried = await carriedApprovals({
      repository_root: repo.dir,
      base_ref: "main",
      head,
      approved: [approved.slice(0, 12)],
      paths_allowed: ["src/**"],
    });
    expect(carried, JSON.stringify(carried)).toEqual([{ head: approved, content_equal: true, scope_touched: [] }]);

    // The base now touches the scope: named, so the gate stops.
    git(repo.dir, "checkout", "-q", "main");
    advanceMain(repo.dir, "src/other.ts", "export const other = 2;\n");
    git(repo.dir, "checkout", "-q", "feature");
    git(repo.dir, "merge", "-q", "--no-edit", "main");
    const moved = git(repo.dir, "rev-parse", "HEAD").trim();
    const touched = await carriedApprovals({
      repository_root: repo.dir,
      base_ref: "main",
      head: moved,
      approved: [approved],
      paths_allowed: ["src/**"],
    });
    expect(touched).toEqual([{ head: approved, content_equal: true, scope_touched: ["src/other.ts"] }]);
    // Without a scope to read against, every base change counts.
    const unscoped = await carriedApprovals({ repository_root: repo.dir, base_ref: "main", head: moved, approved: [approved] });
    expect(unscoped[0]?.scope_touched.sort()).toEqual(["docs/notes.md", "src/other.ts"]);

    // A commit that changed the branch's own content does not carry.
    writeFileSync(join(repo.dir, "src", "feature.ts"), "export const total = () => 0;\n");
    git(repo.dir, "commit", "-qam", "change\n\nAttempt: att_0000000000000002");
    const changed = git(repo.dir, "rev-parse", "HEAD").trim();
    const differs = await carriedApprovals({
      repository_root: repo.dir,
      base_ref: "main",
      head: changed,
      approved: [approved],
      paths_allowed: ["src/**"],
    });
    expect(differs[0]?.content_equal).toBe(false);

    // A sha this checkout does not hold yields nothing.
    const foreign = await carriedApprovals({
      repository_root: repo.dir,
      base_ref: "main",
      head: changed,
      approved: ["f".repeat(40)],
      paths_allowed: ["src/**"],
    });
    expect(foreign).toEqual([]);
    // The base's own tip is on the branch after a merge, and its content —
    // nothing, against itself — is not the branch's, so it never carries.
    const baseTip = git(repo.dir, "rev-parse", "main").trim();
    const onBase = await carriedApprovals({
      repository_root: repo.dir,
      base_ref: "main",
      head: changed,
      approved: [baseTip],
      paths_allowed: ["src/**"],
    });
    expect(onBase).toEqual([{ head: baseTip, content_equal: false, scope_touched: [] }]);
  }, RUN_TIMEOUT_MS);
});

describe("the conflict brief with what merged", () => {
  it("states each merged ticket's approved contract, and versions the brief for it", () => {
    const base = { base_ref: "main", base_commit: "c".repeat(40), paths: ["src/feature.ts"] };
    const bare = conflictPrompt(base);
    expect(bare).not.toContain("What landed on the base");
    expect(conflictPromptVersion([])).toBe(CONFLICT_PROMPT_VERSION);
    expect(conflictPromptVersion(undefined)).toBe(CONFLICT_PROMPT_VERSION);

    const merged = [
      { ticket_key: "AYO-9", outcome: "total sums its inputs", criteria: ["total([1,2]) is 3"], paths_allowed: ["src/**"] },
    ];
    const briefed = conflictPrompt({ ...base, merged });
    expect(briefed).toContain("What landed on the base since this branch's base");
    expect(briefed).toContain("  AYO-9: total sums its inputs");
    expect(briefed).toContain("    - total([1,2]) is 3");
    expect(briefed).toContain("    scope: src/**");
    expect(briefed.startsWith(bare.slice(0, 200))).toBe(true);
    expect(conflictPromptVersion(merged)).toBe(CONFLICT_PROMPT_WITH_MERGED_VERSION);
    expect(CONFLICT_PROMPT_WITH_MERGED_VERSION).not.toBe(CONFLICT_PROMPT_VERSION);
  });
});
