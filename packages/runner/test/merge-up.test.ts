import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { LimitsTableSchema, type ChangeSet } from "@perbo/contracts";
import type { AgentResult } from "../src/adapter.js";
import { EgressLog } from "../src/egress.js";
import { TicketRunConfigSchema, runTicket } from "../src/loop.js";
import { mergeUp } from "../src/merge-up.js";
import { finding, git, makeContract, makeRepo, makeReview, scratch, withoutInstall } from "./support.js";

/**
 * SCP-192: the loop keeps its branch level with the base.
 *
 * Every one of these drives the real thing — a real repository, a real base
 * branch that moves under the run, a real `git merge` — with only the agent,
 * the reviewer and the two publishing calls replaced. A merge asserted against
 * a double of `git` says nothing about whether the branch a person is asked to
 * merge is current.
 */

/**
 * The agent double, keeping the brief each round was handed.
 *
 * The brief is what criterion 2 is about — a conflict round is told the base
 * commit, the conflicting paths and nothing else — so it is kept rather than
 * only the effect.
 */
const agentDouble = (write: (worktree: string, round: number) => void) => {
  const calls: string[] = [];
  const run = async (request: {
    worktree: string;
    prompt: string;
    profile: { network_allow_list: readonly string[] };
  }): Promise<AgentResult> => {
    write(request.worktree, calls.length);
    calls.push(request.prompt);
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

function makeConfig(repositoryRoot: string) {
  const root = scratch("perbo-mergeup-");
  return TicketRunConfigSchema.parse({
    materialization_manifest: withoutInstall(repositoryRoot),
    ticket_key: "SCP192",
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
    limits: LimitsTableSchema.parse({
      organisation: "test",
      limits: { concurrent_local_attempts: 4 },
    }),
  });
}

/** A commit on the repository's own `main`, made while the run is in flight. */
function landOnBase(repo: string, file: string, contents: string): string {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), contents);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", `base: ${file}`);
  return git(repo, "rev-parse", "HEAD").trim();
}

type ReviewCall = { changeset?: ChangeSet; diff?: string };

const approving = (seen: ReviewCall[], before: () => void = () => undefined) =>
  (async (input: ReviewCall) => {
    before();
    seen.push(input);
    return {
      artifact: makeReview({
        review_id: "rev_0000000000000001",
        decision: "approve" as const,
        changeset_id: input.changeset?.changeset_id ?? "cs_0000000000000001",
      }),
      bundle: {
        prompt_version: "reviewer_v2",
        system_prompt: "s",
        turns: [],
        files_read: [],
        rejected_verdicts: [],
      },
    };
  }) as never;

/**
 * Every case below drives a real `git` repository through the loop —
 * worktree provisioning, a real merge, a real commit — under a machine also
 * running other gates and a loop attempt at once (SCP-191). `loop.test.ts`
 * sizes its own loop-driving cases at the same figure for a full run under
 * that load.
 */
const MERGE_UP_TIMEOUT_MS = 60_000;

