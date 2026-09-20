import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EXIT_CODES, transition, type Ticket } from "@perbo/contracts";
import { pollPullRequest, type TicketDeliveryState } from "@perbo/runner";
import { branchName } from "@perbo/workspace";
import { parseAdmitArgs, runAdmitCommand } from "./admit.js";
import type { Streams } from "../streams.js";
import { recordDelivery, runSyncCommand } from "./sync.js";
import { readContract, readTicket, storeDir, writeTicket } from "../store/tickets.js";
import { SPAWN_TEST_TIMEOUT_MS } from "../test-support/spawn-timeout.js";

/**
 * SCP-235/SCP-252 — a closed, unmerged pull request is read as closed, not as
 * "no longer mergeable", and the ticket behind it is walked off `pr_open`.
 *
 * `sync`'s "no longer mergeable" line is about an open branch whose base has
 * moved (SCP-192); neither half of that is true of a pull request GitHub has
 * already closed. D-083 gives the lifecycle somewhere to put such a ticket:
 * `closed`, or `changes_requested` where the pull request carries a D-073
 * CHANGES REQUESTED verdict, because the verdict is the fact about the review
 * and mergeability a fact about a branch the pull request no longer has.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-sync-closed-test-"));
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

/** The comment a separate D-073 review run leaves on the pull request. */
const verdictComment = (verdict: string): { body: string } => ({
  body: `**D-073 review — claude-fable-5-1 — verdict: ${verdict}** (head \`75e790e2b1c4\`)`,
});

/**
 * Reuses `sync.mergeable.test.ts`'s shape, with a `state`/`closedAt` a closed
 * pull request carries and an open one does not, and the comments the verdict
 * is read from.
 */
const ghAnswer = (
  mergeable: string,
  mergeStateStatus: string,
  options: {
    state?: "OPEN" | "CLOSED";
    closedAt?: string | null;
    comments?: Array<{ body: string }>;
  } = {},
): string =>
  `${JSON.stringify({
    number: PR,
    url,
    state: options.state ?? "OPEN",
    body: "",
    mergeable,
    mergeStateStatus,
    closedAt: options.closedAt ?? null,
    statusCheckRollup: [{ name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }],
    reviews: [],
    comments: options.comments ?? [],
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

describe("sync records a pull request GitHub closed without merging", () => {
  it("prints the closed line instead of \"no longer mergeable\", walks to closed, and records closed_at", async () => {
    const { repo, dir } = publishedTicket("closed-conflicting");
    const streams = capture();
    let captured: TicketDeliveryState | undefined;

    const code = await withGh(
      fakeGh("closed-conflicting", ghAnswer("CONFLICTING", "DIRTY", { state: "CLOSED", closedAt: "2026-09-03T04:00:00.000Z" })),
      () =>
        runSyncCommand({
          argv: ["PRB-1", "--repo", repo],
          streams,
          cwd: repo,
          now: NOW,
          poll: async (args) => {
            const result = await pollPullRequest(args);
            captured = result;
            return result;
          },
        }),
    );

    expect(code).toBe(EXIT_CODES.approve);
    const ticket = readTicket(dir, "PRB-1");
    expect(ticket.delivery.state).toBe("closed");
    // D-083: no verdict on the pull request, so the record is simply terminal.
    expect(ticket.state).toBe("closed");
    expect(ticket.history.at(-1)?.from).toBe("pr_open");
    expect(captured?.closed_at).toBe("2026-09-03T04:00:00.000Z");

    const said = streams.err.join("");
    expect(said).not.toContain("no longer mergeable");
    expect(said).toContain(`#${PR}`);
    expect(said).toContain("closed without merging");
    expect(said).not.toContain("stays pr_open");
    expect(said).toContain("is now closed");
  });

  it("walks to changes_requested when the pull request carries a CHANGES REQUESTED verdict", async () => {
    const { repo, dir } = publishedTicket("closed-changes-requested");
    const streams = capture();

    const code = await withGh(
      fakeGh(
        "closed-changes-requested",
        ghAnswer("MERGEABLE", "CLEAN", {
          state: "CLOSED",
          closedAt: "2026-09-03T04:00:00.000Z",
          comments: [{ body: "thanks" }, verdictComment("CHANGES REQUESTED")],
        }),
      ),
      () => runSyncCommand({ argv: ["PRB-1", "--repo", repo], streams, cwd: repo, now: NOW }),
    );

    expect(code).toBe(EXIT_CODES.approve);
    const ticket = readTicket(dir, "PRB-1");
    // The verdict is the fact about the review; the delivery record still says
    // what `gh` said about the pull request itself.
    expect(ticket.state).toBe("changes_requested");
    expect(ticket.delivery.state).toBe("closed");
    expect(ticket.history.at(-1)?.from).toBe("pr_open");

    const said = streams.err.join("");
    expect(said).toContain("closed without merging");
    expect(said).toContain("is now changes_requested");
    expect(said).toContain("CHANGES REQUESTED");
  });

  it("walks to closed when the only verdict on it is an approval", async () => {
    const { repo, dir } = publishedTicket("closed-approved");
    const streams = capture();

    const code = await withGh(
      fakeGh(
        "closed-approved",
        ghAnswer("MERGEABLE", "CLEAN", {
          state: "CLOSED",
          closedAt: "2026-09-03T04:00:00.000Z",
          comments: [verdictComment("APPROVE")],
        }),
      ),
      () => runSyncCommand({ argv: ["PRB-1", "--repo", repo], streams, cwd: repo, now: NOW }),
    );

    expect(code).toBe(EXIT_CODES.approve);
    const ticket = readTicket(dir, "PRB-1");
    expect(ticket.state).toBe("closed");
    expect(ticket.delivery.state).toBe("closed");
    expect(streams.err.join("")).not.toContain("is now changes_requested");
  });

  it("still says \"no longer mergeable\" for an open pull request that conflicts", async () => {
    const { repo, dir } = publishedTicket("still-open-conflicting");
    const streams = capture();

    const code = await withGh(fakeGh("still-open-conflicting", ghAnswer("CONFLICTING", "DIRTY")), () =>
      runSyncCommand({ argv: ["PRB-1", "--repo", repo], streams, cwd: repo, now: NOW }),
    );

    expect(code).toBe(EXIT_CODES.approve);
    expect(readTicket(dir, "PRB-1").delivery.mergeable).toBe("conflicting");
    const said = streams.err.join("");
    expect(said).toContain("no longer mergeable");
    expect(said).not.toContain("closed without merging");
  });
}, SPAWN_TEST_TIMEOUT_MS);
