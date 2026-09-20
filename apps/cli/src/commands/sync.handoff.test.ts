import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EXIT_CODES, TicketSchema, transition, type Ticket } from "@perbo/contracts";
import { branchName } from "@perbo/workspace";
import { parseAdmitArgs, runAdmitCommand } from "./admit.js";
import type { Streams } from "../streams.js";
import { runSyncCommand } from "./sync.js";
import { readContract, readTicket, storeDir, writeTicket } from "../store/tickets.js";

/**
 * SCP-157: `perbo sync` on a `failed` ticket whose branch a person delivered
 * by hand — the loop's own executor never opened this pull request, and the
 * loop's own attempt is the reason the ticket says `failed` at all. `sync`
 * still has to walk it to `merged` once a pull request exists, and leave it
 * alone once one does not.
 *
 * `gh` is faked as a binary on PATH, the same way sync-reconcile.test.ts does
 * it: the criterion is about the process `sync` starts and the branch name it
 * puts on the command line.
 *
 * Every case spawns real `git` and `gh` processes, so each carries an explicit
 * timeout (SCP-246, in SCP-191's style) rather than vitest's five-second
 * default: on a machine also running gates and mutant attempts, that work can
 * outrun five seconds on its own.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-sync-handoff-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const OUTCOME = "Search results are paginated.";

const gitIdentity = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function repository(name: string): string {
  const dir = join(scratch, name);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "base"], { env: gitIdentity });
  return dir;
}

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (chunk) => out.push(chunk), stderr: (chunk) => err.push(chunk), isTTY: false };
}

const admitArgv = (repo: string) => [
  "--repo",
  repo,
  "--outcome",
  OUTCOME,
  "--criterion",
  "A second page is reachable. :: a paging test",
  "--path",
  "packages/search/**",
  "--approve",
];

/** A `gh` on PATH that records every invocation and answers from a fixed file. */
function fakeGh(
  name: string,
  answer: { stdout: string; stderr?: string; code?: number },
): { bin: string; invocations: () => string[][] } {
  const root = join(scratch, `gh-${name}`);
  mkdirSync(root, { recursive: true });
  const log = join(root, "invocations.log");
  const stdoutFile = join(root, "stdout");
  const stderrFile = join(root, "stderr");
  writeFileSync(log, "");
  writeFileSync(stdoutFile, answer.stdout);
  writeFileSync(stderrFile, answer.stderr ?? "");
  const script = join(root, "gh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      "{",
      '  echo "--"',
      '  for arg in "$@"; do echo "$arg"; done',
      `} >> ${log}`,
      `cat ${stdoutFile}`,
      `cat ${stderrFile} >&2`,
      `exit ${answer.code ?? 0}`,
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return {
    bin: root,
    invocations: () =>
      readFileSync(log, "utf8")
        .split("--\n")
        .slice(1)
        .map((block) => block.split("\n").filter((line) => line.length > 0)),
  };
}

const originalPath = process.env.PATH;
const originalToken = process.env.GH_TOKEN;
const originalGithubToken = process.env.GITHUB_TOKEN;
afterEach(() => {
  process.env.PATH = originalPath;
  if (originalToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = originalToken;
  if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalGithubToken;
});

/**
 * The `gh` on PATH, and the credential the sync reads GitHub through.
 *
 * `GH_TOKEN` is set rather than inherited: SCP-200 decides the credential path
 * before the read, so a suite that let the machine's own environment decide it
 * would ask `gh auth status` on one developer's machine and not on another's.
 */
const withGh = <T,>(bin: string, body: () => Promise<T>): Promise<T> => {
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  process.env.GH_TOKEN = "test-token";
  delete process.env.GITHUB_TOKEN;
  return body();
};

const PR_URL = "https://github.com/o/r/pull/41";

const ghAnswer = (state: "OPEN" | "CLOSED" | "MERGED"): string =>
  `${JSON.stringify({
    number: 41,
    url: PR_URL,
    state,
    body: "",
    mergeStateStatus: state === "OPEN" ? "CLEAN" : null,
    statusCheckRollup: [{ name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }],
    reviews: [],
    comments: [],
  })}\n`;

/**
 * A ticket the loop ran and failed: admitted, approved, walked to
 * `provisioning` then `failed`, with its branch recorded — exactly what
 * `recordDelivery` leaves behind for an attempt that never opened a pull
 * request, which AYO-6, AYO-13 and AYO-14 are in the live store.
 */
function failedTicket(name: string): { repo: string; dir: string; ticket: Ticket; branch: string } {
  const repo = repository(name);
  runAdmitCommand({ args: parseAdmitArgs(admitArgv(repo)), streams: capture(), cwd: repo });
  const dir = storeDir(repo, null);
  const at = new Date("2026-09-01T09:00:00.000Z");
  const branch = branchName({
    ticket_key: "PRB-1",
    ticket_id: readTicket(dir, "PRB-1").ticket_id,
    outcome: readContract(dir, "PRB-1").outcome,
  });

  let ticket = readTicket(dir, "PRB-1");
  ticket = transition(ticket, "provisioning", "run started", at);
  ticket = transition(ticket, "failed", "the attempt did not complete: terminated", at);
  ticket = TicketSchema.parse({ ...ticket, delivery: { ...ticket.delivery, branch } });
  writeTicket(dir, ticket);

  return { repo, dir, ticket, branch };
}

const ticketFile = (dir: string) => join(dir, "tickets", "PRB-1.json");
const NOW = new Date("2026-09-03T10:00:00.000Z");

describe("ac_3 — a failed ticket with no pull request is left exactly as it is", () => {
  it("changes nothing and reports the ticket was left untouched", async () => {
    const { repo, dir } = failedTicket("no-pr");
    const gh = fakeGh("no-pr", {
      stdout: "",
      stderr: 'no pull requests found for branch "ayo/x/y"\n',
      code: 1,
    });
    const before = readFileSync(ticketFile(dir), "utf8");
    const streams = capture();

    const code = await withGh(gh.bin, () =>
      runSyncCommand({ argv: ["PRB-1", "--repo", repo], streams, cwd: repo, now: NOW }),
    );

    expect(code).toBe(EXIT_CODES.did_not_complete);
    expect(readFileSync(ticketFile(dir), "utf8")).toBe(before);
    expect(readTicket(dir, "PRB-1").state).toBe("failed");
    expect(readTicket(dir, "PRB-1").history).toHaveLength(4);
    expect(streams.err.join("")).toContain("left untouched");
  }, 30_000);
});

describe("ac_2 — a failed ticket whose branch a person merged by hand is walked to merged", () => {
  it("records a hand-off row then a merge row, each naming the pull request as reconciled", async () => {
    const { repo, dir, ticket: before } = failedTicket("merged-by-hand");
    const gh = fakeGh("merged-by-hand", { stdout: ghAnswer("MERGED") });
    const streams = capture();

    const code = await withGh(gh.bin, () =>
      runSyncCommand({ argv: ["PRB-1", "--repo", repo], streams, cwd: repo, now: NOW }),
    );

    expect(code).toBe(EXIT_CODES.approve);
    const after = readTicket(dir, "PRB-1");
    expect(after.state).toBe("merged");

    const written = after.history.slice(before.history.length);
    expect(written.map((entry) => ({ from: entry.from, to: entry.to }))).toEqual([
      { from: "failed", to: "pr_open" },
      { from: "pr_open", to: "merged" },
    ]);

    // Both rows are reconciled and name the pull request as the source.
    for (const entry of written) {
      expect(entry.note).toContain("reconciled after the fact by `perbo sync`");
      expect(entry.note).toContain(PR_URL);
      expect(entry.at).toBe(NOW.toISOString());
    }
    // Only the first row is a hand-off; only it has to say the loop is not
    // who opened the pull request.
    expect(written[0]!.note).toMatch(/loop.*not|not the loop/);
    expect(written[1]!.note).not.toMatch(/loop/);
  }, 30_000);

  it("walks only to pr_open when the pull request is still open", async () => {
    const { repo, dir } = failedTicket("open-only");
    const gh = fakeGh("open-only", { stdout: ghAnswer("OPEN") });

    const code = await withGh(gh.bin, () =>
      runSyncCommand({ argv: ["PRB-1", "--repo", repo], streams: capture(), cwd: repo, now: NOW }),
    );

    expect(code).toBe(EXIT_CODES.approve);
    const after = readTicket(dir, "PRB-1");
    expect(after.state).toBe("pr_open");
    expect(after.history.at(-1)).toMatchObject({ from: "failed", to: "pr_open" });
  }, 30_000);
});
