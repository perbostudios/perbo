import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  EXIT_CODES,
  bundleManifestsDir,
  bundleRoot,
  decidable,
  decisionChoicesFor,
  hasAcceptanceCriteria,
  leftToPrinciple,
  loopOnRecord,
  NOTHING_TRIED,
  routedToPerson,
  type Finding,
  type PlanContract,
} from "@perbo/contracts";
import { MODEL_PROVIDERS, createModel, type Model, type ModelProvider } from "@perbo/model";
import {
  DECISION_OPTIONS_JSON_SCHEMA,
  DecisionOptionsVerdictSchema,
  PlanningError,
  readDecisionOptions,
  readDecisionOptionsRecord,
  writeDecisionOptionsRecord,
  type DecisionFinding,
  type DecisionOptionsRecord,
  type FindingOptions,
} from "@perbo/planning";
import { BundleStore, attemptBundles, preflight, renderPreflight } from "@perbo/runner";
import type { CommandContext } from "../command.js";
import type { NarratedCommand } from "../command-line/table.js";
import { listFlag, parseArgv, switchFlag, valueFlag, type FlagTable, type Grammar } from "../command-line/grammar.js";
import { storeFor, StoreTargetSchema } from "../store/index.js";
import { assertContractMatches, readContract, readTicket } from "../store/tickets.js";
import { readInput, UsageError } from "../usage-error.js";
import { ModelIdSchema } from "./admit.js";
import { buildReportForSubject, ticketSubject } from "./inspect.js";

/**
 * `perbo options` — the answers the Architect offers to the findings a
 * ticket's last review routed to a person (D-135): for each
 * finding asked about, a few principles the person could adopt, one of them
 * recommended, from the finding, the criterion it sits on, the contract and
 * the change the review judged.
 *
 * They are kept beside the ticket as `<KEY>.options.json`, for the review they
 * answer, so asking again prints them and calls no model; a finding not yet
 * answered there is the only one a model is asked about. A later review
 * replaces the record, because its findings are about another change.
 *
 * Nothing here is an answer: the person picks one, or writes their own, and
 * `perbo verdict --decide` records it (D-132). Nothing the model wrote becomes
 * a branch, a path, a command or a target (ADR-0023 §4).
 */

/** What one asking names: which ticket, which of its findings, and the model to read with. */
export const OptionsInputSchema = z.strictObject({
  target: StoreTargetSchema,
  key: z.string().min(1, "options requires a ticket key, e.g. PRB-1"),
  findings: z
    .array(z.string().regex(/^[0-9a-f]{64}$/, "--finding takes a finding's whole key, as inspect prints it"))
    .min(1, "options requires at least one --finding <finding key>"),
  provider: z.enum(MODEL_PROVIDERS, { error: `--provider must be one of ${MODEL_PROVIDERS.join(", ")}` }),
  model: ModelIdSchema.nullable(),
});
export type OptionsInput = z.infer<typeof OptionsInputSchema>;

/** What an asking is given beyond the store. */
export interface OptionsDeps {
  /** The reading model. Otherwise built from the input's provider. */
  model: Model;
}

/** The reading transport, constrained to the answers' schema. */
function optionsModel(provider: ModelProvider, modelId: string | null): Model {
  return createModel(provider, { submitSchema: DECISION_OPTIONS_JSON_SCHEMA, modelId });
}

/** The criteria the reading is handed: each criterion's id and its own words. */
function criteriaOf(contract: PlanContract): { id: string; text: string }[] {
  return hasAcceptanceCriteria(contract)
    ? contract.acceptance_criteria.map((criterion) => ({ id: criterion.id, text: criterion.text }))
    : [];
}

/**
 * The answers to each finding asked about, printed as JSON on stdout whether
 * or not `--json` is given: the desktop reads it.
 */
