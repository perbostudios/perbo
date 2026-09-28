import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ANSWERS_OWED_NOTE,
  DECISION_WORDS,
  EXIT_CODES,
  TicketSchema,
  findingKey,
  gateClosedNote,
  incompleteNote,
  transition,
  type Finding,
  type Ticket,
} from "@perbo/contracts";
import type { PreflightRequest, PreflightResult } from "@perbo/runner";
import { initRepository } from "@perbo/test-support";
import { admitCommandLine } from "../admit.js";
import { verdictCommandLine } from "../verdict/index.js";
import { type ExecuteDeps, executeCommandLine } from "./index.js";
import { readTicket, storeDir, writeTicket } from "../../store/tickets.js";
import { runCommandLine } from "../../command-line/terminal.js";
import { makeReview } from "../../test-support/records.js";
import { recordStreams } from "../../test-support/streams.js";

/**
 * D-132 at the command line: a ticket whose refinement stalled has the
 * findings it left open put to the person, and `perbo run` continues on their
 * answers exactly as after an escalation.
 *
 * PRB-15's shape: the review routes three findings to the executor, round 1
 * closes one, round 2 closes none, and the run ends `remediation_stalled`. The
 * person ships one as it is and leaves the approach to the executor for the
 * other with `perbo verdict --decide`. The next `perbo run` executes one round
 * on the one handed on, with nothing else, verifies it closed, and delivers.
 * The executor is a real program the runner spawns; the reviewer and the
 * verifier are stand-ins, since paying a provider is not what this is about.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-run-stalled-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const OUTCOME = "The feature module exports a computed total";

/**
 * An executor that writes a new line to one file on every call, so each round
 * changes the branch, and declines `declines` (D-065) whenever its prompt names it.
 */
