import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EXIT_CODES, transition, type Ticket } from "@perbo/contracts";
import { branchName } from "@perbo/workspace";
import { admitCommandLine } from "./admit.js";
import { derivedBranch, syncCommandLine } from "./sync.js";
import { readContract, readTicket, storeDir, writeTicket } from "../store/tickets.js";
import { makeAttempt } from "../test-support/records.js";
import { SPAWN_TEST_TIMEOUT_MS } from "@perbo/test-support";
import { runCommandLine } from "../command-line/terminal.js";
import { recordStreams } from "../test-support/streams.js";
import { emptyRepository } from "../test-support/repository.js";

/**
 * `perbo sync` brings a **stranded** ticket back.
 *
 * A run killed between opening the pull request and moving the ticket leaves the
 * ticket saying `executing` for ever, and until this there was no command that
 * could correct it. Sync derives the branch the runner would have used, asks
 * `gh` about it once, and walks the ticket to where the attempts record and the
 * pull request together support — or refuses.
 *
 * `gh` is faked as a **binary on PATH**, not as a stub passed into the command:
 * the criterion is about the process this command starts and the branch name it
 * puts on the command line, and a double injected through `poll` would only
 * prove that a function this file also wrote was called.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-sync-reconcile-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const OUTCOME = "Search results are paginated.";

function repository(name: string): string {
  const dir = join(scratch, name);
  emptyRepository(dir);
  return dir;
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
const withGh = <T,>(bin: string, body: () => T | Promise<T>): Promise<Awaited<T>> => {
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  process.env.GH_TOKEN = "test-token";
  delete process.env.GITHUB_TOKEN;
  return Promise.resolve(body());
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
 * A ticket stranded mid-run: admitted and approved, walked into `state`, and
 * with **no branch on its delivery record** — which is exactly what a run killed
 * before `recordDelivery` leaves behind. Its attempts are on the branch the
 * runner provisioned for it, unless `attemptsOn` names another.
 */
function stranded(
  name: string,
  state: Ticket["state"],
  attempts: Array<{ attempt_id: string; reason: "completed" | "cost_ceiling_exceeded" }> = [
    { attempt_id: "att_reconcile01", reason: "completed" },
  ],
  options: { writeAttemptsFile?: boolean; attemptsOn?: (ticket: Ticket) => string } = {},
): { repo: string; dir: string; ticket: Ticket; branch: string } {
  const repo = repository(name);
  runCommandLine(admitCommandLine, { argv: admitArgv(repo), streams: recordStreams(), cwd: repo });
  const dir = storeDir(repo, null);
  const at = new Date("2026-09-01T09:00:00.000Z");

  let ticket = readTicket(dir, "PRB-1");
  const route = ["provisioning", "executing", "verifying", "independent_review"] as const;
  for (const to of route.slice(0, route.indexOf(state as (typeof route)[number]) + 1)) {
    ticket = transition(ticket, to, "run started", at);
  }
  writeTicket(dir, ticket);
  const branch = branchName({
    ticket_key: "PRB-1",
    ticket_id: ticket.ticket_id,
    outcome: readContract(dir, "PRB-1").outcome,
  });

  if (options.writeAttemptsFile !== false) {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(
      join(dir, "state", `${ticket.ticket_id}.attempts.json`),
      `${JSON.stringify(
        {
          ticket_id: ticket.ticket_id,
          attempts: attempts.map((entry) =>
            makeAttempt({
              attempt_id: entry.attempt_id,
              ticket_id: ticket.ticket_id,
              created_at: "2026-09-01T09:05:00.000Z",
              termination: { reason: entry.reason, detail: "" },
              usage: {},
              changeset_id: entry.reason === "completed" ? "cs_reconcile01" : null,
              head_commit: entry.reason === "completed" ? "b2c3d4e" : null,
              branch: options.attemptsOn?.(ticket) ?? branch,
            }),
          ),
        },
        null,
        2,
      )}\n`,
    );
  }

  return { repo, dir, ticket, branch };
}

const ticketFile = (dir: string) => join(dir, "tickets", "PRB-1.json");
const NOW = new Date("2026-09-02T10:00:00.000Z");

