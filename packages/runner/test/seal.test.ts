import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS_TABLE, SecretIndex } from "@perbo/contracts";
import { provision } from "@perbo/workspace";
import { sealChangeSet, untrackedAfterChecks } from "../src/seal.js";
import {
  createPullRequest,
  pullRequestBody,
  pushAttemptBranch,
  TicketDeliveryStateSchema,
} from "../src/delivery.js";
import { finding, makeContract, makeReview } from "../src/test-support/records.js";
import { runnerRepository } from "../src/test-support/repository.js";
import { scratch } from "./support.js";
import { readFileSync as read } from "node:fs";

async function worktreeFor(repo: { dir: string; head: string }, attempt = "att_seal") {
  const root = scratch("perbo-seal-");
  const workspace = await provision({
    repository_root: repo.dir,
    repository_id: "repo_fixture",
    ticket_key: "SCP018",
    ticket_id: "ticket_SCP018",
    outcome: "seal the change set",
    base_commit: repo.head,
    attempt_id: attempt,
    root,
    limits: DEFAULT_LIMITS_TABLE,
  });
  return workspace;
}

const sealArgs = (workspace: { path: string; base_commit: string }, secrets: SecretIndex) => ({
  worktree: workspace.path,
  base_commit: workspace.base_commit,
  ticket_key: "SCP018",
  attempt_id: "att_seal",
  outcome: "seal the change set",
  secrets,
});

describe("sealing a change set", () => {
  it("records base and head, and the pair moves when the change moves", async () => {
    const repo = runnerRepository(scratch);
    const workspace = await worktreeFor(repo);
    writeFileSync(join(workspace.path, "src", "feature.ts"), "export const a = 1;\n");

    const sealed = await sealChangeSet(sealArgs(workspace, new SecretIndex()));
    expect(sealed.changeset?.base_commit).toBe(workspace.base_commit);
    expect(sealed.changeset?.head_commit).toBe(sealed.head_commit);
    expect(sealed.changeset?.head_commit_source).toBe("recorded");
    expect(sealed.changeset?.files.map((file) => file.path)).toEqual(["src/feature.ts"]);

    writeFileSync(join(workspace.path, "src", "feature.ts"), "export const a = 2;\n");
    const again = await sealChangeSet(sealArgs(workspace, new SecretIndex()));
    expect(again.head_commit).not.toBe(sealed.head_commit);
  }, 30_000);

  it("returns nothing when the attempt changed nothing", async () => {
    const repo = runnerRepository(scratch);
    const workspace = await worktreeFor(repo, "att_empty");
    const sealed = await sealChangeSet(sealArgs(workspace, new SecretIndex()));
    expect(sealed.changeset).toBeNull();
    expect(sealed.head_commit).toBeNull();
  }, 30_000);

  it("keeps a materialized secret out of the commit by content, under an innocuous name", async () => {
    const repo = runnerRepository(scratch);
    const workspace = await worktreeFor(repo, "att_secret");
    const secrets = new SecretIndex();
    const body = "SESSION_SECRET=s3cr3t_value_abcdef\n";
    secrets.add(".env.local", body);

    // Not called `.env`, not gitignored, and byte-identical to what was
    // materialized. A filename rule would commit this.
    writeFileSync(join(workspace.path, "src", "config-backup.txt"), body);
    writeFileSync(join(workspace.path, "src", "feature.ts"), "export const a = 1;\n");

    const sealed = await sealChangeSet(sealArgs(workspace, secrets));
    expect(sealed.excluded_paths).toContain("src/config-backup.txt");
    expect(sealed.changeset?.files.map((file) => file.path)).toEqual(["src/feature.ts"]);
    expect(sealed.diff).not.toContain("s3cr3t_value_abcdef");
  }, 30_000);

  it("catches a prohibited path a command allow-list would never see", async () => {
    const repo = runnerRepository(scratch);
    const workspace = await worktreeFor(repo, "att_policy");
    mkdirSync(join(workspace.path, ".github", "workflows"), { recursive: true });
    writeFileSync(join(workspace.path, ".github", "workflows", "validate.yml"), "on: push\n");

    const sealed = await sealChangeSet(sealArgs(workspace, new SecretIndex()));
    expect(sealed.prohibited.map((hit) => hit.action)).toContain("write_policy_path");
  }, 30_000);
});

