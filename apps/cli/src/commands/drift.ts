import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { EXIT_CODES } from "@perbo/contracts";
import { MODEL_PROVIDERS, createModel, type Model, type ModelProvider } from "@perbo/model";
import {
  DRIFT_REPORT_JSON_SCHEMA,
  DriftVerdictSchema,
  assertNoSymlink,
  readDrift,
  readSpecText,
  type DriftRecord,
} from "@perbo/planning";
import { preflight, renderPreflight } from "@perbo/runner";
import type { CommandContext } from "../command.js";
import type { NarratedCommand } from "../command-line/table.js";
import {
  parseArgv,
  switchFlag,
  valueFlag,
  type FlagTable,
  type Grammar,
} from "../command-line/grammar.js";
import {
  planPromise,
  promisesHash,
  readDriftRecord,
  sha256,
  writeDriftRecord,
  type DriftKey,
} from "../store/drift.js";
import { storeFor, StoreTargetSchema } from "../store/index.js";
import { assertContractMatches, readContract, readTicket } from "../store/tickets.js";
import { readInput, UsageError } from "../usage-error.js";
import { ModelIdSchema } from "./admit.js";

/**
 * `perbo drift` — the plan read against the spec it was drafted from
 * (D-NEW-the-plan-answers-the-spec-and-says-so), and the one reader of the
 * record `store/drift.ts` keeps.
 *
 * The interview cannot part the two: its edit of a promise is held to the
 * spec in the same turn. A person's own edit is held to nothing, so after one
 * the plan and its spec may no longer promise the same thing, and this is the
 * reading that says where. It is advice on the way from the plan to the
 * contract and never a gate: the exit code is 0 whatever it finds.
 *
 * The verdict is kept beside the ticket against two hashes — the spec's bytes
 * and the plan's promise texts — and holds while neither moves. Admission
 * seeds it, because a plan just drafted agrees with its spec by construction;
 * a chat turn that moved the plan under the interview's guard carries it
 * forward; a hand edit lets it go, and the next reading here is a model's.
 * That is what keeps a model call for the state that needs one: an
 * arrangement edit, a re-run, or the desktop arriving at the page again find
 * the record and print it.
 */

/** What one reading asks for: which ticket, read by which model, or dismissed. */
export const DriftInputSchema = z.strictObject({
  target: StoreTargetSchema,
  key: z.string().min(1, "drift requires a ticket key, e.g. PRB-1"),
  provider: z.enum(MODEL_PROVIDERS, {
    error: "--provider must be 'anthropic', 'claude-cli' or 'codex-cli'",
  }),
  model: ModelIdSchema.nullable(),
  /** Record going on to the contract with the differences open. */
  dismiss: z.boolean(),
});
export type DriftInput = z.infer<typeof DriftInputSchema>;

/** What a reading is given beyond the store. */
export interface DriftDeps {
  /** The reading model. Otherwise built from the input's provider. */
  model: Model;
}

/** The reading transport, the reviewer's own, constrained to the report schema. */
function driftModel(provider: ModelProvider, modelId: string | null): Model {
  return createModel(provider, { submitSchema: DRIFT_REPORT_JSON_SCHEMA, modelId });
}

/**
 * The verdict for a ticket at its current state, printed as JSON on stdout
 * whether or not `--json` is given: the desktop reads it, and there is no
 * rendering a person needs that the page does not draw better.
 */
