import type * as ChildProcess from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  EXIT_CODES,
  ReviewArtifactSchema,
  SecretIndex,
  findingKey,
  reconcileStopVerdicts,
  type Finding,
  type PlanContractWithCriteria,
  type ReviewArtifact,
  type RunBundle,
  type RunBundleKind,
  type StopVerdicts,
} from "@perbo/contracts";
import { BundleStore, parseStopAnswers, pullRequestBody } from "@perbo/runner";
import { UsageError } from "../../usage-error.js";
import { runEscapesCommand } from "../escapes/index.js";
import { runInspectCommand } from "../inspect.js";
import { runStopsCommand } from "../stops.js";
import { parseVerdictArgs, runVerdictCommand } from "./index.js";
import { LocalVerdictSchema, LocalVerdictsSchema } from "./record.js";
import { FINDING_KEY, makeAttempt, makeReview, makeTicket } from "../../test-support/attempt-fixture.js";
import { SPAWN_TEST_TIMEOUT_MS } from "../../test-support/spawn-timeout.js";

/**
 * `perbo verdict` (SCP-181): a person answers a review here instead of on the
 * pull request, and the answer is the same answer.
 *
 * Every test in this file runs against a store built the way the loop builds
 * one — a ticket, an attempts record, bundles holding the review artifact, and
 * where a pull request exists, a stops record produced by parsing a body this
 * repository's own `pullRequestBody` wrote. Nothing is stubbed but the two ways
 * this codebase can reach a network, and those are stubbed to throw: `gh` and
 * every other child process is refused, and `fetch` raises. A decision is a
 * local fact, and a test that let either through would not be checking that.
 */

type ChildProcessModule = typeof ChildProcess;

vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<ChildProcessModule>();
  const refuse = (file: string): never => {
    throw new Error(`refused: recording a verdict spawned ${file}`);
  };
  // git reads this checkout's identity for the author field, and the fixtures
  // here build their checkouts with it; that is local either way, and it is
  // the only child anything in this file may start.
  return {
    ...actual,
    execFileSync: ((file: string, args: readonly string[], options: unknown) =>
      file === "git" ? actual.execFileSync(file, args as string[], options as never) : refuse(file)) as unknown,
    execFile: (file: string) => refuse(file),
    exec: (command: string) => refuse(command),
    spawn: (file: string) => refuse(file),
    spawnSync: ((file: string, args: readonly string[], options: unknown) =>
      file === "git" ? actual.spawnSync(file, args as string[], options as never) : refuse(file)) as unknown,
  };
});

vi.stubGlobal("fetch", () => {
  throw new Error("refused: recording a verdict asked the network");
});

