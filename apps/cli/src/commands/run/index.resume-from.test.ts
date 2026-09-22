import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretIndex } from "@perbo/contracts";
import { BundleStore } from "@perbo/runner";
import { afterAll, describe, expect, it } from "vitest";
import { admitCommandLine } from "../admit.js";
import { executeCommandLine } from "./index.js";
import { buildInspectReport, renderInspect } from "../inspect.js";
import { readTicket, storeDir } from "../../store/tickets.js";
import { makeAttempt, makeTicket } from "../../test-support/records.js";
import { SPAWN_TEST_TIMEOUT_MS } from "@perbo/test-support";
import { runCommandLine } from "../../command-line/terminal.js";
import { recordStreams } from "../../test-support/streams.js";

/**
 * `perbo run --ticket <id> --resume-from <bundle_id>` at the command line
 * (SCP-154).
 *
 * What the loop does with the retained diff is proven in the runner's own
 * suite, against a real executor a ceiling cut. What is proven here is the
 * surface a person meets: the exit code, what is written to stderr, and that a
 * refusal reaches them before anything is executed or the ticket is moved.
 *
 * Every bundle below is written by `BundleStore` — the class the loop itself
 * records with — and every diff by `git diff`, so what the command reads is a
 * bundle in the form it will really find rather than a fixture shaped to pass.
 */

/**
 * A temporary directory, removed when this file has finished with it.
 *
 * Every repository, bundle store and fake agent below is one of these, and
 * `mkdtempSync` leaves what it makes for the caller to remove. TMPDIR is inside
 * the checkout when these run under the runner, so a fixture nobody removes is
 * a directory in `git status` as well as a directory on disk.
 */
const madeScratch: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  madeScratch.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of madeScratch.splice(0)) {
    // `maxRetries` covers the ENOTEMPTY a git process still exiting can produce;
    // past that it is best effort, because a fixture that will not be removed is
    // a leak rather than a test failure.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Left behind; the next `git status` is where it will be noticed.
    }
  }
});

/** The attempt a ceiling cut, in every fixture below. */
const CUT_ATTEMPT = "att_c07e0f1a2b3c4d5e";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const git = (dir: string, ...argv: string[]): string =>
  execFileSync("git", ["-C", dir, ...argv], { encoding: "utf8", env: GIT_ENV });

/** A repository with one commit, the way `perbo admit` expects to find one. */
function repository(name: string): string {
  const dir = scratch(`perbo-resume-${name}-`);
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: GIT_ENV });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return dir;
}

/** One more commit, so the repository head is no longer where it was. */
function commit(dir: string, name: string, body: string): string {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", name), body);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", name);
  return git(dir, "rev-parse", "HEAD").trim();
}

/**
 * A real patch, produced by git against the repository's own tree and then
 * taken back out of it: the bytes a cut attempt's `change.diff` holds.
 */
function retainedDiff(dir: string): string {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "carried.ts"), "export const carried = 'unfinished';\n");
  git(dir, "add", "-N", "--", "src/carried.ts");
  const diff = git(dir, "diff", "--", "src/carried.ts");
  git(dir, "reset", "-q", "--", "src/carried.ts");
  rmSync(join(dir, "src", "carried.ts"));
  expect(diff).toContain("carried.ts");
  return diff;
}

/** The ticket `admit` writes, ready to run, and the contract's base commit. */
function admit(repo: string): { ticket_id: string; base_commit: string } {
  const admitted = recordStreams();
  expect(
    runCommandLine(admitCommandLine, {
      argv: [
        "--repo", repo,
        "--outcome", "Search results are paginated.",
        "--criterion", "A page holds 25 hits. :: a 140-hit query returns 25",
        "--path", "packages/search/**",
        "--approve",
      ],
      streams: admitted,
      cwd: repo,
    }),
  ).toBe(0);
  const ticket = readTicket(storeDir(repo, null), "PRB-1");
  expect(ticket.state).toBe("ready");
  return { ticket_id: ticket.ticket_id, base_commit: git(repo, "rev-parse", "HEAD").trim() };
}

