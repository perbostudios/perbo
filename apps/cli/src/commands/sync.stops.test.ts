import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ReviewArtifactSchema,
  StopVerdictsSchema,
  findingKey,
  isDogfoodStop,
  summariseStops,
  transition,
  type Finding,
  type PlanContractWithCriteria,
  type ReviewArtifact,
} from "@perbo/contracts";
import {
  TicketDeliveryStateSchema,
  parseStopAnswers,
  pullRequestBody,
  type TicketDeliveryState,
} from "@perbo/runner";
import { admitCommandLine } from "./admit.js";
import { recordDelivery, syncCommandLine } from "./sync.js";
import { readTicket, storeDir, writeTicket } from "../store/tickets.js";
import { makeAttempt, makeReview } from "../test-support/records.js";
import { SPAWN_TEST_TIMEOUT_MS, gitEnvironment } from "@perbo/test-support";
import { runCommandLine } from "../command-line/terminal.js";
import { recordStreams } from "../test-support/streams.js";

/**
 * `perbo sync` reads the answers ticked against each stop off the pull
 * request and writes them beside the attempt record (D-060, measured live).
 * The record is rewritten whole every time; what it remembers across syncs is
 * when each answer first appeared.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-sync-stops-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function repository(name: string): string {
  const dir = join(scratch, name);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "base"], {
    env: gitEnvironment(),
  });
  return dir;
}

const admitArgv = (repo: string) => [
  "--repo",
  repo,
  "--outcome",
  "Activation email goes out within 60 seconds.",
  "--criterion",
  "A signup queues exactly one email. :: one message on the queue",
  "--path",
  "packages/auth/**",
  "--approve",
];

const k1 = "1".repeat(64);
const k2 = "2".repeat(64);
const PR = "https://github.com/o/r/pull/7";

const observed = (
  stop_answers: TicketDeliveryState["stop_answers"],
  observed_at: string,
  reachable = true,
): TicketDeliveryState =>
  TicketDeliveryStateSchema.parse({
    ticket_id: "ticket_x",
    branch: "perbo/PRB-1",
    pull_request_url: PR,
    pull_request_number: 7,
    state: "open",
    merge_state: null,
    checks: [],
    observed: reachable,
    human_review_verdicts: [],
    finding_outcomes: {},
    candidate_missed_recall: 0,
    reverted_by: null,
    fixed_by: null,
    attempts: [],
    observed_at,
    stop_answers,
  });

function delivered(name: string): { repo: string; dir: string; ticket_id: string } {
  const repo = repository(name);
  runCommandLine(admitCommandLine, { argv: admitArgv(repo), streams: recordStreams(), cwd: repo });
  const dir = storeDir(repo, null);
  const at = new Date("2026-09-02T01:00:00.000Z");
  let ticket = recordDelivery(
    readTicket(dir, "PRB-1"),
    { workspace: { branch: "perbo/PRB-1" }, pull_request: { url: PR, number: 7 } },
    at,
  );
  for (const to of ["provisioning", "executing", "verifying", "independent_review", "pr_open"] as const) {
    ticket = transition(ticket, to, "run", at);
  }
  writeTicket(dir, ticket);
  return { repo, dir, ticket_id: ticket.ticket_id };
}

const stopsFile = (dir: string, ticket_id: string) => join(dir, "state", `${ticket_id}.stops.json`);
const readStops = (dir: string, ticket_id: string) =>
  StopVerdictsSchema.parse(JSON.parse(readFileSync(stopsFile(dir, ticket_id), "utf8")));

const T1 = "2026-09-02T02:00:00.000Z";
const T2 = "2026-09-03T02:00:00.000Z";

describe("perbo sync writes the stop answers beside the attempt record", () => {
  it("records what gh read off the pull request, keyed by finding", async () => {
    const { repo, dir, ticket_id } = delivered("stops-first");
    const streams = recordStreams();
    await runCommandLine(syncCommandLine, {
      argv: ["PRB-1", "--repo", repo],
      streams,
      cwd: repo,
      now: new Date(T1),
      deps: {
        poll: () =>
          Promise.resolve(
            observed(
              [
                { finding_key: k1, rule_id: "auth.token_never_expires", routing: "blocks", answer: "endorse" },
                { finding_key: k2, rule_id: "behaviour.incidental_change", routing: "declined", answer: null },
              ],
              T1,
            ),
          ),
      },
    });
    const stops = readStops(dir, ticket_id);
    expect(stops.ticket_key).toBe("PRB-1");
    expect(stops.pull_request_url).toBe(PR);
    expect(stops.shown_to_person).toBe(true);
    expect(stops.stops).toEqual([
      {
        finding_key: k1,
        rule_id: "auth.token_never_expires",
        routing: "blocks",
        answer: "endorse",
        answered_at: T1,
        // An unsigned tick is what the GitHub UI writes: a person's answer.
        answered_by: "person",
        first_seen_at: T1,
      },
      {
        finding_key: k2,
        rule_id: "behaviour.incidental_change",
        routing: "declined",
        answer: null,
        answered_at: null,
        answered_by: null,
        first_seen_at: T1,
      },
    ]);
    expect(streams.err()).toContain("stops: 1 of 2 answered");
  });

  it("keeps answered_at across a re-sync where nothing changed", async () => {
    const { repo, dir, ticket_id } = delivered("stops-resync");
    const answers: TicketDeliveryState["stop_answers"] = [
      { finding_key: k1, rule_id: "auth.token_never_expires", routing: "blocks", answer: "endorse" },
    ];
    const sync = (at: string) =>
      runCommandLine(syncCommandLine, {
        argv: ["PRB-1", "--repo", repo],
        streams: recordStreams(),
        cwd: repo,
        now: new Date(at),
        deps: {
          poll: () => Promise.resolve(observed(answers, at)),
        },
      });
    await sync(T1);
    const first = readStops(dir, ticket_id);
    await sync(T2);
    const second = readStops(dir, ticket_id);
    expect(second.stops[0]?.answered_at).toBe(T1);
    expect(second.stops[0]?.first_seen_at).toBe(T1);
    expect(second.first_seen_at).toBe(T1);
    expect(second.observed_at).toBe(T2);
    expect({ ...second, observed_at: first.observed_at }).toEqual(first);
  });

  it("re-stamps answered_at when the person changed their answer", async () => {
    const { repo, dir, ticket_id } = delivered("stops-changed");
    const sync = (answer: "endorse" | "override", at: string) =>
      runCommandLine(syncCommandLine, {
        argv: ["PRB-1", "--repo", repo],
        streams: recordStreams(),
        cwd: repo,
        now: new Date(at),
        deps: {
          poll: () =>
            Promise.resolve(
              observed([{ finding_key: k1, rule_id: "auth.token_never_expires", routing: "blocks", answer }], at),
            ),
        },
      });
    await sync("endorse", T1);
    await sync("override", T2);
    expect(readStops(dir, ticket_id).stops[0]).toMatchObject({ answer: "override", answered_at: T2 });
  });

  it("records a pull request on which nothing was shown, so the companion has a denominator", async () => {
    const { repo, dir, ticket_id } = delivered("stops-none");
    await runCommandLine(syncCommandLine, {
      argv: ["PRB-1", "--repo", repo],
      streams: recordStreams(),
      cwd: repo,
      now: new Date(T1),
      deps: {
        poll: () => Promise.resolve(observed([], T1)),
      },
    });
    const stops = readStops(dir, ticket_id);
    expect(stops.shown_to_person).toBe(false);
    expect(stops.stops).toEqual([]);
    expect(stops.pull_request_url).toBe(PR);
  });

  it("writes nothing when gh could not be asked", async () => {
    const { repo, dir, ticket_id } = delivered("stops-unreachable");
    await runCommandLine(syncCommandLine, {
      argv: ["PRB-1", "--repo", repo],
      streams: recordStreams(),
      cwd: repo,
      now: new Date(T1),
      deps: {
        poll: () => Promise.resolve(observed([], T1, false)),
      },
    });
    expect(existsSync(stopsFile(dir, ticket_id))).toBe(false);
  });
}, SPAWN_TEST_TIMEOUT_MS);

/* ------------------------------------------------------------------ *
 * Who answered, from the same body (D-058).
 * ------------------------------------------------------------------ */