describe("the branch is level with the base before the review reads it", () => {
  it("merges a base commit that landed under the run, and reviews against the new base", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);

    // The commit lands while the executor is running: after the worktree was
    // provisioned from `repo.head`, and before anything is sealed or reviewed.
    let movedTo = "";
    const agent = agentDouble((worktree) => {
      mkdirSync(join(worktree, "src"), { recursive: true });
      writeFileSync(join(worktree, "src", "feature.ts"), "export const total = (n) => n.length;\n");
      movedTo = landOnBase(repo.dir, "src/unrelated.ts", "export const other = 2;\n");
    });

    const reviewed: ReviewCall[] = [];
    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: approving(reviewed) },
    });

    expect(result.outcome).toBe("approved");
    // The review's change set is the branch against the base's new tip.
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]!.changeset!.base_commit).toBe(movedTo);
    // And it is the branch's own change: the base's commit is in the branch's
    // history, so what it added is not in the diff the reviewer read.
    expect(reviewed[0]!.diff).toContain("src/feature.ts");
    expect(reviewed[0]!.diff).not.toContain("src/unrelated.ts");

    const attempt = result.rounds[0]!.attempt;
    expect(attempt.merged_base).toBe(movedTo);
    expect(attempt.base_commit).toBe(movedTo);
    // The branch really carries the base commit: `--is-ancestor` exits 0.
    expect(() =>
      git(repo.dir, "merge-base", "--is-ancestor", movedTo, attempt.head_commit!),
    ).not.toThrow();
  }, MERGE_UP_TIMEOUT_MS);

  it("hands a conflicting base commit to a round that names those files and nothing else", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);

    const conflicting = "src/index.ts";
    let movedTo = "";
    const agent = agentDouble((worktree, round) => {
      if (round === 0) {
        // The ticket's own work, plus a change to a file the base then also
        // changes: the conflict is one file of a larger change set.
        mkdirSync(join(worktree, "src"), { recursive: true });
        writeFileSync(join(worktree, "src", "feature.ts"), "export const total = (n) => n.length;\n");
        writeFileSync(join(worktree, conflicting), "export const version = 2;\n");
        movedTo = landOnBase(repo.dir, conflicting, "export const version = 3;\n");
        return;
      }
      // The conflict round's only task: make the branch's side agree with the
      // base, so the merge the loop retries is clean.
      writeFileSync(join(worktree, conflicting), "export const version = 3;\n");
    });

    const reviewed: ReviewCall[] = [];
    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: approving(reviewed) },
    });

    // Two rounds ran: the executor's, and the conflict resolution.
    expect(agent.calls).toHaveLength(2);
    const brief = agent.calls[1]!;
    expect(brief).toContain(conflicting);
    expect(brief).toContain(movedTo);
    expect(brief).toContain("Resolve the conflict and nothing else.");
    // "and nothing else": the conflict brief is neither the executor's brief
    // nor the remediation brief, so the round cannot be spent re-doing the
    // ticket or answering findings.
    expect(brief).not.toContain("# Acceptance criteria");
    expect(brief).not.toContain("remediation round");
    // The round's own change set is larger than the conflict; the brief names
    // only the file that conflicts.
    expect(brief).not.toContain("src/feature.ts");

    expect(result.rounds[0]!.kind).toBe("execute");
    expect(result.rounds[1]!.kind).toBe("resolve_conflict");
    // The resolution is sealed and reviewed like any round, against the base
    // that conflicted.
    expect(result.outcome).toBe("approved");
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]!.changeset!.base_commit).toBe(movedTo);
    expect(result.rounds[1]!.attempt.merged_base).toBe(movedTo);
  }, MERGE_UP_TIMEOUT_MS);

  it("stops the ticket with the files named when the round cannot resolve the conflict", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);

    const conflicting = "src/index.ts";
    const agent = agentDouble((worktree, round) => {
      if (round === 0) {
        writeFileSync(join(worktree, conflicting), "export const version = 2;\n");
        landOnBase(repo.dir, conflicting, "export const version = 3;\n");
        return;
      }
      // A round that changed something else entirely: the conflict is still there.
      mkdirSync(join(worktree, "src"), { recursive: true });
      writeFileSync(join(worktree, "src", "feature.ts"), "export const total = 1;\n");
    });

    const reviewed: ReviewCall[] = [];
    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: approving(reviewed) },
    });

    expect(result.outcome).toBe("base_conflict");
    expect(result.detail).toContain(conflicting);
    // The gate never opened: nothing is reviewed on a branch that cannot reach
    // its base.
    expect(reviewed).toHaveLength(0);
  }, MERGE_UP_TIMEOUT_MS);

  it("stops when the resolution leaves conflict markers in the change set", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);

    const conflicting = "src/index.ts";
    const agent = agentDouble((worktree, round) => {
      if (round === 0) {
        writeFileSync(join(worktree, conflicting), "export const version = 2;\n");
        landOnBase(repo.dir, conflicting, "export const version = 3;\n");
        return;
      }
      // The executor did the merge itself and committed the conflict as it
      // stood — the failure mode a person meets as a branch full of markers.
      const tip = git(repo.dir, "rev-parse", "main").trim();
      try {
        git(worktree, "merge", "--no-edit", tip);
      } catch {
        // The conflict is the point of this fixture.
      }
      writeFileSync(
        join(worktree, conflicting),
        "<<<<<<< HEAD\nexport const version = 2;\n=======\nexport const version = 3;\n>>>>>>> base\n",
      );
      git(worktree, "add", "-A");
      git(worktree, "commit", "-qm", "merge");
    });

    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: approving([]) },
    });

    expect(result.outcome).toBe("base_conflict");
    expect(result.detail).toContain(conflicting);
    expect(result.detail).toContain("conflict marker");
  }, MERGE_UP_TIMEOUT_MS);

  it("starts a re-run from a merged-up branch, so the executor sees what the base has", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);

    const first = agentDouble((worktree) => {
      mkdirSync(join(worktree, "src"), { recursive: true });
      writeFileSync(join(worktree, "src", "feature.ts"), "export const total = (n) => n.length;\n");
    });
    const firstRun = await runTicket({
      config: { ...config, runs_started: 1 },
      contract,
      hooks: {
        agent: first.run as never,
        review: (async () => ({
          artifact: makeReview({
            review_id: "rev_0000000000000001",
            decision: "changes_requested" as const,
            findings: [finding({ rule_id: "security.secret_in_diff", routing: "blocks" })],
          }),
          bundle: {
            prompt_version: "reviewer_v2",
            system_prompt: "s",
            turns: [],
            files_read: [],
            rejected_verdicts: [],
          },
        })) as never,
      },
    });
    expect(firstRun.outcome).toBe("changes_requested");

    // The base moves after the first run sealed its commit.
    const movedTo = landOnBase(repo.dir, "src/base-added.ts", "export const added = true;\n");

    // The second run's executor must find the base's file already in its tree.
    let sawBaseFile: boolean | null = null;
    const second = agentDouble((worktree) => {
      sawBaseFile = existsSync(join(worktree, "src", "base-added.ts"));
      writeFileSync(join(worktree, "src", "feature.ts"), "export const total = (n) => n.length + 0;\n");
    });
    const reviewed: ReviewCall[] = [];
    const secondRun = await runTicket({
      config: { ...config, runs_started: 2 },
      contract,
      hooks: { agent: second.run as never, review: approving(reviewed) },
    });

    expect(sawBaseFile).toBe(true);
    expect(secondRun.outcome).toBe("approved");
    expect(secondRun.rounds[0]!.attempt.merged_base).toBe(movedTo);
    expect(reviewed[0]!.changeset!.base_commit).toBe(movedTo);
    // The executor never rebuilds what the base already has: the base's own
    // file is not in the change set the reviewer read.
    expect(reviewed[0]!.diff).not.toContain("src/base-added.ts");
  }, MERGE_UP_TIMEOUT_MS);

  it("merges up again before the pull request, and records the base tip it opened over", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = { ...makeConfig(repo.dir), publish: true };
    // SCP-200: the credential path this run publishes through is read from the
    // runner's own environment, so the test sets it rather than inheriting
    // whatever the machine happens to hold.
    const token = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "test-token";

    const agent = agentDouble((worktree) => {
      mkdirSync(join(worktree, "src"), { recursive: true });
      writeFileSync(join(worktree, "src", "feature.ts"), "export const total = (n) => n.length;\n");
    });

    // The base moves between the review and the publish, which is the window
    // the round's own merge-up cannot cover.
    let movedTo = "";
    const reviewed: ReviewCall[] = [];
    const opened: Array<{ head: string; base_ref: string }> = [];
    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agent.run as never,
        review: approving(reviewed, () => {
          movedTo = landOnBase(repo.dir, "src/late.ts", "export const late = 1;\n");
        }),
        push: (async () => ({ pushed: true, detail: "test" })) as never,
        open: (async (request: { branch: string; base_ref: string }) => {
          opened.push({
            head: git(repo.dir, "rev-parse", request.branch).trim(),
            base_ref: request.base_ref,
          });
          return { url: "https://example.invalid/pull/1", number: 1 };
        }) as never,
      },
    });

    if (token === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = token;

    expect(result.outcome).toBe("approved");
    expect(opened).toHaveLength(1);
    // SCP-200: the run says which credential it published through, and
    // `recordDelivery` is what puts that on the ticket.
    expect(result.github_credential).toBe("GH_TOKEN");
    // The branch the pull request opened over carries the commit that landed
    // after the review: it is mergeable at the moment it opens.
    expect(() =>
      git(repo.dir, "merge-base", "--is-ancestor", movedTo, opened[0]!.head),
    ).not.toThrow();
    expect(result.merged_base).toBe(movedTo);
  }, MERGE_UP_TIMEOUT_MS);
});

