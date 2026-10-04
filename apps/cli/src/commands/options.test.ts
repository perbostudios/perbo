import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { EXIT_CODES, ReviewArtifactSchema, SecretIndex, gateClosedNote, type Finding, type ReviewArtifact } from "@perbo/contracts";
import { SUBMIT_REVIEW_TOOL, type Model, type ModelRequest, type ModelTurn } from "@perbo/model";
import { DecisionOptionsVerdictSchema, decisionOptionsRecordPath, readDecisionOptionsRecord } from "@perbo/planning";
import { BundleStore } from "@perbo/runner";
import { initRepository } from "@perbo/test-support";
import { runCommandLine } from "../command-line/terminal.js";
import { listTickets, readTicket, storeDir, writeTicket } from "../store/tickets.js";
import { makeAttempt, makeReview } from "../test-support/records.js";
import { recordStreams } from "../test-support/streams.js";
import { UsageError } from "../usage-error.js";
import { admitCommandLine } from "./admit.js";
import { optionsCommandLine } from "./options.js";

/**
 * `perbo options`: the Architect's answers to the findings a ticket's last
 * review left for a person (D-135), and the record that keeps
 * them for that review so asking again spends nothing.
 *
 * Nothing here calls a model. The reading is a scripted double, and the one
 * that must never be reached throws — a cached set that quietly ran a model
 * would pass a test that only read the output.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-options-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SPEC = `# Activation email

## Outcome

New users receive an activation email within 60 seconds of signing up.

## Requirements

- R1: A signup POST queues exactly one activation email.
- R2: A failed send is retried three times.
`;

const drafted = {
  name: "Activation email",
  outcome: "New users receive an activation email within 60 seconds of signing up.",
  acceptance_criteria: [
    {
      text: "A signup POST queues exactly one activation email.",
      assertion: "one message is on the queue after a single signup",
      kind: "test",
      requirement_id: "R1",
    },
    {
      text: "A failed send is retried three times.",
      assertion: "three attempts are recorded for one failing send",
      kind: "test",
      requirement_id: "R2",
    },
  ],
  proposed_scope: { paths_allowed: ["packages/queue/**"], paths_prohibited_extra: [] },
  rationale: "The spec's two requirements are queueing and retrying.",
  depends_on: [],
  nodes: [],
  edges: [],
};

function scripted(script: Array<Array<{ tool: string; input: unknown }>>): Model & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let turn = 0;
  return {
    provider: "double",
    model_id: "scripted",
    requests,
    async turn(request: ModelRequest): Promise<ModelTurn> {
      requests.push(request);
      const calls = script[turn] ?? [];
      turn += 1;
      return {
        toolCalls: calls.map((call, index) => ({ id: `t${turn}_${index}`, name: call.tool, input: call.input })),
        usage: { input_tokens: 800, output_tokens: 150, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        stop_reason: calls.length > 0 ? "tool_use" : "end_turn",
      };
    },
  };
}
const submits = (input: unknown) => [{ tool: SUBMIT_REVIEW_TOOL, input }];

/** A model the command must not reach. */
const unreachable = (): Model => ({
  provider: "double",
  model_id: "unreachable",
  turn(): Promise<ModelTurn> {
    throw new Error("the model was called for answers already on record");
  },
});

const DEAD_LETTER = "d".repeat(64);
const WHO_IS_TOLD = "e".repeat(64);
const SECRET = "f".repeat(64);
const EXECUTORS = "9".repeat(64);

const finding = (over: Partial<Finding>): Finding =>
  ({
    key: DEAD_LETTER,
    rule_id: "product.dead_letter",
    source: "semantic",
    criterion_id: "ac_2",
    severity: "major",
    blocking: true,
    blocking_reason: "Criterion 2 leaves a product choice unresolved.",
    routing: "escalates",
    row: "semantic_high_risk",
    closure: "human",
    direction: "unsure",
    confidence: 0.8,
    file: "packages/queue/retry.ts",
    line: 67,
    symbol: null,
    statement: "Where should a permanently failed email go?",
    status: "open",
    outcome: "unknown",
    waiver: null,
    ...over,
  }) as Finding;

