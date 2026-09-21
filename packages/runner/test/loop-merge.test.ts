import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LimitsTableSchema, type ChangeSet } from "@perbo/contracts";
import type { AgentResult } from "../src/adapter.js";
import { EgressLog } from "../src/egress.js";
import { TicketRunConfigSchema, runTicket } from "../src/loop.js";
import type { LoopMergeOutcome } from "../src/merge.js";
import { makeContract, makeReview, withoutInstall } from "../src/test-support/records.js";
import { runnerRepository } from "../src/test-support/repository.js";
import { scratch } from "./support.js";

/**
 * SCP-202: the loop's own post-approval merge step.
 *
 * The run ends `approved` with a pull request open, and what happens next is
 * the `merge` switch's to decide. The step is the same one `perbo sync
 * --merge` calls, so what is proven here is where the loop calls it and what
 * it does with the answer; the six conditions themselves are proven against a
 * fake `gh` in `apps/cli/src/commands/sync.merge.test.ts`.
 */

const agentDouble = (write: (worktree: string) => void) => {
  const run = async (request: {
    worktree: string;
    prompt: string;
    profile: { network_allow_list: readonly string[] };
  }): Promise<AgentResult> => {
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
  return { run };
};

const approving = (async (input: { changeset?: ChangeSet }) => ({
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
})) as never;

function makeConfig(repositoryRoot: string, over: Record<string, unknown> = {}) {
  const root = scratch("perbo-loopmerge-");
  return TicketRunConfigSchema.parse({
    materialization_manifest: withoutInstall(repositoryRoot),
    ticket_key: "SCP202",
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
    limits: LimitsTableSchema.parse({
      organisation: "test",
      limits: { concurrent_local_attempts: 4 },
    }),
    ...over,
  });
}

const writeFeature = (worktree: string) => {
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(join(worktree, "src", "feature.ts"), "export const total = (n) => n.length;\n");
};

const publishing = {
  push: (async () => ({ pushed: true, detail: "test" })) as never,
  open: (async () => ({ url: "https://example.invalid/pull/1", number: 1 })) as never,
};

/**
 * A `gh` on PATH that records every argv it was given and fails.
 *
 * No merge in these two cases may reach it: the `person` case decides on the
 * switch before any read, and the `loop` case replaces the step itself. The
 * run does read the head's checks through `gh` after the merge step, which is
 * what `merged()` is narrower than "was it called at all" for.
 */
function refusingGh(name: string): { bin: string; merged: () => boolean } {
  const root = scratch(`perbo-loopmerge-gh-${name}-`);
  const log = join(root, "argv");
  const script = join(root, "gh");
  writeFileSync(
    script,
    ["#!/bin/sh", `echo "$@" >> ${log}`, 'echo "gh: not expected" >&2', "exit 1", ""].join("\n"),
  );
  chmodSync(script, 0o755);
  return {
    bin: root,
    merged: () => existsSync(log) && /^pr merge\b/m.test(readFileSync(log, "utf8")),
  };
}

const originalPath = process.env.PATH;
const originalToken = process.env.GH_TOKEN;
afterEach(() => {
  process.env.PATH = originalPath;
  if (originalToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = originalToken;
});

/** A full run of the loop against a real repository, under a loaded machine. */
const LOOP_MERGE_TIMEOUT_MS = 60_000;

describe("the loop's post-approval merge step", () => {
  it("never merges on the default switch, and says the merge is a person's", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    // No `merge` key at all: the run configuration's own default is `person`.
    const config = makeConfig(repo.dir);
    const gh = refusingGh("person");
    process.env.PATH = `${gh.bin}:${originalPath ?? ""}`;
    process.env.GH_TOKEN = "test-token";

    const result = await runTicket({
      config,
      contract,
      hooks: { agent: agentDouble(writeFeature).run as never, review: approving, ...publishing },
    });

    expect(result.outcome).toBe("approved");
    expect(result.pull_request).not.toBeNull();
    expect(result.merge?.merged).toBe(false);
    expect(result.merge?.stop?.rule_id).toBe("merge.switch_is_person");
    // And the sentence beside it, which is the whole of what the person is
    // told: what the switch says, and that the merge is now theirs to click.
    expect(result.merge?.stop?.statement).toBe(
      'the `merge` switch is "person", so this merge is a person\'s click: the pull request is open and waiting for one',
    );
    // The switch is decided before anything is read, so no credential is spent
    // and no `gh pr merge` is spawned to be told the answer is no.
    expect(gh.merged()).toBe(false);
  }, LOOP_MERGE_TIMEOUT_MS);

  it("hands the pull request it just opened to the merge step when the switch is the loop's", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir, { merge: "loop" });
    const gh = refusingGh("loop");
    process.env.PATH = `${gh.bin}:${originalPath ?? ""}`;
    process.env.GH_TOKEN = "test-token";

    const asked: Array<Record<string, unknown>> = [];
    const outcome: LoopMergeOutcome = {
      merged: true,
      stop: null,
      head_sha: "abcdef1234567890abcdef1234567890abcdef12",
      detail: "merged by the loop",
    };
    const result = await runTicket({
      config,
      contract,
      hooks: {
        agent: agentDouble(writeFeature).run as never,
        review: approving,
        ...publishing,
        merge: (async (request: Record<string, unknown>) => {
          asked.push(request);
          return outcome;
        }) as never,
      },
    });

    expect(result.outcome).toBe("approved");
    expect(asked).toHaveLength(1);
    // Nothing a model produced reaches this request: the number comes from the
    // pull request the runner just opened, the base from the configuration,
    // and the attempt id from the attempt record.
    expect(asked[0]!["pull_request_number"]).toBe(1);
    expect(asked[0]!["base_ref"]).toBe("main");
    expect(asked[0]!["mode"]).toBe("loop");
    expect(String(asked[0]!["attempt_id"])).toMatch(/^att_/);
    expect(result.merge).toEqual(outcome);
    expect(gh.merged()).toBe(false);
  }, LOOP_MERGE_TIMEOUT_MS);
});