describe("perbo sync derives the stranded ticket's branch and asks gh about it once", () => {
  const states = ["provisioning", "executing", "verifying", "independent_review"] as const;

  for (const state of states) {
    it(`asks gh exactly once, for the runner's branch name, from ${state}`, async () => {
      const { repo, dir, ticket, branch } = stranded(`derive-${state}`, state);
      const gh = fakeGh(`derive-${state}`, { stdout: ghAnswer("OPEN") });

      // Independently of the naming function: `prb/<ticket id>/<outcome slug>`.
      const slug = "search-results-are-paginated";
      expect(branch).toBe(`prb/${ticket.ticket_id.replace("ticket_", "")}/${slug}`);
      expect(readTicket(dir, "PRB-1").delivery.branch).toBeNull();

      await withGh(gh.bin, () =>
        runCommandLine(syncCommandLine, { argv: ["PRB-1", "--repo", repo], streams: recordStreams(), cwd: repo, now: NOW }),
      );

      const calls = gh.invocations();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.slice(0, 3)).toEqual(["pr", "view", branch]);
      // And the branch it derived is now on the record it could not find one on.
      expect(readTicket(dir, "PRB-1").delivery.branch).toBe(branch);
    });
  }

  it("keeps the branch the attempts record names, whatever the ticket's key derives now", async () => {
    // The branch the ticket's attempts were on: `ayo/`, which PRB-1 does not derive.
    const onAyo = (ticket: Ticket) => `ayo/${ticket.ticket_id.replace("ticket_", "")}/search-results-are-paginated`;
    const { repo, dir, ticket } = stranded("recorded-ayo", "executing", undefined, { attemptsOn: onAyo });
    const gh = fakeGh("recorded-ayo", { stdout: ghAnswer("OPEN") });

    await withGh(gh.bin, () =>
      runCommandLine(syncCommandLine, { argv: ["PRB-1", "--repo", repo], streams: recordStreams(), cwd: repo, now: NOW }),
    );

    const calls = gh.invocations();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 3)).toEqual(["pr", "view", onAyo(ticket)]);
    expect(readTicket(dir, "PRB-1").delivery.branch).toBe(onAyo(ticket));
  });

  it("derives a new name only where nothing records one", async () => {
    const { repo, ticket } = stranded("recorded-none", "executing", []);
    const gh = fakeGh("recorded-none", { stdout: ghAnswer("OPEN") });

    await withGh(gh.bin, () =>
      runCommandLine(syncCommandLine, { argv: ["PRB-1", "--repo", repo], streams: recordStreams(), cwd: repo, now: NOW }),
    );

    expect(gh.invocations()[0]?.slice(0, 3)).toEqual([
      "pr",
      "view",
      `prb/${ticket.ticket_id.replace("ticket_", "")}/search-results-are-paginated`,
    ]);
  });

  it("reads the branch the delivery record names without needing the contract", () => {
    const { dir, ticket } = stranded("recorded-delivery", "executing", [], { writeAttemptsFile: false });
    const recorded = `ayo/${ticket.ticket_id.replace("ticket_", "")}/search-results-are-paginated`;
    // With a branch on record, nothing has to be derived, so the contract is never read.
    rmSync(join(dir, "tickets", "PRB-1.contract.json"));
    expect(derivedBranch(dir, "PRB-1", { ...ticket, delivery: { ...ticket.delivery, branch: recorded } })).toBe(
      recorded,
    );
  });
}, SPAWN_TEST_TIMEOUT_MS);

describe("what gh and the attempts record say decides where the ticket lands", () => {
  it("walks an open pull request over a completed attempt to pr_open", async () => {
    const { repo, dir } = stranded("evidence-open", "executing");
    const gh = fakeGh("evidence-open", { stdout: ghAnswer("OPEN") });
    const streams = recordStreams();

    const code = await withGh(gh.bin, () =>
      runCommandLine(syncCommandLine, { argv: ["PRB-1", "--repo", repo], streams, cwd: repo, now: NOW }),
    );

    expect(code).toBe(EXIT_CODES.approve);
    const ticket = readTicket(dir, "PRB-1");
    expect(ticket.state).toBe("pr_open");
    expect(ticket.delivery).toMatchObject({ state: "open", pull_request_url: PR_URL, pull_request_number: 41 });
  });

  it("moves a closed, unmerged pull request to changes_requested", async () => {
    const { repo, dir } = stranded("evidence-closed", "executing");
    const gh = fakeGh("evidence-closed", { stdout: ghAnswer("CLOSED") });

    const code = await withGh(gh.bin, () =>
      runCommandLine(syncCommandLine, { argv: ["PRB-1", "--repo", repo], streams: recordStreams(), cwd: repo, now: NOW }),
    );

    expect(code).toBe(EXIT_CODES.approve);
    const ticket = readTicket(dir, "PRB-1");
    expect(ticket.state).toBe("changes_requested");
    expect(ticket.delivery.state).toBe("closed");
  });

  it("leaves the ticket exactly as it was when gh finds no pull request", async () => {
    const { repo, dir } = stranded("evidence-none", "executing");
    // What `gh pr view` actually does for a branch with no pull request.
    const gh = fakeGh("evidence-none", {
      stdout: "",
      stderr: 'no pull requests found for branch "ayo/x/y"\n',
      code: 1,
    });
    const before = readFileSync(ticketFile(dir), "utf8");
    const streams = recordStreams();

    const code = await withGh(gh.bin, () =>
      runCommandLine(syncCommandLine, { argv: ["PRB-1", "--repo", repo], streams, cwd: repo, now: NOW }),
    );

    expect(code).toBe(EXIT_CODES.did_not_complete);
    expect(readFileSync(ticketFile(dir), "utf8")).toBe(before);
    expect(readTicket(dir, "PRB-1").state).toBe("executing");
    expect(streams.err()).toContain("found no pull request");
  });

  it("carries a merged pull request all the way from executing", async () => {
    const { repo, dir } = stranded("evidence-merged", "executing");
    const gh = fakeGh("evidence-merged", { stdout: ghAnswer("MERGED") });

    await withGh(gh.bin, () =>
      runCommandLine(syncCommandLine, { argv: ["PRB-1", "--repo", repo], streams: recordStreams(), cwd: repo, now: NOW }),
    );

    const ticket = readTicket(dir, "PRB-1");
    expect(ticket.state).toBe("merged");
    expect(ticket.history.map((entry) => entry.to)).toContain("pr_open");
  });
}, SPAWN_TEST_TIMEOUT_MS);