let repos = 0;
/** PRB-1 admitted from its spec, with one attempt whose review escalated the given findings. */
async function reviewed(
  findings: Finding[],
  reviewId = "rev_options0001",
  decision: ReviewArtifact["decision"] = "escalate",
): Promise<{ repo: string; dir: string }> {
  const repo = join(scratch, `repo-${repos++}`);
  initRepository(repo, { files: { "specs/activation-email/spec.md": SPEC } });
  const streams = recordStreams();
  const code = await runCommandLine(admitCommandLine, {
    argv: ["--repo", repo, "--from-spec", join(repo, "specs", "activation-email", "spec.md")],
    streams,
    cwd: repo,
    deps: { model: scripted([submits(drafted)]) },
  });
  if (code !== EXIT_CODES.approve) throw new Error(`admission failed:\n${streams.err()}`);
  const dir = storeDir(repo, null);
  record(dir, findings, reviewId, 1, decision);
  return { repo, dir };
}

/** Another attempt on PRB-1, reviewed with the given findings, recorded after the ones before it. */
function record(
  dir: string,
  findings: Finding[],
  reviewId: string,
  round: number,
  decision: ReviewArtifact["decision"] = "escalate",
): void {
  const ticket_id = readTicket(dir, "PRB-1").ticket_id;
  const attempts = join(dir, "state", `${ticket_id}.attempts.json`);
  const prior = round === 1 ? [] : JSON.parse(readFileSync(attempts, "utf8")).attempts;
  const attempt = makeAttempt({
    attempt_id: `att_options0000000${round}`,
    ticket_id,
    created_at: `2026-09-27T1${round}:00:00.000Z`,
    termination: { reason: "completed", detail: "" },
    usage: { cost_micros: 0 },
    changeset_id: `cs_options0000${round}`,
    head_commit: "b2c3d4e",
  });
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(attempts, `${JSON.stringify({ ticket_id, attempts: [...prior, attempt] }, null, 2)}\n`);
  const review = ReviewArtifactSchema.parse({
    ...makeReview({
      review_id: reviewId,
      changeset_id: `cs_options0000${round}`,
      decision,
      cost_basis: "unavailable",
    }),
    findings,
  });
  const bundles = new BundleStore({ root: join(dir, "bundles"), retainContext: true });
  const write = (
    kind: "execution" | "review",
    subject_id: string,
    inputs: Record<string, string>,
    artifacts: Array<{ name: string; media_type: string; body: string }>,
  ) =>
    bundles.write({
      kind,
      subject_id,
      ticket_id,
      inputs,
      context_manifest: [],
      versions: { code: "test", prompt: "executor_v4", policy: "A2b", model: "claude-opus-5", tool: "1.0.98" },
      usage: { input_tokens: 1, output_tokens: 1, cost_micros: 0, cost_basis: "unavailable", wall_clock_ms: 1 },
      artifacts,
      errors: [],
      transitions: [],
      retention: { class: "raw_transcript", expires_at: null },
      secrets: new SecretIndex(),
      excluded_paths: [],
      deterministic: false,
      model_version_pinned: true,
      now: new Date(`2026-09-27T1${round}:01:00.000Z`),
    });
  write("execution", attempt.attempt_id, { termination: "completed" }, [
    { name: "attempt.json", media_type: "application/json", body: JSON.stringify(attempt) },
    {
      name: "change.diff",
      media_type: "text/x-diff",
      body: `diff --git a/packages/queue/retry.ts b/packages/queue/retry.ts\n+export const retries = ${round + 2};\n`,
    },
  ]);
  write("review", review.review_id, { attempt_id: attempt.attempt_id }, [
    { name: "review.json", media_type: "application/json", body: JSON.stringify(review) },
  ]);
}

/**
 * A remediation round on PRB-1 after its review, judged by a closure
 * verification that was given `given` and left `open` open, recorded under
 * the round's own attempt as the loop records it.
 */
