import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EXIT_CODES, PROHIBITED_ACTIONS, transition, type Ticket } from "@perbo/contracts";
import { branchName } from "@perbo/workspace";
import { admitCommandLine } from "./admit.js";
import type { Streams } from "../streams.js";
import { makeAttempt } from "../test-support/records.js";
import { recordDelivery, syncCommandLine } from "./sync.js";
import { stopsCommandLine } from "./stops.js";
import { readContract, readTicket, storeDir, writeTicket } from "../store/tickets.js";
import { REPO_ROOT } from "../test-support/paths.js";
import { runCommandLine } from "../command-line/terminal.js";
import { recordStreams } from "../test-support/streams.js";
import { emptyRepository } from "../test-support/repository.js";

/**
 * SCP-202: the loop merges the pull request it opened, behind the `merge`
 * switch, and only when all six of D-077's conditions hold.
 *
 * Every condition is proven against a fake `gh` whose answers this file
 * controls and whose argv it keeps; nothing here runs the real one. Each stop
 * case leaves the other five conditions at their passing value, so a condition
 * dropped from the implementation fails exactly the case that names it.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-sync-merge-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const OUTCOME = "Search results are paginated.";
const PR = 202;
const url = `https://github.com/o/r/pull/${PR}`;
const HEAD = "1c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ff";
const OTHER = "9dead9dead9dead9dead9dead9dead9dead9dea0";
const ATTEMPT = "att_0000000000000202";
/** The unit separator the fake `gh` writes between the arguments of one call. */
const US = "\u001f";

/**
 * A spawned `gh` on a machine that is also running the rest of the gate: the
 * script is `/bin/sh` and answers from a file, but the process start is not
 * free, and a five-second vitest default is what makes that look like a defect
 * (SCP-191). Each case here spawns `gh` three or four times, and the stop table
 * runs seven stores in one case.
 */
const MERGE_TEST_TIMEOUT_MS = 120_000;

/** The D-073 verdict comment a separate review run leaves, naming the head. */
const approvalComment = (sha: string, verdict = "APPROVE"): string =>
  `**D-073 review — claude-opus-5 — verdict: ${verdict}** (head \`${sha.slice(0, 12)}\`)`;

const view = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: PR,
  url,
  state: "OPEN",
  body: "",
  headRefOid: HEAD,
  baseRefName: "main",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  statusCheckRollup: [{ name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }],
  reviews: [],
  comments: [{ body: approvalComment(HEAD) }],
  commits: [{ oid: HEAD, messageHeadline: "PRB-1: paginate", messageBody: `Attempt: ${ATTEMPT}\n` }],
  ...over,
});

const verifiedCommits = (shas: readonly string[] = [HEAD], verified = true): unknown =>
  shas.map((sha) => ({ sha, commit: { verification: { verified, reason: verified ? "valid" : "unsigned" } } }));

interface GhAnswers {
  /** What `gh pr view` answers. */
  view?: Record<string, unknown>;
  /** What it answers from the second call on: the base moving under the merge. */
  viewAgain?: Record<string, unknown>;
  /** What it answers once `gh pr merge` has succeeded. */
  viewMerged?: Record<string, unknown>;
  /** What `gh api …/pulls/N/commits` answers: the signature verification. */
  commitsApi?: unknown;
  /** `gh pr view` fails with this on stderr: there is no pull request to read. */
  viewFails?: string;
  /** `gh pr merge` fails with this on stderr: GitHub refused the merge. */
  mergeFails?: string;
}

interface FakeGh {
  bin: string;
  /** Every invocation, as its argument vector. */
  argv: () => string[][];
}

/**
 * A `gh` on PATH that answers `pr view`, `api`, `auth status` and `pr merge`
 * from files and keeps every argv it was given.
 *
 * Two things about it are the real `gh`'s behaviour rather than convenience:
 * a pull request reads as `MERGED` once `pr merge` has succeeded, and — where
 * the case asks for it — the second `pr view` can answer differently from the
 * first, which is the base moving between the decision and the merge.
 */