const scratch = mkdtempSync(join(tmpdir(), "perbo-verdict-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const TICKET_ID = "ticket_verdict0001";
const ATTEMPT = "att_verdict00000001";
const PULL_REQUEST = "https://github.com/o/r/pull/9";
const NOW = new Date("2026-09-04T10:11:12.000Z");
const LATER = new Date("2026-09-05T08:00:00.000Z");
const AUTHOR = "Lian Matsuo <lian@example.invalid>";

function capture(isTTY = false) {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (chunk: string) => out.push(chunk), stderr: (chunk: string) => err.push(chunk), isTTY };
}

/* ------------------------------------------------------------------ *
 * The review under decision: three stops and one advisory finding, with
 * every key computed by the same `findingKey` the reviewer uses.
 * ------------------------------------------------------------------ */

const FINDINGS = [
  {
    rule_id: "auth.token_never_expires",
    criterion_id: "ac_1",
    file: "src/auth.ts",
    routing: "blocks",
    blocking: true,
    statement: "The token carries no exp claim.",
  },
  {
    rule_id: "data.migration_is_not_reversible",
    criterion_id: "ac_2",
    file: "src/migrate.ts",
    routing: "blocks",
    blocking: true,
    statement: "The migration drops a column with no down step.",
  },
  {
    rule_id: "scope.touched_a_prohibited_path",
    criterion_id: "ac_3",
    file: "infra/main.tf",
    routing: "escalates",
    blocking: true,
    statement: "The change edits infrastructure the contract prohibits.",
  },
  {
    rule_id: "code.unused_import",
    criterion_id: null,
    file: "src/a.ts",
    routing: "advisory",
    blocking: false,
    statement: "`readFileSync` is imported and never used.",
  },
] as const;

/** The keys, in the order above: three stops, then the advisory. */
const KEYS = FINDINGS.map((finding) =>
  findingKey({ rule_id: finding.rule_id, criterion_id: finding.criterion_id, file: finding.file, symbol: null }),
);
const [STOP_ONE, STOP_TWO, STOP_THREE, ADVISORY] = KEYS;

function reviewArtifact(): ReviewArtifact {
  const base = makeReview({
    review_id: "rev_verdict0001",
    changeset_id: "cs_verdict0001",
    decision: "changes_requested",
    cost_basis: "unavailable",
  });
  const template = base.findings[0]!;
  return ReviewArtifactSchema.parse({
    ...base,
    findings: FINDINGS.map((finding, index) => ({
      ...template,
      key: KEYS[index]!,
      rule_id: finding.rule_id,
      criterion_id: finding.criterion_id,
      file: finding.file,
      line: 3,
      symbol: null,
      routing: finding.routing,
      blocking: finding.blocking,
      closure: finding.blocking ? "human" : "executor",
      statement: finding.statement,
    })) satisfies Array<Record<string, unknown>> as Finding[],
  });
}

const CONTRACT = {
  ticket_id: TICKET_ID,
  plan_id: "plan_fixture0001",
  version: 1,
  level: "P1",
  outcome: "Search results are paginated.",
  acceptance_criteria: [{ id: "ac_1", text: "Pages are 25 rows." }],
  rollout: "reversible change; rollback is `git revert`",
} as unknown as PlanContractWithCriteria;

const attempt = makeAttempt({
  attempt_id: ATTEMPT,
  ticket_id: TICKET_ID,
  created_at: "2026-09-03T11:47:38.000Z",
  termination: { reason: "completed", detail: "" },
  usage: { iterations: 30, commands: 20, wall_clock_ms: 260_000, cost_basis: "unavailable" },
  changeset_id: "cs_verdict0001",
  head_commit: "b2c3d4e",
});

/** The pull-request body this review would be published under. */
function body(): string {
  return pullRequestBody({
    contract: CONTRACT,
    attempt: attempt as never,
    review: reviewArtifact(),
    attempts: [attempt as never],
  });
}

/** One box ticked, exactly as a person ticks it in the GitHub UI. */
function tick(text: string, key: string, answer: "endorse" | "override"): string {
  return text
    .split("\n")
    .map((line) => (line.includes(`key=${key} answer=${answer}`) ? line.replace("- [ ]", "- [x]") : line))
    .join("\n");
}

/** The stops record `perbo sync` writes from a body, through the real parser. */
function stopsRecordFor(text: string, at: string): StopVerdicts {
  return reconcileStopVerdicts({
    previous: null,
    ticket: { ticket_id: TICKET_ID, key: "AYO-7" },
    pull_request_url: PULL_REQUEST,
    observed: parseStopAnswers(text),
    observed_at: at,
  });
}

/**
 * A store as the loop leaves one: the ticket, its attempt, the bundles holding
 * the review artifact, and — when `pullRequest` is given — the stops record
 * `perbo sync` would have written from that body.
 */
function storeWith(name: string, options: { pullRequest?: string; bundles?: boolean } = {}): {
  repo: string;
  store: string;
} {
  const repo = join(scratch, name);
  const store = join(repo, ".perbo");
  mkdirSync(join(store, "tickets"), { recursive: true });
  mkdirSync(join(store, "state"), { recursive: true });
  writeFileSync(
    join(store, "tickets", "AYO-7.json"),
    JSON.stringify(makeTicket({ key: "AYO-7", ticket_id: TICKET_ID, repository_root: repo, pull_request_url: PULL_REQUEST })),
  );
  writeFileSync(
    join(store, "state", `${TICKET_ID}.attempts.json`),
    `${JSON.stringify({ ticket_id: TICKET_ID, attempts: [attempt] }, null, 2)}\n`,
  );

  if (options.bundles !== false) {
    const bundles = new BundleStore({ root: join(store, "bundles"), retainContext: true });
    const write = (
      kind: RunBundleKind,
      subject_id: string,
      inputs: RunBundle["inputs"],
      artifacts: Array<{ name: string; media_type: string; body: string }>,
    ) =>
      bundles.write({
        kind,
        subject_id,
        ticket_id: TICKET_ID,
        inputs,
        context_manifest: [],
        versions: { code: "stage-3", prompt: "executor_v4", policy: "A2b", model: "claude-opus-5", tool: "1.0.98" },
        usage: { input_tokens: 1, output_tokens: 1, cost_micros: 0, cost_basis: "unavailable", wall_clock_ms: 1 },
        artifacts,
        errors: [],
        transitions: [],
        retention: { class: "raw_transcript", expires_at: null },
        secrets: new SecretIndex(),
        excluded_paths: [],
        deterministic: false,
        model_version_pinned: true,
        now: new Date("2026-09-03T11:52:00.000Z"),
      });
    write("execution", ATTEMPT, { termination: "completed" }, [
      { name: "attempt.json", media_type: "application/json", body: JSON.stringify(attempt) },
      { name: "transcript.jsonl", media_type: "application/x-ndjson", body: "" },
    ]);
    write("review", "rev_verdict0001", { changeset_id: "cs_verdict0001", decision: "changes_requested", remediation_round: 0 }, [
      { name: "review.json", media_type: "application/json", body: JSON.stringify(reviewArtifact()) },
    ]);
  }

  if (options.pullRequest !== undefined) {
    writeFileSync(
      join(store, "state", `${TICKET_ID}.stops.json`),
      `${JSON.stringify(stopsRecordFor(options.pullRequest, "2026-09-03T12:00:00.000Z"), null, 2)}\n`,
    );
  }
  return { repo, store };
}

const readVerdicts = (store: string) =>
  LocalVerdictsSchema.parse(JSON.parse(readFileSync(join(store, "verdicts.json"), "utf8")));

describe("perbo verdict records the decision locally", () => {
  it("writes one row carrying the review, the key, the decision, who, when and the note", async () => {
    const { repo, store } = storeWith("records");
    const streams = capture();
    const code = await runVerdictCommand({
      argv: ["AYO-7", "--override", STOP_ONE!.slice(0, 12), "--note", "the agent should have fixed this", "--author", AUTHOR, "--repo", repo],
      streams,
      cwd: repo,
      now: NOW,
    });

    expect(code).toBe(0);
    const file = readVerdicts(store);
    expect(file.verdicts).toHaveLength(1);
    expect(file.verdicts[0]).toEqual({
      review: {
        reference: "AYO-7",
        ticket_id: TICKET_ID,
        ticket_key: "AYO-7",
        pull_request_url: PULL_REQUEST,
      },
      finding_key: STOP_ONE,
      rule_id: "auth.token_never_expires",
      routing: "blocks",
      decision: "override",
      author: AUTHOR,
      // `--author` in the form this command writes is read back as the pair,
      // so `author` and `decided_by` never name two different people.
      decided_by: { name: "Lian Matsuo", email: "lian@example.invalid" },
      decided_at: "2026-09-04T10:11:12.000Z",
      note: "the agent should have fixed this",
      superseded_at: null,
    });
    expect(streams.err.join("")).toContain("nothing was sent anywhere");
  });

  /** Three real `git` spawns setting up the checkout's identity, under the load SCP-191 measures. */
  const GIT_IDENTITY_TIMEOUT_MS = 60_000;

  it("records who decided from this repository's two git config lines when none is given", async () => {
    const { repo, store } = storeWith("author");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Ada Lovelace"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "ada@example.invalid"], { cwd: repo });
    const streams = capture();

    expect(
      await runVerdictCommand({
        argv: ["AYO-7", "--endorse", STOP_TWO!, "--repo", repo],
        streams,
        cwd: repo,
        now: NOW,
      }),
    ).toBe(0);
    const recorded = readVerdicts(store).verdicts[0];
    expect(recorded?.author).toBe("Ada Lovelace <ada@example.invalid>");
    // The same two values, typed: `user.name` and `user.email` as the
    // repository holds them, character for character, and nothing else — no
    // account, no token, nothing that needed a network to find out.
    expect(recorded?.decided_by).toEqual({ name: "Ada Lovelace", email: "ada@example.invalid" });
  }, GIT_IDENTITY_TIMEOUT_MS);

  it("refuses when the repository names nobody, naming the two config lines to run", async () => {
    const { repo, store } = storeWith("unnamed");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    // A repository configured with neither. `git config --get` falls back to
    // the machine's own global and system files, and this is a test about a
    // repository that names nobody rather than about whoever runs it, so both
    // of those are pointed at nothing for the length of it.
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_SYSTEM", "/dev/null");
    try {
      const streams = capture();
      const code = await runVerdictCommand({
        argv: ["AYO-7", "--override", STOP_ONE!, "--repo", repo],
        streams,
        cwd: repo,
        now: NOW,
      });

      expect(code).not.toBe(0);
      expect(code).toBe(EXIT_CODES.usage_or_input_error);
      // Nothing written: the store is exactly as it was before the refusal.
      expect(existsSync(join(store, "verdicts.json"))).toBe(false);
      expect(streams.out.join("")).toBe("");
      const said = streams.err.join("");
      expect(said).toContain("git config user.name");
      expect(said).toContain("git config user.email");
      // And the way out that does not need git at all is named too.
      expect(said).toContain("--author");

      // A `--json` caller is refused the same way, in the shape it asked for.
      const asJson = capture();
      expect(
        await runVerdictCommand({
          argv: ["AYO-7", "--override", STOP_ONE!, "--repo", repo, "--json"],
          streams: asJson,
          cwd: repo,
          now: NOW,
        }),
      ).toBe(EXIT_CODES.usage_or_input_error);
      expect(existsSync(join(store, "verdicts.json"))).toBe(false);
      const printed = JSON.parse(asJson.out.join("")) as { refused: boolean; set: string[] };
      expect(printed.refused).toBe(true);
      expect(printed.set.join(" ")).toContain("git config user.name");
      expect(printed.set.join(" ")).toContain("git config user.email");

      // With somebody named, the same store records the decision.
      expect(
        await runVerdictCommand({
          argv: ["AYO-7", "--override", STOP_ONE!, "--author", AUTHOR, "--repo", repo],
          streams: capture(),
          cwd: repo,
          now: NOW,
        }),
      ).toBe(0);
      expect(readVerdicts(store).verdicts).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  }, GIT_IDENTITY_TIMEOUT_MS);

  it("takes the review by pull request and by review id, not only by ticket key", async () => {
    for (const [name, reference] of [
      ["by-url", PULL_REQUEST],
      ["by-number", "#9"],
      ["by-review", "rev_verdict0001"],
    ] as const) {
      const { repo, store } = storeWith(name);
      expect(
        await runVerdictCommand({
          argv: [reference, "--accept", ADVISORY!.slice(0, 12), "--author", AUTHOR, "--repo", repo],
          streams: capture(),
          cwd: repo,
          now: NOW,
        }),
      ).toBe(0);
      expect(readVerdicts(store).verdicts[0]?.review).toMatchObject({ reference, ticket_key: "AYO-7" });
    }
  });

  it("refuses a key it cannot resolve, a stop answer on a finding that stopped nothing, and two decisions at once", async () => {
    const { repo } = storeWith("refusals");
    const run = (argv: string[]) => runVerdictCommand({ argv: [...argv, "--repo", repo], streams: capture(), cwd: repo, now: NOW });

    await expect(run(["AYO-7", "--endorse", "ffffff"])).rejects.toThrow(/is not a finding on this review/);
    await expect(run(["AYO-7", "--endorse", ADVISORY!])).rejects.toThrow(/stopped nothing/);
    await expect(run(["AYO-9", "--endorse", STOP_ONE!])).rejects.toThrow(/matches no ticket key/);
    expect(() => parseVerdictArgs(["AYO-7", "--endorse", STOP_ONE!, "--override", STOP_TWO!])).toThrow(UsageError);
    expect(() => parseVerdictArgs(["AYO-7"])).toThrow(/needs one decision/);
    expect(() => parseVerdictArgs(["--endorse", STOP_ONE!])).toThrow(/exactly one review/);
  });

  it("SCP-189: reports a flag right after a decision as a missing key, not as the key itself", () => {
    // Before the fix this read `--note` as the key, ran out of positionals for
    // "x", and refused with "verdict takes exactly one review" — a person
    // typo'd one flag and was told a different one was wrong.
    expect(() => parseVerdictArgs(["AYO-7", "--endorse", "--note", "x"])).toThrow(/missing key after --endorse/);
    expect(() => parseVerdictArgs(["AYO-7", "--override", "--author", "a"])).toThrow(/missing key after --override/);
    expect(() => parseVerdictArgs(["AYO-7", "--accept", "--reject", STOP_ONE!])).toThrow(/missing key after --accept/);
    // The flag itself with nothing after it at all is the same refusal.
    expect(() => parseVerdictArgs(["AYO-7", "--endorse"])).toThrow(/missing key after --endorse/);
    // A key that merely starts with a hex digit and is not a flag still works.
    expect(parseVerdictArgs(["AYO-7", "--endorse", STOP_ONE!])).toMatchObject({
      list: false,
      decision: "endorse",
      key: STOP_ONE,
    });
  });
}, SPAWN_TEST_TIMEOUT_MS);

describe("the key is the one the pull-request checkbox carries", () => {
  it("writes the key a person's tick would have answered, and the decision lands on that stop", async () => {
    const published = body();
    const checkbox = parseStopAnswers(published);
    const { repo, store } = storeWith("same-key", { pullRequest: published });

    expect(
      await runVerdictCommand({
        argv: ["AYO-7", "--override", STOP_ONE!.slice(0, 12), "--author", AUTHOR, "--repo", repo],
        streams: capture(),
        cwd: repo,
        now: NOW,
      }),
    ).toBe(0);

    // The two paths name the same finding: the key the writer recorded is the
    // key the parser read out of the body's marker, character for character.
    const recorded = readVerdicts(store).verdicts[0]!;
    const fromCheckbox = checkbox.find((stop) => stop.rule_id === "auth.token_never_expires")!;
    expect(recorded.finding_key).toBe(fromCheckbox.finding_key);
    expect(recorded.rule_id).toBe(fromCheckbox.rule_id);
    expect(recorded.routing).toBe(fromCheckbox.routing);

    // And the decision resolves to that stop rather than to a second record:
    // `stops` reads the file the pull request produced and finds it answered.
    const streams = capture();
    await runStopsCommand({ argv: ["--repo", repo, "--json"], streams, cwd: repo });
    const summary = JSON.parse(streams.out.join("")) as {
      summary: { overridden: number; stops: number; unanswered_stops: number };
    };
    expect(summary.summary.stops).toBe(checkbox.length);
    expect(summary.summary.overridden).toBe(1);
    expect(summary.summary.unanswered_stops).toBe(checkbox.length - 1);
  });
}, SPAWN_TEST_TIMEOUT_MS);

describe("stops and inspect read the decisions back", () => {
  const summaryOf = async (repo: string) => {
    const streams = capture();
    expect(await runStopsCommand({ argv: ["--repo", repo, "--json"], streams, cwd: repo })).toBe(0);
    return (JSON.parse(streams.out.join("")) as { summary: unknown }).summary;
  };

  it("counts a decision taken here exactly as one ticked on the pull request", async () => {
    // Every stop answered on the pull request, the way a person answers them.
    const ticked = [
      [STOP_ONE!, "endorse"],
      [STOP_TWO!, "override"],
      [STOP_THREE!, "override"],
    ].reduce((text, [key, answer]) => tick(text, key!, answer as "endorse" | "override"), body());
    const { repo: pullRequestRepo } = storeWith("counted-pr", { pullRequest: ticked });

    // The same three answers, taken here instead — and with no stops record in
    // the store at all, so `stops` has nothing but `verdicts.json` to read.
    const { repo: localRepo } = storeWith("counted-local");
    for (const [key, decision] of [
      [STOP_ONE!, "--endorse"],
      [STOP_TWO!, "--override"],
      [STOP_THREE!, "--override"],
    ] as const) {
      expect(
        await runVerdictCommand({
          argv: ["AYO-7", decision, key, "--author", AUTHOR, "--repo", localRepo],
          streams: capture(),
          cwd: localRepo,
          now: NOW,
        }),
      ).toBe(0);
    }

    const local = (await summaryOf(localRepo)) as Record<string, unknown>;
    const remote = (await summaryOf(pullRequestRepo)) as Record<string, unknown>;
    expect(local).toEqual(remote);
    expect(local).toMatchObject({
      changes: 1,
      stops: 3,
      unanswered_stops: 0,
      endorsed: 1,
      overridden: 0,
      shown: 1,
    });
  });

  it("fills in the stop a pull request left unanswered, and the totals then match tick for tick", async () => {
    // One box ticked on the pull request; the second stop answered here.
    const { repo: mixed } = storeWith("mixed", { pullRequest: tick(body(), STOP_ONE!, "endorse") });
    expect(
      await runVerdictCommand({
        argv: ["AYO-7", "--override", STOP_TWO!, "--author", AUTHOR, "--repo", mixed],
        streams: capture(),
        cwd: mixed,
        now: NOW,
      }),
    ).toBe(0);

    // Both ticked on the pull request instead: the same three stops, two
    // answered, one not.
    const { repo: allTicked } = storeWith("all-ticked", {
      pullRequest: tick(tick(body(), STOP_ONE!, "endorse"), STOP_TWO!, "override"),
    });

    expect(await summaryOf(mixed)).toEqual(await summaryOf(allTicked));
    expect(await summaryOf(mixed)).toMatchObject({ stops: 3, unanswered_stops: 1, endorsed: 1, overridden: 0 });
  });

  it("prints the decision, who took it and their note beside the finding", async () => {
    const { repo } = storeWith("inspected");
    expect(
      await runVerdictCommand({
        argv: ["AYO-7", "--override", STOP_ONE!, "--note", "pagination size is ours to choose", "--author", AUTHOR, "--repo", repo],
        streams: capture(),
        cwd: repo,
        now: NOW,
      }),
    ).toBe(0);

    const streams = capture(true);
    expect(await runInspectCommand({ argv: ["AYO-7", "--repo", repo], streams, cwd: repo })).toBe(0);
    const printed = streams.out.join("");
    const findingLine = printed.indexOf("auth.token_never_expires");
    const decisionLine = printed.indexOf("decision override");
    expect(findingLine).toBeGreaterThan(-1);
    // Beside its finding, not in a list of its own somewhere below.
    expect(decisionLine).toBeGreaterThan(findingLine);
    expect(printed.slice(decisionLine, decisionLine + 400)).toContain(AUTHOR);
    expect(printed).toContain("pagination size is ours to choose");
    expect(printed).toContain("2026-09-04T10:11:12.000Z");
  });

  it("still prints a decision whose finding it cannot show, rather than dropping it", async () => {
    // No bundles in the store, so there is no review artifact to print the
    // finding from — only the stops record the pull request produced.
    const { repo } = storeWith("no-artifact", { bundles: false, pullRequest: body() });
    expect(
      await runVerdictCommand({
        argv: ["AYO-7", "--endorse", STOP_TWO!, "--note", "mine to decide", "--author", AUTHOR, "--repo", repo],
        streams: capture(),
        cwd: repo,
        now: NOW,
      }),
    ).toBe(0);

    const streams = capture(true);
    expect(await runInspectCommand({ argv: ["AYO-7", "--repo", repo], streams, cwd: repo })).toBe(0);
    const printed = streams.out.join("");
    expect(printed).toContain("DECISIONS");
    expect(printed).toContain(STOP_TWO!.slice(0, 12));
    expect(printed).toContain("decision endorse");
    expect(printed).toContain("mine to decide");
  });

  it("carries every decision, superseded ones included, in the JSON report", async () => {
    const { repo } = storeWith("inspected-json");
    const decide = (decision: string, extra: string[] = []) =>
      runVerdictCommand({
        argv: ["AYO-7", decision, ADVISORY!, "--author", AUTHOR, "--repo", repo, ...extra],
        streams: capture(),
        cwd: repo,
        now: decision === "--accept" ? NOW : LATER,
      });
    expect(await decide("--accept")).toBe(0);
    expect(await decide("--reject", ["--replace"])).toBe(0);

    const streams = capture();
    await runInspectCommand({ argv: ["AYO-7", "--repo", repo, "--json"], streams, cwd: repo });
    const report = JSON.parse(streams.out.join("")) as {
      verdicts: Array<{ decision: string; superseded_at: string | null }>;
    };
    expect(report.verdicts.map((one) => [one.decision, one.superseded_at])).toEqual([
      ["accept", "2026-09-05T08:00:00.000Z"],
      ["reject", null],
    ]);
  });
}, SPAWN_TEST_TIMEOUT_MS);

describe("escapes and stops name who decided", () => {
  /** Prose naming a group, which is not a name and an address and is not split into one. */
  const A_TEAM = "the platform team";

  it("prints the author beside a decision that records one, and nothing extra beside one that does not", async () => {
    const { repo } = storeWith("who-decided");
    const decide = (decision: string, key: string, author: string) =>
      runVerdictCommand({
        argv: ["AYO-7", decision, key, "--author", author, "--repo", repo],
        streams: capture(),
        cwd: repo,
        now: NOW,
      });
    // One decision of each kind. `--author` in the form this command writes is
    // read back as the pair; prose naming a group is left in `author` alone,
    // so its row carries no `decided_by` — which is exactly what a row written
    // before the field existed looks like to a reader.
    expect(await decide("--override", STOP_ONE!, AUTHOR)).toBe(0);
    expect(await decide("--accept", ADVISORY!, A_TEAM)).toBe(0);

    for (const [name, run] of [
      ["stops", runStopsCommand],
      ["escapes", runEscapesCommand],
    ] as const) {
      const streams = capture();
      expect(await run({ argv: ["--repo", repo], streams, cwd: repo, now: LATER })).toBe(0);
      const lines = streams.out.join("").split("\n");

      const named = lines.find((line) => line.includes(STOP_ONE!.slice(0, 12)));
      expect(named, `${name} prints the decision`).toBeDefined();
      expect(named).toContain("override");
      expect(named).toContain(AUTHOR);

      const unnamed = lines.find((line) => line.includes(ADVISORY!.slice(0, 12)));
      expect(unnamed, `${name} prints the decision that names nobody it can type`).toBeDefined();
      // Nothing extra: the row ends at the decision. No dash standing in for a
      // name, and not the account the machine happens to be logged in as.
      expect(unnamed).toMatch(/accept$/);
      expect(unnamed).not.toContain(A_TEAM);
    }
  });

  it("names no column at all where nothing on the record says who", async () => {
    // Every decision in this store is one a reader cannot name anybody for —
    // which is what a store written before the field looks like. It prints its
    // decisions and no empty column promising an answer none of them has.
    const { repo } = storeWith("none-named");
    expect(
      await runVerdictCommand({
        argv: ["AYO-7", "--override", STOP_ONE!, "--author", A_TEAM, "--repo", repo],
        streams: capture(),
        cwd: repo,
        now: NOW,
      }),
    ).toBe(0);

    for (const run of [runStopsCommand, runEscapesCommand]) {
      const streams = capture();
      expect(await run({ argv: ["--repo", repo], streams, cwd: repo, now: LATER })).toBe(0);
      const printed = streams.out.join("");
      expect(printed).toContain(STOP_ONE!.slice(0, 12));
      expect(printed).not.toContain("decided by");
    }
  });

  it("prints no decisions at all where none were taken here", async () => {
    const { repo } = storeWith("none-decided", { pullRequest: tick(body(), STOP_ONE!, "endorse") });
    for (const run of [runStopsCommand, runEscapesCommand]) {
      const streams = capture();
      expect(await run({ argv: ["--repo", repo], streams, cwd: repo, now: LATER })).toBe(0);
      // Not the block's header, not a row: a store answered only on pull
      // requests prints exactly what it printed before this existed.
      expect(streams.out.join("")).not.toContain("change  finding");
      expect(streams.out.join("")).not.toContain(STOP_ONE!.slice(0, 12));
    }
  });
}, SPAWN_TEST_TIMEOUT_MS);

describe("a key that has been decided is not decided again by accident", () => {
  it("refuses the second decision and leaves the file byte for byte as it was", async () => {
    const { repo, store } = storeWith("twice");
    const first = await runVerdictCommand({
      argv: ["AYO-7", "--endorse", STOP_ONE!, "--note", "I wanted to be asked", "--author", AUTHOR, "--repo", repo],
      streams: capture(),
      cwd: repo,
      now: NOW,
    });
    expect(first).toBe(0);
    const before = readFileSync(join(store, "verdicts.json"), "utf8");

    const streams = capture();
    const second = await runVerdictCommand({
      argv: ["AYO-7", "--override", STOP_ONE!, "--author", AUTHOR, "--repo", repo],
      streams,
      cwd: repo,
      now: LATER,
    });
    expect(second).not.toBe(0);
    expect(readFileSync(join(store, "verdicts.json"), "utf8")).toBe(before);
    expect(streams.err.join("")).toContain("--replace");
    expect(streams.err.join("")).toContain("was already decided endorse");
  });

  it("SCP-189: under --json, refuses the second decision with one JSON object on stdout and nothing on stderr", async () => {
    const { repo, store } = storeWith("twice-json");
    const first = await runVerdictCommand({
      argv: ["AYO-7", "--endorse", STOP_ONE!, "--note", "I wanted to be asked", "--author", AUTHOR, "--repo", repo],
      streams: capture(),
      cwd: repo,
      now: NOW,
    });
    expect(first).toBe(0);
    const before = readFileSync(join(store, "verdicts.json"), "utf8");

    const streams = capture();
    const second = await runVerdictCommand({
      argv: ["AYO-7", "--accept", STOP_ONE!, "--author", AUTHOR, "--repo", repo, "--json"],
      streams,
      cwd: repo,
      now: LATER,
    });
    expect(second).toBe(EXIT_CODES.usage_or_input_error);
    // The refusal leaves the record exactly as it was, same as the plain path.
    expect(readFileSync(join(store, "verdicts.json"), "utf8")).toBe(before);
    // A `--json` caller gets one JSON object on stdout naming the standing
    // decision, and nothing at all on stderr — the prose path is for a person.
    expect(streams.err.join("")).toBe("");
    const printed = JSON.parse(streams.out.join("")) as {
      refused: boolean;
      finding_key: string;
      decision: string;
      author: string;
      decided_at: string;
    };
    expect(printed).toEqual({
      refused: true,
      finding_key: STOP_ONE,
      decision: "endorse",
      author: AUTHOR,
      decided_at: "2026-09-04T10:11:12.000Z",
    });
  });

  it("keeps the earlier decision on the record when --replace is given", async () => {
    const { repo, store } = storeWith("replaced");
    expect(
      await runVerdictCommand({
        argv: ["AYO-7", "--endorse", STOP_ONE!, "--note", "I wanted to be asked", "--author", AUTHOR, "--repo", repo],
        streams: capture(),
        cwd: repo,
        now: NOW,
      }),
    ).toBe(0);
    expect(
      await runVerdictCommand({
        argv: ["AYO-7", "--override", STOP_ONE!, "--note", "on reflection, fix it", "--author", AUTHOR, "--repo", repo, "--replace"],
        streams: capture(),
        cwd: repo,
        now: LATER,
      }),
    ).toBe(0);

    const file = readVerdicts(store);
    expect(file.verdicts).toHaveLength(2);
    expect(file.verdicts[0]).toMatchObject({
      decision: "endorse",
      note: "I wanted to be asked",
      decided_at: "2026-09-04T10:11:12.000Z",
      superseded_at: "2026-09-05T08:00:00.000Z",
    });
    expect(file.verdicts[1]).toMatchObject({
      decision: "override",
      note: "on reflection, fix it",
      superseded_at: null,
    });

    // And only the decision in force is counted.
    const streams = capture();
    await runStopsCommand({ argv: ["--repo", repo, "--json"], streams, cwd: repo });
    expect((JSON.parse(streams.out.join("")) as { summary: { endorsed: number; overridden: number } }).summary).toMatchObject({
      endorsed: 0,
      overridden: 1,
    });
  });
}, SPAWN_TEST_TIMEOUT_MS);

describe("SCP-189: a decline resolves from the attempts record alone once the review artifact is pruned", () => {
  const PRUNED_TICKET_ID = "ticket_pruned00001";
  const DECLINER = "att_pruned000000001";

  /**
   * A store with one remediation-round attempt whose transcript declines
   * `FINDING_KEY`. The round's own review bundle has its `review.json` bytes
   * marked unretained, exactly as pruning would leave it, so `attempt.review`
   * carries no findings and no `rule_id` for the key the decline names.
   *
   * `includeRoutingEvidence` controls a second, unrelated review bundle (a
   * different changeset, never picked as this attempt's own review) that
   * still lists `FINDING_KEY` — the evidence `parseDeclines` requires before
   * it will recognise a `NO_PRACTICE` line as a real decline at all, standing
   * in for whatever review first routed the finding. It never supplies a
   * `rule_id` to `knownFindings`, which only ever reads an attempt's *own*
   * review: the point of the fixture is that a rule_id from anywhere else is
   * invisible to it.
   */
  function storeWithPrunedDecline(name: string, includeRoutingEvidence = true): { repo: string; store: string } {
    const repo = join(scratch, name);
    const store = join(repo, ".perbo");
    mkdirSync(join(store, "tickets"), { recursive: true });
    mkdirSync(join(store, "state"), { recursive: true });
    writeFileSync(
      join(store, "tickets", "AYO-20.json"),
      JSON.stringify(
        makeTicket({ key: "AYO-20", ticket_id: PRUNED_TICKET_ID, repository_root: repo, pull_request_url: null }),
      ),
    );

    const decliner = makeAttempt({
      attempt_id: DECLINER,
      ticket_id: PRUNED_TICKET_ID,
      created_at: "2026-09-04T09:00:00.000Z",
      termination: { reason: "completed", detail: "" },
      usage: { iterations: 5, commands: 3, wall_clock_ms: 40_000, cost_basis: "not_incurred" },
      changeset_id: "cs_pruned_decline",
      head_commit: "d4e5f6a",
      remediation_round: 1,
    });
    writeFileSync(
      join(store, "state", `${PRUNED_TICKET_ID}.attempts.json`),
      `${JSON.stringify({ ticket_id: PRUNED_TICKET_ID, attempts: [decliner] }, null, 2)}\n`,
    );

    const bundles = new BundleStore({ root: join(store, "bundles"), retainContext: true });
    const write = (
      kind: RunBundleKind,
      subject_id: string,
      inputs: RunBundle["inputs"],
      artifacts: Array<{ name: string; media_type: string; body: string }>,
    ) =>
      bundles.write({
        kind,
        subject_id,
        ticket_id: PRUNED_TICKET_ID,
        inputs,
        context_manifest: [],
        versions: { code: "stage-3", prompt: "executor_v4", policy: "A2b", model: "claude-opus-5", tool: "1.0.98" },
        usage: { input_tokens: 1, output_tokens: 1, cost_micros: 0, cost_basis: "unavailable", wall_clock_ms: 1 },
        artifacts,
        errors: [],
        transitions: [],
        retention: { class: "raw_transcript", expires_at: null },
        secrets: new SecretIndex(),
        excluded_paths: [],
        deterministic: false,
        model_version_pinned: true,
        now: new Date("2026-09-04T09:05:00.000Z"),
      });

    // The unrelated, still-intact review: a different changeset, so this
    // attempt's own `reviewBundle` lookup never picks it, but it is still
    // scanned for the finding keys a decline is allowed to name.
    if (includeRoutingEvidence) {
      write(
        "review",
        "rev_still_intact001",
        { changeset_id: "cs_earlier_round", decision: "remediable", remediation_round: 0 },
        [
          {
            name: "review.json",
            media_type: "application/json",
            body: JSON.stringify(
              makeReview({ review_id: "rev_still_intact001", changeset_id: "cs_earlier_round", decision: "remediable", cost_basis: "unavailable" }),
            ),
          },
        ],
      );
    }

    // The round's own review — this is the one pruning takes.
    const { path: reviewPath } = write(
      "review",
      "rev_pruned00000001",
      { changeset_id: "cs_pruned_decline", decision: "remediable", remediation_round: 1 },
      [
        {
          name: "review.json",
          media_type: "application/json",
          body: JSON.stringify(
            makeReview({ review_id: "rev_pruned00000001", changeset_id: "cs_pruned_decline", decision: "remediable", cost_basis: "unavailable" }),
          ),
        },
      ],
    );
    const pruned = JSON.parse(readFileSync(reviewPath, "utf8")) as RunBundle;
    pruned.artifacts = pruned.artifacts.map((artifact) =>
      artifact.name === "review.json" ? { ...artifact, retained: false } : artifact,
    );
    writeFileSync(reviewPath, `${JSON.stringify(pruned, null, 2)}\n`);

    const decline = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: `NO_PRACTICE ${FINDING_KEY}: no house style covers this` }] },
    });
    write("execution", DECLINER, { termination: "completed", remediation_round: 1 }, [
      { name: "attempt.json", media_type: "application/json", body: JSON.stringify(decliner) },
      { name: "transcript.jsonl", media_type: "application/x-ndjson", body: decline },
    ]);

    return { repo, store };
  }

  it("resolves --endorse on the declined key with routing declined, with no rule_id visible to it", async () => {
    const { repo, store } = storeWithPrunedDecline("pruned-decline");
    const code = await runVerdictCommand({
      argv: ["AYO-20", "--endorse", FINDING_KEY, "--author", AUTHOR, "--repo", repo],
      streams: capture(),
      cwd: repo,
      now: NOW,
    });
    expect(code).toBe(0);
    const file = LocalVerdictsSchema.parse(JSON.parse(readFileSync(join(store, "verdicts.json"), "utf8")));
    expect(file.verdicts[0]).toMatchObject({
      finding_key: FINDING_KEY,
      routing: "declined",
      decision: "endorse",
    });
    // Never a rule this store ever recorded for the key: the real one was
    // exactly what the pruned bundle carried, and nothing else names it.
    expect(file.verdicts[0]!.rule_id).not.toBe("test.mocks_module_under_test");
    expect(file.verdicts[0]!.rule_id.length).toBeGreaterThan(0);
  });

  it("still refuses the key where no review, pruned or otherwise, ever routed it", async () => {
    // Without the second review bundle, `parseDeclines` has nothing to check
    // the transcript's NO_PRACTICE line against, so the decline is not even
    // parsed — the boundary the fix does not (and should not) reach past.
    const { repo } = storeWithPrunedDecline("pruned-decline-no-routing", false);
    await expect(
      runVerdictCommand({
        argv: ["AYO-20", "--endorse", FINDING_KEY, "--author", AUTHOR, "--repo", repo],
        streams: capture(),
        cwd: repo,
        now: NOW,
      }),
    ).rejects.toThrow(/no findings are recorded/);
  });
}, SPAWN_TEST_TIMEOUT_MS);