describe("mergeUp itself", () => {
  /** A branch beside `main` in its own worktree, at `main`'s current tip. */
  function branchWorktree(repo: string, name: string): string {
    const path = join(scratch("perbo-mergeup-wt-"), name);
    git(repo, "worktree", "add", "-b", name, path, "HEAD");
    return path;
  }

  it("does nothing for a base ref this checkout cannot resolve", async () => {
    const repo = makeRepo();
    const worktree = branchWorktree(repo.dir, "unresolvable");

    const result = await mergeUp({
      worktree,
      repository_root: repo.dir,
      // The shape a ticketless run pointed at somebody else's pull request has.
      base_ref: "release-2.4",
      base_commit: repo.head,
      ticket_key: "SCP192",
      attempt_id: "att_0000000000000001",
    });

    expect(result).toEqual({ status: "current", base_commit: repo.head });
  }, MERGE_UP_TIMEOUT_MS);

  it("does nothing for a base ref that could be read as an option", async () => {
    const repo = makeRepo();
    const worktree = branchWorktree(repo.dir, "optionish");

    const result = await mergeUp({
      worktree,
      repository_root: repo.dir,
      base_ref: "--exec=touch /tmp/pwned",
      base_commit: repo.head,
      ticket_key: "SCP192",
      attempt_id: "att_0000000000000001",
    });

    expect(result).toEqual({ status: "current", base_commit: repo.head });
  }, MERGE_UP_TIMEOUT_MS);

  it("refuses a conflict whose unmerged paths do not fit in one listing", async () => {
    const repo = makeRepo();
    const worktree = branchWorktree(repo.dir, "cut-listing");
    const conflicting = "src/index.ts";
    writeFileSync(join(worktree, conflicting), "export const version = 2;\n");
    git(worktree, "add", "-A");
    git(worktree, "commit", "-qm", "the branch's own change");
    const tip = landOnBase(repo.dir, conflicting, "export const version = 3;\n");
    expect(tip).not.toBe(repo.head);

    await expect(
      mergeUp({
        worktree,
        repository_root: repo.dir,
        base_ref: "main",
        base_commit: repo.head,
        ticket_key: "SCP192",
        attempt_id: "att_0000000000000001",
        // Smaller than the one path the conflict has, so the listing is cut.
        maxOutputBytes: 4,
      }),
    ).rejects.toThrow(/could not be read whole/);
  }, MERGE_UP_TIMEOUT_MS);

  it("names no path when the merge failed for a reason that is not a conflict", async () => {
    const repo = makeRepo();
    const worktree = branchWorktree(repo.dir, "blocked");
    // The branch has a commit of its own, so the merge is not a fast-forward.
    writeFileSync(join(worktree, "src", "own.ts"), "export const own = 1;\n");
    git(worktree, "add", "-A");
    git(worktree, "commit", "-qm", "own");
    // And an untracked file exactly where the base is about to add one, which
    // `git merge` refuses to overwrite — a refusal, not a conflict.
    const tip = landOnBase(repo.dir, "src/collides.ts", "export const base = 1;\n");
    writeFileSync(join(worktree, "src", "collides.ts"), "not committed\n");

    const result = await mergeUp({
      worktree,
      repository_root: repo.dir,
      base_ref: "main",
      base_commit: repo.head,
      ticket_key: "SCP192",
      attempt_id: "att_0000000000000001",
    });

    expect(result.status).toBe("conflict");
    // No file for a round to reconcile, so the loop stops rather than spending
    // one on it.
    expect(result).toMatchObject({ tip, paths: [] });
    expect((result as { detail: string }).detail).not.toBe("");
    // The failed merge left nothing behind: the worktree is as it was.
    expect(git(worktree, "rev-parse", "HEAD").trim()).not.toBe(tip);
    expect(git(worktree, "status", "--porcelain")).toContain("?? src/collides.ts");
  }, MERGE_UP_TIMEOUT_MS);
});