function agent(dir: string, declines: string | null = null): string {
  const binary = join(dir, "agent.cjs");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
"use strict";
const { appendFileSync, mkdirSync } = require("node:fs");
const { dirname, join } = require("node:path");
if (process.argv.includes("--version")) {
  process.stdout.write("fake-agent 1.0.0\\n");
  process.exit(0);
}
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ type: "system", subtype: "init", apiKeySource: "none", mcp_servers: [], plugins: [], skills: [], agents: [], memory_paths: null });
const input = { file_path: "src/feature.ts", content: "export const total = " + process.hrtime.bigint() + ";\\n" };
emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_fake_1", name: "Write", input }], usage: { input_tokens: 7, output_tokens: 2 } } });
const path = join(process.cwd(), input.file_path);
mkdirSync(dirname(path), { recursive: true });
appendFileSync(path, input.content);
const declines = ${JSON.stringify(declines)};
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";
const result = declines !== null && prompt.includes(declines) ? "NO_PRACTICE " + declines + ": which fixture loads is a product call" : "done";
emit({ type: "result", subtype: "success", is_error: false, result, total_cost_usd: 0.004, permission_denials: [] });
process.exit(0);
`,
    { mode: 0o755 },
  );
  chmodSync(binary, 0o755);
  return binary;
}

/** A `gh` on PATH that logs each argv and answers `pr create`, and fails everything else. */
function fakeGh(dir: string, log: string): string {
  const bin = join(dir, "gh-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `for arg in "$@"; do printf '%s\\n' "$arg" >> "${log}"; done`,
      `printf -- '--\\n' >> "${log}"`,
      'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
      '  echo "https://github.com/o/r/pull/15"',
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return bin;
}

const okPreflight = (_request: PreflightRequest): PreflightResult => ({ ok: true, findings: [], tools: {}, github: null });

/** Three findings the review routes to the executor. */
const FINDINGS = ["src/a.ts", "src/b.ts", "src/c.ts"].map((file) => ({
  key: findingKey({ rule_id: "verification.execution_missing", criterion_id: "ac_1", file, symbol: null }),
  file,
}));
const [SHIPPED, HANDED, CLOSED_EARLY] = FINDINGS.map((finding) => finding.key) as [string, string, string];

/** A reviewer that routes `findings` to the executor, on the commit it was handed. */
const remediableWith = (findings: ReadonlyArray<{ key: string; file: string }>) => async (request: { changeset?: { changeset_id: string }; head_commit?: string }) => {
  const base = makeReview({
    review_id: "rev_0000000000000015",
    changeset_id: request.changeset?.changeset_id ?? "cs_0000000000000001",
    decision: "remediable",
    cost_basis: "unavailable",
  });
  const template = base.findings[0]!;
  return {
    artifact: {
      ...base,
      target: { ...base.target, head_commit: request.head_commit ?? base.target.head_commit },
      checks: [],
      findings: findings.map(
        ({ key, file }): Finding => ({
          ...template,
          key,
          rule_id: "verification.execution_missing",
          file,
          statement: `No execution result establishes ${file}.`,
        }),
      ),
    },
    bundle: { prompt_version: "reviewer_v2", system_prompt: "s", turns: [], files_read: [], rejected_verdicts: [] },
  };
};

/** A reviewer that routes the three findings to the executor. */
const remediable = remediableWith(FINDINGS);

/** A closure verifier that records what each round was given and closes what `closes` names. */
const verifier = (seen: string[][], closes: (round: number) => readonly string[]) =>
  (async (input: { findings: Array<{ key: string }> }) => {
    const keys = input.findings.map((entry) => entry.key);
    seen.push(keys);
    const closed = new Set(closes(seen.length));
    const open = keys.filter((key) => !closed.has(key));
    return {
      prompt_version: "closure_verify_v1",
      per_finding: keys.map((finding_key) => ({
        finding_key,
        status: closed.has(finding_key) ? "closed" : "not_closed",
        pointer: "src/feature.ts",
      })),
      deterministic_failure: null,
      all_closed: open.length === 0,
      open_keys: open,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      cost_micros: 30,
      cost_basis: "provider_list_estimate",
    };
  }) as never;

const noReview = (async () => {
  throw new Error("a run that continues a review's findings reviews nothing again");
}) as never;

/** A repository with PRB-1 admitted and approved, and what a run of it needs. */
function fixture(declines: string | null = null): { repo: string; config: string; key: string; gh: string; ghLog: string } {
  const dir = mkdtempSync(join(scratch, "ticket-"));
  const repo = join(dir, "repo");
  initRepository(repo, {
    files: { "package.json": JSON.stringify({ name: "fixture" }), "src/index.ts": "export const version = 1;\n" },
  });
  const admitted = recordStreams();
  const code = runCommandLine(admitCommandLine, {
    argv: [
      "--repo", repo,
      "--outcome", OUTCOME,
      "--criterion", "total() returns the sum of its inputs :: total([1,2]) is 3 :: test",
      "--path", "src/**",
      "--approve",
      "--json",
    ],
    streams: admitted,
    cwd: repo,
  });
  if (code !== EXIT_CODES.approve) throw new Error(admitted.err());
  const config = join(dir, "run.json");
  writeFileSync(
    config,
    JSON.stringify({
      worktree_root: join(dir, "worktrees"),
      agent_binary: agent(dir, declines),
      model: "double",
      max_remediation_rounds: 3,
      materialization_manifest: {
        manifest_version: 1,
        repository_id: "repo_fixture",
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
        isolation: { mode: "parallel", port_range_size: 0, port_range_start: 41_000, port_range_end: 41_009, database_schema_prefix: null },
      },
      limits: { organisation: "test", limits: { concurrent_local_attempts: 4 } },
    }),
  );
  const ghLog = join(dir, "gh.log");
  return { repo, config, key: admitted.json<{ ticket: { key: string } }>().ticket.key, gh: fakeGh(dir, ghLog), ghLog };
}

const originalPath = process.env.PATH;

async function run(
  at: ReturnType<typeof fixture>,
  deps: Partial<ExecuteDeps>,
  argv: readonly string[] = [],
): Promise<{ code: number; err: string; out: string }> {
  const streams = recordStreams();
  process.env.PATH = `${at.gh}:${originalPath ?? ""}`;
  try {
    const code = await runCommandLine(executeCommandLine, {
      argv: ["--repo", at.repo, "--ticket", at.key, "--config", at.config, "--json", ...argv],
      streams,
      cwd: at.repo,
      deps: { preflight: okPreflight, ...deps },
    });
    return { code, err: streams.err(), out: streams.out() };
  } finally {
    process.env.PATH = originalPath;
  }
}

async function decide(at: ReturnType<typeof fixture>, key: string, choice: string): Promise<number> {
  return runCommandLine(verdictCommandLine, {
    argv: [at.key, "--decide", key, "--choice", choice, "--author", "Owen <owen@example.com>", "--repo", at.repo],
    streams: recordStreams(),
    cwd: at.repo,
    now: new Date(),
  });
}

/** Run 1 on a fresh ticket: round 1 closes CLOSED_EARLY, round 2 closes nothing, and the run stalls. */
async function stalledTicket(): Promise<ReturnType<typeof fixture>> {
  const at = fixture();
  const rounds: string[][] = [];
  const first = await run(at, {
    hooks: {
      review: remediable as never,
      verify: verifier(rounds, (round) => (round === 1 ? [CLOSED_EARLY] : [])),
    },
  });
  expect(first.code, first.err).toBe(2);
  expect(readTicket(storeDir(at.repo, null), at.key).history.at(-1)?.note).toBe(gateClosedNote("remediation_stalled"));
  return at;
}

/** Every port that would execute, review or verify fails the test. */
const nothingRuns = {
  agent: (async () => {
    throw new Error("a refused run executes nothing");
  }) as never,
  review: noReview,
  verify: (async () => {
    throw new Error("a refused run verifies nothing");
  }) as never,
};

describe("perbo run after a refinement that stalled", () => {
  it("is refused before the ticket moves while what it left open is unanswered, and keeps an answer already given", async () => {
    const at = await stalledTicket();
    const store = storeDir(at.repo, null);
    const before = readTicket(store, at.key);

    const refused = await run(at, { hooks: nothingRuns });
    expect(refused.code, refused.err).toBe(EXIT_CODES.did_not_complete);
    expect(refused.err).toContain(
      `error: ${at.key}'s last run finished trying and left 2 finding(s) for you to answer ` +
        `(${SHIPPED.slice(0, 12)}, ${HANDED.slice(0, 12)}), none of them handed to the executor, so this run does not ` +
        `start: answer each with \`perbo verdict ${at.key} --decide <finding> --choice approach|let-it-decide|ship-as-is\`, ` +
        `and \`perbo options ${at.key} --finding <finding>\` offers answers to pick`,
    );
    expect(readTicket(store, at.key)).toEqual(before);

    // One shipped as it is and the other unanswered: nothing is handed on, so
    // the run is still refused, and the answer given stands for the next.
    expect(await decide(at, SHIPPED, "ship-as-is")).toBe(0);
    const still = await run(at, { hooks: nothingRuns });
    expect(still.code, still.err).toBe(EXIT_CODES.did_not_complete);
    expect(still.err).toContain(`left 1 finding(s) for you to answer (${HANDED.slice(0, 12)})`);
    expect(readTicket(store, at.key)).toEqual(before);

    expect(await decide(at, HANDED, "ship-as-is")).toBe(0);
    const delivered = await run(at, { hooks: nothingRuns });
    expect(delivered.code, delivered.err).toBe(0);
    expect(readTicket(store, at.key).state).toBe("pr_open");
  }, 300_000);

  it("continues only the finding handed on, and leaves the unanswered one with the person", async () => {
    const at = await stalledTicket();
    expect(await decide(at, HANDED, "let-it-decide")).toBe(0);
    const rounds: string[][] = [];
    const second = await run(at, { hooks: { review: noReview, verify: verifier(rounds, () => [HANDED]) } });
    expect(rounds).toEqual([[HANDED]]);
    expect(second.code, second.err).toBe(2);
    expect((JSON.parse(second.out) as { outcome: string; detail: string }).outcome).toBe("escalated");
    expect((JSON.parse(second.out) as { detail: string }).detail).toContain(SHIPPED);
    expect(readTicket(storeDir(at.repo, null), at.key).state).toBe("changes_requested");
  }, 300_000);


  it("continues only the finding the person handed on, and delivers once it is closed", async () => {
    const at = fixture();
    const store = storeDir(at.repo, null);

    const firstRounds: string[][] = [];
    const first = await run(at, {
      hooks: {
        review: remediable as never,
        verify: verifier(firstRounds, (round) => (round === 1 ? [CLOSED_EARLY] : [])),
      },
    });
    expect(first.code, first.err).toBe(2);
    expect(firstRounds).toEqual([
      [SHIPPED, HANDED, CLOSED_EARLY],
      [SHIPPED, HANDED],
    ]);
    const stalled = readTicket(store, at.key);
    expect(stalled.state).toBe("changes_requested");
    expect(stalled.history.at(-1)?.note).toBe(gateClosedNote("remediation_stalled"));

    // The person answers what the loop left open; the one a round closed takes no answer.
    expect(await decide(at, SHIPPED, "ship-as-is")).toBe(0);
    expect(await decide(at, HANDED, "let-it-decide")).toBe(0);

    const secondRounds: string[][] = [];
    const second = await run(at, { hooks: { review: noReview, verify: verifier(secondRounds, () => [HANDED]) } });
    expect(second.code, second.err).toBe(0);
    expect(secondRounds).toEqual([[HANDED]]);
    expect(readTicket(store, at.key).state).toBe("pr_open");

    // Its branch published later lists the person's answers, read on the same rule.
    const published = await run(
      at,
      { hooks: { review: noReview, push: (async () => ({ pushed: true, detail: "recorded" })) as never } },
      ["--publish-retained"],
    );
    expect(published.code, published.err).toBe(0);
    const log = existsSync(at.ghLog) ? readFileSync(at.ghLog, "utf8") : "";
    expect(log).toContain("### Decided by a person");
    expect(log).toContain(`decided by Owen: ${DECISION_WORDS.ship_as_is}`);
  }, 300_000);
});