export async function drift(
  input: DriftInput,
  context: CommandContext & { stdout(chunk: string): void } & Partial<DriftDeps>,
): Promise<number> {
  const { key } = input;
  const repositoryRoot = resolve(context.cwd, input.target.repo);
  const dir = storeFor(context.cwd, input.target);

  const ticket = readTicket(dir, key);
  const recorded = ticket.admission.spec;
  if (recorded === null) {
    throw new UsageError(
      `${key} was not drafted from a spec, so there is nothing to read its plan against`,
    );
  }
  const contract = readContract(dir, key);
  assertContractMatches(ticket, contract);

  // Read once, as bytes for the hash and as sections for the model: a spec
  // that cannot be read is a fact the person resolves, not one to read around.
  let bytes: Buffer;
  let sections: ReturnType<typeof readSpecText>;
  try {
    assertNoSymlink(repositoryRoot, recorded.path);
    bytes = readFileSync(resolve(repositoryRoot, recorded.path));
    sections = readSpecText(resolve(repositoryRoot, recorded.path));
  } catch (error) {
    // A link, a missing file and an unreadable one are the same answer here:
    // the pages and the edit path refuse over them in the same words.
    throw new UsageError(
      `${key} was drafted from ${recorded.path}, which cannot be read now: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const at: DriftKey = { spec: sha256(bytes), promises: promisesHash(contract) };

  const existing = readDriftRecord(dir, key);
  const holds =
    existing !== null && existing.spec === at.spec && existing.promises === at.promises;
  const print = (record: DriftRecord, cached: boolean): number => {
    context.stdout(
      `${JSON.stringify(DriftVerdictSchema.parse({ ...record, key, cached }), null, 2)}\n`,
    );
    return EXIT_CODES.approve;
  };

  if (input.dismiss) {
    // Going on with the differences open is recorded against the reading it
    // was open over, and only that one: a state nothing has read has no
    // findings to dismiss.
    if (!holds) {
      throw new UsageError(
        `nothing has been read at this state of ${key}: the spec or the plan moved since the ` +
          `last reading, or there was none. Run perbo drift ${key} first`,
      );
    }
    const dismissed: DriftRecord = { ...existing, dismissed: true };
    writeDriftRecord(dir, key, dismissed);
    return print(dismissed, true);
  }

  if (holds) return print(existing, true);

  if (context.model === undefined) {
    // A missing binary or credential is reported before anything is spent,
    // with its fix, rather than as an outage half-way through.
    const result = preflight({
      agentBinary: null,
      agentProvider: null,
      reviewerProvider: input.provider,
      needsGh: false,
      needsGit: false,
    });
    if (!result.ok) {
      context.diagnostics.stderr(
        `error: the reading cannot start on this machine\n${renderPreflight(result)}\n`,
      );
      return EXIT_CODES.did_not_complete;
    }
  }
  const model = context.model ?? driftModel(input.provider, input.model);
  context.diagnostics.stderr(
    `reading ${key}'s plan against ${recorded.path} with ${model.provider} ${model.model_id}\n`,
  );
  const read = await readDrift({
    spec: { outcome: sections.text.outcome, requirements: sections.requirements },
    plan: { key, ...planPromise(contract) },
    model,
  });
  // Keyed by the state that was read, not the state after the model returned:
  // an edit made during the reading is one the record must not vouch for.
  const record: DriftRecord = {
    ...at,
    origin: "read",
    findings: read.findings,
    dismissed: false,
    checked_at: context.now.toISOString(),
    model: read.model,
  };
  writeDriftRecord(dir, key, record);
  return print(record, false);
}

const DRIFT_FLAGS = {
  "--repo": valueFlag(),
  "--store": valueFlag(),
  "--provider": valueFlag(),
  "--model": valueFlag(),
  "--dismiss": switchFlag(),
  // Taken for parity with the commands beside it: the verdict is JSON either way.
  "--json": switchFlag(),
} satisfies FlagTable;

const DRIFT_GRAMMAR: Grammar<typeof DRIFT_FLAGS> = {
  command: "drift",
  flags: DRIFT_FLAGS,
  positionals: { min: 1, max: 1, refusal: "drift requires a ticket key, e.g. PRB-1" },
  afterDoubleDash: "positionals",
};

export const driftCommandLine: NarratedCommand<DriftInput, { json: boolean }, DriftDeps> = {
  kind: "narrated",
  name: "drift",
  grammars: [DRIFT_GRAMMAR],
  grammarFor: () => DRIFT_GRAMMAR,
  read(argv) {
    const line = parseArgv(DRIFT_GRAMMAR, argv);
    return {
      input: readInput(DriftInputSchema, {
        target: { repo: line.flags["--repo"] ?? ".", store: line.flags["--store"] ?? null },
        key: line.positionals[0],
        provider: line.flags["--provider"] ?? "claude-cli",
        model: line.flags["--model"] ?? null,
        dismiss: line.flags["--dismiss"] === true,
      }),
      output: { json: line.flags["--json"] === true },
    };
  },
  run: (input, _output, context) => drift(input, context),
};
