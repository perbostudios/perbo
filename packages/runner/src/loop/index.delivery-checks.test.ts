import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveredCheckSchema, LimitsTableSchema, type ChangeSet } from "@perbo/contracts";
import { scratchDirectories } from "@perbo/test-support";
import type { AgentResult } from "../adapter.js";
import { EgressLog } from "../egress.js";
import { TicketRunConfigSchema, runTicket } from "./index.js";
import { makeContract, makeReview, withoutInstall } from "../test-support/records.js";
import { runnerRepository } from "../test-support/repository.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * The loop reads the checks on the head it pushed before it records a delivery.
 *
 * A run opens its pull request from a worktree holding the whole history and a
 * clean install. CI runs the same change on a shallow checkout of a fresh
 * machine, and a check that fails only there was invisible to the gate that
 * opened the pull request: the run said the change was approved, and the head's
 * build check went red minutes later with nothing on the record about it.
 *
 * So the run waits for the conclusions, records them, edits the body to say
 * them, and names the failing check on its own outcome line. It fixes nothing:
 * a red check is a fact about the head, and the review's judgement of the
 * change is a different fact.
 *
 * `gh` is faked on PATH and answers the rollup; the push and the pull-request
 * creation are hooked, because there is no remote here. The read, the bound,
 * the record and the body edit are the shipped ones.
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

const writeFeature = (worktree: string) => {
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(join(worktree, "src", "feature.ts"), "export const total = (n) => n.length;\n");
};

const publishing = {
  push: (async () => ({ pushed: true, detail: "test" })) as never,
  open: (async () => ({ url: "https://example.invalid/pull/9", number: 9 })) as never,
};

