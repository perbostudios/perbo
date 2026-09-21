import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENV_ALLOW_LIST,
  DEFAULT_LIMITS_TABLE,
  LimitsTableSchema,
  SecretIndex,
} from "@perbo/contracts";
import { provision } from "@perbo/workspace";
import { runAgent } from "../src/adapter.js";
import { AttemptCeilings } from "../src/ceilings.js";
import { runPinnedChecks } from "../src/checks.js";
import { buildAgentEnvironment, buildPermissionProfile } from "../src/profile.js";
import {
  prepareScratchDirectory,
  SCRATCH_DIR_NAME,
  scratchEnvironment,
  scratchPath,
} from "../src/scratch.js";
import { sealChangeSet, untrackedAfterChecks } from "../src/seal.js";
import { runnerRepository } from "../src/test-support/repository.js";
import { scratch } from "./support.js";

/**
 * The scratch directory inside the boundary (SCP-166).
 *
 * The write guard refuses anything that lands outside the attempt's worktree,
 * `/tmp` included, and a brief that says so did not stop an executor reaching
 * for `/tmp` anyway. So the runner gives it a temporary directory the boundary
 * contains: `TMPDIR` points inside the worktree, the guard resolves the
 * variable to it, and the seal never carries what is written there.
 */

async function worktreeFor(repo: { dir: string; head: string }, attempt: string) {
  return provision({
    repository_root: repo.dir,
    repository_id: "repo_fixture",
    ticket_key: "SCP166",
    ticket_id: "ticket_SCP166",
    outcome: "give the executor a scratch directory",
    base_commit: repo.head,
    attempt_id: attempt,
    root: scratch("perbo-scp166-"),
    limits: DEFAULT_LIMITS_TABLE,
  });
}

/**
 * An executor that reports the temporary directory it was handed, and whether
 * that directory was there when it started. It reads the environment rather
 * than an argument, because the environment is what is being asserted.
 */
function recordingExecutor(worktree: string, report: string): string {
  const binary = join(worktree, "recording-executor");
  writeFileSync(
    binary,
    "#!/bin/sh\n" +
      'if [ "$1" != "-p" ]; then exit 0; fi\n' +
      `printf '%s\\n' "$TMPDIR" "$TMP" "$TEMP" > "${report}"\n` +
      `if [ -d "$TMPDIR" ]; then printf 'present\\n' >> "${report}"; else printf 'absent\\n' >> "${report}"; fi\n`,
    { mode: 0o755 },
  );
  return binary;
}

/**
 * An executor that makes one Bash tool call, as the transport reports it. The
 * command never runs: the adapter judges it from the stream, which is the
 * surface that terminates an attempt.
 */
function toolCallExecutor(worktree: string, name: string, command: string): string {
  const binary = join(worktree, name);
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command } }], usage: {} },
  });
  writeFileSync(binary, `#!/bin/sh\ncat <<'JSON'\n${line}\nJSON\n`, { mode: 0o755 });
  return binary;
}

const ceilings = () =>
  new AttemptCeilings(
    LimitsTableSchema.parse({ organisation: "test", limits: { attempt_wall_clock_ms: 600_000 } }),
  );

const agentRequest = (worktree: string, binary: string, env: NodeJS.ProcessEnv) => ({
  binary,
  worktree,
  prompt: "irrelevant",
  model: "none",
  profile: buildPermissionProfile({ worktree }),
  ceilings: ceilings(),
  env,
});

