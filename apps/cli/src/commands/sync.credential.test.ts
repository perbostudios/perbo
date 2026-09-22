import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EXIT_CODES, transition, type Ticket } from "@perbo/contracts";
import { branchName } from "@perbo/workspace";
import { admitCommandLine } from "./admit.js";
import { recordDelivery, syncCommandLine } from "./sync.js";
import { readContract, readTicket, storeDir, writeTicket } from "../store/tickets.js";
import { SPAWN_TEST_TIMEOUT_MS, gitEnvironment } from "@perbo/test-support";
import { runCommandLine } from "../command-line/terminal.js";
import { recordStreams } from "../test-support/streams.js";

/**
 * SCP-200 criterion 1, for `perbo sync`: which credential `gh` was read
 * through, decided before the read and recorded beside what it returned.
 *
 * A machine's one `gh` login is not shared safely by every process on it, so a
 * sync that has a `GH_TOKEN` uses it and says so; one that has neither a token
 * nor a login is refused in words a person can search for, and nothing on the
 * ticket is touched — the refusal has to be distinguishable from "there is no
 * pull request", which is the ambiguity this ticket exists to remove.
 *
 * Every test here spawns a real `gh` (a fake one, on PATH) and a real `git`, so
 * each declares its own deadline.
 */

const SPAWN_DEADLINE_MS = 20_000;

const scratch = mkdtempSync(join(tmpdir(), "perbo-sync-credential-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const OUTCOME = "Search results are paginated.";
const PR = 91;
const url = `https://github.com/o/r/pull/${PR}`;

const ghAnswer = `${JSON.stringify({
  number: PR,
  url,
  state: "OPEN",
  body: "",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  statusCheckRollup: [],
  reviews: [],
  comments: [],
  commits: [],
})}\n`;

/**
 * A `gh` on PATH that answers `pr view` from one fixed body, decides
 * `auth status` by exit code, and writes down every argument list it was given.
 */
function fakeGh(name: string, authExit: number): { path: string; calls: () => string[] } {
  const bin = join(scratch, `bin-${name}`);
  mkdirSync(bin, { recursive: true });
  const log = join(bin, "calls");
  const body = join(bin, "view.json");
  writeFileSync(log, "");
  writeFileSync(body, ghAnswer);
  const script = join(bin, "gh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      `if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit ${authExit}; fi`,
      `if [ "$1" = "pr" ] && [ "$2" = "view" ]; then cat ${JSON.stringify(body)}; exit 0; fi`,
      `echo "this fake gh answers auth status and pr view only, got: $*" >&2`,
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return {
    path: bin,
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== ""),
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

/** The environment a sync runs in: this `gh`, and this much of a credential. */
function withGh<T>(bin: string, token: string | null, body: () => T | Promise<T>): Promise<Awaited<T>> {
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  delete process.env.GITHUB_TOKEN;
  if (token === null) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = token;
  return Promise.resolve(body());
}

/** A ticket sitting at `pr_open` behind a pull request the loop published. */
function publishedTicket(name: string): { repo: string; dir: string } {
  const repo = join(scratch, name);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "base"], { env: gitEnvironment() });
  runCommandLine(admitCommandLine, {
    argv: [
      "--repo",
      repo,
      "--outcome",
      OUTCOME,
      "--criterion",
      "A second page is reachable. :: a paging test",
      "--path",
      "packages/search/**",
      "--approve",
    ],
    streams: recordStreams(),
    cwd: repo,
  });
  const dir = storeDir(repo, null);
  const branch = branchName({
    ticket_key: "PRB-1",
    ticket_id: readTicket(dir, "PRB-1").ticket_id,
    outcome: readContract(dir, "PRB-1").outcome,
  });

  const at = new Date("2026-09-04T09:00:00.000Z");
  let ticket: Ticket = readTicket(dir, "PRB-1");
  ticket = transition(ticket, "provisioning", "run started", at);
  ticket = transition(ticket, "executing", "1 attempt executed", at);
  ticket = transition(ticket, "verifying", "no deterministic checks are configured", at);
  ticket = transition(ticket, "independent_review", "reviewed independently", at);
  ticket = recordDelivery(ticket, { workspace: { branch }, pull_request: { url, number: PR } }, at);
  ticket = transition(ticket, "pr_open", "approved; a human merges it", at);
  writeTicket(dir, ticket);
  return { repo, dir };
}

const NOW = new Date("2026-09-04T11:40:00.000Z");
const ticketFile = (dir: string) => join(dir, "tickets", "PRB-1.json");
const SENTINEL = "ghp_scp200syncsentinelvalue";

describe("sync says which credential it read GitHub through", () => {
  it(
    "records `GH_TOKEN` and never asks `gh` about its own login",
    async () => {
      const { repo, dir } = publishedTicket("token");
      const gh = fakeGh("sync-token", 1);

      const code = await withGh(gh.path, SENTINEL, () =>
        runCommandLine(syncCommandLine, { argv: ["PRB-1", "--repo", repo], streams: recordStreams(), cwd: repo, now: NOW }),
      );

      expect(code).toBe(EXIT_CODES.approve);
      expect(readTicket(dir, "PRB-1").delivery.github_credential).toBe("GH_TOKEN");
      // The token is the credential, so `gh auth status` is not asked — which
      // is one fewer process rewriting the machine's `gh` configuration.
      expect(gh.calls().some((call) => call.startsWith("auth"))).toBe(false);
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "records `gh_login` where no token is set and `gh` is signed in",
    async () => {
      const { repo, dir } = publishedTicket("login");
      const gh = fakeGh("sync-login", 0);

      const code = await withGh(gh.path, null, () =>
        runCommandLine(syncCommandLine, { argv: ["PRB-1", "--repo", repo], streams: recordStreams(), cwd: repo, now: NOW }),
      );

      expect(code).toBe(EXIT_CODES.approve);
      expect(readTicket(dir, "PRB-1").delivery.github_credential).toBe("gh_login");
      expect(gh.calls()[0]).toBe("auth status");
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "refuses before it reads anything when there is neither, in the words `gh is not logged in`",
    async () => {
      const { repo, dir } = publishedTicket("neither");
      const gh = fakeGh("sync-neither", 1);
      const before = readFileSync(ticketFile(dir), "utf8");
      const streams = recordStreams();

      const code = await withGh(gh.path, null, () =>
        runCommandLine(syncCommandLine, { argv: ["PRB-1", "--repo", repo], streams, cwd: repo, now: NOW }),
      );

      expect(code).toBe(EXIT_CODES.did_not_complete);
      expect(streams.err()).toContain("gh is not logged in");
      // Before anything else: the pull request was never asked about, and the
      // ticket is byte for byte what it was.
      expect(gh.calls()).toEqual(["auth status"]);
      expect(readFileSync(ticketFile(dir), "utf8")).toBe(before);
    },
    SPAWN_DEADLINE_MS,
  );
});

describe("the record a publishing run leaves", () => {
  it("carries the credential the run opened the pull request through", () => {
    const { dir } = publishedTicket("publish-record");
    const ticket = readTicket(dir, "PRB-1");
    const at = new Date("2026-09-04T12:00:00.000Z");

    const recorded = recordDelivery(
      ticket,
      {
        workspace: { branch: ticket.delivery.branch! },
        pull_request: { url, number: PR },
        github_credential: "GH_TOKEN",
      },
      at,
    );

    expect(recorded.delivery.github_credential).toBe("GH_TOKEN");
  });
}, SPAWN_TEST_TIMEOUT_MS);