/**
 * The seal runs git, and git fails for reasons only git can state: a hook that
 * refuses the commit, a signing key nothing can unlock, a repository that has
 * moved under it. The exit code says a command failed; only what it wrote says
 * why, and the failure carries that out to whatever prints it.
 */
describe("a seal whose commit fails", () => {
  it("carries the command and git's own words, so the failure says why", async () => {
    const repo = runnerRepository(scratch);
    writeFileSync(
      join(repo.dir, ".git", "hooks", "pre-commit"),
      "#!/bin/sh\necho 'the pre-commit hook would not have this commit' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    const workspace = await worktreeFor(repo, "att_hook");
    writeFileSync(join(workspace.path, "src", "feature.ts"), "export const a = 1;\n");

    const thrown = await sealChangeSet(sealArgs(workspace, new SecretIndex())).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("git commit");
    expect(message).toContain("the pre-commit hook would not have this commit");
  }, 30_000);
});

/**
 * SCP-195: the seal is where the guard's own miss becomes visible.
 *
 * The change set carries a path the contract does not admit only if a write the
 * guard should have refused got through — a program the resolver cannot see
 * into, or a shape it could not read. That is a defect in the runner, and the
 * record has to say so rather than let the review find it.
 */
describe("the spec commit's files, kept out of the change set", () => {
  it("excludes the recorded path and not another the same spelling would match as a glob", async () => {
    const repo = runnerRepository(scratch);
    const workspace = await worktreeFor(repo, "att_spec_literal");
    mkdirSync(join(workspace.path, "src", "nodes"), { recursive: true });
    // A recorded name git reads as a character class unless the pathspec is
    // literal, beside the work file that class matches.
    writeFileSync(join(workspace.path, "src", "nodes", "node[3].md"), "the spec's\n");
    writeFileSync(join(workspace.path, "src", "nodes", "node3.md"), "the change's\n");

    const sealed = await sealChangeSet({
      ...sealArgs(workspace, new SecretIndex()),
      paths_allowed: ["src/**"],
      spec_paths: ["src/nodes/node[3].md"],
    });
    expect(sealed.changed_paths).not.toContain("src/nodes/node[3].md");
    expect(sealed.changed_paths).toContain("src/nodes/node3.md");
  }, 30_000);
});

describe("a changed path outside the contract's allowed paths", () => {
  it("is reported by the seal, with the path named", async () => {
    const repo = runnerRepository(scratch);
    const workspace = await worktreeFor(repo, "att_scope");
    writeFileSync(join(workspace.path, "src", "feature.ts"), "export const a = 1;\n");
    mkdirSync(join(workspace.path, "docs"), { recursive: true });
    writeFileSync(join(workspace.path, "docs", "notes.md"), "notes\n");

    const sealed = await sealChangeSet({
      ...sealArgs(workspace, new SecretIndex()),
      paths_allowed: ["src/**"],
    });
    expect(sealed.changed_paths).toContain("docs/notes.md");
    expect(sealed.outside_allowed_paths).toEqual(["docs/notes.md"]);
  }, 30_000);

  it("says nothing where every changed path is inside them", async () => {
    const repo = runnerRepository(scratch);
    const workspace = await worktreeFor(repo, "att_scope_clean");
    writeFileSync(join(workspace.path, "src", "feature.ts"), "export const a = 1;\n");

    const sealed = await sealChangeSet({
      ...sealArgs(workspace, new SecretIndex()),
      paths_allowed: ["src/**"],
    });
    expect(sealed.outside_allowed_paths).toEqual([]);
  }, 30_000);

  it("admits everything where no globs were named, which is how the seal ran before", async () => {
    const repo = runnerRepository(scratch);
    const workspace = await worktreeFor(repo, "att_scope_unscoped");
    mkdirSync(join(workspace.path, "docs"), { recursive: true });
    writeFileSync(join(workspace.path, "docs", "notes.md"), "notes\n");

    const sealed = await sealChangeSet(sealArgs(workspace, new SecretIndex()));
    expect(sealed.changed_paths).toContain("docs/notes.md");
    expect(sealed.outside_allowed_paths).toEqual([]);
  }, 30_000);
});

describe("delivery", () => {
  it("refuses to push or open a pull request from anything but the attempt's own branch", async () => {
    await expect(pushAttemptBranch({ worktree: "/tmp", branch: "main" })).rejects.toMatchObject({
      name: "DeliveryError",
      detail: expect.stringContaining("not an attempt branch"),
    });
    await expect(
      createPullRequest({
        worktree: "/tmp",
        branch: "release/1.0",
        base_ref: "main",
        title: "t",
        body: "b",
      }),
    ).rejects.toMatchObject({
      name: "DeliveryError",
      detail: expect.stringContaining("not an attempt branch"),
    });
  });

  it("never merges: there is no call to do it", () => {
    const source = read(new URL("../src/delivery.ts", import.meta.url), "utf8");
    expect(source).not.toContain("pr\", \"merge");
    expect(source).not.toMatch(/"merge"/);
  });

  it("puts the ticket, plan, attempt, coverage, rollout and cost in the body", () => {
    const contract = makeContract();
    const review = makeReview({
      review_id: "rev_0000000000000002",
      decision: "approve",
      coverage: [{ criterion_id: "ac_1", status: "met", verification_strength: "directly_verified" }],
      findings: [finding({ routing: "advisory", blocking: false })],
    });
    const attempt = {
      attempt_id: "att_1",
      base_commit: "abc1234",
      head_commit: "def5678",
      usage: { cost_micros: 250_000 },
    };
    const body = pullRequestBody({
      contract: contract as never,
      attempt: attempt as never,
      review,
      attempts: [attempt as never],
    });

    expect(body).toContain("ticket_SCP094");
    expect(body).toContain("plan_stage2` v1");
    expect(body).toContain("att_1");
    expect(body).toContain("ac_1");
    expect(body).toContain("directly_verified");
    expect(body).toContain("git revert");
    expect(body).toContain("0.2500 USD");
    expect(body).toContain("A human merges this");
  });

  it("names the finding a criterion's evidence answered, when there was one", () => {
    const contract = makeContract();
    const review = makeReview({ review_id: "rev_0000000000000002", decision: "approve" });
    const stamped = {
      ...review,
      coverage: [{ ...review.coverage[0]!, authored_in_response_to: "a".repeat(64) }],
    };
    const attempt = { attempt_id: "att_2", base_commit: "a", head_commit: "b", usage: { cost_micros: 0 } };
    const body = pullRequestBody({
      contract: contract as never,
      attempt: attempt as never,
      review: stamped as never,
      attempts: [attempt as never],
    });
    expect(body).toContain("evidence written in answer to finding aaaaaaaaaaaa");
  });

  it("keeps the ticket record to labels, never comment bodies", () => {
    const state = TicketDeliveryStateSchema.parse({
      ticket_id: "ticket_1",
      branch: "ayo/scp020/x",
      pull_request_url: "https://github.com/o/r/pull/1",
      pull_request_number: 1,
      state: "open",
      merge_state: "CLEAN",
      checks: [{ name: "validate", status: "COMPLETED", conclusion: "SUCCESS" }],
      human_review_verdicts: ["changes_requested"],
      finding_outcomes: { abcdef123456: "fixed" },
      candidate_missed_recall: 2,
      reverted_by: null,
      fixed_by: null,
      attempts: ["att_1"],
      observed_at: "2026-08-27T00:00:00.000Z",
    });
    // There is no field for a comment body, which is the point.
    expect(Object.keys(state)).not.toContain("comments");
    expect(JSON.stringify(state)).not.toContain("body");
  });
});

describe("the diff that gets reviewed", () => {
  it("is what the reviewer receives, and the transcript is not in it", async () => {
    const repo = runnerRepository(scratch);
    const workspace = await worktreeFor(repo, "att_diff");
    writeFileSync(join(workspace.path, "src", "feature.ts"), "export const a = 1;\n");
    const sealed = await sealChangeSet(sealArgs(workspace, new SecretIndex()));
    expect(sealed.diff).toContain("+export const a = 1;");
    expect(sealed.changeset?.truncated).toBe(false);
    expect(sealed.changeset?.diff_bytes).toBe(Buffer.byteLength(sealed.diff, "utf8"));
    expect(readFileSync(join(workspace.path, "src", "feature.ts"), "utf8")).toContain("a = 1");
  }, 30_000);

  it("withholds a diff past the cap rather than cutting it, and keeps every changed path", async () => {
    const repo = runnerRepository(scratch);
    const workspace = await worktreeFor(repo, "att_large");
    // Alphabetically first, so a tail-truncated diff would lose it first.
    writeFileSync(join(workspace.path, "src", "aaa-first.ts"), "export const first = 1;\n");
    writeFileSync(join(workspace.path, "src", "big.ts"), `export const big = "${"x".repeat(4_000)}";\n`);
    writeFileSync(join(workspace.path, "src", "index.ts"), "export const version = 2;\n");

    const sealed = await sealChangeSet({
      ...sealArgs(workspace, new SecretIndex()),
      max_diff_bytes: 1_024,
    });

    expect(sealed.changeset?.truncated).toBe(true);
    expect(sealed.changeset?.diff_bytes).toBeGreaterThan(4_000);
    expect(sealed.diff).toBe("");
    // The file list comes from name-status, never from the diff body.
    expect(sealed.changeset?.files.map((file) => file.path)).toEqual([
      "src/aaa-first.ts",
      "src/big.ts",
      "src/index.ts",
    ]);
    expect(sealed.changeset?.files.map((file) => file.change_kind)).toEqual([
      "added",
      "added",
      "modified",
    ]);
    expect(sealed.changed_paths).toEqual(["src/aaa-first.ts", "src/big.ts", "src/index.ts"]);
    expect(sealed.head_commit).not.toBeNull();
  }, 30_000);
});

describe("check output from a previous round", () => {
  it("is kept out of the next round's diff rather than committed as the agent's work", async () => {
    const repo = runnerRepository(scratch);
    const workspace = await worktreeFor(repo, "att_artifacts");

    // Round N: the agent writes a file, the checks write a coverage report the
    // repository does not ignore.
    writeFileSync(join(workspace.path, "src", "feature.ts"), "export const a = 1;\n");
    mkdirSync(join(workspace.path, "coverage"), { recursive: true });
    writeFileSync(join(workspace.path, "coverage", "report.json"), '{"pct":100}');

    const sealed = await sealChangeSet({
      ...sealArgs(workspace, new SecretIndex()),
      exclude_paths: ["coverage/report.json"],
    });

    expect(sealed.excluded_check_artifacts).toEqual(["coverage/report.json"]);
    expect(sealed.changeset?.files.map((file) => file.path)).toEqual(["src/feature.ts"]);
  }, 30_000);

  it("reports what the working tree gained, so the next seal knows", async () => {
    const repo = runnerRepository(scratch);
    const workspace = await worktreeFor(repo, "att_untracked");
    writeFileSync(join(workspace.path, "coverage.json"), "{}");
    const seen = await untrackedAfterChecks({ worktree: workspace.path });
    expect(seen).toContain("coverage.json");
  }, 30_000);

  it("refuses a listing it could not read whole, rather than seal what it lost", async () => {
    const repo = runnerRepository(scratch);
    const workspace = await worktreeFor(repo, "att_untracked_cut");
    writeFileSync(join(workspace.path, "coverage.json"), "{}");
    writeFileSync(join(workspace.path, "profile.json"), "{}");

    await expect(
      // Smaller than the two paths the listing has, so it is cut.
      untrackedAfterChecks({ worktree: workspace.path, maxOutputBytes: 8 }),
    ).rejects.toThrow(/could not be read whole/);
  }, 30_000);
});

describe("what counts as check output", () => {
  it("is untracked files only, so a modified tracked file still reaches the reviewer", async () => {
    const repo = runnerRepository(scratch);
    const workspace = await worktreeFor(repo, "att_modified");
    // A check that rewrites a tracked file is a bigger problem than a coverage
    // directory, and hiding it would also drop the same file if the agent edits
    // it in the next round.
    writeFileSync(join(workspace.path, "src", "index.ts"), "export const version = 2;\n");
    writeFileSync(join(workspace.path, "coverage.json"), "{}");
    const seen = await untrackedAfterChecks({ worktree: workspace.path });
    expect(seen).toEqual(["coverage.json"]);
  }, 30_000);
});
