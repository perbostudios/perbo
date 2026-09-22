import type * as ChildProcess from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  EXIT_CODES,
  ReviewArtifactSchema,
  SecretIndex,
  findingKey,
  planContractFromSource,
  sourceContractFromPullRequest,
  type Finding,
  type ReviewArtifact,
  type RunBundle,
} from "@perbo/contracts";
import { BundleStore } from "@perbo/runner";
import { LocalVerdictsSchema } from "./record.js";
import {
  buildTicketlessBundle,
  routingFor,
  writeTicketlessBundle,
  type ReviewTarget,
} from "../review/ticketless.js";
import { verdictCommandLine } from "./index.js";
import { runCommandLine } from "../../command-line/terminal.js";
import { makeAttempt, makeReview } from "../../test-support/attempt-fixture.js";
import { SPAWN_TEST_TIMEOUT_MS } from "../../test-support/spawn-timeout.js";

/**
 * `perbo verdict` on a review that no attempt filed (SCP-249).
 *
 * `perbo review --pr owner/repo#N` writes its bundle into
 * `<repo>/.perbo/reviews/` and files no attempt: there was no run, so there is
 * no attempts record for the id it hands back. Every test here runs against a
 * repository holding only what `review` wrote, which is the shape the readiness
 * run met, so the reference reaches `<store>/reviews/` only after the ticket
 * store and the attempts record have both said they do not know it.
 *
 * The network is stubbed to throw and every child process but `git` is refused,
 * for the same reason the ticket-store suite does it: a decision is a local
 * fact, and a test that let either through would not be checking that.
 */

type ChildProcessModule = typeof ChildProcess;

vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<ChildProcessModule>();
  const refuse = (file: string): never => {
    throw new Error(`refused: recording a verdict spawned ${file}`);
  };
  return {
    ...actual,
    execFileSync: ((file: string, args: readonly string[], options: unknown) =>
      file === "git" ? actual.execFileSync(file, args as string[], options as never) : refuse(file)) as unknown,
    execFile: (file: string) => refuse(file),
    exec: (command: string) => refuse(command),
    spawn: (file: string) => refuse(file),
    spawnSync: (file: string) => refuse(file),
  };
});

vi.stubGlobal("fetch", () => {
  throw new Error("refused: recording a verdict asked the network");
});

const scratch = mkdtempSync(join(tmpdir(), "perbo-verdict-review-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const REVIEW_ID = "rev_open00000001";
const PULL_REQUEST = "o/r#7";
const PULL_REQUEST_URL = "https://github.com/o/r/pull/7";
/** What `planContractFromSource` mints for that pull request, and files under. */
const WORK_ID = "ticket_gh_o_r_7";
const NOW = new Date("2026-09-06T09:10:11.000Z");
const LATER = new Date("2026-09-06T12:00:00.000Z");
const AUTHOR = "Lian Matsuo <lian@example.invalid>";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (chunk: string) => out.push(chunk), stderr: (chunk: string) => err.push(chunk), isTTY: false };
}

/* ------------------------------------------------------------------ *
 * The review the pull request got: two advisory findings of one rule on
 * two files, which is the shape `review --pr` produced on the readiness
 * run. Both keys start `8b`, so that prefix names two findings and is
 * the ambiguous one the command has to refuse.
 * ------------------------------------------------------------------ */

const FINDINGS = [
  {
    rule_id: "criterion.no_execution_evidence",
    criterion_id: "ac_outcome",
    file: "src/queue.ts",
    statement: "Nothing in the change proves the queue drains under load.",
  },
  {
    rule_id: "criterion.no_execution_evidence",
    criterion_id: "ac_outcome",
    file: "src/server.ts",
    statement: "The new handler has no test that runs it.",
  },
] as const;

const KEYS = FINDINGS.map((finding) =>
  findingKey({ rule_id: finding.rule_id, criterion_id: finding.criterion_id, file: finding.file, symbol: null }),
);
const [QUEUE, SERVER] = KEYS as [string, string];

/** The prefix both findings answer to, which is what makes it no answer at all. */
const AMBIGUOUS = "8b";