/**
 * `perbo verdict --list <change>`: the record read back.
 *
 * The command that takes a decision is only half of what a person needs from
 * this file — the other half is "what have we already decided about this", and
 * until now the only answers were `inspect`, which prints a decision beside
 * the finding it is about and needs the artifacts to do it, and reading
 * `verdicts.json` by hand. This prints the decisions themselves: what was
 * decided, who decided it as far as the record can say, and when.
 */
describe("perbo verdict --list reads back what was decided about a change", () => {
  /** Prose naming a group: not a name and an address, so no pair is recorded. */
  const A_TEAM = "the platform team";

  const decide = (repo: string, argv: string[], now: Date) =>
    runVerdictCommand({ argv: [...argv, "--author", argv.includes("--accept") ? A_TEAM : AUTHOR, "--repo", repo], streams: capture(), cwd: repo, now });

  it("prints both decisions newest first, with the key, the decision, who decided and when", async () => {
    const { repo } = storeWith("listed");
    // Two decisions on one change, a day apart, and the later one taken by
    // somebody the record cannot type as a name and an address.
    expect(await decide(repo, ["AYO-7", "--override", STOP_ONE!], NOW)).toBe(0);
    expect(await decide(repo, ["AYO-7", "--accept", ADVISORY!], LATER)).toBe(0);

    const streams = capture();
    expect(await runVerdictCommand({ argv: ["AYO-7", "--list", "--repo", repo], streams, cwd: repo })).toBe(0);
    const lines = streams.out.join("").split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(2);

    // Newest first, and each line carries the whole answer: when it was taken,
    // which finding it was about, what was decided, and who decided it.
    expect(lines[0]).toBe(`2026-09-05T08:00:00.000Z  ${ADVISORY!.slice(0, 12)}  accept    not recorded`);
    expect(lines[1]).toBe(`2026-09-04T10:11:12.000Z  ${STOP_ONE!.slice(0, 12)}  override  ${AUTHOR}`);
    // The prose the second decision was taken under is not a pair and is not
    // printed as one: the row says the record does not carry who.
    expect(lines[0]).not.toContain(A_TEAM);
  });

  it("prints `no decisions recorded` and exits 0 for a change nothing has been decided about", async () => {
    const { repo, store } = storeWith("listed-none");
    const streams = capture();

    const code = await runVerdictCommand({ argv: ["AYO-7", "--list", "--repo", repo], streams, cwd: repo });

    expect(code).toBe(0);
    expect(streams.out.join("")).toBe("no decisions recorded\n");
    // Reading the record does not start one: nothing at all was written.
    expect(existsSync(join(store, "verdicts.json"))).toBe(false);
  });

  it("emits the stored rows unchanged under --json, narrowed to the change asked about", async () => {
    const { repo, store } = storeWith("listed-json");
    expect(await decide(repo, ["AYO-7", "--override", STOP_ONE!], NOW)).toBe(0);
    // A replaced decision and its replacement: both are on the record, so both
    // are in what --list emits.
    expect(await decide(repo, ["AYO-7", "--endorse", STOP_ONE!, "--replace"], LATER)).toBe(0);

    // A decision on some other change, written straight into the same file, so
    // that "the rows for this change" is a narrowing and not the whole file.
    const file = readVerdicts(store);
    const elsewhere = LocalVerdictSchema.parse({
      ...file.verdicts[0]!,
      review: { ...file.verdicts[0]!.review, reference: "AYO-8", ticket_id: "ticket_other000001", ticket_key: "AYO-8" },
    });
    writeFileSync(
      join(store, "verdicts.json"),
      `${JSON.stringify(LocalVerdictsSchema.parse({ ...file, verdicts: [...file.verdicts, elsewhere] }), null, 2)}\n`,
    );

    const streams = capture();
    expect(
      await runVerdictCommand({ argv: ["AYO-7", "--list", "--json", "--repo", repo], streams, cwd: repo }),
    ).toBe(0);

    // Read back through the contracts' own schema, and equal to the rows the
    // store holds for this change — same fields, same order, nothing computed.
    const printed = LocalVerdictsSchema.parse(JSON.parse(streams.out.join("")));
    const stored = readVerdicts(store).verdicts.filter((row) => row.review.ticket_id === TICKET_ID);
    expect(stored).toHaveLength(2);
    expect(printed.verdicts).toEqual(stored);
    expect(printed.schema_version).toBe(file.schema_version);
    // And the other change's decision is not in it.
    expect(streams.out.join("")).not.toContain("AYO-8");
  });

  it("takes no decision and none of the flags that write one", () => {
    expect(parseVerdictArgs(["AYO-7", "--list"])).toEqual({
      list: true,
      reference: "AYO-7",
      repo: ".",
      store: null,
      json: false,
    });
    // Reading and deciding in one invocation is a person meaning one of them.
    expect(() => parseVerdictArgs(["AYO-7", "--list", "--endorse", STOP_ONE!])).toThrow(/one or the other/);
    // The flags that only make sense when something is being written are
    // refused rather than ignored: silence would read as having recorded them.
    expect(() => parseVerdictArgs(["AYO-7", "--list", "--note", "x"])).toThrow(/--note/);
    expect(() => parseVerdictArgs(["AYO-7", "--list", "--author", AUTHOR])).toThrow(/--author/);
    expect(() => parseVerdictArgs(["AYO-7", "--list", "--replace"])).toThrow(/--replace/);
    expect(() => parseVerdictArgs(["AYO-7", "--list", "--stand-in"])).toThrow(/--stand-in/);
  });
}, SPAWN_TEST_TIMEOUT_MS);