describe("a base that has not moved costs nothing", () => {
  it("adds no merge commit and records no merged base", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);

    const agent = agentDouble((worktree) => {
      mkdirSync(join(worktree, "src"), { recursive: true });
      writeFileSync(join(worktree, "src", "feature.ts"), "export const total = 1;\n");
    });
    const reviewed: ReviewCall[] = [];
    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: approving(reviewed) },
    });

    expect(result.outcome).toBe("approved");
    expect(result.rounds[0]!.attempt.merged_base).toBeNull();
    expect(result.rounds[0]!.attempt.base_commit).toBe(repo.head);
    // One commit on the branch: the seal's. No merge commit was invented for a
    // base that had not moved.
    expect(
      git(
        repo.dir,
        "rev-list",
        "--count",
        `${repo.head}..${result.rounds[0]!.attempt.head_commit!}`,
      ).trim(),
    ).toBe("1");
  }, MERGE_UP_TIMEOUT_MS);
});

/**
 * SCP-195 against SCP-192: the scope assertion is about the change set the
 * review reads, which after a merge-up is the re-read one.
 *
 * The merge-up does not re-seal — it re-reads the range through `describeRange`
 * — so an assertion that lived only in the seal would be silently replaced by
 * the re-read's answer, and a path the guard missed would reach the reviewer
 * with the run reporting nothing wrong.
 */
