import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EXIT_CODES, transition, type Ticket } from "@perbo/contracts";
import { branchName } from "@perbo/workspace";
import { parseAdmitArgs, runAdmitCommand } from "../src/admit.js";
import type { Streams } from "../src/streams.js";
import { recordDelivery, runSyncCommand } from "../src/sync.js";
import { readContract, readTicket, storeDir, writeTicket } from "../src/tickets.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./spawn-timeout.js";

/**
 * SCP-192 criterion 3: a pull request that stopped being mergeable is recorded
 * as such.
 *
 * The loop opens a mergeable pull request; the base moves afterwards and GitHub
 * reports the branch as conflicting. Nothing local can see that — only `gh`
 * can — so `sync` is where it reaches the ticket, and it reaches it as a value
 * on the delivery record rather than only as a line on a terminal that has
 * scrolled away.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-sync-mergeable-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const OUTCOME = "Search results are paginated.";
const PR = 61;
const url = `https://github.com/o/r/pull/${PR}`;

const gitIdentity = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (chunk) => out.push(chunk), stderr: (chunk) => err.push(chunk), isTTY: false };
}

/** A `gh` on PATH that answers every invocation from one fixed body. */
function fakeGh(name: string, stdout: string): string {
  const root = join(scratch, `gh-${name}`);
  mkdirSync(root, { recursive: true });
  const body = join(root, "stdout");
  writeFileSync(body, stdout);
  const script = join(root, "gh");
  writeFileSync(script, ["#!/bin/sh", `cat ${body}`, "exit 0", ""].join("\n"));
  chmodSync(script, 0o755);
  return root;
}

const ghAnswer = (mergeable: string, mergeStateStatus: string): string =>
  `${JSON.stringify({
    number: PR,
    url,
    state: "OPEN",
    body: "",
    mergeable,
    mergeStateStatus,
    statusCheckRollup: [{ name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }],
    reviews: [],
    comments: [],
  })}\n`;

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

/** A ticket sitting at `pr_open` behind a pull request the loop published. */
function publishedTicket(name: string): { repo: string; dir: string; branch: string } {
  const repo = join(scratch, name);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "base"], { env: gitIdentity });
  runAdmitCommand({
    args: parseAdmitArgs([
      "--repo",
      repo,
      "--outcome",
      OUTCOME,
      "--criterion",
      "A second page is reachable. :: a paging test",
      "--path",
      "packages/search/**",
      "--approve",
    ]),
    streams: capture(),
    cwd: repo,
  });
  const dir = storeDir(repo, null);
  const branch = branchName({
    ticket_key: "PRB-1",
    ticket_id: readTicket(dir, "PRB-1").ticket_id,
    outcome: readContract(dir, "PRB-1").outcome,
  });

  const at = new Date("2026-09-03T09:00:00.000Z");
  let ticket: Ticket = readTicket(dir, "PRB-1");
  ticket = transition(ticket, "provisioning", "run started", at);
  ticket = transition(ticket, "executing", "1 attempt executed", at);
  ticket = transition(ticket, "verifying", "no deterministic checks are configured", at);
  ticket = transition(ticket, "independent_review", "reviewed independently", at);
  ticket = recordDelivery(ticket, { workspace: { branch }, pull_request: { url, number: PR } }, at);
  ticket = transition(ticket, "pr_open", "approved; a human merges it", at);
  writeTicket(dir, ticket);
  return { repo, dir, branch };
}

const NOW = new Date("2026-09-04T10:00:00.000Z");

describe("sync records a pull request that stopped being mergeable", () => {
  it("writes `conflicting` onto the delivery record and says a re-run merges up again", async () => {
    const { repo, dir } = publishedTicket("conflicting");
    const streams = capture();

    const code = await withGh(fakeGh("conflicting", ghAnswer("CONFLICTING", "DIRTY")), () =>
      runSyncCommand({ argv: ["PRB-1", "--repo", repo], streams, cwd: repo, now: NOW }),
    );

    expect(code).toBe(EXIT_CODES.approve);
    expect(readTicket(dir, "PRB-1").delivery.mergeable).toBe("conflicting");
    const said = streams.err.join("");
    expect(said).toContain("no longer mergeable");
    expect(said).toContain("perbo run --ticket PRB-1");
  });

  it("records a mergeable pull request as mergeable and says nothing about it", async () => {
    const { repo, dir } = publishedTicket("clean");
    const streams = capture();

    const code = await withGh(fakeGh("clean", ghAnswer("MERGEABLE", "CLEAN")), () =>
      runSyncCommand({ argv: ["PRB-1", "--repo", repo], streams, cwd: repo, now: NOW }),
    );

    expect(code).toBe(EXIT_CODES.approve);
    expect(readTicket(dir, "PRB-1").delivery.mergeable).toBe("mergeable");
    expect(streams.err.join("")).not.toContain("no longer mergeable");
  });

  it("leaves the answer unknown when GitHub has not computed it yet", async () => {
    const { repo, dir } = publishedTicket("unknown");
    const streams = capture();

    await withGh(fakeGh("unknown", ghAnswer("UNKNOWN", "UNKNOWN")), () =>
      runSyncCommand({ argv: ["PRB-1", "--repo", repo], streams, cwd: repo, now: NOW }),
    );

    // GitHub computes mergeability asynchronously, so `UNKNOWN` is "not yet",
    // not "conflicting" — recording it as a conflict would send a person to
    // re-run a ticket whose branch is fine.
    expect(readTicket(dir, "PRB-1").delivery.mergeable).toBe("unknown");
    expect(streams.err.join("")).not.toContain("no longer mergeable");
  });
}, SPAWN_TEST_TIMEOUT_MS);
