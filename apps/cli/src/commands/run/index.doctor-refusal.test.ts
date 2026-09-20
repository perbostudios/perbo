import { spawnSync } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiagnosticResultSchema, type DiagnosticResult } from "@perbo/contracts";
import type { PreflightRequest, PreflightResult } from "@perbo/runner";
import type { DiagnoseRequest } from "@perbo/workspace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDoctorCommand, type DoctorOptions } from "./index.js";
import { SPAWN_TEST_TIMEOUT_MS } from "../../test-support/spawn-timeout.js";

/**
 * `perbo doctor`, with the three things it does that start another program —
 * the machine preflight, the materialisation diagnostic and the reading of the
 * branch this checkout is on — handed in.
 *
 * The refusal below timed out at 5 s on `main` and passed on the same tree in a
 * pull request (postmortem 2026-09-02, action A1). It was not slow: it asked
 * the machine for `claude --version` and walked the checkout with
 * `git ls-files`, and how long those take is a property of the machine. The fix
 * is that neither runs, not a longer deadline — so every test here observes
 * `node:child_process` and says how many processes were started.
 */

/**
 * Wrapped around the real module, so the count is of processes actually
 * started rather than of calls to a double. These seven are every export of
 * `node:child_process` that starts one; the rest of the module passes through
 * untouched.
 */
const observed = vi.hoisted(() => ({ started: [] as string[] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  const watch = <T>(name: string, real: T): T =>
    ((...args: unknown[]) => {
      observed.started.push(`${name} ${String(args[0])}`);
      return (real as (...a: unknown[]) => unknown)(...args);
    }) as T;
  return {
    ...actual,
    exec: watch("exec", actual.exec),
    execFile: watch("execFile", actual.execFile),
    execFileSync: watch("execFileSync", actual.execFileSync),
    execSync: watch("execSync", actual.execSync),
    fork: watch("fork", actual.fork),
    spawn: watch("spawn", actual.spawn),
    spawnSync: watch("spawnSync", actual.spawnSync),
  } satisfies typeof actual;
});

const streams = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    streams: {
      stdout: (chunk: string) => out.push(chunk),
      stderr: (chunk: string) => err.push(chunk),
      isTTY: false,
    },
  };
};

const doctorArgs = (repo: string, extra: Partial<DoctorOptions["args"]> = {}): DoctorOptions["args"] => ({
  ticket: null,
  store: null,
  contract: null,
  config: null,
  repo,
  worktreeRoot: null,
  publish: false,
  json: true,
  quiet: true,
  writeConfig: false,
  probe: false,
  resumeFrom: null,
  outcome: null,
  criteria: [],
  paths: [],
  pr: null,
  relevel: false,
  ...extra,
});

/** The findings, as the real diagnostic states them — through its own schema. */
const cannotMaterialize: DiagnosticResult = DiagnosticResultSchema.parse({
  materializable: false,
  findings: [
    {
      reason: "lockfile_missing",
      severity: "advisory",
      detail: "no lockfile pins what npm installs, so the install resolves its own versions",
      path: "package.json",
    },
    {
      reason: "ignored_paths_unavailable",
      severity: "refusal",
      detail: "could not list the ignored files: not a git repository",
      path: null,
    },
  ],
  proposed: null,
});

const machineReady: PreflightResult = {
  ok: true,
  findings: [],
  tools: { node: { present: true, version: process.versions.node } },
  github: null,
};

/** The branch a checkout is on, answered rather than read off the disk. */
const onMain = () => ({ base_ref: "main", from: "branch" }) as const;

const temporary: string[] = [];
function checkout(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `perbo-doctor-${name}-`));
  temporary.push(dir);
  return dir;
}

beforeEach(() => {
  observed.started.length = 0;
});

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A cold spawn of a real process, under the load SCP-191 measures. */
const DOCTOR_TIMEOUT_MS = 60_000;

describe("the process observer these tests measure with", () => {
  it("records a process that is started, so a count of zero means one thing", () => {
    expect(observed.started).toEqual([]);
    spawnSync(process.execPath, ["-e", ""]);
    expect(observed.started).toEqual([`spawnSync ${process.execPath}`]);
  }, DOCTOR_TIMEOUT_MS);
});