/**
 * The execution bundle of an attempt a ceiling cut: the record the resume
 * reads, written where the run will look for it.
 */
function cutAttemptBundle(input: {
  repo: string;
  ticket_id: string;
  base_commit: string;
  /** Omitted where the cut attempt changed nothing: a bundle with no diff. */
  diff?: string;
  attempt_id?: string;
}): { bundle_id: string; path: string } {
  const store = new BundleStore({ root: join(input.repo, ".perbo", "bundles"), retainContext: true });
  const { bundle, path } = store.write({
    kind: "execution",
    subject_id: input.attempt_id ?? CUT_ATTEMPT,
    ticket_id: input.ticket_id,
    inputs: { base_commit: input.base_commit, termination: "cost_ceiling_exceeded" },
    context_manifest: [],
    versions: { code: "stage-2", prompt: "executor_v6", policy: "local", model: "m", tool: "t" },
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      cost_micros: 5_000_000,
      cost_basis: "transport_reported",
      wall_clock_ms: 1000,
    },
    artifacts: [
      { name: "transcript.jsonl", media_type: "application/x-ndjson", body: "" },
      ...(input.diff === undefined
        ? []
        : [{ name: "change.diff", media_type: "text/x-diff", body: input.diff }]),
    ],
    errors: [{ kind: "cost_ceiling_exceeded", message: "the attempt spent its budget" }],
    transitions: [],
    retention: { class: "raw_transcript", expires_at: null },
    secrets: new SecretIndex(),
    excluded_paths: [],
    deterministic: false,
    model_version_pinned: true,
    now: new Date("2026-09-03T09:00:00.000Z"),
  });
  return { bundle_id: bundle.bundle_id, path };
}

/**
 * An agent binary that records every invocation, including `--version`.
 *
 * Nothing here should ever run it, and the file it would leave is how that is
 * observed rather than asserted about a double.
 */
function recordingAgentBinary(repo: string): { binary: string; ran: () => boolean } {
  const dir = scratch("perbo-resume-bin-");
  const sentinel = join(dir, "invoked");
  const binary = join(dir, "agent");
  writeFileSync(
    binary,
    `#!/bin/sh\necho "$@" >> ${sentinel}\ncase "$1" in --version) echo 'fake-agent 1.0.0'; exit 0 ;; esac\nexit 0\n`,
    { mode: 0o755 },
  );
  mkdirSync(join(repo, ".perbo"), { recursive: true });
  writeFileSync(join(repo, ".perbo", "config.json"), `${JSON.stringify({ agent_binary: binary }, null, 2)}\n`);
  return { binary, ran: () => existsSync(sentinel) };
}

/**
 * A PATH with git on it and nothing else, so the coding agent is genuinely
 * absent and the run stops at the preflight rather than executing anything.
 */
function withoutClaudeOnPath(): () => void {
  const bin = mkdtempSync(join(tmpdir(), "perbo-empty-bin-"));
  symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(bin, "git"));
  const previous = process.env.PATH;
  process.env.PATH = bin;
  return () => {
    process.env.PATH = previous;
    rmSync(bin, { recursive: true, force: true });
  };
}

/**
 * Every case below runs `perbo run` end to end against a real
 * repository, a cold spawn under the load SCP-191 measures rather than an
 * idle machine's five seconds.
 */
const RESUME_RUN_TIMEOUT_MS = 60_000;