/**
 * `perbo verdict --stand-in`: the command line's half of D-058's label.
 *
 * A stop becomes dogfood two ways, and this is the one that needs no pull
 * request: the AI acting as the founder's partner takes a decision here and
 * says so, the row carries who answered, and every partner number `perbo
 * stops` prints is read without it. The flag has to be typed — an answer taken
 * here says nothing about who took it unless somebody says it, and the silent
 * reading is "a person", which is what every row written before the flag
 * existed meant.
 *
 * What is asserted below is the record on disk and the numbers the reading
 * prints from it, over stores this file builds the way the loop builds one.
 */
describe("perbo verdict --stand-in labels the answer dogfood", () => {
  const STAND_IN = "Perbo stand-in <stand-in@example.invalid>";

  const answer = (repo: string, argv: readonly string[], author: string) =>
    runVerdictCommand({
      argv: [...argv, "--author", author, "--repo", repo],
      streams: capture(),
      cwd: repo,
      now: NOW,
    });

  const summaryOf = async (repo: string) => {
    const streams = capture();
    expect(await runStopsCommand({ argv: ["--repo", repo, "--json"], streams, cwd: repo })).toBe(0);
    return (
      JSON.parse(streams.out.join("")) as {
        summary: {
          precision: { n: number };
          endorsed: number;
          stops: number;
          dogfood_stops: number;
          dogfood_changes: number;
        };
      }
    ).summary;
  };

  it("takes the flag beside a decision, and defaults to nobody having claimed one", () => {
    const taken = parseVerdictArgs(["AYO-7", "--endorse", STOP_ONE!, "--stand-in"]);
    expect(taken).toMatchObject({ list: false, decision: "endorse", standIn: true });
    // Order is not part of it: the flag reads the same before the decision.
    expect(parseVerdictArgs(["AYO-7", "--stand-in", "--endorse", STOP_ONE!])).toMatchObject({ standIn: true });
    // And an answer nobody claimed is not the stand-in's by omission.
    expect(parseVerdictArgs(["AYO-7", "--endorse", STOP_ONE!])).toMatchObject({ standIn: false });
  });

  it("writes answered_by on the stand-in's row and leaves a person's row without it", async () => {
    const { repo, store } = storeWith("stand-in-row");
    const streams = capture();

    expect(
      await runVerdictCommand({
        argv: ["AYO-7", "--endorse", STOP_ONE!, "--stand-in", "--author", STAND_IN, "--repo", repo],
        streams,
        cwd: repo,
        now: NOW,
      }),
    ).toBe(0);
    expect(await answer(repo, ["AYO-7", "--override", STOP_TWO!], AUTHOR)).toBe(0);

    const [claimed, unclaimed] = readVerdicts(store).verdicts;
    expect(claimed).toMatchObject({ finding_key: STOP_ONE, decision: "endorse", answered_by: "stand_in" });
    // Absent rather than `null`: a row nobody claimed reads exactly as every
    // row written before the flag existed does, which is what makes the label
    // able to take a stop out of a partner number and never put one in.
    expect(unclaimed).toMatchObject({ finding_key: STOP_TWO, decision: "override" });
    expect(Object.hasOwn(unclaimed!, "answered_by")).toBe(false);
    // And the person taking the decision is told what the flag did to it.
    expect(streams.err.join("")).toContain("recorded as the AI stand-in's answer: dogfood");
  });

  it("keeps the stand-in's decision out of the partner reading, and a person's in it", async () => {
    // The same store, the same key, the same decision, one flag apart. The
    // pull request lists all three stops with nothing ticked, so the record
    // the decision lands on is one `perbo sync` wrote.
    const { repo: byStandIn } = storeWith("stand-in-excluded", { pullRequest: body() });
    const { repo: byPerson } = storeWith("stand-in-counted", { pullRequest: body() });
    expect(await answer(byStandIn, ["AYO-7", "--endorse", STOP_ONE!, "--stand-in"], STAND_IN)).toBe(0);
    expect(await answer(byPerson, ["AYO-7", "--endorse", STOP_ONE!], AUTHOR)).toBe(0);

    expect(await summaryOf(byStandIn)).toMatchObject({
      // No partner answered anything, so precision has no population at all…
      precision: { n: 0 },
      endorsed: 0,
      // …and the change that left it is counted rather than dropped.
      dogfood_stops: 1,
      dogfood_changes: 1,
      // The record's own diagnostics are untouched: three stops are three
      // stops whoever answered one of them.
      stops: 3,
    });
    expect(await summaryOf(byPerson)).toMatchObject({
      precision: { n: 1 },
      endorsed: 1,
      dogfood_stops: 0,
      dogfood_changes: 0,
      stops: 3,
    });
  });

  it("excludes it on a store with no stops record either, where the decision is the whole record", async () => {
    // The offline path: nothing was synced, so the reading is built out of
    // `verdicts.json` alone. The label has to survive that construction too.
    const { repo } = storeWith("stand-in-offline");
    expect(await answer(repo, ["AYO-7", "--endorse", STOP_ONE!, "--stand-in"], STAND_IN)).toBe(0);
    expect(await answer(repo, ["AYO-7", "--override", STOP_TWO!], AUTHOR)).toBe(0);

    expect(await summaryOf(repo)).toMatchObject({
      // One partner answer, an override: the change is overridden, not endorsed
      // — the stand-in's endorsement is not a person wanting to be asked.
      precision: { n: 1 },
      endorsed: 0,
      dogfood_stops: 1,
      dogfood_changes: 0,
      stops: 2,
    });

    // And the exclusion is on the page rather than folded away.
    const streams = capture();
    await runStopsCommand({ argv: ["--repo", repo], streams, cwd: repo });
    expect(streams.out.join("")).toMatch(/dogfood stops excluded\s+1\s+answered by an AI stand-in/);
  });
}, SPAWN_TEST_TIMEOUT_MS);