function fakeGh(name: string, answers: GhAnswers): FakeGh {
  const root = join(scratch, `gh-${name}`);
  mkdirSync(root, { recursive: true });
  const log = join(root, "argv");
  writeFileSync(join(root, "view.json"), `${JSON.stringify(answers.view ?? view())}\n`);
  writeFileSync(join(root, "view-again.json"), `${JSON.stringify(answers.viewAgain ?? answers.view ?? view())}\n`);
  writeFileSync(
    join(root, "view-merged.json"),
    `${JSON.stringify(answers.viewMerged ?? view({ state: "MERGED" }))}\n`,
  );
  writeFileSync(join(root, "api.json"), `${JSON.stringify(answers.commitsApi ?? verifiedCommits())}\n`);
  if (answers.viewFails !== undefined) writeFileSync(join(root, "view-fails"), answers.viewFails);
  if (answers.mergeFails !== undefined) writeFileSync(join(root, "merge-fails"), answers.mergeFails);
  const script = join(root, "gh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      // One line per invocation, arguments separated by a unit separator so an
      // argument that contains spaces or newlines is still one field.
      `printf '%s\\037' "$@" >> ${log}`,
      `printf '\\n' >> ${log}`,
      'if [ "$1 $2" = "pr view" ]; then',
      `  if [ -f ${root}/view-fails ]; then cat ${root}/view-fails >&2; exit 1; fi`,
      `  if [ -f ${root}/merged ]; then cat ${root}/view-merged.json; exit 0; fi`,
      `  if [ -f ${root}/seen ]; then cat ${root}/view-again.json; exit 0; fi`,
      `  : > ${root}/seen`,
      `  cat ${root}/view.json`,
      "  exit 0",
      "fi",
      'if [ "$1 $2" = "pr merge" ]; then',
      `  if [ -f ${root}/merge-fails ]; then cat ${root}/merge-fails >&2; exit 1; fi`,
      `  : > ${root}/merged`,
      `  echo "Merged pull request #${PR}"`,
      "  exit 0",
      "fi",
      'if [ "$1 $2" = "auth status" ]; then exit 0; fi',
      `if [ "$1" = "api" ]; then cat ${root}/api.json; exit 0; fi`,
      'echo "gh: unexpected $*" >&2',
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return {
    bin: root,
    argv: () =>
      (existsSync(log) ? readFileSync(log, "utf8") : "")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.split(US).filter((field) => field !== "")),
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

/** The `gh` on PATH, and the credential every read and the merge go through. */
const withGh = <T,>(bin: string, body: () => T | Promise<T>): Promise<Awaited<T>> => {
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  process.env.GH_TOKEN = "test-token";
  delete process.env.GITHUB_TOKEN;
  return Promise.resolve(body());
};

/** A ticket at `pr_open` behind a pull request the loop published. */
function publishedTicket(
  name: string,
  config: Record<string, unknown> | null = null,
): { repo: string; dir: string; branch: string } {
  const repo = join(scratch, name);
  emptyRepository(repo);
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
  if (config !== null) writeFileSync(join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
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
  ticket = transition(ticket, "pr_open", "approved; a person merges it", at);
  writeTicket(dir, ticket);

  // The attempt the merge commit's trailer comes from: the loop's own, as the
  // run that opened this pull request recorded it.
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(
    join(dir, "state", `${ticket.ticket_id}.attempts.json`),
    `${JSON.stringify(
      {
        ticket_id: ticket.ticket_id,
        attempts: [
          makeAttempt({
            attempt_id: ATTEMPT,
            ticket_id: ticket.ticket_id,
            created_at: at.toISOString(),
            termination: { reason: "completed", detail: "" },
            usage: { cost_micros: 1000, cost_basis: "transport_reported" },
            changeset_id: "cs_1",
            head_commit: HEAD.slice(0, 7),
          }),
        ],
      },
      null,
      2,
    )}\n`,
  );
  return { repo, dir, branch };
}

const NOW = new Date("2026-09-04T10:00:00.000Z");

/** `perbo sync <KEY> --merge`, with the escape collection left out of it. */
const syncMerge = (repo: string, streams: Streams) =>
  runCommandLine(syncCommandLine, {
    argv: ["PRB-1", "--merge", "--repo", repo],
    streams,
    cwd: repo,
    now: NOW,
    deps: {
      mergeFacts: () => null,
    },
  });

/** The `gh` invocation whose verb is `pr merge`, or undefined if there was none. */
const mergeCall = (calls: string[][]): string[] | undefined =>
  calls.find((call) => call[0] === "pr" && call[1] === "merge");

describe("ac_1 — the switch, and the six conditions", () => {
  it("never merges on a configuration that does not name the switch, and says so", async () => {
    // The default is `person` and it is the whole of the gate: a store with no
    // `merge` key must not merge, whatever else is true of the pull request.
    // Every other condition here passes.
    const { repo, dir } = publishedTicket("default-person");
    const gh = fakeGh("default-person", {});
    const streams = recordStreams();

    const code = await withGh(gh.bin, () => syncMerge(repo, streams));

    expect(mergeCall(gh.argv())).toBeUndefined();
    expect(streams.err()).toContain("merge.switch_is_person");
    // With the sentence the rule id stands for, in the words a person acts on.
    expect(streams.err()).toContain(
      'the `merge` switch is "person", so this merge is a person\'s click: the pull request is open and waiting for one',
    );
    expect(readTicket(dir, "PRB-1").state).toBe("pr_open");
    expect(readTicket(dir, "PRB-1").delivery.merged_by).toBeNull();
    expect(code).toBe(EXIT_CODES.did_not_complete);
  }, MERGE_TEST_TIMEOUT_MS);

  /**
   * One case per condition, each its own test, because the reviewer's mutants
   * remove one condition at a time: a table inside a single test would report
   * every one of them as the same failure.
   */
  const cases: Array<{ name: string; rule: string; answers: GhAnswers }> = [
    {
      name: "no comment carries a D-073 verdict",
      rule: "merge.no_separate_approval",
      answers: { view: view({ comments: [{ body: "looks good to me" }] }) },
    },
    {
      name: "the only D-073 verdict is not an approval",
      rule: "merge.no_separate_approval",
      answers: { view: view({ comments: [{ body: approvalComment(HEAD, "REQUEST_CHANGES") }] }) },
    },
    {
      name: "a check on the head has not finished",
      rule: "merge.checks_not_green",
      answers: {
        view: view({ statusCheckRollup: [{ name: "unit", status: "IN_PROGRESS", conclusion: null }] }),
      },
    },
    {
      name: "GitHub has not computed mergeability",
      rule: "merge.not_mergeable",
      answers: { view: view({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }) },
    },
    {
      name: "a commit carries no loop attempt trailer",
      rule: "merge.commit_outside_loop",
      answers: {
        view: view({
          commits: [
            { oid: HEAD, messageHeadline: "PRB-1: paginate", messageBody: `Attempt: ${ATTEMPT}\n` },
            { oid: OTHER, messageHeadline: "fix a typo", messageBody: "" },
          ],
        }),
        commitsApi: verifiedCommits([HEAD, OTHER]),
      },
    },
    {
      name: "a commit has no verified signature",
      rule: "merge.unverified_signature",
      answers: { commitsApi: verifiedCommits([HEAD], false) },
    },
    {
      name: "the approval names a head that is no longer the head",
      rule: "merge.head_moved_after_approval",
      answers: { view: view({ comments: [{ body: approvalComment(OTHER) }] }) },
    },
  ];

  for (const [index, one] of cases.entries()) {
    it(`stops with ${one.rule} when ${one.name}`, async () => {
      const { repo, dir } = publishedTicket(`stop-${index}`, { merge: "loop" });
      const gh = fakeGh(`stop-${index}`, one.answers);
      const streams = recordStreams();

      const code = await withGh(gh.bin, () => syncMerge(repo, streams));

      expect(mergeCall(gh.argv()), "it merged anyway").toBeUndefined();
      expect(streams.err()).toContain(one.rule);
      expect(readTicket(dir, "PRB-1").state).toBe("pr_open");
      expect(code).toBe(EXIT_CODES.did_not_complete);
    }, MERGE_TEST_TIMEOUT_MS);
  }

  it("merges when all six hold", async () => {
    const { repo, dir } = publishedTicket("all-six", { merge: "loop" });
    const gh = fakeGh("all-six", {});
    const streams = recordStreams();

    const code = await withGh(gh.bin, () => syncMerge(repo, streams));

    expect(mergeCall(gh.argv())).toBeDefined();
    expect(code).toBe(EXIT_CODES.approve);
    expect(readTicket(dir, "PRB-1").state).toBe("merged");
  }, MERGE_TEST_TIMEOUT_MS);
});

describe("ac_1 — the refusals that are not one of the six", () => {
  it("stops with merge.no_pull_request when gh finds none on the branch", async () => {
    const { repo, dir } = publishedTicket("no-pull-request", { merge: "loop" });
    const gh = fakeGh("no-pull-request", {
      viewFails: "no pull requests found for branch\n",
    });
    const streams = recordStreams();

    const code = await withGh(gh.bin, () => syncMerge(repo, streams));

    expect(mergeCall(gh.argv())).toBeUndefined();
    expect(streams.err()).toContain("merge.no_pull_request");
    expect(readTicket(dir, "PRB-1").delivery.merged_by).toBeNull();
    expect(code).toBe(EXIT_CODES.did_not_complete);
  }, MERGE_TEST_TIMEOUT_MS);

  it("stops with merge.no_pull_request when the one on the branch is closed", async () => {
    const { repo, dir } = publishedTicket("closed-pull-request", { merge: "loop" });
    const gh = fakeGh("closed-pull-request", { view: view({ state: "CLOSED" }) });
    const streams = recordStreams();

    const code = await withGh(gh.bin, () => syncMerge(repo, streams));

    expect(mergeCall(gh.argv())).toBeUndefined();
    expect(streams.err()).toContain("merge.no_pull_request");
    expect(readTicket(dir, "PRB-1").delivery.merged_by).toBeNull();
    expect(code).toBe(EXIT_CODES.did_not_complete);
  }, MERGE_TEST_TIMEOUT_MS);

  it("stops with merge.refused_by_github in gh's own words when the merge itself fails", async () => {
    const { repo, dir } = publishedTicket("refused", { merge: "loop" });
    // Two lines, because `gh pr merge` says what it refused on the second one:
    // a stop that quoted only the first would hand a person the symptom and
    // drop the reason.
    const gh = fakeGh("refused", {
      mergeFails:
        "X Pull request #202 is not mergeable\nGraphQL: Base branch was modified. Review and try the merge again.\n",
    });
    const streams = recordStreams();

    const code = await withGh(gh.bin, () => syncMerge(repo, streams));

    // The merge was attempted — this is a refusal by GitHub, not a condition
    // the loop could read beforehand.
    expect(mergeCall(gh.argv())).toBeDefined();
    const said = streams.err();
    expect(said).toContain("merge.refused_by_github");
    expect(said).toContain("Pull request #202 is not mergeable");
    expect(said).toContain("Base branch was modified");
    expect(readTicket(dir, "PRB-1").state).toBe("pr_open");
    expect(readTicket(dir, "PRB-1").delivery.merged_by).toBeNull();
    expect(code).toBe(EXIT_CODES.did_not_complete);
  }, MERGE_TEST_TIMEOUT_MS);
  it("quotes gh's whole refusal, every line of it (D-NEW-nothing-shown-is-cut)", async () => {
    const { repo } = publishedTicket("refused-long", { merge: "loop" });
    const lines = [
      "X Pull request #202 is not mergeable: the merge commit cannot be cleanly created.",
      "To have the pull request merged after all the requirements have been met, add the `--auto` flag.",
      "To use administrator privileges to immediately merge the pull request, add the `--admin` flag.",
      "Run the following to resolve the merge conflicts locally:",
      "  gh pr checkout 202 && git fetch origin main && git merge origin/main",
      "GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)",
    ];
    const gh = fakeGh("refused-long", { mergeFails: `${lines.join("\n")}\n` });
    const streams = recordStreams();

    await withGh(gh.bin, () => syncMerge(repo, streams));

    const said = streams.err();
    expect(lines.join("; ").length).toBeGreaterThan(400);
    for (const line of lines) expect(said).toContain(line.trim());
  }, MERGE_TEST_TIMEOUT_MS);
});

describe("ac_2 — the merge, the trailer, and what is written back", () => {
  it("merges with --merge, carries the attempt id as a trailer, and reads the merge back", async () => {
    const { repo, dir } = publishedTicket("merge-argv", { merge: "loop" });
    const gh = fakeGh("merge-argv", {});
    const streams = recordStreams();

    const code = await withGh(gh.bin, () => syncMerge(repo, streams));
    expect(code).toBe(EXIT_CODES.approve);

    const call = mergeCall(gh.argv());
    expect(call).toBeDefined();
    // Never squash and never rebase: both rewrite the commits, and the attempt
    // trailer on each of them is what SCP-196 reads a merge as the loop's by.
    expect(call).toContain("--merge");
    expect(call).not.toContain("--squash");
    expect(call).not.toContain("--rebase");
    expect(call!.join(" ")).toContain(`Attempt: ${ATTEMPT}`);

    // `sync` read the merge back onto the delivery record, and the ticket
    // walked to `merged` on the same evidence any other sync walks it on.
    const after = readTicket(dir, "PRB-1");
    expect(after.state).toBe("merged");
    expect(after.delivery.state).toBe("merged");
    expect(after.delivery.merged_by).toBe("loop");
  }, MERGE_TEST_TIMEOUT_MS);

  it("counts a merge the loop performed as unattended under SCP-196's rule", async () => {
    const { repo } = publishedTicket("counted", { merge: "loop" });
    const gh = fakeGh("counted", {});

    await withGh(gh.bin, () => syncMerge(repo, recordStreams()));

    const streams = recordStreams();
    await runCommandLine(stopsCommandLine, { argv: ["--repo", repo], streams, cwd: repo, now: NOW });
    expect(streams.out()).toContain("1 merged ticket with a known answer (1 unattended, 0 attended)");
  }, MERGE_TEST_TIMEOUT_MS);
});

describe("ac_3 — serial in phase 1", () => {
  it("refuses to merge while another loop merge is in flight for the same base", async () => {
    const { repo, dir } = publishedTicket("in-flight", { merge: "loop" });
    const gh = fakeGh("in-flight", {});
    // A lock held by a live process on the same base — this process, so the
    // staleness check cannot take it over.
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(
      join(dir, "state", "merge.main.lock.json"),
      `${JSON.stringify(
        {
          pid: process.pid,
          host: hostname(),
          base_ref: "main",
          ticket_key: "AYO-2",
          started_at: NOW.toISOString(),
        },
        null,
        2,
      )}\n`,
    );

    const streams = recordStreams();
    const code = await withGh(gh.bin, () => syncMerge(repo, streams));

    expect(mergeCall(gh.argv())).toBeUndefined();
    expect(streams.err()).toContain("merge.in_flight");
    // The refusal names what holds it, the way SCP-193's run lock does.
    expect(streams.err()).toContain("AYO-2");
    expect(readTicket(dir, "PRB-1").state).toBe("pr_open");
    expect(code).toBe(EXIT_CODES.did_not_complete);
  }, MERGE_TEST_TIMEOUT_MS);

  it("re-reads mergeability immediately before merging, so a base that moved is a stop", async () => {
    // The second `gh pr view` disagrees with the first: between the decision
    // and the merge the base moved, the head moved with it, and GitHub can no
    // longer merge the branch. A stop, rather than a conflict landed.
    const { repo, dir } = publishedTicket("base-moved", { merge: "loop" });
    const gh = fakeGh("base-moved", {
      viewAgain: view({ headRefOid: OTHER, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
    });
    const streams = recordStreams();

    const code = await withGh(gh.bin, () => syncMerge(repo, streams));

    expect(mergeCall(gh.argv())).toBeUndefined();
    expect(streams.err()).toContain("merge.base_moved");
    expect(readTicket(dir, "PRB-1").state).toBe("pr_open");
    expect(code).toBe(EXIT_CODES.did_not_complete);
  }, MERGE_TEST_TIMEOUT_MS);
});

describe("ac_5 — the switch is documented and the executor's brief is unchanged", () => {
  it("documents the switch and its default in docs/04 and beside D-041's gate in docs/08", () => {
    for (const name of ["04-ticket-workspace-and-review.md", "08-security-autonomy-and-data.md"]) {
      const text = readFileSync(join(REPO_ROOT, "docs", name), "utf8");
      expect(text, name).toContain("`merge: loop`");
      expect(text, name).toContain("D-041");
    }
  });

  it("leaves the executor's own brief and its prohibition alone: the runner merges, not the agent", () => {
    // The runner holds the credential and performs the merge, the way it
    // performs the push. Nothing about what the executor may do changed.
    expect(PROHIBITED_ACTIONS).toContain("self_merge");
    const prompt = readFileSync(join(REPO_ROOT, "packages", "runner", "src", "prompt.ts"), "utf8");
    expect(prompt).toContain("Do not commit. Do not push. Do not open a pull request. Do not merge anything.");
  });
});