describe("the scope assertion survives the merge-up", () => {
  it("still stops the attempt as runner_defect when the base moved under the round", async () => {
    const repo = makeRepo();
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);

    // The base moves while the executor runs, so the seal's range is re-read
    // against the new tip before anything judges it.
    let movedTo = "";
    const agent = agentDouble((worktree) => {
      mkdirSync(join(worktree, "src"), { recursive: true });
      writeFileSync(join(worktree, "src", "feature.ts"), "export const total = 1;\n");
      // Outside `src/**` and `test/**` and outside every package they declare —
      // written where no command named it, which is the shape the guard cannot
      // see and the reason the seal reads the change set at all.
      writeFileSync(join(worktree, "package.json"), '{"name":"escaped"}\n');
      movedTo = landOnBase(repo.dir, "src/unrelated.ts", "export const other = 2;\n");
    });

    const reviewed: ReviewCall[] = [];
    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: approving(reviewed) },
    });

    const attempt = result.rounds[0]!.attempt;
    // The merge-up happened: the round is judged against the base's new tip.
    expect(attempt.merged_base).toBe(movedTo);
    expect(attempt.base_commit).toBe(movedTo);
    // And the assertion travelled with the re-read.
    expect(attempt.termination.reason).toBe("runner_defect");
    expect(attempt.termination.detail).toContain("package.json");
    expect(reviewed).toHaveLength(0);
    expect(result.outcome).toBe("terminated");
  }, MERGE_UP_TIMEOUT_MS);
});