/**
 * An AI's endorsement of a stop is not a person wanting to be asked, so the two
 * answers are told apart where they are given. A person ticking a box in the
 * GitHub UI changes the tick and nothing else, so an unsigned tick is a
 * person's; the stand-in edits the body through `gh` and signs the line it
 * ticked. Everything below is the real machinery — this repository's own
 * `pullRequestBody` writes the body, its own `parseStopAnswers` reads the ticks
 * back, and `perbo sync` writes the record that is then read off disk.
 */

const STOPS = [
  { rule_id: "auth.token_never_expires", criterion_id: "ac_1", file: "src/auth.ts" },
  { rule_id: "scope.touched_a_prohibited_path", criterion_id: "ac_2", file: "src/scope.ts" },
] as const;

const [STAND_IN_STOP, PERSON_STOP] = STOPS.map((one) =>
  findingKey({ rule_id: one.rule_id, criterion_id: one.criterion_id, file: one.file, symbol: null }),
);

const DOGFOOD_CONTRACT = {
  ticket_id: "ticket_x",
  plan_id: "plan_fixture0001",
  version: 1,
  level: "P1",
  outcome: "Activation email goes out within 60 seconds.",
  acceptance_criteria: [
    { id: "ac_1", text: "A signup queues exactly one email." },
    { id: "ac_2", text: "The scope is respected." },
  ],
  rollout: "reversible change; rollback is `git revert`",
} as unknown as PlanContractWithCriteria;