function makeConfig(repositoryRoot: string, over: Record<string, unknown> = {}) {
  const root = scratch("perbo-delivery-checks-");
  return TicketRunConfigSchema.parse({
    materialization_manifest: withoutInstall(repositoryRoot),
    ticket_key: "CHECKS",
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

/** One check as `gh pr view --json statusCheckRollup` reports a check run. */
const checkRun = (name: string, conclusion: string | null) => ({
  __typename: "CheckRun",
  name,
  status: conclusion === null ? "IN_PROGRESS" : "COMPLETED",
  ...(conclusion === null ? {} : { conclusion }),
});

/**
 * A check run still running, as `gh` actually reports one: the conclusion is
 * there and empty rather than absent (SCP-277).
 */
const runningCheckRun = (name: string) => ({
  __typename: "CheckRun",
  name,
  status: "IN_PROGRESS",
  conclusion: "",
});

/** A legacy status context, which carries `state` alone and no `status`. */
const statusContext = (context: string, state: string) => ({
  __typename: "StatusContext",
  context,
  state,
});

/**
 * A `gh` on PATH that answers `pr view --json statusCheckRollup` from a file
 * the test writes, accepts `pr edit --body`, and refuses everything else.
 *
 * The rollup is re-read on every call, so a test can let the head settle
 * between two polls; the body and the argv of every call are kept where the
 * test can read them.
 */
function fakeGh(name: string, rollup: unknown[]): {
  bin: string;
  answer: (next: unknown[]) => void;
  calls: () => string[][];
  body: () => string | null;
} {
  const root = scratch(`perbo-delivery-checks-gh-${name}-`);
  const rollupPath = join(root, "rollup.json");
  const logPath = join(root, "calls.jsonl");
  const bodyPath = join(root, "body.md");
  const script = join(root, "gh");
  writeFileSync(rollupPath, JSON.stringify({ statusCheckRollup: rollup }));
  writeFileSync(logPath, "");
  writeFileSync(
    script,
    `#!/usr/bin/env node
"use strict";
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(argv) + "\\n");
if (argv[0] === "pr" && argv[1] === "view" && argv.includes("statusCheckRollup")) {
  process.stdout.write(readFileSync(${JSON.stringify(rollupPath)}, "utf8"));
  process.exit(0);
}
if (argv[0] === "pr" && argv[1] === "edit") {
  writeFileSync(${JSON.stringify(bodyPath)}, argv[argv.indexOf("--body") + 1] ?? "");
  process.exit(0);
}
process.stderr.write("gh: not answered\\n");
process.exit(1);
`,
  );
  chmodSync(script, 0o755);
  return {
    bin: root,
    answer: (next: unknown[]) => writeFileSync(rollupPath, JSON.stringify({ statusCheckRollup: next })),
    calls: () =>
      readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    body: () => {
      try {
        return readFileSync(bodyPath, "utf8");
      } catch {
        return null;
      }
    },
  };
}

const originalPath = process.env.PATH;
const originalToken = process.env.GH_TOKEN;
afterEach(() => {
  process.env.PATH = originalPath;
  if (originalToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = originalToken;
});

/** A clock the run drives through its own waits, so the bound is observed. */
function drivenClock(from = Date.parse("2026-09-07T00:00:00.000Z")) {
  let at = from;
  const waited: number[] = [];
  return {
    now: () => new Date(at),
    sleep: async (ms: number) => {
      waited.push(ms);
      at += ms;
    },
    waited: () => waited,
    elapsed: () => at - from,
  };
}

/** A full run of the loop against a real repository, under a loaded machine. */
const RUN_TIMEOUT_MS = 60_000;

const viewsOfTheRollup = (calls: string[][]): string[][] =>
  calls.filter((argv) => argv[0] === "pr" && argv[1] === "view" && argv.includes("statusCheckRollup"));

describe("the checks on the head the loop published", () => {
  it("records a failing check with its conclusion, and the delivery is not green", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    const gh = fakeGh("failing", [checkRun("build", "FAILURE"), checkRun("lint", "SUCCESS")]);
    process.env.PATH = `${gh.bin}:${originalPath ?? ""}`;
    process.env.GH_TOKEN = "test-token";
    const clock = drivenClock();

    const result = await runTicket({
      config,
      contract,
      now: clock.now,
      sleep: clock.sleep,
      hooks: { agent: agentDouble(writeFeature).run as never, review: approving, ...publishing },
    });

    expect(result.pull_request).not.toBeNull();
    // The change was approved and a check on its head went red: two facts, and
    // the run keeps both.
    expect(result.outcome).toBe("approved");
    expect(result.delivery_checks?.state).toBe("checks_failed");
    expect(result.delivery_checks?.state).not.toBe("green");
    expect(result.delivery_checks?.checks).toEqual([
      { name: "build", conclusion: "failure" },
      { name: "lint", conclusion: "success" },
    ]);
    // Which check, and what it concluded, on the line a person reads.
    expect(result.detail).toContain("build (failure)");
    // And it was read: the gate did not take the pull request's word for it.
    expect(viewsOfTheRollup(gh.calls())).not.toHaveLength(0);
  }, RUN_TIMEOUT_MS);

  it("records the conclusions of a head whose checks are green", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    const gh = fakeGh("green", [checkRun("build", "SUCCESS"), checkRun("lint", "SKIPPED")]);
    process.env.PATH = `${gh.bin}:${originalPath ?? ""}`;
    process.env.GH_TOKEN = "test-token";
    const clock = drivenClock();

    const result = await runTicket({
      config,
      contract,
      now: clock.now,
      sleep: clock.sleep,
      hooks: { agent: agentDouble(writeFeature).run as never, review: approving, ...publishing },
    });

    expect(result.outcome).toBe("approved");
    expect(result.delivery_checks?.state).toBe("green");
    expect(result.delivery_checks?.checks).toEqual([
      { name: "build", conclusion: "success" },
      { name: "lint", conclusion: "skipped" },
    ]);
    // Everything concluded on the first read, so nothing was waited out.
    expect(result.delivery_checks?.bounded).toBe(false);
    expect(clock.waited()).toEqual([]);
    expect(result.detail).not.toContain("checks failed");
  }, RUN_TIMEOUT_MS);

  it("records a head with no check runs by the bound as unchecked, and the bound counts in the run's clock", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    // A minute, spent in the run's own clock rather than in a timer's.
    const config = makeConfig(repo.dir, { delivery_checks_bound_ms: 60_000 });
    const gh = fakeGh("unchecked", []);
    process.env.PATH = `${gh.bin}:${originalPath ?? ""}`;
    process.env.GH_TOKEN = "test-token";
    const clock = drivenClock();

    const result = await runTicket({
      config,
      contract,
      now: clock.now,
      sleep: clock.sleep,
      hooks: { agent: agentDouble(writeFeature).run as never, review: approving, ...publishing },
    });

    expect(result.outcome).toBe("approved");
    // Not a pass: a head nothing has reported on is not one whose checks went
    // green, and the record says which of the two it is.
    expect(result.delivery_checks?.state).toBe("unchecked");
    expect(result.delivery_checks?.checks).toEqual([]);
    expect(result.delivery_checks?.bounded).toBe(true);
    // The bound is what ended it: the run waited its whole length and stopped.
    expect(result.delivery_checks?.waited_ms).toBe(60_000);
    expect(clock.elapsed()).toBeGreaterThanOrEqual(60_000);
    expect(clock.waited().reduce((total, ms) => total + ms, 0)).toBe(60_000);
    // And it stopped: a bound that was ignored would read the rollup forever.
    expect(viewsOfTheRollup(gh.calls()).length).toBeLessThanOrEqual(6);
  }, RUN_TIMEOUT_MS);

  it("waits out a check that has not concluded, and records it once it has", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir, { delivery_checks_bound_ms: 600_000 });
    const gh = fakeGh("settling", [checkRun("build", null)]);
    process.env.PATH = `${gh.bin}:${originalPath ?? ""}`;
    process.env.GH_TOKEN = "test-token";
    const clock = drivenClock();

    const result = await runTicket({
      config,
      contract,
      now: clock.now,
      // The check concludes while the run is waiting, which is what a real one
      // does: the rollup a poll reads is not the rollup the last poll read.
      sleep: async (ms: number) => {
        await clock.sleep(ms);
        gh.answer([checkRun("build", "FAILURE")]);
      },
      hooks: { agent: agentDouble(writeFeature).run as never, review: approving, ...publishing },
    });

    expect(result.delivery_checks?.state).toBe("checks_failed");
    expect(result.delivery_checks?.checks).toEqual([{ name: "build", conclusion: "failure" }]);
    // It concluded before the bound, so the bound is not what ended the read.
    expect(result.delivery_checks?.bounded).toBe(false);
    expect(clock.elapsed()).toBeLessThan(600_000);
  }, RUN_TIMEOUT_MS);

  it("states the checks it read in the pull request's body, below what was already there", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    const gh = fakeGh("body", [checkRun("build", "FAILURE"), checkRun("lint", "SUCCESS")]);
    process.env.PATH = `${gh.bin}:${originalPath ?? ""}`;
    process.env.GH_TOKEN = "test-token";
    const clock = drivenClock();

    await runTicket({
      config,
      contract,
      now: clock.now,
      sleep: clock.sleep,
      hooks: { agent: agentDouble(writeFeature).run as never, review: approving, ...publishing },
    });

    const body = gh.body();
    expect(body).not.toBeNull();
    // One line per check, with what it concluded.
    expect(body).toContain("- `build` — failure");
    expect(body).toContain("- `lint` — success");
    expect(body).toContain("checks_failed");
    // Below the sections the body already had, which are not rewritten.
    const written = body!;
    expect(written).toContain("## Acceptance criteria");
    expect(written).toContain("## Review");
    expect(written.indexOf("## Checks on the head")).toBeGreaterThan(written.indexOf("## Review"));
  }, RUN_TIMEOUT_MS);

  it("reads a check run still in progress as pending, and records it unchecked at the bound", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir, { delivery_checks_bound_ms: 60_000 });
    // `gh` reports the conclusion of a running check as an empty string, which
    // is not a conclusion: the head has not failed, it has not finished.
    const gh = fakeGh("in-progress", [runningCheckRun("validate"), checkRun("build", "SUCCESS")]);
    process.env.PATH = `${gh.bin}:${originalPath ?? ""}`;
    process.env.GH_TOKEN = "test-token";
    const clock = drivenClock();

    const result = await runTicket({
      config,
      contract,
      now: clock.now,
      sleep: clock.sleep,
      hooks: { agent: agentDouble(writeFeature).run as never, review: approving, ...publishing },
    });

    expect(result.outcome).toBe("approved");
    // Not `checks_failed`: nothing on this head concluded red.
    expect(result.delivery_checks?.state).toBe("unchecked");
    expect(result.delivery_checks?.checks).toEqual([
      { name: "validate", conclusion: "unchecked" },
      { name: "build", conclusion: "success" },
    ]);
    // It was still running, so the poll kept waiting and the bound ended it.
    expect(result.delivery_checks?.bounded).toBe(true);
    expect(result.delivery_checks?.waited_ms).toBe(60_000);
    expect(viewsOfTheRollup(gh.calls()).length).toBeGreaterThan(1);
    // And every conclusion the read returns is one the record accepts.
    expect(() => DeliveredCheckSchema.array().parse(result.delivery_checks?.checks)).not.toThrow();
    expect(result.detail).not.toContain("the head's checks failed");
  }, RUN_TIMEOUT_MS);

  it("reads a rollup whose every entry has completed on the first poll", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir);
    const gh = fakeGh("completed", [
      checkRun("build", "FAILURE"),
      checkRun("lint", "SUCCESS"),
      statusContext("ci/legacy", "SUCCESS"),
    ]);
    process.env.PATH = `${gh.bin}:${originalPath ?? ""}`;
    process.env.GH_TOKEN = "test-token";
    const clock = drivenClock();

    const result = await runTicket({
      config,
      contract,
      now: clock.now,
      sleep: clock.sleep,
      hooks: { agent: agentDouble(writeFeature).run as never, review: approving, ...publishing },
    });

    expect(result.delivery_checks?.checks).toEqual([
      { name: "build", conclusion: "failure" },
      { name: "lint", conclusion: "success" },
      { name: "ci/legacy", conclusion: "success" },
    ]);
    expect(result.delivery_checks?.state).toBe("checks_failed");
    // Everything had concluded, so nothing was waited out.
    expect(result.delivery_checks?.bounded).toBe(false);
    expect(clock.waited()).toEqual([]);
  }, RUN_TIMEOUT_MS);

  it("reads a legacy status context still pending as pending", async () => {
    const repo = runnerRepository(scratch);
    const contract = makeContract();
    contract.base.base_commit = repo.head;
    const config = makeConfig(repo.dir, { delivery_checks_bound_ms: 60_000 });
    const gh = fakeGh("pending-context", [statusContext("ci/legacy", "PENDING")]);
    process.env.PATH = `${gh.bin}:${originalPath ?? ""}`;
    process.env.GH_TOKEN = "test-token";
    const clock = drivenClock();

    const result = await runTicket({
      config,
      contract,
      now: clock.now,
      sleep: clock.sleep,
      hooks: { agent: agentDouble(writeFeature).run as never, review: approving, ...publishing },
    });

    // `PENDING` is the state of a context that has not run yet, not a verdict.
    expect(result.delivery_checks?.state).toBe("unchecked");
    expect(result.delivery_checks?.checks).toEqual([{ name: "ci/legacy", conclusion: "unchecked" }]);
    expect(result.delivery_checks?.bounded).toBe(true);
    expect(result.detail).not.toContain("the head's checks failed");
  }, RUN_TIMEOUT_MS);
});
