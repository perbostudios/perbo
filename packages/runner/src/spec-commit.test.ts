import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LimitsTableSchema, type ChangeSet, type SpecFile } from "@perbo/contracts";
import { scratchDirectories } from "@perbo/test-support";
import type { AgentResult } from "./adapter.js";
import { EgressLog } from "./egress.js";
import { TicketRunConfigSchema, runTicket, type TicketRunConfig } from "./loop.js";
import { RunRefusedError } from "./refusal.js";
import { finding, makeContract, makeReview, withoutInstall } from "./test-support/records.js";
import { git, runnerRepository } from "./test-support/repository.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * SCP-314: the spec the change is judged against is the branch's first commit,
 * and the review reads the diff after it (D-103).
 *
 * Every run here is a real run of the loop against a real repository, with the
 * agent, the reviewer and the GitHub-side steps replaced by doubles. What the
 * doubles record is what the review and the verification were handed, which is
 * where the exclusion either holds or does not.
 */

const SPEC_MD = `# Activation email

## Outcome

New users receive an activation email within 60 seconds of signing up.

## Requirements

- R1: A signup POST queues exactly one activation email.
`;
const NODE_1 = "# Queue the email\n\n- R1: A signup POST queues exactly one activation email.\n";
const NODE_2 = "# Retry a failed send\n\nNothing is derived to this node yet.\n";
const CONTEXT = "# Terms\n\nAn activation email proves the address.\n";
const ADR = "# ADR-0002: Retry a failed send\n\n- Status: accepted\n";

const hash = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

/**
 * What the interview left in the checkout, and the record admission made of
 * it: the spec's folder, a reworded `CONTEXT.md` and a new ADR.
 */
function writeSpec(repositoryRoot: string): SpecFile[] {
  const written: Array<[string, string]> = [
    ["specs/activation-email/spec.md", SPEC_MD],
    ["specs/activation-email/nodes/node_1.md", NODE_1],
    ["specs/activation-email/nodes/node_2.md", NODE_2],
    // A name git would read as a character class if a pathspec were not
    // literal: every list the loop builds from these paths is one.
    ["specs/activation-email/nodes/node[3].md", NODE_2],
    ["CONTEXT.md", CONTEXT],
    ["docs/adr/0002-retry.md", ADR],
  ];
  for (const [path, content] of written) {
    mkdirSync(join(repositoryRoot, path, ".."), { recursive: true });
    writeFileSync(join(repositoryRoot, path), content);
  }
  return written.map(([path, content]) => ({ path, content_sha256: hash(content) }));
}