export async function options(
  input: OptionsInput,
  context: CommandContext & { stdout(chunk: string): void } & Partial<OptionsDeps>,
): Promise<number> {
  const { key } = input;
  const dir = storeFor(context.cwd, input.target);
  const ticket = readTicket(dir, key);
  const contract = readContract(dir, key);
  assertContractMatches(ticket, contract);

  // The ticket's last review, as the desktop's decision page reads it, and
  // the change that review judged: the diff its own attempt sealed.
  const report = buildReportForSubject({ storeDirectory: dir, subject: ticketSubject(dir, key), attempt: null });
  const reviewed = report.attempts.findLast((attempt) => attempt.review !== null);
  const review = reviewed?.review ?? null;
  if (reviewed === undefined || review === null)
    throw new UsageError(`${key} has no review on record, so it has no findings to offer answers to`);
  // What the loop has done on that review, which says who each finding is asked of.
  const loop =
    loopOnRecord({
      review_id: review.review_id,
      bundles: report.attempts.flatMap((attempt) => attempt.bundles),
      history: ticket.history,
    })?.loop ?? NOTHING_TRIED;

  const findings: Finding[] = [...new Set(input.findings)].map((wanted) => {
    const finding = review.findings.find((entry) => entry.key === wanted);
    if (finding === undefined)
      throw new UsageError(
        `${wanted.slice(0, 12)} is not a finding of ${key}'s last review (${review.review_id}); ` +
          "`perbo inspect` lists its findings",
      );
    // A finding the executor declined takes no answer here, as the decision
    // card asks none of it: a principle is its answer (D-065).
    if (leftToPrinciple(finding, loop))
      throw new UsageError(
        `${wanted.slice(0, 12)} (${finding.rule_id}) is a finding the executor declined (D-065), and no ` +
          "choice closes it: `perbo principle add` carries your answer to the executor",
      );
    if (finding.status !== "open" || !(routedToPerson(finding, loop) || finding.closure === "human"))
      throw new UsageError(
        `${wanted.slice(0, 12)} (${finding.rule_id}) is not a finding the review left for a person to answer`,
      );
    if (decidable(review, loop) && routedToPerson(finding, loop) && !decisionChoicesFor(finding.rule_id).includes("approach"))
      throw new UsageError(
        `${wanted.slice(0, 12)} (${finding.rule_id}) is never handed to the executor, so its only answer is ` +
          "to ship the change as it is, and there is no principle to offer",
      );
    return finding;
  });

  const held = (record: DecisionOptionsRecord | null): Map<string, FindingOptions> =>
    new Map(
      record !== null && record.review_id === review.review_id
        ? record.findings.map((entry) => [entry.finding_key, { finding_key: entry.finding_key, options: entry.options }])
        : [],
    );
  const print = (answered: Map<string, FindingOptions>, cached: boolean): number => {
    context.stdout(
      `${JSON.stringify(
        DecisionOptionsVerdictSchema.parse({
          key,
          review_id: review.review_id,
          findings: findings.map((finding) => answered.get(finding.key)!),
          cached,
        }),
        null,
        2,
      )}\n`,
    );
    return EXIT_CODES.approve;
  };

  const record = readRecord(dir, key);
  const before = held(record);
  const missing = findings.filter((finding) => !before.has(finding.key));
  if (missing.length === 0) return print(before, true);

  if (context.model === undefined) {
    // A missing binary or credential is reported before anything is spent.
    const result = preflight({
      agentBinary: null,
      agentProvider: null,
      reviewerProvider: input.provider,
      needsGh: false,
      needsGit: false,
    });
    if (!result.ok) {
      context.diagnostics.stderr(
        `error: the Architect cannot be asked on this machine\n${renderPreflight(result)}\n`,
      );
      return EXIT_CODES.did_not_complete;
    }
  }
  const model = context.model ?? optionsModel(input.provider, input.model);
  context.diagnostics.stderr(
    `asking ${model.provider} ${model.model_id} for answers to ${missing.length} of ${key}'s findings\n`,
  );

  const criteria = criteriaOf(contract);
  const handed: DecisionFinding[] = missing.map((finding) => ({
    rule_id: finding.rule_id,
    statement: finding.statement,
    reason: finding.blocking_reason,
    criterion: criteria.find((criterion) => criterion.id === finding.criterion_id) ?? null,
    file: finding.file,
    line: finding.line,
    symbol: finding.symbol,
  }));
  const read = await readDecisionOptions({
    contract: { key, outcome: contract.outcome, criteria, paths_allowed: contract.scope.paths_allowed },
    findings: handed,
    change: changeOf(dir, reviewed.record, reviewed.bundles),
    model,
  });
  const offered_at = context.now.toISOString();
  const fresh = missing.map((finding, index) => ({
    finding_key: finding.key,
    options: read.answers[index]!,
    offered_at,
    model: read.model,
  }));

  // Read again before writing: another asking about this review may have
  // landed while the model read, and what it recorded stands beside this.
  const now = readRecord(dir, key);
  const kept = now !== null && now.review_id === review.review_id ? now.findings : [];
  writeRecord(dir, key, {
    review_id: review.review_id,
    findings: [...kept, ...fresh.filter((entry) => !kept.some((prior) => prior.finding_key === entry.finding_key))],
  });
  const answered = held(readRecord(dir, key));
  return print(answered, false);
}