describe("perbo run --resume-from, when the base commit has moved", () => {
  it("exits non-zero naming change.diff, runs no executor, and leaves the ticket ready", async () => {
    const repo = repository("moved");
    // The attempt a ceiling cut ran here, and its diff describes this tree.
    const cutBase = git(repo, "rev-parse", "HEAD").trim();
    const diff = retainedDiff(repo);
    // Then the repository moved on, and the ticket was admitted against the
    // commit it moved to. The retained diff is a statement about the older one.
    const moved = commit(repo, "other.ts", "export const other = 2;\n");
    expect(moved).not.toBe(cutBase);

    const ticket = admit(repo);
    expect(ticket.base_commit).toBe(moved);
    const bundle = cutAttemptBundle({ repo, ticket_id: ticket.ticket_id, base_commit: cutBase, diff });
    const agent = recordingAgentBinary(repo);
    const before = readTicket(storeDir(repo, null), "PRB-1");
    const bundleBefore = readFileSync(bundle.path, "utf8");

    const run = recordStreams();
    const code = await runCommandLine(executeCommandLine, {
      argv: ["--repo", repo, "--ticket", "PRB-1", "--resume-from", bundle.bundle_id],
      streams: run,
      cwd: repo,
    });

    expect(code).not.toBe(0);
    expect(code).toBe(3);
    const said = run.err();
    // The file the person is trying to recover is named, with both commits and
    // the bundle it is in, so the refusal can be acted on where it is read.
    expect(said).toContain("change.diff");
    expect(said).toContain(bundle.bundle_id);
    expect(said).toContain(cutBase);
    expect(said).toContain(moved);
    expect(said).toContain("could not resume");
    expect(run.out()).toBe("");

    // Nothing was executed: the agent binary the run would have used was never
    // started, not even for its version.
    expect(agent.ran()).toBe(false);
    // Nothing was spent and nothing was moved: the ticket is where it was, and
    // the cut attempt's bundle is byte-for-byte what it was.
    expect(readTicket(storeDir(repo, null), "PRB-1")).toEqual(before);
    expect(readTicket(storeDir(repo, null), "PRB-1").state).toBe("ready");
    expect(readFileSync(bundle.path, "utf8")).toBe(bundleBefore);
  }, RESUME_RUN_TIMEOUT_MS);

  it("refuses a bundle recorded against another ticket, and one that is not a bundle id", async () => {
    const repo = repository("other-ticket");
    const diff = retainedDiff(repo);
    const ticket = admit(repo);
    const bundle = cutAttemptBundle({
      repo,
      ticket_id: "ticket_someoneelses",
      base_commit: ticket.base_commit,
      diff,
    });
    const agent = recordingAgentBinary(repo);

    const wrongTicket = recordStreams();
    expect(
      await runCommandLine(executeCommandLine, {
        argv: ["--repo", repo, "--ticket", "PRB-1", "--resume-from", bundle.bundle_id],
        streams: wrongTicket,
        cwd: repo,
      }),
    ).toBe(3);
    expect(wrongTicket.err()).toContain("change.diff");
    expect(wrongTicket.err()).toContain("ticket_someoneelses");

    const notABundle = recordStreams();
    expect(
      await runCommandLine(executeCommandLine, {
        argv: ["--repo", repo, "--ticket", "PRB-1", "--resume-from", "../../etc/passwd"],
        streams: notABundle,
        cwd: repo,
      }),
    ).toBe(3);
    expect(notABundle.err()).toContain("change.diff");
    expect(notABundle.err()).toContain("is not a bundle id");

    expect(agent.ran()).toBe(false);
    expect(readTicket(storeDir(repo, null), "PRB-1").state).toBe("ready");
  }, RESUME_RUN_TIMEOUT_MS);
});

describe("perbo run --resume-from, when the bundle matches the run", () => {
  it("accepts it, says what will be applied, and stops only for what the machine lacks", async () => {
    const repo = repository("accepted");
    const diff = retainedDiff(repo);
    const ticket = admit(repo);
    const bundle = cutAttemptBundle({
      repo,
      ticket_id: ticket.ticket_id,
      base_commit: ticket.base_commit,
      diff,
    });

    // The agent binary is absent from this PATH, so the run stops at the
    // preflight — after the resume was accepted, which is the point: a matching
    // bundle is not what ends this run.
    const restore = withoutClaudeOnPath();
    let code: number;
    const run = recordStreams();
    try {
      code = await runCommandLine(executeCommandLine, {
        argv: ["--repo", repo, "--ticket", "PRB-1", "--resume-from", bundle.bundle_id],
        streams: run,
        cwd: repo,
      });
    } finally {
      restore();
    }

    const said = run.err();
    expect(said).toContain(`resuming from execution bundle ${bundle.bundle_id}`);
    expect(said).toContain(CUT_ATTEMPT);
    expect(said).toContain("cost_ceiling_exceeded");
    // Stated as what is about to happen, because at this line nothing has been
    // applied and no worktree exists yet.
    expect(said).toContain("change.diff will be applied");
    expect(said).toContain("unverified prior work");
    expect(said).not.toContain("could not resume");

    expect(code).toBe(3);
    expect(said).toContain("agent_binary_missing");
    expect(readTicket(storeDir(repo, null), "PRB-1").state).toBe("ready");
  }, RESUME_RUN_TIMEOUT_MS);
});