const dogfoodAttempt = makeAttempt({
  attempt_id: "att_dogfood00000001",
  ticket_id: "ticket_x",
  created_at: "2026-09-01T11:47:38.000Z",
  termination: { reason: "completed", detail: "" },
  usage: { iterations: 12, commands: 8, wall_clock_ms: 90_000, cost_basis: "unavailable" },
  changeset_id: "cs_dogfood0001",
  head_commit: "b2c3d4e",
});

/** A review carrying two human-closure blocking findings, so one body has two stops. */
function dogfoodReview(): ReviewArtifact {
  const base = makeReview({
    review_id: "rev_dogfood0001",
    changeset_id: "cs_dogfood0001",
    decision: "changes_requested",
    cost_basis: "unavailable",
  });
  const template = base.findings[0]!;
  return ReviewArtifactSchema.parse({
    ...base,
    findings: STOPS.map((one, index) => ({
      ...template,
      key: index === 0 ? STAND_IN_STOP : PERSON_STOP,
      rule_id: one.rule_id,
      criterion_id: one.criterion_id,
      file: one.file,
      line: 7,
      symbol: null,
      routing: "blocks",
      blocking: true,
      closure: "human",
      statement: "Something a person has to decide.",
    })) satisfies Array<Record<string, unknown>> as Finding[],
  });
}

/**
 * One box ticked, and how the line that carries it is signed.
 *
 * `unsigned` is what the GitHub UI writes when a person clicks a box: the tick
 * changes and nothing else, which is why an unsigned tick is read as a person's.
 * The other two are the convention the body states beside the boxes — the
 * stand-in signs what it answers, and a person signs a line to say an answer is
 * theirs, which is how a stop already recorded as the stand-in's is taken back.
 */
function tick(
  text: string,
  key: string,
  answer: "endorse" | "override",
  by: "unsigned" | "person" | "stand_in",
): string {
  const signature = by === "unsigned" ? "" : ` <!-- perbo:answered-by who=${by} -->`;
  return text
    .split("\n")
    .map((line) =>
      line.includes(`key=${key} answer=${answer}`) ? `${line.replace("- [ ]", "- [x]")}${signature}` : line,
    )
    .join("\n");
}

