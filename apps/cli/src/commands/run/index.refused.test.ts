import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT_CODES } from "@perbo/contracts";
import type { PreflightRequest, PreflightResult } from "@perbo/runner";
import { exitForThrown, runCommandLine } from "../../command-line/terminal.js";
import { type ExecuteDeps, executeCommandLine } from "./index.js";
import { inspectCommandLine } from "../inspect.js";
import { storeDir } from "../../store/index.js";
import { recordStreams } from "../../test-support/streams.js";
import { gitEnvironment, initRepository } from "@perbo/test-support";

/**
 * What a person reads when the loop refuses to start.
 *
 * A refusal is not a defect: the repository was diagnosed and found unable to
 * run a change at all, and what the person does next is a fix in their own
 * repository. Reaching them as a stack trace hands them a debugging session
 * inside this program instead of the finding and the command that explains it.
 * An error nothing here recognises is the other thing, and it keeps its stack —
 * so what these two tests hold apart is the error's **type**, not its wording.
 *
 * The program is driven the way `startEntryPoint` drives it: the command is
 * called, and whatever escapes it goes through `exitForThrown` onto the same
 * stderr, because that is the whole of the mapping from a thrown error to what
 * a person sees.
 *
 * **Fail-first, measured rather than argued.** Nothing here imports a module or
 * a symbol the change adds, so this file loads at the commit before it and each
 * test fails on the behaviour it is about rather than on an import.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-refused-run-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const git = (dir: string, ...argv: string[]): string =>
  execFileSync("git", ["-C", dir, ...argv], { encoding: "utf8", env: gitEnvironment() });

/**
 * A repository with one commit and a test script. A lockfile is not required
 * to run: a checkout without one installs unpinned and is told so.
 */