const agentDouble = (write: (worktree: string, round: number) => void) => {
  let round = 0;
  const worktrees: string[] = [];
  const prohibited: string[][] = [];
  const run = async (request: {
    worktree: string;
    profile: { network_allow_list: readonly string[] };
    paths_prohibited?: readonly string[];
  }): Promise<AgentResult> => {
    worktrees.push(request.worktree);
    prohibited.push([...(request.paths_prohibited ?? [])]);
    write(request.worktree, round);
    round += 1;
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
  return { run, worktrees, prohibited };
};

const writeFeature = (worktree: string) => {
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(join(worktree, "src", "feature.ts"), "export const total = (n) => n.length;\n");
};

function makeConfig(
  repositoryRoot: string,
  spec_files: SpecFile[],
  over: Record<string, unknown> = {},
): TicketRunConfig {
  const root = scratch("perbo-spec-commit-");
  return TicketRunConfigSchema.parse({
    materialization_manifest: withoutInstall(repositoryRoot),
    ticket_key: "FCX1",
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
    spec_files,
    limits: LimitsTableSchema.parse({ organisation: "test", limits: { concurrent_local_attempts: 4 } }),
    ...over,
  });
}

/** The reviewer double, recording the change set and the range it was shown. */
function approving() {
  const changesets: ChangeSet[] = [];
  const ranges: string[] = [];
  const review = (async (input: { changeset?: ChangeSet; repoDir: string }) => {
    if (input.changeset) changesets.push(input.changeset);
    ranges.push(
      git(input.repoDir, "diff", "--name-only", `${input.changeset!.base_commit}..HEAD`).trim(),
    );
    return {
      artifact: makeReview({
        review_id: `rev_${String(changesets.length).padStart(16, "0")}`,
        decision: "approve" as const,
        changeset_id: input.changeset?.changeset_id ?? "cs_0000000000000001",
      }),
      bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
    };
  }) as never;
  return { review, changesets, ranges };
}

/** The commits `base..branch` carries, oldest first, each with the paths it changed. */
function branchCommits(repositoryRoot: string, base: string, branch: string) {
  return git(repositoryRoot, "rev-list", "--reverse", "--first-parent", `${base}..${branch}`)
    .split("\n")
    .map((sha) => sha.trim())
    .filter((sha) => sha.length > 0)
    .map((sha) => ({
      sha,
      subject: git(repositoryRoot, "log", "-1", "--format=%s", sha).trim(),
      message: git(repositoryRoot, "log", "-1", "--format=%B", sha),
      paths: git(repositoryRoot, "diff", "--name-only", `${sha}^`, sha)
        .split("\n")
        .map((path) => path.trim())
        .filter((path) => path.length > 0),
    }));
}

const RUN_TIMEOUT_MS = 90_000;

describe("the branch's first commit", () => {
  it("holds exactly the recorded spec files, with their contents and nothing else", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const files = writeSpec(repo.dir);
    const config = makeConfig(repo.dir, files);
    const reviewer = approving();

    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agentDouble(writeFeature).run as never, review: reviewer.review },
    });
    expect(result.outcome).toBe("approved");

    const commits = branchCommits(repo.dir, repo.head, result.workspace.branch);
    expect(commits.length).toBeGreaterThan(1);
    const spec = commits[0]!;
    expect(spec.paths).toEqual(files.map((file) => file.path).sort());
    for (const file of files) {
      expect(repo.git("show", `${spec.sha}:${file.path}`)).toBe(
        {
          "specs/activation-email/spec.md": SPEC_MD,
          "specs/activation-email/nodes/node_1.md": NODE_1,
          "specs/activation-email/nodes/node_2.md": NODE_2,
          "specs/activation-email/nodes/node[3].md": NODE_2,
          "CONTEXT.md": CONTEXT,
          "docs/adr/0002-retry.md": ADR,
        }[file.path],
      );
    }
    // The loop's own commit: SCP-227's re-level reads the trailer to tell it
    // from a person's.
    expect(spec.message).toMatch(/Attempt: att_/);
    expect(result.rounds[0]!.attempt.spec_commit).toBe(spec.sha);
  }, RUN_TIMEOUT_MS);

  it("prohibits every recorded file to the executor, since the change set no longer carries them", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const files = writeSpec(repo.dir);
    const agent = agentDouble(writeFeature);
    const result = await runTicket({
      config: makeConfig(repo.dir, files),
      contract,
      hooks: { agent: agent.run as never, review: approving().review },
    });

    expect(result.outcome).toBe("approved");
    // A write to one of these would otherwise reach the pull request with
    // nothing judging it: the seal keeps them out of the change set the review
    // reads, so the guard is what keeps the executor out of them.
    for (const file of files) expect(agent.prohibited[0]).toContain(file.path);
  }, RUN_TIMEOUT_MS);

  it("refuses a recorded file whose folder in the worktree leaves it, writing nothing there", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const files = writeSpec(repo.dir);
    // The branch carries a folder on the way as a link out of the checkout, so
    // the worktree materializes one. The checkout holds that folder as a real
    // directory with the recorded bytes, so the record and the hashes are in
    // order: what has to be judged is where the write lands.
    const outside = scratch("perbo-spec-outside-");
    const nodes = join(repo.dir, "specs", "activation-email", "nodes");
    mkdirSync(join(outside, "nodes"), { recursive: true });
    for (const name of ["node_1.md", "node_2.md"])
      writeFileSync(join(outside, "nodes", name), "not the spec\n");
    rmSync(nodes, { recursive: true, force: true });
    symlinkSync(join(outside, "nodes"), nodes);
    repo.git("add", "-A");
    repo.git("commit", "-m", "a folder that is a link");
    contract.base.base_commit = repo.git("rev-parse", "HEAD").trim();
    rmSync(nodes, { force: true });
    mkdirSync(join(nodes, "deep"), { recursive: true });
    writeFileSync(join(nodes, "node_1.md"), NODE_1);
    writeFileSync(join(nodes, "node_2.md"), NODE_2);
    // A recorded file whose folder is not under the link, so making it would
    // put a directory outside the checkout before anything judged the path.
    writeFileSync(join(nodes, "deep", "node_3.md"), NODE_2);
    // Sorted where the producer would put it: under the link, and judged
    // before the file whose own folder is the link.
    files.splice(1, 0, {
      path: "specs/activation-email/nodes/deep/node_3.md",
      content_sha256: hash(NODE_2),
    });

    const agent = agentDouble(writeFeature);
    await expect(
      runTicket({
        config: makeConfig(repo.dir, files, { base_ref: "main" }),
        contract,
        hooks: { agent: agent.run as never, review: approving().review },
      }),
    ).rejects.toThrow(RunRefusedError);
    expect(agent.worktrees).toHaveLength(0);
    // Nothing travelled through the link, and the spec's own file, which the
    // record lists first, was not written before the refusal.
    expect(readFileSync(join(outside, "nodes", "node_1.md"), "utf8")).toBe("not the spec\n");
    expect(readFileSync(join(outside, "nodes", "node_2.md"), "utf8")).toBe("not the spec\n");
    expect(readdirSync(join(outside, "nodes")).sort()).toEqual(["node_1.md", "node_2.md"]);
    expect(existsSync(join(outside, "nodes", "deep"))).toBe(false);
  }, RUN_TIMEOUT_MS);

  it("refuses a recorded path the worktree has as a directory, writing none of the record", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const files = writeSpec(repo.dir);
    // The branch carries a directory where the record names a file. The
    // checkout holds the file, so the bytes and the hash are in order.
    const recorded = join(repo.dir, "specs", "activation-email", "nodes", "node_1.md");
    rmSync(recorded, { force: true });
    mkdirSync(recorded, { recursive: true });
    writeFileSync(join(recorded, "inner.md"), "# Not the node\n");
    repo.git("add", "-A");
    repo.git("commit", "-m", "a directory where a spec file goes");
    contract.base.base_commit = repo.git("rev-parse", "HEAD").trim();
    rmSync(recorded, { recursive: true, force: true });
    writeFileSync(recorded, NODE_1);

    const agent = agentDouble(writeFeature);
    const refused = await runTicket({
      config: makeConfig(repo.dir, files, { base_ref: "main" }),
      contract,
      hooks: { agent: agent.run as never, review: approving().review },
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RunRefusedError);
    expect((refused as Error).message).toContain("specs/activation-email/nodes/node_1.md");
    expect(agent.worktrees).toEqual([]);
  }, RUN_TIMEOUT_MS);

  it("refuses a recorded path that is not a file inside the repository, before anything is read", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const files = [
      ...writeSpec(repo.dir),
      // A record written by hand, or carried over from another checkout.
      { path: "/etc/passwd", content_sha256: hash("nothing\n") },
    ];
    const agent = agentDouble(writeFeature);
    const refused = await runTicket({
      config: makeConfig(repo.dir, files),
      contract,
      hooks: { agent: agent.run as never, review: approving().review },
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RunRefusedError);
    expect((refused as Error).message).toContain("not a file inside the repository");
    expect(agent.worktrees).toEqual([]);
  }, RUN_TIMEOUT_MS);

  it("refuses a recorded file the checkout reads from outside itself", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const files = writeSpec(repo.dir);
    // The bytes are read at a repository-relative path whose folder is a link
    // out of the checkout, so the hash matches and the content is a file the
    // repository does not hold. What is committed is what was read.
    const outside = scratch("perbo-spec-source-");
    mkdirSync(join(outside, "nodes"), { recursive: true });
    for (const [name, body] of [["node_1.md", NODE_1], ["node_2.md", NODE_2]] as const)
      writeFileSync(join(outside, "nodes", name), body);
    rmSync(join(repo.dir, "specs", "activation-email", "nodes"), { recursive: true, force: true });
    symlinkSync(join(outside, "nodes"), join(repo.dir, "specs", "activation-email", "nodes"));

    const agent = agentDouble(writeFeature);
    await expect(
      runTicket({
        config: makeConfig(repo.dir, files),
        contract,
        hooks: { agent: agent.run as never, review: approving().review },
      }),
    ).rejects.toThrow(RunRefusedError);
    expect(agent.worktrees).toHaveLength(0);
  }, RUN_TIMEOUT_MS);

  it("refuses a recorded file that the branch carries as a link, writing nothing through it", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const files = writeSpec(repo.dir);
    // The recorded path is a link on the branch, so the worktree materializes
    // one and a write through it lands on whatever it points at. The primary
    // checkout holds the recorded bytes as a file, which is what the hash is
    // checked against: what has to be judged is the path being written.
    const outside = scratch("perbo-spec-linked-");
    const target = join(outside, "node_1.md");
    writeFileSync(target, "not the spec\n");
    const recorded = join(repo.dir, "specs", "activation-email", "nodes", "node_1.md");
    rmSync(recorded, { force: true });
    symlinkSync(target, recorded);
    repo.git("add", "-A");
    repo.git("commit", "-m", "a spec file that is a link");
    contract.base.base_commit = repo.git("rev-parse", "HEAD").trim();
    rmSync(recorded, { force: true });
    writeFileSync(recorded, NODE_1);

    const agent = agentDouble(writeFeature);
    const refused = await runTicket({
      config: makeConfig(repo.dir, files, { base_ref: "main" }),
      contract,
      hooks: { agent: agent.run as never, review: approving().review },
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RunRefusedError);
    expect(agent.worktrees).toHaveLength(0);
    expect((refused as Error).message).toContain("carries it as a link to");
    expect(readFileSync(target, "utf8")).toBe("not the spec\n");
  }, RUN_TIMEOUT_MS);

  it("refuses the run, naming the file, when a recorded file's content has changed, and no executor runs", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const files = writeSpec(repo.dir);
    writeFileSync(
      join(repo.dir, "specs", "activation-email", "nodes", "node_2.md"),
      "# Retry a failed send\n\nEdited after admission.\n",
    );
    const config = makeConfig(repo.dir, files);
    const agent = agentDouble(writeFeature);

    await expect(
      runTicket({ config, contract, hooks: { agent: agent.run as never, review: approving().review } }),
    ).rejects.toThrow(/specs\/activation-email\/nodes\/node_2\.md/);
    expect(agent.worktrees).toEqual([]);
  }, RUN_TIMEOUT_MS);

  it("refuses a recorded file the checkout no longer has", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const files = [
      ...writeSpec(repo.dir),
      { path: "specs/activation-email/nodes/node_9.md", content_sha256: hash("missing\n") },
    ];
    const agent = agentDouble(writeFeature);
    const refused = await runTicket({
      config: makeConfig(repo.dir, files),
      contract,
      hooks: { agent: agent.run as never, review: approving().review },
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RunRefusedError);
    expect((refused as Error).message).toContain("specs/activation-email/nodes/node_9.md");
    expect(agent.worktrees).toEqual([]);
  }, RUN_TIMEOUT_MS);

  it("makes no commit where the base already holds the spec, and still keeps it out", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    const files = writeSpec(repo.dir);
    // The spec is already on the base: the interview wrote it and somebody
    // committed it before the ticket ran.
    repo.git("add", "-A");
    repo.git("commit", "-m", "the spec, before the loop");
    contract.base.base_commit = repo.git("rev-parse", "HEAD").trim();

    const reviewer = approving();
    const said: string[] = [];
    const result = await runTicket({
      config: makeConfig(repo.dir, files, { base_ref: "main" }),
      contract,
      hooks: { agent: agentDouble(writeFeature).run as never, review: reviewer.review },
      onProgress: (message) => said.push(message),
    });

    expect(result.outcome).toBe("approved");
    // Nothing to add, so nothing is committed and the attempt names no spec
    // commit — and the files stay out of the change set all the same, because
    // the base holds what a commit would have added.
    expect(result.rounds[0]!.attempt.spec_commit).toBeNull();
    expect(said.some((line) => line.includes("already holds"))).toBe(true);
    for (const changeset of reviewer.changesets)
      for (const file of changeset.files)
        expect(files.map((each) => each.path)).not.toContain(file.path);
  }, RUN_TIMEOUT_MS);

  it("is the executor's own seal for a ticket admitted without a spec", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const result = await runTicket({
      config: makeConfig(repo.dir, []),
      contract,
      hooks: { agent: agentDouble(writeFeature).run as never, review: approving().review },
    });
    expect(result.outcome).toBe("approved");
    const commits = branchCommits(repo.dir, repo.head, result.workspace.branch);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.paths).toEqual(["src/feature.ts"]);
    expect(result.rounds[0]!.attempt.spec_commit).toBeNull();
  }, RUN_TIMEOUT_MS);
});