describe("perbo doctor", () => {
  it("refuses a repository it cannot materialize, by name and before any attempt", async () => {
    const dir = checkout("refusal");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    const requests: DiagnoseRequest[] = [];
    const { out, streams: sink } = streams();

    const code = await runDoctorCommand({
      args: doctorArgs(dir),
      streams: sink,
      cwd: process.cwd(),
      preflight: () => machineReady,
      diagnose: (request) => {
        requests.push(request);
        return Promise.resolve(cannotMaterialize);
      },
      // SCP-279: the fourth collaborator, stubbed like the others. The real one
      // asks `gh` what this repository runs on a pull request.
      pullRequestChecks: (request) =>
        Promise.resolve({
          answered: false,
          runs_checks: false,
          workflows: [],
          workflows_seen: 0,
          workflows_ref: null,
          required_checks: [],
          base_ref: request.base_ref,
          detail: "not asked here",
        }),
      baseRef: onMain,
    });

    expect(code).toBe(1);
    const result = JSON.parse(out.join("")) as { materializable: boolean; findings: Array<{ reason: string }> };
    expect(result.materializable).toBe(false);
    expect(result.findings.map((finding) => finding.reason)).toContain("lockfile_missing");
    expect(result.findings.map((finding) => finding.reason)).toContain("ignored_paths_unavailable");
    // The refusal above came from the command reading the diagnostic it was
    // given. Nothing was run to reach it.
    expect(observed.started).toEqual([]);
    expect(requests).toEqual([{ checkout: dir, repository_id: "repo_local" }]);
  }, DOCTOR_TIMEOUT_MS);

  it("asks the collaborators it was given, and only those", async () => {
    const dir = checkout("injected");
    const machineRequests: PreflightRequest[] = [];
    const diagnoseRequests: DiagnoseRequest[] = [];
    const { out } = await run(dir, {
      preflight: (request) => {
        machineRequests.push(request);
        return machineReady;
      },
      diagnose: (request) => {
        diagnoseRequests.push(request);
        return Promise.resolve(cannotMaterialize);
      },
      // SCP-279: the fourth collaborator, stubbed like the others. The real one
      // asks `gh` what this repository runs on a pull request.
      pullRequestChecks: (request) =>
        Promise.resolve({
          answered: false,
          runs_checks: false,
          workflows: [],
          workflows_seen: 0,
          workflows_ref: null,
          required_checks: [],
          base_ref: request.base_ref,
          detail: "not asked here",
        }),
      baseRef: onMain,
    });

    expect(machineRequests).toEqual([
      // `probeGithub` is doctor's own: it asks whether GitHub answers whether
      // or not this repository publishes (SCP-200). `installBinary` is null
      // because this checkout names no package manager, so a run here spawns no
      // install.
      {
        agentBinary: "claude",
        agentProvider: "claude-cli",
        reviewerProvider: "claude-cli",
        needsGh: false,
        installBinary: null,
        probeGithub: true,
      },
    ]);
    expect(diagnoseRequests).toEqual([{ checkout: dir, repository_id: "repo_local" }]);
    expect(observed.started).toEqual([]);
    // The stubs' answers are the ones reported, not a second opinion from the
    // real ones alongside them.
    const result = JSON.parse(out.join("")) as {
      preflight: PreflightResult;
      findings: Array<{ reason: string }>;
    };
    expect(result.preflight).toEqual(machineReady);
    expect(result.findings.map((finding) => finding.reason)).toEqual([
      "lockfile_missing",
      "ignored_paths_unavailable",
    ]);
  });

  it("checks the real machine and the real checkout when it is given neither", async () => {
    // A checkout that is not there: the real diagnostic answers from the path
    // alone, and the real preflight looks for binaries on a PATH with none.
    const dir = join(checkout("defaults"), "gone");
    const restore = withEmptyPath();
    let out: string[];
    try {
      ({ out } = await run(dir, {}));
    } finally {
      restore();
    }

    const result = JSON.parse(out.join("")) as {
      findings: Array<{ reason: string }>;
      preflight: PreflightResult;
    };
    // `source_checkout_missing` is the real diagnostic's own answer, and
    // `agent_binary_missing` the real preflight's; neither stub says either.
    expect(result.findings.map((finding) => finding.reason)).toContain("source_checkout_missing");
    expect(result.preflight.ok).toBe(false);
    expect(result.preflight.findings.map((finding) => finding.reason)).toContain("agent_binary_missing");
    // And the default path is the one that starts processes — which is why the
    // refusal test injects.
    expect(observed.started.length).toBeGreaterThan(0);
  });
}, SPAWN_TEST_TIMEOUT_MS);

async function run(
  repo: string,
  collaborators: Pick<DoctorOptions, "preflight" | "diagnose" | "baseRef" | "pullRequestChecks">,
): Promise<{ out: string[]; err: string[]; code: number }> {
  const sink = streams();
  const code = await runDoctorCommand({
    args: doctorArgs(repo),
    streams: sink.streams,
    cwd: process.cwd(),
    ...collaborators,
  });
  return { out: sink.out, err: sink.err, code };
}

/**
 * A PATH with nothing on it, so every binary the preflight looks for is
 * genuinely absent — and absent fast, since `spawn` fails on the lookup rather
 * than waiting for a program to answer `--version`.
 */
function withEmptyPath(): () => void {
  const empty = mkdtempSync(join(tmpdir(), "perbo-doctor-nopath-"));
  temporary.push(empty);
  const previous = process.env.PATH;
  process.env.PATH = empty;
  return () => {
    process.env.PATH = previous;
  };
}