function repository(name: string, options: { lockfile: boolean }): string {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  initRepository(dir, {
    files: {
      "package.json": `${JSON.stringify({ name: "fixture", scripts: { test: "node --test" } }, null, 2)}\n`,
      ...(options.lockfile ? { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" } : {}),
      "src/index.ts": "export const version = 1;\n",
    },
  });
  return dir;
}

/** The repository's own `.perbo/config.json`, as a run with no ticket reads it. */
function repoConfig(repo: string, config: Record<string, unknown>): void {
  const dir = storeDir(repo, null);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    `${JSON.stringify(
      {
        agent_binary: "true",
        model: "double",
        checks: [
          {
            check_id: "check_unit",
            name: "unit",
            kind: "unit",
            command: ["node", "-e", "process.exit(0)"],
            timeout_ms: 30_000,
          },
        ],
        limits: { organisation: "test", limits: { concurrent_local_attempts: 4 } },
        ...config,
      },
      null,
      2,
    )}\n`,
  );
}

/** The root a run under the override below puts its worktrees in. */
const worktreeRoot = (name: string): string => join(scratch, `${name}-worktrees`);

/**
 * The one key a repository configuration may not set here, because the derived
 * default puts worktrees under `$HOME` and a test must not write there.
 */
function worktreeOverride(name: string): string {
  const path = join(scratch, `${name}.config.json`);
  writeFileSync(path, JSON.stringify({ worktree_root: worktreeRoot(name) }));
  return path;
}

/** A materialization that installs nothing: this fixture has no dependencies. */
const noInstall = (repo: string) => ({
  manifest_version: 1,
  repository_id: `repo_${repo.split("/").pop()}`,
  source_checkout: repo,
  entries: [],
  install: {
    kind: "none",
    package_manager: "none",
    offline_preferred: true,
    lifecycle_scripts: { policy: "disabled", exception: null },
    command: ["true"],
    pinned: true,
  },
  verify: { command: ["node", "-e", "process.exit(0)"], timeout_ms: 30_000 },
  isolation: {
    mode: "parallel",
    port_range_size: 0,
    port_range_start: 41_000,
    port_range_end: 41_009,
    database_schema_prefix: null,
  },
});

/** The machine, answered rather than measured: PATH is not what this is about. */
const okPreflight = (_request: PreflightRequest): PreflightResult => ({
  ok: true,
  findings: [],
  tools: {},
  github: null,
});

/**
 * `perbo run …` as the program runs it: the command, and — for anything that
 * escapes it — `exitForThrown` writing onto the same stderr, which is
 * `startEntryPoint`'s own body.
 */
async function program(
  repo: string,
  argv: readonly string[],
  options: Partial<ExecuteDeps> = {},
): Promise<{ code: number; err: string }> {
  const streams = recordStreams();
  try {
    const code = await runCommandLine(executeCommandLine, {
      argv: ["--repo", repo, ...argv],
      streams,
      cwd: repo,
      deps: { preflight: okPreflight, ...options },
    });
    return { code, err: streams.err() };
  } catch (error) {
    const failure = exitForThrown("run", error);
    streams.stderr(`error: ${failure.message}\n`);
    return { code: failure.code, err: streams.err() };
  }
}

/** One line of stderr that is a stack frame, as V8 writes them. */
const STACK_FRAME = /^\s+at\s/m;

/** The run record on disk, parsed here rather than through the module that wrote it. */
interface RecordedRefusal {
  refusal: {
    refused_at: string;
    reason: string;
    repository_root: string;
    findings: Array<{ reason: string; detail: string; severity: string; path: string | null }>;
  } | null;
}

function runRecord(store: string, runId: string): RecordedRefusal {
  const path = join(store, "runs", `${runId}.run.json`);
  expect(existsSync(path), `no run record at ${path}`).toBe(true);
  return JSON.parse(readFileSync(path, "utf8")) as RecordedRefusal;
}

/** The one id this store holds a run record for. */
function onlyRunId(store: string): string {
  const dir = join(store, "runs");
  expect(existsSync(dir), `no runs directory at ${dir}`).toBe(true);
  const ids = readdirSync(dir)
    .filter((name) => name.endsWith(".run.json"))
    .map((name) => name.slice(0, -".run.json".length));
  expect(ids).toHaveLength(1);
  return ids[0] as string;
}

/** Whitespace collapsed, so a sentence a renderer wrapped still matches as one. */
const flat = (text: string): string => text.replace(/\s+/g, " ");

/** Whitespace removed, so a path a renderer broke across lines still matches as one. */
const squashed = (text: string): string => text.replace(/\s+/g, "");

const OUTCOME = "The feature module exports a computed total";

describe("a repository the diagnostic refuses", () => {
  it("says what was found and what to run, with no stack trace", async () => {
    const repo = repository("unsignable", { lockfile: false });
    // It signs its commits with a key that is not there, so nothing can.
    git(repo, "config", "commit.gpgsign", "true");
    git(repo, "config", "gpg.format", "ssh");
    git(repo, "config", "user.signingkey", join(scratch, "absent-key.pub"));
    repoConfig(repo, {});

    const result = await program(repo, [
      "--outcome", OUTCOME,
      "--path", "src/**",
      "--config", worktreeOverride("unsignable"),
    ]);

    // The run did not complete — the same code it exits with today.
    expect(result.code).toBe(EXIT_CODES.did_not_complete);

    // And it cost nothing on the way there: no branch cut in the person's
    // repository, and nothing under the root the worktree would have gone in.
    expect(git(repo, "branch", "--list", "ayo/*", "prb/*").trim()).toBe("");
    const worktrees = worktreeRoot("unsignable");
    expect(existsSync(worktrees) ? readdirSync(worktrees) : []).toEqual([]);

    // What was found, in the diagnostic's own words: the refusal, named by its
    // reason and stating what it means. The advisory this checkout also carries
    // — it has no lockfile — is not printed here: what stopped the run is what
    // a person needs to fix.
    expect(result.err).toContain("commit_signing_unavailable");
    expect(flat(result.err)).toContain("this repository signs its commits");
    expect(result.err).not.toContain("lockfile_missing");

    // And what to do about it: the command that answers the whole question,
    // against this repository.
    expect(result.err).toContain(`perbo doctor --repo ${repo}`);

    // Not one frame of this program's own stack.
    expect(result.err).not.toMatch(STACK_FRAME);

    // The record carries the refusal, so the run is readable afterwards rather
    // than only at the moment it was printed.
    const store = storeDir(repo, null);
    const runId = onlyRunId(store);
    const record = runRecord(store, runId);
    expect(record.refusal).not.toBeNull();
    expect(record.refusal?.findings.map((finding) => finding.reason)).toEqual([
      "commit_signing_unavailable",
    ]);

    // And `inspect` reads it back in the same words the record holds — in the
    // report a script parses, field for field, and in the one a person reads.
    const inspected = async (isTTY: boolean): Promise<string> => {
      const read = recordStreams({ isTTY });
      await runCommandLine(inspectCommandLine, {
        argv: [runId, "--repo", repo],
        streams: read,
        cwd: repo,
          });
      // The machine-readable report is read as written: a painted escape in it
      // is a defect, not something to strip.
      return isTTY ? read.plain() : read.out();
    };
    expect((JSON.parse(await inspected(false)) as RecordedRefusal).refusal).toEqual(record.refusal);
    const shown = await inspected(true);
    expect(flat(shown)).toContain(flat(record.refusal!.reason));
    for (const finding of record.refusal!.findings) {
      expect(shown).toContain(finding.reason);
      expect(squashed(shown)).toContain(squashed(finding.detail));
    }
  }, 120_000);

  it("keeps the stack for an error nothing recognises, on the same path", async () => {
    const repo = repository("unexpected", { lockfile: true });
    repoConfig(repo, { materialization_manifest: noInstall(repo) });

    const result = await program(
      repo,
      [
        "--outcome", OUTCOME,
        "--path", "src/**",
        "--config", worktreeOverride("unexpected"),
      ],
      {
        hooks: {
          agent: () => {
            throw new TypeError("cannot read properties of undefined (reading 'seal')");
          },
        } as never,
      },
    );

    expect(result.code).toBe(EXIT_CODES.did_not_complete);
    expect(result.err).toContain("cannot read properties of undefined");
    // A TypeError is not a refusal, and the frames are the only thing that says
    // where it came from.
    expect(result.err).toMatch(STACK_FRAME);
  }, 120_000);
});