describe("the reviewed diff", () => {
  it("lists no spec file while the branch's own range does, and the pull request carries the commit", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const files = writeSpec(repo.dir);
    const config = makeConfig(repo.dir, files, { publish: true });
    const reviewer = approving();
    const opened: string[] = [];
    process.env.GH_TOKEN = "test-token";

    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agentDouble(writeFeature).run as never,
        review: reviewer.review,
        push: (async () => ({ pushed: true, detail: "test" })) as never,
        open: (async (request: { branch: string }) => {
          opened.push(request.branch);
          return { url: "https://example.invalid/pull/1", number: 1 };
        }) as never,
        merge: (async () => ({
          merged: false,
          stop: { rule_id: "merge.switch_is_person", statement: "s" },
          head_sha: null,
          detail: "person",
        })) as never,
      },
    });
    expect(result.outcome).toBe("approved");

    const specPaths = files.map((file) => file.path);
    expect(reviewer.changesets).toHaveLength(1);
    const reviewed = reviewer.changesets[0]!.files.map((file) => file.path);
    expect(reviewed).toEqual(["src/feature.ts"]);
    for (const path of specPaths) expect(reviewed).not.toContain(path);
    // The worktree's own range, read while the review was running: the spec is
    // on the branch, and the change set the reviewer was handed leaves it out.
    for (const path of specPaths) expect(reviewer.ranges[0]).toContain(path);

    expect(opened).toEqual([result.workspace.branch]);
    const commits = branchCommits(repo.dir, repo.head, result.workspace.branch);
    expect(commits[0]!.paths).toEqual(specPaths.sort());
  }, RUN_TIMEOUT_MS);
});