function reviewArtifact(): ReviewArtifact {
  const base = makeReview({
    review_id: REVIEW_ID,
    changeset_id: "cs_open00000001",
    decision: "approve",
    cost_basis: "unavailable",
  });
  const template = base.findings[0]!;
  return ReviewArtifactSchema.parse({
    ...base,
    plan_id: "plan_gh_o_r_7",
    findings: FINDINGS.map((finding, index) => ({
      ...template,
      key: KEYS[index]!,
      rule_id: finding.rule_id,
      criterion_id: finding.criterion_id,
      severity: "minor",
      blocking: false,
      routing: "advisory",
      closure: "executor",
      file: finding.file,
      line: 3,
      symbol: null,
      statement: finding.statement,
    })) satisfies Array<Record<string, unknown>> as Finding[],
  });
}

/**
 * A repository as `perbo review --pr` leaves one: `.perbo/reviews/` holding
 * the bundle it wrote, and nothing else at all — no ticket, no attempts record,
 * no bundles. The bundle is built by the same functions the command uses, so
 * the fixture is an artifact rather than a hand-written imitation of one.
 */
function repositoryWithReview(name: string, artifact = reviewArtifact()): { repo: string; store: string } {
  const repo = join(scratch, name);
  const store = join(repo, ".perbo");
  mkdirSync(store, { recursive: true });
  const contract = sourceContractFromPullRequest({
    reference: PULL_REQUEST,
    title: "Drain the queue on shutdown",
    body: "The worker exits with items still queued.",
    url: PULL_REQUEST_URL,
  });
  const plan = planContractFromSource({
    contract,
    base_commit: "d105e19",
    repository_id: "repo_o_r",
    paths_allowed: ["**"],
    captured_at: new Date("2026-09-06T08:00:00.000Z"),
  });
  const target: ReviewTarget = {
    kind: "pull_request",
    reference: PULL_REQUEST,
    url: PULL_REQUEST_URL,
    head_ref: "fix/drain-queue",
    base_ref: "main",
    head_commit: "bb409e7",
    base_commit: "d105e19",
    merge_base: false,
    github_credential: "gh_login",
    head_repository: "o/r",
    head_lookup: "same_repository",
  };
  writeTicketlessBundle(
    join(store, "reviews"),
    buildTicketlessBundle({
      source: { contract, plan, target, diff: "diff --git a/src/queue.ts b/src/queue.ts\n", external_text_attempts: [] },
      artifact,
      routing: routingFor(artifact),
    }),
  );
  return { repo, store };
}

const readVerdicts = (store: string) =>
  LocalVerdictsSchema.parse(JSON.parse(readFileSync(join(store, "verdicts.json"), "utf8")));

const verdict = (repo: string, argv: string[], now = NOW) =>
  runCommandLine(verdictCommandLine, {
    argv: [...argv, "--repo", repo],
    streams: capture(),
    cwd: repo,
    now,
  });