describe("the temporary directory the runner hands the executor", () => {
  it("exists before the executor starts, and the three names point into the worktree", async () => {
    const repo = runnerRepository(scratch);
    const workspace = await worktreeFor(repo, "att_scratch_env");
    const report = join(scratch("perbo-scp166-report-"), "env.txt");
    const binary = recordingExecutor(workspace.path, report);

    await runAgent(
      agentRequest(workspace.path, binary, {
        // What the host would have handed down. None of it may survive.
        PATH: process.env.PATH ?? "",
        TMPDIR: "/tmp/inherited",
        TMP: "/tmp",
        TEMP: "/tmp",
      }),
    );

    const lines = readFileSync(report, "utf8").trim().split("\n");
    const expected = join(workspace.path, SCRATCH_DIR_NAME);
    expect(lines.slice(0, 3)).toEqual([expected, expected, expected]);
    expect(lines[3]).toBe("present");
  }, 60_000);

  it("is named by the runner from the worktree, never by anything a model returned", () => {
    expect(scratchPath("/w/a")).toBe(join("/w/a", ".perbo-tmp"));
  });

  it("carries the three names through the environment allow-list", () => {
    for (const name of ["TMPDIR", "TMP", "TEMP"]) {
      expect(DEFAULT_ENV_ALLOW_LIST as readonly string[]).toContain(name);
    }
  });

  it("sets all three to the runner's directory even when the host named /tmp", () => {
    const worktree = scratch("perbo-scp166-env-");
    const { env } = buildAgentEnvironment({
      base: { PATH: "/usr/bin", TMPDIR: "/tmp/host", TMP: "/tmp/host", TEMP: "/tmp/host" },
      profile: buildPermissionProfile({ worktree }),
      worktree,
      ports: { start: 1, end: 2 },
      database_schema: null,
    });
    const expected = join(worktree, SCRATCH_DIR_NAME);
    expect(env.TMPDIR).toBe(expected);
    expect(env.TMP).toBe(expected);
    expect(env.TEMP).toBe(expected);
  });
});

/**
 * The adapter is what tells the guard about the directory it made. Judging the
 * command lines directly proves the guard; only running one through `runAgent`
 * proves the runner handed the guard the scratch path at all.
 */
describe("the guard the adapter runs over the executor's commands", () => {
  it("lets a write through $TMPDIR run, and records no prohibited action", async () => {
    const repo = runnerRepository(scratch);
    const workspace = await worktreeFor(repo, "att_scratch_allowed");
    const binary = toolCallExecutor(workspace.path, "writes-to-tmpdir", "printf x > $TMPDIR/x");

    const result = await runAgent(
      agentRequest(workspace.path, binary, { PATH: process.env.PATH ?? "" }),
    );

    expect(result.prohibited).toEqual([]);
    expect(result.termination.reason).toBe("completed");
    expect(result.commands.map((command) => command.detail)).toEqual(["printf x > $TMPDIR/x"]);
  }, 60_000);

  it("still terminates the attempt on the literal /tmp the directory exists to replace", async () => {
    const repo = runnerRepository(scratch);
    const workspace = await worktreeFor(repo, "att_scratch_refused");
    const binary = toolCallExecutor(workspace.path, "writes-to-tmp", "cat > /tmp/x");

    const result = await runAgent(
      agentRequest(workspace.path, binary, { PATH: process.env.PATH ?? "" }),
    );

    expect(result.prohibited.map((hit) => hit.action)).toContain("write_outside_worktree");
    expect(result.termination.reason).toBe("prohibited_action");
    expect(result.termination.detail).toContain("/tmp/x");
  }, 60_000);
});

describe("the scratch directory and the seal", () => {
  it("never carries a file the executor wrote there into the sealed change set", async () => {
    const repo = runnerRepository(scratch);
    const workspace = await worktreeFor(repo, "att_scratch_seal");

    const path = prepareScratchDirectory(workspace.path);
    mkdirSync(join(path, "nested"), { recursive: true });
    writeFileSync(join(path, "probe.test.ts"), "it('probes', () => {});\n");
    writeFileSync(join(path, "nested", "notes.md"), "scratch\n");
    writeFileSync(join(workspace.path, "src", "feature.ts"), "export const a = 1;\n");

    const sealed = await sealChangeSet({
      worktree: workspace.path,
      base_commit: workspace.base_commit,
      ticket_key: "SCP166",
      attempt_id: "att_scratch_seal",
      outcome: "give the executor a scratch directory",
      secrets: new SecretIndex(),
    });

    expect(sealed.changed_paths).toEqual(["src/feature.ts"]);
    expect(sealed.diff).not.toContain(SCRATCH_DIR_NAME);
    // What the seal's staging actually produced, read back off the commit.
    const committed = execFileSync("git", ["show", "--pretty=", "--name-only", "HEAD"], {
      cwd: workspace.path,
      encoding: "utf8",
    });
    expect(committed.trim()).toBe("src/feature.ts");
    // Nothing is left staged, and the scratch files are still on disk: they
    // were excluded, not deleted.
    expect(
      execFileSync("git", ["diff", "--cached", "--name-only"], {
        cwd: workspace.path,
        encoding: "utf8",
      }).trim(),
    ).toBe("");
    expect(existsSync(join(path, "probe.test.ts"))).toBe(true);
  }, 30_000);

  it("is not mistaken for output a pinned check produced", async () => {
    const repo = runnerRepository(scratch);
    const workspace = await worktreeFor(repo, "att_scratch_untracked");

    const path = prepareScratchDirectory(workspace.path);
    writeFileSync(join(path, "probe.txt"), "scratch\n");
    writeFileSync(join(workspace.path, "coverage.json"), "{}\n");

    const untracked = await untrackedAfterChecks({ worktree: workspace.path });
    expect(untracked).toEqual(["coverage.json"]);
  }, 30_000);
});

