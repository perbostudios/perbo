import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT_CODES } from "@perbo/contracts";
import type { PreflightRequest, PreflightResult } from "@perbo/runner";
import { runOrThrow } from "@perbo/workspace";
import { exitForThrown } from "../../command-line/terminal.js";
import { type ExecuteDeps, doctorCommandLine, executeCommandLine } from "./index.js";
import { storeDir } from "../../store/index.js";
import { runCommandLine } from "../../command-line/terminal.js";
import { recordStreams } from "../../test-support/streams.js";
import { gitEnvironment } from "@perbo/test-support";

/**
 * What a person reads about a repository whose configuration signs commits with
 * a key nothing on the machine can use.
 *
 * The seal is the first thing in a run that asks the key to sign, and it comes
 * after the agent has run and been paid for. So the two things held here are
 * that the fact is stated before anything starts — in the same words from
 * `doctor` and from `run` — and that a command which fails anyway reaches the
 * person as what it said rather than as a stack trace.
 *
 * Nothing here imports a symbol the change adds: each test fails on what the
 * program prints rather than on an import.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-signing-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const git = (dir: string, ...argv: string[]): string =>
  execFileSync("git", ["-C", dir, ...argv], { encoding: "utf8", env: gitEnvironment() });

/** A key pair, locked behind `passphrase` where one is given. */
function keypair(name: string, passphrase: string): { pub: string; secret: string } {
  const secret = join(mkdtempSync(join(scratch, `${name}-key-`)), name);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", passphrase, "-C", name, "-f", secret], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  });
  return { pub: `${secret}.pub`, secret };
}

/**
 * A repository that is materializable in every other way — a lockfile, a test
 * script, one commit — and whose own configuration signs its commits with
 * `pub`.
 */
function repository(name: string, pub: string | null): string {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: gitEnvironment() });
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@t.invalid");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "fixture", scripts: { test: "node --test" } }, null, 2)}\n`,
  );
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "export const version = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  if (pub !== null) {
    git(dir, "config", "commit.gpgsign", "true");
    git(dir, "config", "gpg.format", "ssh");
    git(dir, "config", "user.signingkey", pub);
  }
  return dir;
}

/** The repository's own `.perbo/config.json`, as a run with no ticket reads it. */
function repoConfig(repo: string): void {
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
      },
      null,
      2,
    )}\n`,
  );
}

/** The root a run under the override below puts its worktrees in. */
const worktreeRoot = (name: string): string => join(scratch, `${name}-worktrees`);

function worktreeOverride(name: string): string {
  const path = join(scratch, `${name}.config.json`);
  writeFileSync(path, JSON.stringify({ worktree_root: worktreeRoot(name) }));
  return path;
}

/** The machine, answered rather than measured: PATH is not what this is about. */
const okPreflight = (_request: PreflightRequest): PreflightResult => ({
  ok: true,
  findings: [],
  tools: {},
  github: null,
});

/**
 * `perbo run …` as the program runs it: the command, and — for anything that
 * escapes it — `exitForThrown` writing onto the same stderr.
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

/**
 * The commands below read the environment this process is in, so the machine's
 * own agent and global configuration are taken out of it for the duration.
 */
const CLEARED = ["SSH_AUTH_SOCK", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"] as const;
const held = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of CLEARED) held.set(name, process.env[name]);
  delete process.env["SSH_AUTH_SOCK"];
  process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  process.env["GIT_CONFIG_SYSTEM"] = "/dev/null";
});

afterEach(() => {
  for (const name of CLEARED) {
    const value = held.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const OUTCOME = "The feature module exports a computed total";
const SIGNING = "commit_signing_unavailable";

describe("a repository whose configuration signs commits with a key nothing can use", () => {
  it("is refused before anything runs, in one line, with what the signer said", async () => {
    const key = keypair("locked", "a-passphrase-no-agent-holds");
    const repo = repository("locked-run", key.pub);
    repoConfig(repo);

    const result = await program(repo, [
      "--outcome", OUTCOME,
      "--path", "src/**",
      "--config", worktreeOverride("locked-run"),
    ]);

    expect(result.code).toBe(EXIT_CODES.did_not_complete);

    // The finding, named, with the signer's own words behind it.
    expect(result.err).toContain(SIGNING);
    expect(result.err).toMatch(/incorrect passphrase/i);
    // And both ways out.
    expect(result.err).toContain("ssh-add");
    expect(result.err).toContain("commit.gpgsign false");
    // And what answers the whole question about this repository.
    expect(result.err).toContain(`perbo doctor --repo ${repo}`);

    // It cost nothing on the way there: no branch cut, nothing under the root
    // the worktree would have gone in, and not one frame of this program.
    expect(git(repo, "branch", "--list", "ayo/*", "prb/*").trim()).toBe("");
    const worktrees = worktreeRoot("locked-run");
    expect(existsSync(worktrees) ? readdirSync(worktrees) : []).toEqual([]);
    expect(result.err).not.toMatch(STACK_FRAME);
  }, 120_000);

  it("is reported by doctor, in the same words, in the report a script reads", async () => {
    const key = keypair("locked-doctor", "a-passphrase-no-agent-holds");
    const repo = repository("locked-doctor", key.pub);
    const read = recordStreams();

    const code = await runCommandLine(doctorCommandLine, {
      argv: ["--repo", repo, "--json"],
      streams: read,
      cwd: repo,
      deps: { preflight: okPreflight },
    });

    expect(code).toBe(1);
    const report = read.json<{
      materializable: boolean;
      findings: Array<{ reason: string; severity: string; detail: string }>;
    }>();
    expect(report.materializable).toBe(false);
    const finding = report.findings.find((candidate) => candidate.reason === SIGNING);
    expect(finding, `findings were ${report.findings.map((f) => f.reason).join(", ")}`).toBeDefined();
    expect(finding?.severity).toBe("refusal");
    expect(finding?.detail).toMatch(/incorrect passphrase/i);
  }, 120_000);

  it("runs a repository whose key does sign exactly as before", async () => {
    const key = keypair("open", "");
    const repo = repository("open-doctor", key.pub);
    const read = recordStreams();

    const code = await runCommandLine(doctorCommandLine, {
      argv: ["--repo", repo, "--json"],
      streams: read,
      cwd: repo,
      deps: { preflight: okPreflight },
    });

    expect(code).toBe(0);
    const report = read.json<{
      materializable: boolean;
      findings: Array<{ reason: string }>;
    }>();
    expect(report.materializable).toBe(true);
    expect(report.findings.map((finding) => finding.reason)).toEqual([]);
  }, 120_000);
});

describe("a command the run could not finish", () => {
  it("reaches the person as what git said, not as an exit code and a stack", async () => {
    const repo = repository("hook", null);
    writeFileSync(
      join(repo, ".git", "hooks", "pre-commit"),
      "#!/bin/sh\necho 'the pre-commit hook would not have this commit' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    writeFileSync(join(repo, "src", "feature.ts"), "export const total = 1;\n");
    git(repo, "add", "-A");

    const thrown = await runOrThrow(["git", "commit", "-q", "-m", "sealed"], {
      cwd: repo,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_CONFIG_GLOBAL: "/dev/null" },
      timeoutMs: 30_000,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).not.toBeNull();

    const failure = exitForThrown("run", thrown);
    expect(failure.code).toBe(EXIT_CODES.did_not_complete);
    expect(failure.message).toContain("git commit");
    expect(failure.message).toContain("the pre-commit hook would not have this commit");
    expect(failure.message).not.toMatch(STACK_FRAME);
  }, 60_000);
});