describe("the history a reconciliation writes says it is a reconciliation", () => {
  it("marks every state it wrote as reconciled from the record, claiming no observation", async () => {
    const { repo, dir, ticket: before } = stranded("provenance", "provisioning");
    const gh = fakeGh("provenance", { stdout: ghAnswer("OPEN") });

    await withGh(gh.bin, () =>
      runCommandLine(syncCommandLine, { argv: ["PRB-1", "--repo", repo], streams: recordStreams(), cwd: repo, now: NOW }),
    );

    const after = readTicket(dir, "PRB-1");
    const written = after.history.slice(before.history.length);
    expect(written.map((entry) => entry.to)).toEqual([
      "executing",
      "verifying",
      "independent_review",
      "pr_open",
    ]);
    for (const entry of written) {
      expect(entry.at).toBe(NOW.toISOString());
      expect(entry.note).toContain("reconciled after the fact by `perbo sync`");
      expect(entry.note).toMatch(/from the attempts record|from `gh`/);
      // Nothing here was watched happening: the run that would have been
      // watched is the one that died and left the ticket stranded.
      expect(entry.note).not.toMatch(/\bobserv(ed|ing)\b|\bwatched\b|\bwitnessed\b|\bsaw\b|\bseen\b/i);
    }
  });
}, SPAWN_TEST_TIMEOUT_MS);

describe("sync refuses rather than inventing a history it cannot walk", () => {
  it("makes no change at all when the evidence names a state no row reaches", async () => {
    // A pull request exists, and the record says no attempt ever completed. The
    // two disagree, so there is no `independent_review` step, and `pr_open` is
    // unreachable from where the walk stops at `verifying`.
    const { repo, dir } = stranded("refusal", "provisioning", [
      { attempt_id: "att_reconcile02", reason: "cost_ceiling_exceeded" },
    ]);
    const gh = fakeGh("refusal", { stdout: ghAnswer("OPEN") });
    const before = readFileSync(ticketFile(dir), "utf8");
    const streams = recordStreams();

    const code = await withGh(gh.bin, () =>
      runCommandLine(syncCommandLine, { argv: ["PRB-1", "--repo", repo], streams, cwd: repo, now: NOW }),
    );

    expect(code).toBe(EXIT_CODES.did_not_complete);
    expect(readFileSync(ticketFile(dir), "utf8")).toBe(before);

    const reported = streams.err();
    expect(reported).toContain("refusing to reconcile it to pr_open");
    expect(reported).toContain("the run ended pr_open and the ticket is verifying, which has no row to it");
  });

  it("refuses when there is no attempts record to reconcile from", async () => {
    const { repo, dir } = stranded("refusal-norecord", "provisioning", [], { writeAttemptsFile: false });
    const gh = fakeGh("refusal-norecord", { stdout: ghAnswer("OPEN") });
    const before = readFileSync(ticketFile(dir), "utf8");
    const streams = recordStreams();

    const code = await withGh(gh.bin, () =>
      runCommandLine(syncCommandLine, { argv: ["PRB-1", "--repo", repo], streams, cwd: repo, now: NOW }),
    );

    expect(code).toBe(EXIT_CODES.did_not_complete);
    expect(readFileSync(ticketFile(dir), "utf8")).toBe(before);
    expect(streams.err()).toContain("refusing to reconcile it to pr_open");
  });
}, SPAWN_TEST_TIMEOUT_MS);
