import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  EXIT_CODES,
  transition,
  type DeliveredCheck,
  type DeliveryChecksState,
  type Ticket,
} from "@perbo/contracts";
import { branchName } from "@perbo/workspace";
import { parseAdmitArgs, runAdmitCommand } from "../src/admit.js";
import type { Streams } from "../src/streams.js";
import { recordDelivery, runSyncCommand } from "../src/sync.js";
import { readContract, readTicket, storeDir, writeTicket } from "../src/tickets.js";

/**
 * What the ticket's delivery record says about the checks on its head.
 *
 * The run reads them after opening the pull request and hands them to
 * `recordDelivery`; every `perbo sync` afterwards re-reads them from `gh` and
 * writes the record whole from what it said. Both halves matter: a run that
 * recorded a red check and a sync that then quietly dropped it would leave the
 * ticket looking exactly like one whose checks were never red.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-delivery-checks-record-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const OUTCOME = "Search results are paginated.";
const PR = 71;
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

const ghAnswer = (rollup: unknown[]): string =>
  `${JSON.stringify({
    number: PR,
    url,
    state: "OPEN",
    body: "",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: rollup,
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
 * `GH_TOKEN` is set rather than inherited: the credential path is decided
 * before the read, so a suite that let the machine's own environment decide it
 * would ask `gh auth status` on one developer's machine and not on another's.
 */
const withGh = <T,>(bin: string, body: () => Promise<T>): Promise<T> => {
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  process.env.GH_TOKEN = "test-token";
  delete process.env.GITHUB_TOKEN;
  return body();
};

const AT = new Date("2026-09-07T09:00:00.000Z");

/**
 * A ticket walked to `pr_open` behind a pull request the run published, with
 * whatever that run read on the head.
 */
function publishedTicket(
  name: string,
  read: { checks: DeliveredCheck[]; state: DeliveryChecksState } | null,
): { repo: string; dir: string; ticket: Ticket } {
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

  let ticket: Ticket = readTicket(dir, "PRB-1");
  ticket = transition(ticket, "provisioning", "run started", AT);
  ticket = transition(ticket, "executing", "1 attempt executed", AT);
  ticket = transition(ticket, "verifying", "no deterministic checks are configured", AT);
  ticket = transition(ticket, "independent_review", "reviewed independently", AT);
  ticket = recordDelivery(
    ticket,
    {
      workspace: { branch },
      pull_request: { url, number: PR },
      ...(read ? { delivery_checks: read } : {}),
    },
    AT,
  );
  ticket = transition(ticket, "pr_open", "approved; a human merges it", AT);
  writeTicket(dir, ticket);
  return { repo, dir, ticket };
}

const NOW = new Date("2026-09-07T10:00:00.000Z");

describe("the checks the run read, on the ticket", () => {
  it("records a failing check with its conclusion rather than a delivery that is green", () => {
    const { ticket } = publishedTicket("failed", {
      state: "checks_failed",
      checks: [
        { name: "build", conclusion: "failure" },
        { name: "lint", conclusion: "success" },
      ],
    });

    expect(ticket.delivery.checks_state).toBe("checks_failed");
    expect(ticket.delivery.checks_state).not.toBe("green");
    expect(ticket.delivery.checks).toEqual([
      { name: "build", conclusion: "failure" },
      { name: "lint", conclusion: "success" },
    ]);
    // The pull request is still open — a red check is not a closed one — and
    // what changed is what the record says about its head.
    expect(ticket.delivery.state).toBe("open");
  });

  it("leaves the reading null where nothing read it, which is not a pass", () => {
    const { ticket } = publishedTicket("unread", null);

    expect(ticket.delivery.checks_state).toBeNull();
    expect(ticket.delivery.checks).toEqual([]);
  });

  it("keeps a failing check on the record when sync rewrites it from `gh`", async () => {
    const { repo, dir } = publishedTicket("resynced", {
      state: "checks_failed",
      checks: [{ name: "build", conclusion: "failure" }],
    });
    const streams = capture();

    const code = await withGh(
      fakeGh(
        "resynced",
        ghAnswer([
          { name: "build", status: "COMPLETED", conclusion: "FAILURE" },
          { name: "lint", status: "IN_PROGRESS" },
        ]),
      ),
      () => runSyncCommand({ argv: ["PRB-1", "--repo", repo], streams, cwd: repo, now: NOW }),
    );

    expect(code).toBe(EXIT_CODES.approve);
    const after = readTicket(dir, "PRB-1");
    // Rewritten whole from what `gh` said, and what it said is still red. A
    // check it reported with no conclusion is `unchecked`, which is not a pass
    // either.
    expect(after.delivery.checks_state).toBe("checks_failed");
    expect(after.delivery.checks).toEqual([
      { name: "build", conclusion: "failure" },
      { name: "lint", conclusion: "unchecked" },
    ]);
  }, 30_000);

  it("records a check still going as unchecked beside one that concluded, and a legacy context under its own name", async () => {
    const { repo, dir } = publishedTicket("running", null);
    const streams = capture();

    const code = await withGh(
      fakeGh(
        "running",
        ghAnswer([
          { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
          // `gh` prints the conclusion of a check run that has not finished as
          // an empty string rather than leaving the field out.
          { __typename: "CheckRun", name: "validate", status: "IN_PROGRESS", conclusion: "" },
          // A legacy status context carries no `status` and no `conclusion`,
          // and names itself with `context`.
          { __typename: "StatusContext", context: "ci/legacy", state: "PENDING" },
        ]),
      ),
      () => runSyncCommand({ argv: ["PRB-1", "--repo", repo], streams, cwd: repo, now: NOW }),
    );

    // That the sync returned at all is half the claim: an empty conclusion
    // carried through to the write is neither a conclusion the record can hold
    // nor `unchecked`, and the write refuses it — a `ZodError` out of
    // `runSyncCommand` in place of a delivery record.
    expect(code).toBe(EXIT_CODES.approve);
    const after = readTicket(dir, "PRB-1");
    expect(after.delivery.checks).toEqual([
      { name: "build", conclusion: "success" },
      { name: "validate", conclusion: "unchecked" },
      { name: "ci/legacy", conclusion: "unchecked" },
    ]);
    // One check that has not concluded leaves the whole reading unchecked,
    // which is not a pass.
    expect(after.delivery.checks_state).toBe("unchecked");
  }, 30_000);
});