/**
 * The scratch directory is the executor's, and the checks are not the executor
 * (SCP-168).
 *
 * A pinned check runs the repository's own suite, and a suite that lays a
 * directory out under `os.tmpdir()` to mean "no repository above this" is
 * right on a developer's machine and on CI. It would be wrong only here, where
 * `TMPDIR` points inside the worktree — so the checks are given back the
 * temporary directory the runner itself was started with.
 */

/** A check that records the three temporary-directory names it was given. */
function reportingCheck(directory: string, report: string): string[] {
  const script = join(directory, "reports-tmpdir.mjs");
  writeFileSync(
    script,
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(report)}, JSON.stringify({`,
      "  TMPDIR: process.env.TMPDIR ?? null,",
      "  TMP: process.env.TMP ?? null,",
      "  TEMP: process.env.TEMP ?? null,",
      '}) + "\\n");',
      // Failing is what makes the unit check re-run, so the report carries the
      // re-run's environment as well as the first run's.
      "process.exit(1);",
      "",
    ].join("\n"),
  );
  return ["node", script];
}

const reported = (report: string): Array<Record<string, string | null>> =>
  readFileSync(report, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, string | null>);

const unitCheck = (command: string[]) => [
  {
    check_id: "check_unit",
    name: "unit",
    kind: "unit" as const,
    command,
    timeout_ms: 30_000,
    definition_path: null,
    origin: "configured" as const,
  },
];

describe("the temporary directory the pinned checks run under", () => {
  it("hands the checks and the re-run the host's, never the executor's scratch", async () => {
    const worktree = scratch("perbo-scp168-");
    const report = join(scratch("perbo-scp168-report-"), "tmpdir.jsonl");
    const host = scratch("perbo-scp168-host-");

    const results = await runPinnedChecks({
      checks: unitCheck(reportingCheck(worktree, report)),
      worktree,
      // What the loop hands it: the executor's environment, scratch and all.
      env: { ...process.env, ...scratchEnvironment(scratchPath(worktree)) },
      secrets: new SecretIndex(),
      hostEnv: { TMPDIR: host, TMP: host, TEMP: host },
    });

    const runs = reported(report);
    // The check, then the re-run of the failing suite.
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run).toEqual({ TMPDIR: host, TMP: host, TEMP: host });
    }
    expect(results[0]!.tmpdir).toBe(host);
  }, 60_000);

  it("leaves the three names absent when the runner was started without them", async () => {
    const worktree = scratch("perbo-scp168-unset-");
    const report = join(scratch("perbo-scp168-unset-report-"), "tmpdir.jsonl");

    const results = await runPinnedChecks({
      checks: unitCheck(reportingCheck(worktree, report)),
      worktree,
      env: { ...process.env, ...scratchEnvironment(scratchPath(worktree)) },
      secrets: new SecretIndex(),
      hostEnv: {},
    });

    for (const run of reported(report)) {
      expect(run).toEqual({ TMPDIR: null, TMP: null, TEMP: null });
    }
    expect(results[0]!.tmpdir).toBeNull();
  }, 60_000);

  it("takes the host's values from the runner's own process by default", async () => {
    const worktree = scratch("perbo-scp168-default-");
    const report = join(scratch("perbo-scp168-default-report-"), "tmpdir.jsonl");

    const results = await runPinnedChecks({
      checks: unitCheck(reportingCheck(worktree, report)),
      worktree,
      env: { ...process.env, ...scratchEnvironment(scratchPath(worktree)) },
      secrets: new SecretIndex(),
    });

    const expected = process.env.TMPDIR ?? null;
    expect(results[0]!.tmpdir).toBe(expected);
    for (const run of reported(report)) {
      expect(run.TMPDIR).toBe(expected);
      expect(run.TMPDIR).not.toBe(scratchPath(worktree));
    }
  }, 60_000);
});