describe("perbo inspect, where a cut attempt's work is still on disk", () => {
  /**
   * A ticket with two attempts that both stopped short: one whose execution
   * bundle retained a `change.diff`, and one that changed nothing and has none.
   * The bundle ids are the identifiers `--resume-from` takes, so what is under
   * test is whether the record shows them where the stop is read.
   */
  function ticketWithCutAttempts(): { store: string; withDiff: string; withoutDiff: string } {
    const repo = repository("inspect");
    const ticket_id = "ticket_scp1540000001";
    const store = storeDir(repo, null);
    mkdirSync(join(store, "tickets"), { recursive: true });
    mkdirSync(join(store, "state"), { recursive: true });
    writeFileSync(
      join(store, "tickets", "AYO-1.json"),
      JSON.stringify(makeTicket({ key: "AYO-1", ticket_id, repository_root: repo })),
    );
    const empty = "att_e0000000000000ff";
    writeFileSync(
      join(store, "state", `${ticket_id}.attempts.json`),
      `${JSON.stringify(
        {
          ticket_id,
          attempts: [
            makeAttempt({
              attempt_id: CUT_ATTEMPT,
              ticket_id,
              created_at: "2026-09-03T09:00:00.000Z",
              termination: {
                reason: "cost_ceiling_exceeded",
                detail: "attempt_cost_micros would reach 9,400,000, above the limit of 5,000,000",
              },
              usage: { cost_micros: 5_000_000, cost_basis: "transport_reported" },
              changeset_id: null,
              head_commit: null,
            }),
            makeAttempt({
              attempt_id: empty,
              ticket_id,
              created_at: "2026-09-03T10:00:00.000Z",
              termination: { reason: "no_changes", detail: "the branch adds no change to its base" },
              usage: { cost_micros: 20_000, cost_basis: "transport_reported" },
              changeset_id: null,
              head_commit: null,
            }),
          ],
        },
        null,
        2,
      )}\n`,
    );
    const base_commit = git(repo, "rev-parse", "HEAD").trim();
    const withDiff = cutAttemptBundle({
      repo,
      ticket_id,
      base_commit,
      diff: retainedDiff(repo),
      attempt_id: CUT_ATTEMPT,
    });
    const withoutDiff = cutAttemptBundle({ repo, ticket_id, base_commit, attempt_id: empty });
    return { store, withDiff: withDiff.bundle_id, withoutDiff: withoutDiff.bundle_id };
  }

  it("names each attempt's bundle and the command that resumes the one with a diff", () => {
    const fixture = ticketWithCutAttempts();
    const rendered = renderInspect(
      buildInspectReport({ storeDirectory: fixture.store, key: "AYO-1", attempt: null }),
      { color: false, detail: false, version: "test" },
    );

    // The id `--resume-from` takes is in the default view, which is what the
    // refusal message promises a person will find here.
    expect(rendered).toContain(`bundle  ${fixture.withDiff}`);
    expect(rendered).toContain(`bundle  ${fixture.withoutDiff}`);
    // And, for the attempt whose work survived, the command that starts the
    // next attempt from it — beside the termination that raises the question.
    expect(rendered).toContain(`resume  perbo run --ticket AYO-1 --resume-from ${fixture.withDiff}`);
    // The attempt that changed nothing retained no diff, so there is nothing to
    // resume and nothing is offered.
    expect(rendered).not.toContain(`--resume-from ${fixture.withoutDiff}`);
    for (const line of rendered.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });
}, SPAWN_TEST_TIMEOUT_MS);