/** `git` in a fixture repository, as a person at a terminal runs it. */
const git = (repo: string, ...args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Owen",
      GIT_AUTHOR_EMAIL: "owen@example.com",
      GIT_COMMITTER_NAME: "Owen",
      GIT_COMMITTER_EMAIL: "owen@example.com",
    },
  }).trim();

describe("perbo run where the loop refuses what the command let through", () => {
  // Another run of the ticket ends between the command's reading of it and
  // the loop's: its rows, and the pull request it published, are on the
  // ticket by the time the loop refuses.
  it.each([
    ["changes_requested", gateClosedNote("remediation_stalled")],
    ["failed", incompleteNote("terminated")],
  ] as const)(
    "appends the row that returns it to %s, and every row the other run wrote stands",
    async (left, ending) => {
      const at = await stalledTicket();
      const store = storeDir(at.repo, null);
      const branch = readTicket(store, at.key).delivery.branch!;
      const judged = git(at.repo, "rev-parse", `refs/heads/${branch}`);
      // A commit a person made on the branch by hand: the command reviews that
      // afresh, so it lets the run through...
      const byHand = git(at.repo, "commit-tree", `${judged}^{tree}`, "-p", judged, "-m", "a fix by hand");
      git(at.repo, "update-ref", `refs/heads/${branch}`, byHand);
      let meanwhile: Ticket | null = null;
      const refused = await run(at, {
        hooks: nothingRuns,
        preflight: (request) => {
          // ...the other run ends, publishing its pull request...
          let other = transition(readTicket(store, at.key), "ready", "new attempt after changes_requested");
          other = transition(other, "provisioning", "run started against plan_other");
          for (const to of ["executing", "verifying", "independent_review"] as const) other = transition(other, to, to);
          other = transition(other, left, ending);
          meanwhile = TicketSchema.parse({
            ...other,
            delivery: {
              ...other.delivery,
              pull_request_url: "https://github.com/o/r/pull/16",
              pull_request_number: 16,
              state: "open",
              opened_by: "loop",
              observed_at: new Date().toISOString(),
            },
          });
          writeTicket(store, meanwhile);
          // ...and by the time the loop holds its lock the branch is back at
          // the commit judged, which the loop refuses.
          git(at.repo, "update-ref", `refs/heads/${branch}`, judged);
          return okPreflight(request);
        },
      });
      expect(refused.code, refused.err).toBe(EXIT_CODES.did_not_complete);
      expect(refused.err).toContain(`error: ${at.key}'s last run finished trying and left 2 finding(s) for you to answer`);
      const ticket = readTicket(store, at.key);
      const other = meanwhile!;
      // Appended to, never rewritten: the other run's rows and its pull request stand.
      expect(ticket.history.slice(0, other.history.length)).toEqual(other.history);
      expect(ticket.delivery).toEqual(other.delivery);
      expect(ticket.history.slice(other.history.length)).toMatchObject([
        { from: left, to: "ready", note: `new attempt after ${left}` },
        { from: "ready", to: "provisioning" },
        { from: "provisioning", to: left, note: ANSWERS_OWED_NOTE },
      ]);
      expect(ticket.state).toBe(left);

      // The next run is refused before it moves the ticket, as any run owed answers is.
      const again = await run(at, { hooks: nothingRuns });
      expect(again.code, again.err).toBe(EXIT_CODES.did_not_complete);
      expect(readTicket(store, at.key)).toEqual(ticket);
    },
    300_000,
  );
});