function verified(
  dir: string,
  round: number,
  given: readonly string[],
  open: readonly string[],
  declines: readonly { finding_key: string; reason: string }[] = [],
): void {
  const ticket_id = readTicket(dir, "PRB-1").ticket_id;
  const attempts = join(dir, "state", `${ticket_id}.attempts.json`);
  const prior = JSON.parse(readFileSync(attempts, "utf8")).attempts;
  const attempt = makeAttempt({
    attempt_id: `att_options0000000${round}`,
    ticket_id,
    created_at: `2026-09-27T1${round}:00:00.000Z`,
    termination: { reason: "completed", detail: "" },
    usage: { cost_micros: 0 },
    changeset_id: `cs_options0000${round}`,
    head_commit: "b2c3d4e",
  });
  writeFileSync(
    attempts,
    `${JSON.stringify({ ticket_id, attempts: [...prior, { ...attempt, declines: [...declines] }] }, null, 2)}\n`,
  );
  new BundleStore({ root: join(dir, "bundles"), retainContext: true }).write({
    kind: "review",
    subject_id: `cv_${attempt.attempt_id}`,
    ticket_id,
    inputs: { head_commit: "b2c3d4e", findings_given: given.join(","), findings_open: open.join(",") },
    context_manifest: [],
    versions: { code: "test", prompt: "closure_verify_v1", policy: "A2b", model: "claude-opus-5", tool: "1.0.98" },
    usage: { input_tokens: 1, output_tokens: 1, cost_micros: 0, cost_basis: "unavailable", wall_clock_ms: 1 },
    artifacts: [],
    errors: [],
    transitions: [],
    retention: { class: "raw_transcript", expires_at: null },
    secrets: new SecretIndex(),
    excluded_paths: [],
    deterministic: false,
    model_version_pinned: true,
    now: new Date(`2026-09-27T1${round}:01:00.000Z`),
  });
}

/** The row the CLI writes on PRB-1 for a run that ended on `outcome`. */
function ended(dir: string, outcome: string): void {
  const ticket = readTicket(dir, "PRB-1");
  writeTicket(dir, {
    ...ticket,
    history: [...ticket.history, { at: "2026-09-27T15:00:00.000Z", from: "independent_review", to: "changes_requested", note: gateClosedNote(outcome) }],
  });
}

const offered = [
  { text: "Park it on the dead-letter queue and alert the on-call channel.", recommended: true },
  { text: "Drop it after the last retry and log the failure.", recommended: false },
];
const told = [{ text: "Tell the account's owner by email.", recommended: true }];

async function ask(repo: string, keys: string[], model: Model) {
  const streams = recordStreams();
  const code = await runCommandLine(optionsCommandLine, {
    argv: ["PRB-1", "--repo", repo, ...keys.flatMap((key) => ["--finding", key])],
    streams,
    cwd: repo,
    now: new Date("2026-09-27T12:00:00.000Z"),
    deps: { model },
  });
  return { code, printed: DecisionOptionsVerdictSchema.parse(streams.json()) };
}

describe("perbo options's line", () => {
  it("takes the ticket, any number of findings, the repository and the model", () => {
    expect(
      optionsCommandLine.read([
        "PRB-3", "--finding", DEAD_LETTER, "--finding", WHO_IS_TOLD, "--repo", "..", "--store", "s",
        "--provider", "codex-cli", "--model", "m", "--json",
      ]),
    ).toEqual({
      input: {
        target: { repo: "..", store: "s" },
        key: "PRB-3",
        findings: [DEAD_LETTER, WHO_IS_TOLD],
        provider: "codex-cli",
        model: "m",
      },
      output: { json: true },
    });
    expect(optionsCommandLine.read(["PRB-3", "--finding", DEAD_LETTER]).input.provider).toBe("claude-cli");
    expect(() => optionsCommandLine.read(["PRB-3"])).toThrow(/at least one --finding/);
    expect(() => optionsCommandLine.read(["PRB-3", "--finding", "d1"])).toThrow(/whole key/);
    expect(() => optionsCommandLine.read(["--finding", DEAD_LETTER])).toThrow(UsageError);
  });
});