describe("perbo sync records who answered each stop", () => {
  it("labels the stand-in's answer dogfood and the person's not, from one body", async () => {
    const { repo, dir, ticket_id } = delivered("stops-dogfood");
    const body = pullRequestBody({
      contract: DOGFOOD_CONTRACT,
      attempt: dogfoodAttempt as never,
      review: dogfoodReview(),
      attempts: [dogfoodAttempt as never],
    });
    const answered = tick(tick(body, STAND_IN_STOP!, "endorse", "stand_in"), PERSON_STOP!, "endorse", "unsigned");

    await runCommandLine(syncCommandLine, {
      argv: ["PRB-1", "--repo", repo],
      streams: recordStreams(),
      cwd: repo,
      now: new Date(T1),
      deps: {
        // `gh` is the only thing stood in for: what it returns is the real body
        // above, read by the real parser.
        poll: () => Promise.resolve(observed(parseStopAnswers(answered), T1)),
      },
    });

    const stops = readStops(dir, ticket_id).stops;
    const standIn = stops.find((one) => one.finding_key === STAND_IN_STOP)!;
    const person = stops.find((one) => one.finding_key === PERSON_STOP)!;

    expect(standIn.answer).toBe("endorse");
    expect(standIn.answered_by).toBe("stand_in");
    expect(isDogfoodStop(standIn)).toBe(true);

    expect(person.answer).toBe("endorse");
    expect(person.answered_by).toBe("person");
    expect(isDogfoodStop(person)).toBe(false);
  });

  it("keeps the stand-in's label when a later sync reads a body the marker was edited out of", async () => {
    const { repo, dir, ticket_id } = delivered("stops-dogfood-erased");
    const body = pullRequestBody({
      contract: DOGFOOD_CONTRACT,
      attempt: dogfoodAttempt as never,
      review: dogfoodReview(),
      attempts: [dogfoodAttempt as never],
    });
    const sync = (text: string, at: string) =>
      runCommandLine(syncCommandLine, {
        argv: ["PRB-1", "--repo", repo],
        streams: recordStreams(),
        cwd: repo,
        now: new Date(at),
        deps: {
          poll: () => Promise.resolve(observed(parseStopAnswers(text), at)),
        },
      });

    await sync(tick(body, STAND_IN_STOP!, "endorse", "stand_in"), T1);
    await sync(tick(body, STAND_IN_STOP!, "endorse", "unsigned"), T2);

    const standIn = readStops(dir, ticket_id).stops.find((one) => one.finding_key === STAND_IN_STOP)!;
    expect(standIn.answered_by).toBe("stand_in");
    expect(standIn.answered_at).toBe(T1);
  });

  it("gives the stop back to the partner reading when a person signs the line as their own", async () => {
    // The other half of the same rule: silence cannot clear a signature, so a
    // person whose answer was recorded as the stand-in's says so the way the
    // stand-in did — the convention the body prints beside the boxes — and the
    // stop is a person's again without the answer itself changing.
    const { repo, dir, ticket_id } = delivered("stops-dogfood-reclaimed");
    const body = pullRequestBody({
      contract: DOGFOOD_CONTRACT,
      attempt: dogfoodAttempt as never,
      review: dogfoodReview(),
      attempts: [dogfoodAttempt as never],
    });
    const sync = (text: string, at: string) =>
      runCommandLine(syncCommandLine, {
        argv: ["PRB-1", "--repo", repo],
        streams: recordStreams(),
        cwd: repo,
        now: new Date(at),
        deps: {
          poll: () => Promise.resolve(observed(parseStopAnswers(text), at)),
        },
      });

    await sync(tick(body, STAND_IN_STOP!, "endorse", "stand_in"), T1);
    const asStandIn = readStops(dir, ticket_id);
    expect(summariseStops([asStandIn])).toMatchObject({ dogfood_stops: 1, precision: { n: 0 } });

    await sync(tick(body, STAND_IN_STOP!, "endorse", "person"), T2);
    const reclaimed = readStops(dir, ticket_id);
    const stop = reclaimed.stops.find((one) => one.finding_key === STAND_IN_STOP)!;

    expect(stop.answer).toBe("endorse");
    expect(stop.answered_by).toBe("person");
    expect(isDogfoodStop(stop)).toBe(false);
    // The answer did not change, so the moment it was first given stands.
    expect(stop.answered_at).toBe(T1);
    // And the change is back in the population precision is read over: what
    // the stickiness costs is recoverable by saying something, not permanent.
    expect(summariseStops([reclaimed])).toMatchObject({
      dogfood_stops: 0,
      endorsed: 1,
      precision: { n: 1 },
    });
  });

  it("empties the partner population when every tick in a body is signed as the stand-in's", async () => {
    // The abuse the label makes possible runs outwards: a body is text anyone
    // with write access can edit, and signing every tick takes every stop out
    // of the partner reading. It cannot put an answer in — the record still
    // holds both stops and both answers — and the count of what left is on the
    // record for the reading to print.
    const { repo, dir, ticket_id } = delivered("stops-dogfood-whole-body");
    const body = pullRequestBody({
      contract: DOGFOOD_CONTRACT,
      attempt: dogfoodAttempt as never,
      review: dogfoodReview(),
      attempts: [dogfoodAttempt as never],
    });
    const signed = tick(tick(body, STAND_IN_STOP!, "endorse", "stand_in"), PERSON_STOP!, "override", "stand_in");

    await runCommandLine(syncCommandLine, {
      argv: ["PRB-1", "--repo", repo],
      streams: recordStreams(),
      cwd: repo,
      now: new Date(T1),
      deps: {
        poll: () => Promise.resolve(observed(parseStopAnswers(signed), T1)),
      },
    });

    const record = readStops(dir, ticket_id);
    expect(record.stops.map((one) => one.answered_by)).toEqual(["stand_in", "stand_in"]);
    expect(summariseStops([record])).toMatchObject({
      // Nothing was lost from the record's own diagnostics…
      stops: 2,
      unanswered_stops: 0,
      // …and nothing was added to the partner one, which is now empty.
      dogfood_stops: 2,
      dogfood_changes: 1,
      precision: { n: 0 },
    });
  });
}, SPAWN_TEST_TIMEOUT_MS);