describe("a later round", () => {
  it("keeps the spec commit first and the exclusion in force through a remediation round", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const files = writeSpec(repo.dir);
    const config = makeConfig(repo.dir, files);

    let reviews = 0;
    const verified: ChangeSet[] = [];
    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agentDouble((worktree, round) => {
          if (round === 0) writeFeature(worktree);
          else {
            mkdirSync(join(worktree, "test"), { recursive: true });
            writeFileSync(join(worktree, "test", "feature.test.ts"), "// exercises total()\n");
          }
        }).run as never,
        review: (async (input: { changeset?: ChangeSet }) => {
          reviews += 1;
          return {
            artifact: makeReview({
              review_id: "rev_0000000000000001",
              decision: "remediable" as const,
              changeset_id: input.changeset?.changeset_id ?? "cs_0000000000000001",
              findings: [finding()],
            }),
            bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
          };
        }) as never,
        verify: (async (input: { findings: Array<{ key: string }>; changeset: ChangeSet }) => {
          verified.push(input.changeset);
          return {
            prompt_version: "closure_verify_v1",
            per_finding: input.findings.map((entry) => ({
              finding_key: entry.key,
              status: "closed",
              pointer: "test/feature.test.ts",
            })),
            deterministic_failure: null,
            all_closed: true,
            open_keys: [],
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            cost_micros: 30,
            cost_basis: "provider_list_estimate",
          };
        }) as never,
      },
    });

    expect(result.outcome).toBe("approved");
    expect(reviews).toBe(1);
    expect(verified).toHaveLength(1);
    // And no round counts the spec commit among the ones it inherited: the
    // loop made it during this run, so a pull request naming it as sealed
    // before the attempt would be naming its own work as somebody else's.
    const spec = result.rounds[0]!.attempt.spec_commit;
    expect(spec).not.toBeNull();
    for (const round of result.rounds)
      expect(round.attempt.prior_commits.map((commit) => commit.sha)).not.toContain(spec);
    // The round after the review reads the same one change set, still without
    // the spec in it.
    expect(verified[0]!.files.map((file) => file.path).sort()).toEqual([
      "src/feature.ts",
      "test/feature.test.ts",
    ]);
    const commits = branchCommits(repo.dir, repo.head, result.workspace.branch);
    expect(commits[0]!.paths).toEqual(files.map((file) => file.path).sort());
    expect(commits[0]!.sha).toBe(result.rounds[1]!.attempt.spec_commit);
  }, RUN_TIMEOUT_MS);
});