/**
 * D-132 beside D-065 at the command line: a refinement stalls with one finding
 * the executor declined and one it could not close, the person ships the other
 * as it is, and the next run delivers without a round. It ends `escalated`
 * over the decline and lands where every escalated run lands, publishing or
 * not.
 */
describe("perbo run on answers that leave a finding the executor declined", () => {
  const [DECLINED, ANSWERED] = ["src/d.ts", "src/e.ts"].map((file) => ({
    key: findingKey({ rule_id: "verification.execution_missing", criterion_id: "ac_1", file, symbol: null }),
    file,
  })) as [{ key: string; file: string }, { key: string; file: string }];

  it.each([
    ["not publishing", false],
    ["publishing", true],
  ] as const)("lands at changes_requested on the escalated run's row, %s", async (_label, publish) => {
    const at = fixture(DECLINED.key);
    const store = storeDir(at.repo, null);
    const verified: string[][] = [];
    const first = await run(at, {
      hooks: { review: remediableWith([DECLINED, ANSWERED]) as never, verify: verifier(verified, () => []) },
    });
    expect(first.code, first.err).toBe(2);
    expect(verified).toEqual([[ANSWERED.key]]);
    expect(readTicket(store, at.key).history.at(-1)?.note).toBe(gateClosedNote("remediation_stalled"));

    expect(await decide(at, ANSWERED.key, "ship-as-is")).toBe(0);
    const delivered = await run(
      at,
      { hooks: { ...nothingRuns, push: (async () => ({ pushed: true, detail: "recorded" })) as never } },
      publish ? ["--publish"] : [],
    );
    expect(delivered.code, delivered.err).toBe(2);
    const result = JSON.parse(delivered.out) as { outcome: string; rounds: unknown[] };
    expect([result.outcome, result.rounds]).toEqual(["escalated", []]);
    expect(delivered.err).toContain(`${at.key} is now changes_requested`);
    const ticket = readTicket(store, at.key);
    expect(ticket.state).toBe("changes_requested");
    expect(ticket.history.at(-1)).toMatchObject({
      from: "provisioning",
      to: "changes_requested",
      note: gateClosedNote("escalated"),
    });
    expect(ticket.delivery).toMatchObject(
      publish
        ? { state: "open", pull_request_url: "https://github.com/o/r/pull/15", opened_by: "loop" }
        : { state: "none", pull_request_url: null },
    );
  }, 300_000);
});