/** The diff the attempt sealed, or null where none was retained. */
function changeOf(
  dir: string,
  attempt: Parameters<typeof attemptBundles>[0],
  bundles: Parameters<typeof attemptBundles>[1],
): string | null {
  const execution = attemptBundles(attempt, bundles).execution;
  // Constructed only where the loop already made it: the store creates its
  // directories on construction, and a read must not leave one behind.
  if (execution === undefined || !existsSync(join(dir, ...bundleManifestsDir()))) return null;
  return new BundleStore({ root: join(dir, ...bundleRoot()), retainContext: true }).artifact(execution, "change.diff");
}

/** The record beside the ticket, its refusal said as a `UsageError`. */
function readRecord(dir: string, key: string): DecisionOptionsRecord | null {
  try {
    return readDecisionOptionsRecord(dir, key);
  } catch (error) {
    if (error instanceof PlanningError) throw new UsageError(error.message);
    throw error;
  }
}

function writeRecord(dir: string, key: string, record: DecisionOptionsRecord): void {
  try {
    writeDecisionOptionsRecord(dir, key, record);
  } catch (error) {
    if (error instanceof PlanningError) throw new UsageError(error.message);
    throw error;
  }
}

const OPTIONS_FLAGS = {
  "--repo": valueFlag(),
  "--store": valueFlag(),
  "--finding": listFlag(),
  "--provider": valueFlag(),
  "--model": valueFlag(),
  // Taken for parity with the commands beside it: the answers are JSON either way.
  "--json": switchFlag(),
} satisfies FlagTable;

const OPTIONS_GRAMMAR: Grammar<typeof OPTIONS_FLAGS> = {
  command: "options",
  flags: OPTIONS_FLAGS,
  positionals: { min: 1, max: 1, refusal: "options requires a ticket key, e.g. PRB-1" },
  afterDoubleDash: "positionals",
};

export const optionsCommandLine: NarratedCommand<OptionsInput, { json: boolean }, OptionsDeps> = {
  kind: "narrated",
  name: "options",
  grammars: [OPTIONS_GRAMMAR],
  grammarFor: () => OPTIONS_GRAMMAR,
  read(argv) {
    const line = parseArgv(OPTIONS_GRAMMAR, argv);
    return {
      input: readInput(OptionsInputSchema, {
        target: { repo: line.flags["--repo"] ?? ".", store: line.flags["--store"] ?? null },
        key: line.positionals[0],
        findings: line.flags["--finding"] ?? [],
        provider: line.flags["--provider"] ?? "claude-cli",
        model: line.flags["--model"] ?? null,
      }),
      output: { json: line.flags["--json"] === true },
    };
  },
  run: (input, _output, context) => options(input, context),
};