const originalPath = process.env.PATH;
const originalToken = process.env.GH_TOKEN;
afterEach(() => {
  process.env.PATH = originalPath;
  if (originalToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = originalToken;
});

/** A `gh` that answers nothing, for the checks read after a push. */
function silentGh(): string {
  const root = scratch("perbo-spec-commit-gh-");
  const script = join(root, "gh");
  writeFileSync(script, ["#!/bin/sh", "exit 1", ""].join("\n"));
  chmodSync(script, 0o755);
  return root;
}

describe("a re-level", () => {
  it("does not mistake the spec commit for a person's, and keeps it first", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const files = writeSpec(repo.dir);
    const config = makeConfig(repo.dir, files, { publish: true });
    process.env.PATH = `${silentGh()}:${originalPath ?? ""}`;
    process.env.GH_TOKEN = "test-token";
    const github = {
      push: (async () => ({ pushed: true, detail: "test" })) as never,
      open: (async () => ({ url: "https://example.invalid/pull/1", number: 1 })) as never,
      existing: (async () => ({ url: "https://example.invalid/pull/1", number: 1 })) as never,
      merge: (async () => ({
        merged: false,
        stop: { rule_id: "merge.switch_is_person", statement: "s" },
        head_sha: null,
        detail: "person",
      })) as never,
    };

    const first = await runTicket({
      config,
      contract,
      hooks: { agent: agentDouble(writeFeature).run as never, review: approving().review, ...github },
    });
    expect(first.outcome).toBe("approved");

    // The base moves inside the contract's scope, so the re-level reviews the
    // merged change set afresh rather than carrying the first review.
    writeFileSync(join(repo.dir, "src", "other.ts"), "export const other = 2;\n");
    repo.git("add", "-A");
    repo.git("commit", "-qm", "main moves");

    const reviewer = approving();
    const relevelled = await runTicket({
      config: TicketRunConfigSchema.parse({ ...config, relevel: true }),
      contract,
      hooks: {
        agent: (async () => {
          throw new Error("a re-level with nothing to resolve must not run an executor");
        }) as never,
        review: reviewer.review,
        ...github,
      },
    });
    expect(relevelled.outcome).toBe("relevelled");
    for (const changeset of reviewer.changesets) {
      for (const file of changeset.files) expect(files.map((each) => each.path)).not.toContain(file.path);
    }
    const commits = branchCommits(repo.dir, repo.head, first.workspace.branch);
    expect(commits[0]!.paths).toEqual(files.map((file) => file.path).sort());
  }, RUN_TIMEOUT_MS);

  it("counts the spec commit as the loop's own when it reads the branch against the pull request", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const files = writeSpec(repo.dir);
    const config = makeConfig(repo.dir, files, { publish: true });
    process.env.PATH = `${silentGh()}:${originalPath ?? ""}`;
    process.env.GH_TOKEN = "test-token";
    const github = {
      push: (async () => ({ pushed: true, detail: "test" })) as never,
      open: (async () => ({ url: "https://example.invalid/pull/1", number: 1 })) as never,
      existing: (async () => ({ url: "https://example.invalid/pull/1", number: 1 })) as never,
      merge: (async () => ({
        merged: false,
        stop: { rule_id: "merge.switch_is_person", statement: "s" },
        head_sha: null,
        detail: "person",
      })) as never,
    };
    const first = await runTicket({
      config,
      contract,
      hooks: { agent: agentDouble(writeFeature).run as never, review: approving().review, ...github },
    });
    expect(first.outcome).toBe("approved");

    // SCP-227: what the pull request has is the branch before the loop
    // committed anything, so everything past it — the spec commit and the
    // seal — has to read as the loop's own. A spec commit taken for a
    // person's would refuse the re-level and name it.
    repo.git("update-ref", `refs/remotes/origin/${first.workspace.branch}`, repo.head);
    writeFileSync(join(repo.dir, "notes.md"), "unrelated\n");
    repo.git("add", "-A");
    repo.git("commit", "-qm", "main moves outside the scope");

    const outcome = await runTicket({
      config: TicketRunConfigSchema.parse({ ...config, relevel: true }),
      contract,
      hooks: {
        agent: (async () => {
          throw new Error("a re-level with nothing to resolve must not run an executor");
        }) as never,
        review: approving().review,
        ...github,
      },
    }).catch((error: unknown) => error);
    expect(outcome).not.toBeInstanceOf(RunRefusedError);
    expect((outcome as { outcome: string }).outcome).toBe("relevelled");
  }, RUN_TIMEOUT_MS);
});