describe("perbo verdict answers a review that `review --pr` wrote", () => {
  it("records the decision against the work the review names", async () => {
    const { repo, store } = repositoryWithReview("records");
    const streams = capture();

    const code = await runCommandLine(verdictCommandLine, {
      argv: [REVIEW_ID, "--accept", QUEUE.slice(0, 12), "--note", "fair: no test covers it", "--author", AUTHOR, "--repo", repo],
      streams,
      cwd: repo,
      now: NOW,
    });

    expect(code).toBe(EXIT_CODES.approve);
    const file = readVerdicts(store);
    expect(file.verdicts).toHaveLength(1);
    expect(file.verdicts[0]).toEqual({
      review: {
        reference: REVIEW_ID,
        // The plan the reviewer was given is what files the decision, so a
        // second review of the same pull request answers about the same work.
        ticket_id: WORK_ID,
        ticket_key: null,
        pull_request_url: PULL_REQUEST_URL,
      },
      finding_key: QUEUE,
      rule_id: "criterion.no_execution_evidence",
      routing: null,
      decision: "accept",
      author: AUTHOR,
      decided_by: { name: "Lian Matsuo", email: "lian@example.invalid" },
      decided_at: "2026-09-06T09:10:11.000Z",
      note: "fair: no test covers it",
      superseded_at: null,
    });
    // The key came off the review this store holds, and the line says so.
    expect(streams.err.join("")).toContain(REVIEW_ID);
    expect(streams.err.join("")).toContain("nothing was sent anywhere");
  });

  it("rejects a finding the same way it accepts one", async () => {
    const { repo, store } = repositoryWithReview("rejects");
    expect(await verdict(repo, [REVIEW_ID, "--reject", SERVER, "--author", AUTHOR])).toBe(EXIT_CODES.approve);
    expect(readVerdicts(store).verdicts[0]).toMatchObject({
      finding_key: SERVER,
      decision: "reject",
      review: { ticket_id: WORK_ID },
    });
  });

  it("lists every decision recorded for the review beside its finding", async () => {
    const { repo } = repositoryWithReview("lists");
    await verdict(repo, [REVIEW_ID, "--accept", QUEUE, "--author", AUTHOR]);
    await verdict(repo, [REVIEW_ID, "--reject", SERVER, "--author", AUTHOR], LATER);
    const streams = capture();

    expect(
      await runCommandLine(verdictCommandLine, {
        argv: [REVIEW_ID, "--list", "--repo", repo],
        streams,
        cwd: repo,
        now: NOW,
      }),
    ).toBe(EXIT_CODES.approve);
    const printed = streams.out.join("");
    expect(printed).toContain(`${QUEUE.slice(0, 12)}  accept`);
    expect(printed).toContain(`${SERVER.slice(0, 12)}  reject`);
    // Newest first, which is where the reader's question ends up.
    expect(printed.indexOf(SERVER.slice(0, 12))).toBeLessThan(printed.indexOf(QUEUE.slice(0, 12)));
  });

  it("refuses a second decision on one finding without --replace, and takes it with", async () => {
    const { repo, store } = repositoryWithReview("replace");
    await verdict(repo, [REVIEW_ID, "--accept", QUEUE, "--author", AUTHOR]);
    const before = readFileSync(join(store, "verdicts.json"), "utf8");
    const refused = capture();

    expect(
      await runCommandLine(verdictCommandLine, {
        argv: [REVIEW_ID, "--reject", QUEUE, "--author", AUTHOR, "--repo", repo],
        streams: refused,
        cwd: repo,
        now: LATER,
      }),
    ).toBe(EXIT_CODES.usage_or_input_error);
    expect(refused.err.join("")).toContain("--replace");
    // Refused means the bytes on disk did not move.
    expect(readFileSync(join(store, "verdicts.json"), "utf8")).toBe(before);

    expect(await verdict(repo, [REVIEW_ID, "--reject", QUEUE, "--replace", "--author", AUTHOR], LATER)).toBe(
      EXIT_CODES.approve,
    );
    const rows = readVerdicts(store).verdicts;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ decision: "accept", superseded_at: LATER.toISOString() });
    expect(rows[1]).toMatchObject({ decision: "reject", superseded_at: null });
  });

  it("refuses a prefix that names both findings", async () => {
    const { repo } = repositoryWithReview("ambiguous");
    expect(QUEUE.startsWith(AMBIGUOUS) && SERVER.startsWith(AMBIGUOUS)).toBe(true);
    expect(() => verdict(repo, [REVIEW_ID, "--accept", AMBIGUOUS, "--author", AUTHOR])).toThrow(
      /names 2 findings/,
    );
  });

  it("refuses a review that is in neither place, naming both", async () => {
    const { repo, store } = repositoryWithReview("unknown");
    expect(() => verdict(repo, ["rev_nothingatall", "--accept", QUEUE, "--author", AUTHOR])).toThrow(
      /holds no attempts for rev_nothingatall[\s\S]*reviews/,
    );
    // And the one it does hold is named, so a mistyped id is a short step back.
    expect(() => verdict(repo, ["rev_nothingatall", "--list"])).toThrow(new RegExp(REVIEW_ID));
    expect(store).toContain(".perbo");
  });
}, SPAWN_TEST_TIMEOUT_MS);