describe("perbo options", () => {
  it("asks the Architect once for the findings named, keeps the answers for the review, and prints them", async () => {
    const { repo, dir } = await reviewed([finding({}), finding({ key: WHO_IS_TOLD, statement: "Who is told?", file: null })]);
    const model = scripted([
      submits({ answers: [{ finding: 1, options: offered }, { finding: 2, options: told }] }),
    ]);
    const first = await ask(repo, [DEAD_LETTER, WHO_IS_TOLD], model);
    expect(first.code).toBe(EXIT_CODES.approve);
    expect(first.printed).toEqual({
      key: "PRB-1",
      review_id: "rev_options0001",
      findings: [
        { finding_key: DEAD_LETTER, options: offered },
        { finding_key: WHO_IS_TOLD, options: told },
      ],
      cached: false,
    });
    expect(model.requests).toHaveLength(1);
    // Handed the finding, the criterion it sits on, the contract and the change.
    const user = String(model.requests[0]!.messages[0]!.content);
    expect(user).toContain("Finding: Where should a permanently failed email go?");
    expect(user).toContain("Criterion: ac_2: A failed send is retried three times.");
    expect(user).toContain("New users receive an activation email within 60 seconds of signing up.");
    expect(user).toContain("+export const retries = 3;");
    // Kept beside the ticket, for this review.
    const kept = readDecisionOptionsRecord(dir, "PRB-1")!;
    expect(decisionOptionsRecordPath(dir, "PRB-1")).toBe(join(dir, "tickets", "PRB-1.options.json"));
    expect(kept.review_id).toBe("rev_options0001");
    expect(kept.findings.map((entry) => entry.finding_key)).toEqual([DEAD_LETTER, WHO_IS_TOLD]);
    expect(kept.findings[0]!.model.model_id).toBe("scripted");
    // The record beside the ticket is not a ticket: the store lists PRB-1
    // alone and names no file it could not read.
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(listTickets(dir).map((ticket) => ticket.key)).toEqual(["PRB-1"]);
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).not.toMatch(/not readable/);
    } finally {
      stderr.mockRestore();
    }

    // Asked again, nothing is spent: the record is what is printed.
    const again = await ask(repo, [WHO_IS_TOLD, DEAD_LETTER], unreachable());
    expect(again.printed?.cached).toBe(true);
    expect(again.printed?.findings.map((entry) => entry.finding_key)).toEqual([WHO_IS_TOLD, DEAD_LETTER]);
  });

  it("asks only about a finding the record does not answer, and keeps what it held", async () => {
    const { repo, dir } = await reviewed([finding({}), finding({ key: WHO_IS_TOLD, statement: "Who is told?" })]);
    await ask(repo, [DEAD_LETTER], scripted([submits({ answers: [{ finding: 1, options: offered }] })]));
    const model = scripted([submits({ answers: [{ finding: 1, options: told }] })]);
    const both = await ask(repo, [DEAD_LETTER, WHO_IS_TOLD], model);
    expect(both.printed?.cached).toBe(false);
    expect(both.printed?.findings).toEqual([
      { finding_key: DEAD_LETTER, options: offered },
      { finding_key: WHO_IS_TOLD, options: told },
    ]);
    const user = String(model.requests[0]!.messages[0]!.content);
    expect(user).toContain("Who is told?");
    expect(user).not.toContain("Where should a permanently failed email go?");
    expect(readDecisionOptionsRecord(dir, "PRB-1")!.findings).toHaveLength(2);
  });

  it("asks afresh once a later review stands, and replaces the record with its answers", async () => {
    const { repo, dir } = await reviewed([finding({})]);
    await ask(repo, [DEAD_LETTER], scripted([submits({ answers: [{ finding: 1, options: offered }] })]));
    record(dir, [finding({})], "rev_options0002", 2);
    const model = scripted([submits({ answers: [{ finding: 1, options: told }] })]);
    const later = await ask(repo, [DEAD_LETTER], model);
    expect(later.printed).toMatchObject({ review_id: "rev_options0002", cached: false });
    expect(later.printed?.findings[0]!.options).toEqual(told);
    // The change that later review judged.
    expect(String(model.requests[0]!.messages[0]!.content)).toContain("+export const retries = 4;");
    expect(readDecisionOptionsRecord(dir, "PRB-1")!.review_id).toBe("rev_options0002");
  });

  it("refuses a finding that is not the last review's, one not left for a person, and one never handed to the executor", async () => {
    const { repo } = await reviewed([
      finding({}),
      finding({ key: EXECUTORS, routing: "remediable", closure: "executor", blocking: false }),
      finding({ key: SECRET, rule_id: "security.secret_in_diff" }),
    ]);
    await expect(ask(repo, ["c".repeat(64)], unreachable())).rejects.toThrow(UsageError);
    await expect(ask(repo, ["c".repeat(64)], unreachable())).rejects.toThrow(/is not a finding of PRB-1's last review/);
    await expect(ask(repo, [EXECUTORS], unreachable())).rejects.toThrow(/not a finding the review left for a person/);
    await expect(ask(repo, [SECRET], unreachable())).rejects.toThrow(/never handed to the executor/);
  });

  it("offers answers to what a stalled refinement left open, and still refuses one a round closed", async () => {
    const stuck = finding({ key: DEAD_LETTER, routing: "remediable", closure: "executor", blocking: false });
    const closed = finding({ key: WHO_IS_TOLD, routing: "remediable", closure: "executor", blocking: false });
    const { repo, dir } = await reviewed([stuck, closed], "rev_options0001", "remediable");
    verified(dir, 2, [DEAD_LETTER, WHO_IS_TOLD], [DEAD_LETTER]);
    verified(dir, 3, [DEAD_LETTER], [DEAD_LETTER]);
    // While the loop is still trying, both are the executor's.
    await expect(ask(repo, [DEAD_LETTER], unreachable())).rejects.toThrow(/not a finding the review left for a person/);
    ended(dir, "remediation_stalled");
    const asked = await ask(repo, [DEAD_LETTER], scripted([submits({ answers: [{ finding: 1, options: offered }] })]));
    expect(asked.printed.findings).toEqual([{ finding_key: DEAD_LETTER, options: offered }]);
    await expect(ask(repo, [WHO_IS_TOLD], unreachable())).rejects.toThrow(/not a finding the review left for a person/);
  });

  it("offers answers to a finding the executor declined, and still refuses one its round closed (D-065)", async () => {
    const declined = finding({ key: DEAD_LETTER, routing: "remediable", closure: "executor", blocking: false });
    const closed = finding({ key: WHO_IS_TOLD, routing: "remediable", closure: "executor", blocking: false });
    const { repo, dir } = await reviewed([declined, closed], "rev_options0001", "remediable");
    verified(dir, 2, [WHO_IS_TOLD], [], [{ finding_key: DEAD_LETTER, reason: "A person decides where a failed email goes." }]);
    ended(dir, "escalated");
    const model = scripted([submits({ answers: [{ finding: 1, options: offered }] })]);
    const asked = await ask(repo, [DEAD_LETTER], model);
    expect(asked.printed.findings).toEqual([{ finding_key: DEAD_LETTER, options: offered }]);
    // The Architect reads the executor's reason beside the finding, as data.
    expect(String(model.requests[0]!.messages[0]!.content)).toContain(
      "The executor declined it: A person decides where a failed email goes.",
    );
    await expect(ask(repo, [WHO_IS_TOLD], unreachable())).rejects.toThrow(/not a finding the review left for a person/);
  });

  it("says a ticket with no review has nothing to answer", async () => {
    const repo = join(scratch, `repo-${repos++}`);
    initRepository(repo, { files: { "specs/activation-email/spec.md": SPEC } });
    await runCommandLine(admitCommandLine, {
      argv: ["--repo", repo, "--from-spec", join(repo, "specs", "activation-email", "spec.md")],
      streams: recordStreams(),
      cwd: repo,
      deps: { model: scripted([submits(drafted)]) },
    });
    await expect(ask(repo, [DEAD_LETTER], unreachable())).rejects.toThrow(/has no review on record/);
  });
});