describe("a branch that already has commits", () => {
  it("keeps nothing out of the change set for a branch built before the loop committed specs", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const files = writeSpec(repo.dir);
    const first = await runTicket({
      config: makeConfig(repo.dir, files),
      contract,
      hooks: { agent: agentDouble(writeFeature).run as never, review: approving().review },
    });
    expect(first.outcome).toBe("approved");

    // The branch a ticket admitted before the loop committed specs carries: a
    // person's commit first, one of whose files the spec's record also names.
    repo.git("update-ref", `refs/heads/${first.workspace.branch}`, repo.head);
    const byHand = join(repo.dir, ".perbo-before-specs");
    mkdirSync(byHand, { recursive: true });
    repo.git("worktree", "add", "-q", byHand, first.workspace.branch);
    writeFileSync(join(byHand, "CONTEXT.md"), "# Terms\n\nAn activation email is the address.\n");
    writeFileSync(join(byHand, "src", "feature.ts"), "export const total = (n) => n.length;\n");
    git(byHand, "add", "-A");
    git(byHand, "commit", "-qm", "by hand, before the loop committed specs");
    repo.git("worktree", "remove", "--force", byHand);

    // A store of its own, so no attempts record names a spec commit for it.
    const reviewer = approving();
    const agent = agentDouble(writeFeature);
    const said: string[] = [];
    const second = await runTicket({
      config: makeConfig(repo.dir, files),
      contract,
      hooks: { agent: agent.run as never, review: reviewer.review },
      onProgress: (message) => said.push(message),
    });
    expect(second.outcome).toBe("approved");
    expect(second.workspace.branch).toBe(first.workspace.branch);
    expect(said.some((line) => line.includes("no run recorded a spec commit for it"))).toBe(true);
    // The spec's files stay out of the change set: the branch holds the
    // person's CONTEXT.md, which is outside the contract's globs, and reading
    // it as work would report a write no executor made.
    expect(reviewer.changesets[0]!.files.map((file) => file.path)).not.toContain("CONTEXT.md");
  }, RUN_TIMEOUT_MS);

  it("refuses a rebuilt branch whose first commit touches only the spec's own files", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const files = writeSpec(repo.dir);
    const config = makeConfig(repo.dir, files);
    const first = await runTicket({
      config,
      contract,
      hooks: { agent: agentDouble(writeFeature).run as never, review: approving().review },
    });
    expect(first.outcome).toBe("approved");

    // A person rebuilds the branch and writes the spec themselves. It changes
    // recorded files and nothing else, which is the shape of the loop's own
    // commit, and it holds whatever they wrote.
    repo.git("update-ref", `refs/heads/${first.workspace.branch}`, repo.head);
    const byHand = join(repo.dir, ".perbo-hand-spec");
    mkdirSync(byHand, { recursive: true });
    repo.git("worktree", "add", "-q", byHand, first.workspace.branch);
    mkdirSync(join(byHand, "specs", "activation-email"), { recursive: true });
    writeFileSync(join(byHand, "specs", "activation-email", "spec.md"), "# Something else\n");
    git(byHand, "add", "-A");
    git(byHand, "commit", "-qm", "the spec, by hand");
    repo.git("worktree", "remove", "--force", byHand);

    const agent = agentDouble(writeFeature);
    const refused = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: approving().review },
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RunRefusedError);
    expect((refused as Error).message).toContain("the spec, by hand");
    expect(agent.worktrees).toEqual([]);
  }, RUN_TIMEOUT_MS);

  it("refuses the run, naming what it found, when its first commit is not the spec", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const files = writeSpec(repo.dir);
    const config = makeConfig(repo.dir, files);
    const first = await runTicket({
      config,
      contract,
      hooks: { agent: agentDouble(writeFeature).run as never, review: approving().review },
    });
    expect(first.outcome).toBe("approved");

    // A person rebuilds the branch by hand and leaves their own commit where
    // the spec's was.
    repo.git("update-ref", `refs/heads/${first.workspace.branch}`, repo.head);
    const byHand = join(repo.dir, ".perbo-hand");
    mkdirSync(byHand, { recursive: true });
    repo.git("worktree", "add", "-q", byHand, first.workspace.branch);
    writeFileSync(join(byHand, "src", "feature.ts"), "export const total = (n) => n.length + 1;\n");
    git(byHand, "add", "-A");
    // With the loop's own trailer on it, so what refuses this commit is what it
    // changes rather than who made it.
    git(byHand, "commit", "-qm", "by hand\n\nAttempt: att_by_hand\n");
    repo.git("worktree", "remove", "--force", byHand);

    const agent = agentDouble(writeFeature);
    const refused = await runTicket({
      config,
      contract,
      hooks: { agent: agent.run as never, review: approving().review },
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RunRefusedError);
    expect((refused as Error).message).toContain("by hand");
    expect((refused as Error).message).toContain("src/feature.ts");
    expect(agent.worktrees).toEqual([]);
  }, RUN_TIMEOUT_MS);
});