describe("a review an attempt filed still resolves through the attempts record", () => {
  /**
   * The same store, with a run filed under the very id the stored review is
   * filed under and its own review artifact naming a different finding. The
   * attempts record is the older path and stays the answer: a decision taken
   * here must be the one the run's own review says, not the one a review
   * written beside it happens to hold.
   */
  function repositoryWithBoth(name: string): { repo: string; store: string; key: string } {
    const { repo, store } = repositoryWithReview(name);
    const attempt = makeAttempt({
      attempt_id: "att_open00000000001",
      ticket_id: WORK_ID,
      created_at: "2026-09-06T08:30:00.000Z",
      termination: { reason: "completed", detail: "" },
      usage: { iterations: 3, commands: 2, wall_clock_ms: 1000, cost_basis: "unavailable" },
      changeset_id: "cs_open00000002",
      head_commit: "b2c3d4e",
    });
    mkdirSync(join(store, "state"), { recursive: true });
    writeFileSync(
      join(store, "state", `${WORK_ID}.attempts.json`),
      `${JSON.stringify({ ticket_id: WORK_ID, attempts: [attempt] }, null, 2)}\n`,
    );
    const ranKey = findingKey({
      rule_id: "test.mocks_module_under_test",
      criterion_id: "ac_1",
      file: "src/only-the-run-found-this.ts",
      symbol: null,
    });
    const ran = ReviewArtifactSchema.parse({
      ...makeReview({
        review_id: "rev_open00000002",
        changeset_id: "cs_open00000002",
        decision: "approve",
        cost_basis: "unavailable",
      }),
      findings: [
        {
          ...makeReview({
            review_id: "rev_open00000002",
            changeset_id: "cs_open00000002",
            decision: "approve",
            cost_basis: "unavailable",
          }).findings[0]!,
          key: ranKey,
          file: "src/only-the-run-found-this.ts",
        },
      ] satisfies Array<Record<string, unknown>> as Finding[],
    });
    const bundles = new BundleStore({ root: join(store, "bundles"), retainContext: true });
    const write = (
      kind: "execution" | "review",
      subject_id: string,
      inputs: RunBundle["inputs"],
      artifacts: Array<{ name: string; media_type: string; body: string }>,
    ) =>
      bundles.write({
        kind,
        subject_id,
        ticket_id: WORK_ID,
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
        now: new Date("2026-09-06T08:40:00.000Z"),
      });
    write("execution", "att_open00000000001", { termination: "completed" }, [
      { name: "attempt.json", media_type: "application/json", body: JSON.stringify(attempt) },
      { name: "transcript.jsonl", media_type: "application/x-ndjson", body: "" },
    ]);
    write("review", "rev_open00000002", { changeset_id: "cs_open00000002", decision: "approve", remediation_round: 0 }, [
      { name: "review.json", media_type: "application/json", body: JSON.stringify(ran) },
    ]);
    return { repo, store, key: ranKey };
  }

  it("decides the finding the run's own review names, by the id the run was filed under", async () => {
    const { repo, store, key } = repositoryWithBoth("attempt-filed");
    const streams = capture();

    expect(
      await runCommandLine(verdictCommandLine, {
        argv: [WORK_ID, "--accept", key.slice(0, 12), "--author", AUTHOR, "--repo", repo],
        streams,
        cwd: repo,
        now: NOW,
      }),
    ).toBe(EXIT_CODES.approve);
    expect(readVerdicts(store).verdicts[0]).toMatchObject({
      finding_key: key,
      rule_id: "test.mocks_module_under_test",
      // The attempts record knows of no pull request, and the review sitting
      // beside it does. A row carrying that url would be this reference
      // resolved through the reviews directory instead of through the record.
      review: { reference: WORK_ID, ticket_id: WORK_ID, pull_request_url: null },
    });
    // And the same, in what a person is shown: the id the run was filed under,
    // never the pull request the review beside it read.
    expect(streams.out.join("")).toContain(WORK_ID);
    expect(streams.out.join("")).not.toContain(PULL_REQUEST);
    expect(streams.err.join("")).toContain("read from the review artifact");
  });
}, SPAWN_TEST_TIMEOUT_MS);
