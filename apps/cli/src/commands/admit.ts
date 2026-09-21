import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  APPROACH_SCHEMA_VERSION,
  AcceptanceCriterionSchema,
  EXIT_CODES,
  IllegalTransitionError,
  PlanContractSchema,
  PlanNodeSchema,
  TICKET_SCHEMA_VERSION,
  TicketSchema,
  VERIFICATION_KINDS,
  compareLevels,
  costOf,
  costPhrase,
  derivePlannedRisk,
  isActive,
  isConfigPath,
  isDependencyPath,
  isMigrationPath,
  isSecurityPath,
  onePieceOfWork,
  ticketSourceLabel,
  transition,
  type AcceptanceCriterion,
  type ApproachRecord,
  type GraphEdge,
  type PlanBase,
  type PlanContract,
  type PlanLevel,
  type PlanNode,
  type RiskDerivation,
  type Scope,
  type Ticket,
  type VerificationKind,
  unknownRequirementIds,
} from "@perbo/contracts";
import {
  type BoardEntry,
  CONTRACT_DRAFT_JSON_SCHEMA,
  type DraftResult,
  type GitHubIssue,
  PlanningError,
  type SourceIssue,
  type Spec,
  assertNoSymlink,
  assertNodePagesWritable,
  contractDifferences,
  contractEditCount,
  draftContract,
  fetchGitHubIssue,
  readIssueFile,
  readSpecFile,
} from "@perbo/planning";
import { ProviderError, createModel, type Model, type ModelProvider } from "@perbo/model";
import { RepoReader } from "@perbo/review";
import { formatDuration, formatHumanElapsed } from "../duration.js";
import { QUEUE_HOLDING_STATES } from "../scheduling.js";
import { UsageError, readInput } from "../usage-error.js";
import {
  aliasFlag,
  listFlag,
  parseArgv,
  switchFlag,
  valueFlag,
  type FlagTable,
  type Grammar,
} from "../command-line/grammar.js";
import type { CommandContext, CommandReport, Rendered } from "../command.js";
import type { Diagnostics } from "../diagnostics.js";
import type { NarratedCommand, ReportCommand } from "../command-line/table.js";
import { prohibitedSpecPaths, regenerateNodePages, specCommitFiles } from "../spec/pages.js";
import { specBaseline } from "../spec/staleness.js";
import {
  TicketStoreError,
  assertContractMatches,
  contextManifestHash,
  headCommit,
  idsFor,
  listTickets,
  nextKey,
  readContract,
  readJudgingPaths,
  readDraftSnapshotFile,
  deleteApproachRecord,
  recordIssued,
  readTicket,
  repositoryId,
  standingProhibited,
  storeDir,
  writeApproachRecord,
  writeContract,
  writeDraftSnapshot,
  writeTicket,
  type DraftSnapshot,
  type DraftSnapshotFile,
  type JudgingRule,
} from "../store/tickets.js";
import { specFolder, storeFor, StoreTargetSchema, type StoreTarget } from "../store/index.js";
import { describeScheduling } from "./serve/waits.js";

/**
 * `perbo admit`, `perbo approve`, `perbo list` — roadmap items 11 and 12.
 *
 * The friction these remove is specific and was measured by doing it by hand:
 * before this, starting a ticket meant hand-writing a `contract.json` with an
 * opaque `plan_id`, an opaque `ticket_id`, a 40-character `base_commit`, a
 * `context_manifest_hash` nobody could compute, criterion ids in sequence and a
 * `paths_prohibited` list copied from another file. Six of those eight are
 * derivable and one was a placeholder.
 *
 * ## The model drafts; the person approves
 *
 * `perbo admit --from owner/repo#N` asks a model to draft the contract —
 * outcome, acceptance criteria and a *proposed* scope — from the issue, the
 * way the Admit artboard shows it. `--from-file <path>` drafts from a pasted
 * Markdown file instead, for work that never reached a tracker: the first line
 * is the title, the rest is the body, and the file is external-trust data
 * exactly as an issue body is — local is convenient, not trusted. The two are
 * mutually exclusive, take the same path through the model and produce the same
 * candidate. The draft is written beside the ticket as
 * `<KEY>.draft.json` and rendered; the person edits any of it and approves
 * what they end up with. **A draft is never executed; only an approved
 * contract is.** The person's `approve` is the authority boundary under
 * ADR-0023 §4: a scope glob a model proposed becomes an action parameter only
 * after a human has confirmed it (the founder's decision, 2026-09-02). Typed
 * admission — `--outcome`, `--criterion`, `--path` — calls no model.
 *
 * ## Level is derived, not chosen
 *
 * The plan level comes from `derivePlannedRisk` over the declared scope
 * (docs/04). `--level` may raise it and may not lower it (D-010). A P2
 * contract's additional fields are derived from the same scope; a P3
 * contract's decision fields are a person's to state, and `approve` refuses
 * one where they still are not.
 */

/** The prohibited paths every admitted ticket starts with. */
const DEFAULT_PROHIBITED = [".github/**", "infra/**", "**/*.pem", "**/.env*"];
/** Exempt from scope accounting: they change on every install or codegen run. */
const DEFAULT_GENERATED = ["pnpm-lock.yaml", "package-lock.json", "**/*.generated.ts"];
const DEFAULT_EXPANSION_BUDGET = 3;
const DEFAULT_PREFIX = "PRB";

export type DraftProvider = ModelProvider;

/** The drafting providers this build offers. */
const DRAFT_PROVIDERS = ["anthropic", "claude-cli", "codex-cli"] as const;

const TICKET_KEY = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,6}$/;

/** A ticket key as a flag names one, refused in the words of that flag. */
const namedTicketKey = (flag: string) =>
  z.string().regex(TICKET_KEY, {
    error: (issue) => `${flag} must be a ticket key like PRB-2. Got '${String(issue.input)}'`,
  });

const EXPANSION_BUDGET_REFUSAL = "--expansion-budget must be a whole number of files";

/**
 * `owner/repo#N`. One regex for every caller: the terminal's `--from` and the
 * endpoint's `from` name the same issue, and a name GitHub cannot have is not
 * one either of them may hand to `gh`.
 */
export const IssueReferenceSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*#[1-9][0-9]*$/, {
    error: (issue) =>
      `--from must be a GitHub issue like owner/repo#412. Got '${String(issue.input)}'`,
  });

/**
 * The drafting model's id. It is what a provider's own CLI is started with,
 * which is an action parameter (ADR-0023 §4), so what it may hold is a rule
 * about the value and every caller is held to it.
 */
export const ModelIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, {
  error: (issue) => `--model must be a model id like claude-opus-5. Got '${String(issue.input)}'`,
});

/**
 * What one admission is asked for, whoever asks: the terminal through
 * {@link admitCommandLine}, and a caller in this process through
 * {@link admitDraft}.
 *
 * Every rule about a value is here, so the endpoint, the queue and the
 * interview are held to what a person typing the same thing is held to.
 * Reading a token as a number is the line's own and stays at the edge; what
 * the number then has to be is this.
 */
const ADMISSION_FIELDS = {
  target: StoreTargetSchema,
  prefix: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/, {
    error: (issue) =>
      `--prefix must be 2 to 10 uppercase letters or digits starting with a letter, so a ` +
      `key reads like PRB-118. Got '${String(issue.input)}'`,
  }),
  /** One sentence: what will be true afterwards. It becomes the contract's outcome. */
  title: z.string().nullable(),
  criteria: z.array(z.string()),
  criteriaFile: z.string().nullable(),
  paths: z.array(z.string()),
  prohibited: z.array(z.string()),
  generated: z.array(z.string()),
  expansionBudget: z
    .int({ error: EXPANSION_BUDGET_REFUSAL })
    .min(0, { error: EXPANSION_BUDGET_REFUSAL }),
  /** Null means derived from the scope. A value may only raise the derivation. */
  level: z
    .enum(["P1", "P2", "P3"], {
      error:
        "--level must be P1, P2 or P3; P0 carries no acceptance criteria, so nothing could " +
        "review it",
    })
    .nullable(),
  priority: z.enum(["urgent", "high", "normal", "low"], {
    error: "--priority must be urgent, high, normal or low",
  }),
  labels: z.array(z.string()),
  dependsOn: z.array(namedTicketKey("--depends-on")),
  source: z.string().nullable(),
  sourceUrl: z
    .string()
    .refine(
      (value) => {
        try {
          new URL(value);
          return true;
        } catch {
          return false;
        }
      },
      { error: (issue) => `--source-url must be a URL. Got '${String(issue.input)}'` },
    )
    .nullable(),
  /** `owner/repo#N`: draft the contract from this issue with a model. */
  from: IssueReferenceSchema.nullable(),
  /** A Markdown file holding a pasted issue: draft the contract from it instead. */
  fromFile: z.string().nullable(),
  /** The `spec.md` of a spec folder: draft the contract and its graph from it (D-103). */
  fromSpec: z.string().nullable(),
  /** A ticket in `plan_review` to re-draft from that spec, keeping its key (D-103). */
  startOver: namedTicketKey("--start-over").nullable(),
  provider: z.enum(DRAFT_PROVIDERS, {
    error: "--provider must be 'anthropic', 'claude-cli' or 'codex-cli'",
  }),
  model: ModelIdSchema.nullable(),
  manualReviewer: z.string().nullable(),
  manualReason: z.string().nullable(),
};

/** What one admission is: the fields above, and the approval only a person asks for. */
type Admission = {
  from: string | null;
  fromFile: string | null;
  fromSpec: string | null;
  startOver: string | null;
  approve?: boolean;
};

/**
 * The rules between the fields, which hold whichever schema carries them. A
 * draft has no `approve` at all, so reading it as absent is reading what
 * {@link DraftAdmissionSchema} means.
 */
const admissionRules = (input: Admission, ctx: z.RefinementCtx): void => {
  // Two sources for one draft is not a preference to resolve by picking one:
  // whichever lost would have been read as the thing being admitted, and the
  // ticket would carry the provenance of the other.
  const sources = (
    [
      ["--from", input.from],
      ["--from-file", input.fromFile],
      ["--from-spec", input.fromSpec],
    ] as const
  ).filter(([, value]) => value !== null);
  if (sources.length > 1) {
    ctx.addIssue({
      code: "custom",
      message:
        `${sources.map(([flag]) => flag).join(" and ")} are mutually exclusive: one contract is ` +
        `drafted from one document. Got ` +
        sources.map(([flag, value]) => `${flag} '${value}'`).join(" and "),
    });
  }
  if (input.startOver === null) return;
  // Starting over is drafting the same ticket again from the document it was
  // drafted from, so there is one source it can come from and it is a spec.
  if (input.fromSpec === null) {
    ctx.addIssue({
      code: "custom",
      message:
        `--start-over ${input.startOver} re-drafts a ticket from its spec, so it needs the spec: ` +
        "perbo admit --from-spec specs/<slug>/spec.md --start-over " +
        input.startOver,
    });
  }
  if (input.approve === true) {
    ctx.addIssue({
      code: "custom",
      message:
        "--start-over drafts the contract with a model, so it cannot be approved in the same " +
        "command: read the draft, then `perbo approve <key>`",
    });
  }
};

/** An admission, with the approval only the terminal can ask for. */
export const AdmissionInputSchema = z
  .strictObject({ ...ADMISSION_FIELDS, approve: z.boolean() })
  .superRefine(admissionRules);
export type AdmissionInput = z.infer<typeof AdmissionInputSchema>;

/**
 * An admission a caller in this process makes: the same fields, strict, with
 * no `approve` among them — so an object carrying one is refused rather than
 * quietly stripped. Approval is the person's own keystroke (D-072), and
 * {@link admitCommandLine} is the only reader that can ask for it.
 */
export const DraftAdmissionSchema = z.strictObject(ADMISSION_FIELDS).superRefine(admissionRules);
export type DraftAdmission = z.infer<typeof DraftAdmissionSchema>;

/** What a draft is given beyond the store: the model and the issue reader. */
export interface AdmitDeps {
  /** The drafting model. Otherwise built from the admission's provider. */
  model: Model;
  /** The issue reader. Otherwise `gh issue view`. */
  fetchIssue: (reference: string) => Promise<GitHubIssue>;
}

const ADMIT_FLAGS = {
  "--repo": valueFlag(),
  "--store": valueFlag(),
  "--prefix": valueFlag(),
  "--outcome": valueFlag(),
  // The spelling `perbo admit --title` has always taken, recorded as the
  // outcome it is: one field, so the last of the two given wins.
  "--title": aliasFlag("--outcome"),
  "--criterion": listFlag(),
  "--criteria-file": valueFlag(),
  "--path": listFlag(),
  "--prohibit": listFlag(),
  "--generated": listFlag(),
  "--expansion-budget": valueFlag(),
  "--level": valueFlag(),
  "--priority": valueFlag(),
  "--label": listFlag(),
  "--depends-on": listFlag(),
  "--source": valueFlag(),
  "--source-url": valueFlag(),
  "--from": valueFlag(),
  "--from-file": valueFlag(),
  "--from-spec": valueFlag(),
  "--start-over": valueFlag(),
  "--provider": valueFlag(),
  "--model": valueFlag(),
  "--manual-reviewer": valueFlag(),
  "--manual-reason": valueFlag(),
  "--approve": switchFlag(),
  "--json": switchFlag(),
} satisfies FlagTable;

const ADMIT_GRAMMAR: Grammar<typeof ADMIT_FLAGS> = {
  command: "admit",
  flags: ADMIT_FLAGS,
  positionals: {
    min: 0,
    max: 0,
    refusal:
      'admit takes no positional argument: what is admitted is given as flags, e.g. perbo admit ' +
      '--outcome "..." --criterion "what :: how it is proven" --path "src/**"',
  },
  afterDoubleDash: "positionals",
};

/**
 * An admission before anything has been asked of it: the standing
 * prohibitions, the generated globs, the expansion budget, the prefix and the
 * drafting provider this build offers, against one store.
 *
 * A caller in this process builds an admission from these and its own values.
 * There is no `approve` among them, because there is no approving here.
 */
export function defaultAdmission(target: StoreTarget): DraftAdmission {
  return {
    target,
    prefix: DEFAULT_PREFIX,
    title: null,
    criteria: [],
    criteriaFile: null,
    paths: [],
    prohibited: [...DEFAULT_PROHIBITED],
    generated: [...DEFAULT_GENERATED],
    expansionBudget: DEFAULT_EXPANSION_BUDGET,
    level: null,
    priority: "normal",
    labels: [],
    dependsOn: [],
    source: null,
    sourceUrl: null,
    from: null,
    fromFile: null,
    fromSpec: null,
    startOver: null,
    provider: "claude-cli",
    model: null,
    manualReviewer: null,
    manualReason: null,
  };
}

/**
 * One `perbo admit` line as the admission it asks for.
 *
 * The line's own reading is here — a token becoming a number, a flag naming
 * the standing lists it adds to — and what every value then has to be is
 * {@link AdmissionInputSchema}, which a caller in this process reaches too.
 */
function readAdmission(argv: readonly string[]): {
  input: AdmissionInput;
  output: { json: boolean };
} {
  const line = parseArgv(ADMIT_GRAMMAR, argv);
  const flags = line.flags;

  const rawBudget = flags["--expansion-budget"];
  const expansionBudget = rawBudget === undefined ? DEFAULT_EXPANSION_BUDGET : Number(rawBudget);
  if (!Number.isInteger(expansionBudget) || expansionBudget < 0) {
    throw new UsageError(`${EXPANSION_BUDGET_REFUSAL}. Got '${rawBudget}'`);
  }

  return {
    input: readInput(AdmissionInputSchema, {
      target: { repo: flags["--repo"] ?? ".", store: flags["--store"] ?? null },
      prefix: flags["--prefix"] ?? DEFAULT_PREFIX,
      title: flags["--outcome"] ?? null,
      criteria: [...(flags["--criterion"] ?? [])],
      criteriaFile: flags["--criteria-file"] ?? null,
      paths: [...(flags["--path"] ?? [])],
      // The standing prohibitions and the generated globs are what every
      // contract starts with; a flag adds to them rather than replacing them.
      prohibited: [...DEFAULT_PROHIBITED, ...(flags["--prohibit"] ?? [])],
      generated: [...DEFAULT_GENERATED, ...(flags["--generated"] ?? [])],
      expansionBudget,
      level: flags["--level"] ?? null,
      priority: flags["--priority"] ?? "normal",
      labels: [...(flags["--label"] ?? [])],
      dependsOn: [...(flags["--depends-on"] ?? [])],
      source: flags["--source"] ?? null,
      sourceUrl: flags["--source-url"] ?? null,
      from: flags["--from"] ?? null,
      fromFile: flags["--from-file"] ?? null,
      fromSpec: flags["--from-spec"] ?? null,
      startOver: flags["--start-over"] ?? null,
      provider: flags["--provider"] ?? "claude-cli",
      model: flags["--model"] ?? null,
      manualReviewer: flags["--manual-reviewer"] ?? null,
      manualReason: flags["--manual-reason"] ?? null,
      approve: flags["--approve"] === true,
    }),
    output: { json: flags["--json"] === true },
  };
}

/**
 * `text :: assertion [:: kind]` — what must be proven, the assertion that will
 * prove it, and how: `test` (the default), `artifact`, `query`, `metric` or
 * `manual`. A documentation or decision ticket is proven by an artifact that
 * must exist, and nothing here assumes the proof is code.
 *
 * The separator is ` :: ` **with spaces around it**, not a bare `::`. A bare one
 * silently truncated any criterion containing a scope operator:
 * `"the parser handles std::vector :: a unit test asserts it"` became text
 * `"the parser handles std"` proven by `"vector"`, both non-empty, so no guard
 * fired and the contract was approved with a criterion that says nothing.
 * `::` is ordinary in C++, Rust, Ruby and PHP identifiers, which a code-review
 * product's criteria are full of.
 *
 * More than two separators is refused rather than resolved by picking an end:
 * if the sentence is ambiguous to a reader it is ambiguous to review.
 */
const CRITERION_SEPARATOR = " :: ";

export interface ManualVerifier {
  reviewer: string | null;
  reason: string | null;
}

export function parseCriterion(
  raw: string,
  index: number,
  manual: ManualVerifier = { reviewer: null, reason: null },
): AcceptanceCriterion {
  const parts = raw.split(CRITERION_SEPARATOR);
  if (parts.length > 3) {
    throw new UsageError(
      `criterion ${index + 1} contains ${parts.length - 1} ' :: ' separators, so which part is ` +
        "the assertion is ambiguous. Use one (text :: assertion) or two (text :: assertion :: kind)",
    );
  }
  const [text, assertion, kindRaw] = parts.map((part) => part.trim());
  if (!text) throw new UsageError(`criterion ${index + 1} is empty`);
  if (!assertion) {
    throw new UsageError(
      `criterion ${index + 1} has no assertion. Write it as "what must be true :: the assertion ` +
        `that proves it", with spaces around the ' :: ' — a criterion nothing can prove is the ` +
        "defect class this product exists to catch",
    );
  }
  if (kindRaw !== undefined && !(VERIFICATION_KINDS as readonly string[]).includes(kindRaw)) {
    throw new UsageError(
      `criterion ${index + 1} names verification kind '${kindRaw}'; it must be one of ` +
        `${VERIFICATION_KINDS.join(", ")} (test when the segment is left out)`,
    );
  }
  const kind = (kindRaw ?? "test") as VerificationKind;
  if (kind === "manual" && (!manual.reviewer || !manual.reason)) {
    throw new UsageError(
      `criterion ${index + 1} is proven manually, which needs --manual-reviewer <name> and ` +
        "--manual-reason <why it cannot be automated>: a criterion nobody can automate needs a " +
        "name against it",
    );
  }
  // Parsed rather than asserted: `ac_<n>` and the verification shape are both
  // schema-checked here, so a malformed criterion fails at the point a person
  // can still fix it rather than inside `PlanContractSchema.parse` later.
  return AcceptanceCriterionSchema.parse({
    id: `ac_${index + 1}`,
    text,
    expected_verification:
      kind === "manual"
        ? { kind, assertion, manual_reviewer: manual.reviewer, manual_reason: manual.reason }
        : { kind, assertion },
  });
}

function readCriteriaFile(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function sourceOf(args: AdmissionInput, issue: SourceIssue | null, path: string | null): Ticket["source"] {
  if (issue && path !== null) {
    // A pasted file is not a tracker and it is not nothing, so it has a kind of
    // its own. It used to be recorded as `none` with the path in the reference,
    // which made a file-sourced ticket indistinguishable from one that started
    // here except by looking at the string — and left `none`, the kind that
    // means "no reference", carrying one. `url` stays null unless a person
    // supplied one with --source-url.
    //
    // Resolved, not as typed: `--from-file issue.md` is read relative to where
    // the person was standing, and a ticket outlives that. Provenance is
    // written once and never refreshed, so a reference that only resolves from
    // one directory is one that stops resolving.
    return {
      kind: "file",
      reference: path,
      url: args.sourceUrl,
      title_at_admission: issue.title,
    };
  }
  if (issue) {
    return {
      kind: "github",
      reference: issue.reference,
      url: args.sourceUrl ?? issue.url ?? null,
      title_at_admission: issue.title,
    };
  }
  if (!args.source) {
    // A URL with nothing to attach it to is a lost reference, not a default.
    if (args.sourceUrl) {
      throw new UsageError("--source-url needs --source: a link with no reference to hang it on");
    }
    return { kind: "none", reference: null, url: null, title_at_admission: null };
  }
  const kind = /^[\w.-]+\/[\w.-]+#\d+$/.test(args.source)
    ? ("github" as const)
    : /^[A-Z][A-Z0-9]+-\d+$/.test(args.source)
      ? ("jira" as const)
      : /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(args.source)
        ? ("linear" as const)
        : (() => {
            // `linear` was the fallback, so `--source "slack-thread-2026-08"`
            // became a Linear issue permanently. Provenance is written once at
            // admission and never refreshed by design, so a guess here is wrong
            // for ever.
            throw new UsageError(
              `--source '${args.source}' is not a reference this recognises. Use owner/repo#123 ` +
                "for GitHub, or PROJ-45 for Jira or Linear",
            );
          })();
  return {
    kind,
    reference: args.source,
    url: args.sourceUrl,
    title_at_admission: null,
  };
}

/**
 * What a P3 decision field holds until a person states it. `approve` refuses a
 * contract that still carries it.
 */
export const UNSTATED = "not yet stated";

export interface LevelChoice {
  level: PlanLevel;
  source: "derived" | "raised";
  derivation: RiskDerivation;
}

/**
 * Derive the level from the scope; let `requested` raise it and never lower
 * it. Admission admits a reversible change to a standard repository — a
 * read-only action is P0, which carries no criteria and cannot be admitted,
 * and irreversibility is a property of what the change turns out to do.
 */
export function chooseLevel(scope: Scope, requested: PlanLevel | null): LevelChoice {
  const derivation = derivePlannedRisk({
    scope,
    repository_sensitivity: "standard",
    action_class: "reversible_change",
  });
  if (requested === null || requested === derivation.level) {
    return { level: derivation.level, source: "derived", derivation };
  }
  if (compareLevels(requested, derivation.level) < 0) {
    throw new UsageError(
      `--level ${requested} would lower the level this scope derives to, ${derivation.level} ` +
        `(${derivation.reasons.join("; ")}). A human may raise either level; a human may not ` +
        "lower it",
    );
  }
  return { level: requested, source: "raised", derivation };
}

/**
 * The fields a level adds to the P1 body.
 *
 * P2's are derived from the scope — statements about what it declares, not
 * placeholders. P3's decision fields are a person's: the record carries the
 * derivation and the rest is `UNSTATED` until `perbo edit` states them. A
 * value already on `existing` is kept, so an edit never erases what a person
 * wrote.
 */
export function levelAdditions(
  level: PlanLevel,
  scope: Scope,
  derivation: RiskDerivation,
  existing: Record<string, unknown> = {},
): Record<string, unknown> {
  if (level === "P0" || level === "P1") return {};
  const named = (test: (path: string) => boolean) => scope.paths_allowed.filter(test);
  const migrations = named(isMigrationPath);
  const sensitive = [
    ...named(isSecurityPath).map((path) => `security-sensitive ${path}`),
    ...named(isDependencyPath).map((path) => `dependency manifest ${path}`),
    ...named(isConfigPath).map((path) => `configuration ${path}`),
  ];
  const keep = (key: string, derived: unknown) => (key in existing ? existing[key] : derived);
  const p2 = {
    data_impact: keep(
      "data_impact",
      migrations.length > 0
        ? `declared scope includes a migration path: ${migrations.join(", ")}`
        : "no schema or data migration path in the declared scope",
    ),
    security_impact: keep(
      "security_impact",
      sensitive.length > 0
        ? `declared scope includes ${sensitive.join("; ")}`
        : "no security-sensitive, dependency or configuration path in the declared scope",
    ),
    rollout: keep("rollout", "a human merges the pull request; nothing in this system deploys it"),
    rollback: keep(
      "rollback",
      "git revert of the merged pull request: the admitted action class is a reversible change",
    ),
    estimated_recurring_cost_micros: keep("estimated_recurring_cost_micros", 0),
  };
  if (level === "P2") return p2;
  return {
    ...p2,
    decision_record: keep("decision_record", `derived P3: ${derivation.reasons.join("; ")}`),
    named_approver: keep("named_approver", UNSTATED),
    alternatives: keep("alternatives", [UNSTATED]),
    contingency: keep("contingency", UNSTATED),
  };
}

/** Assemble and validate a contract at a level, keeping what a person already stated. */
export function assembleContract(args: {
  identity: { plan_id: string; version: number; ticket_id: string };
  level: LevelChoice;
  outcome: string;
  criteria: AcceptanceCriterion[];
  scope: Scope;
  base: PlanBase;
  /** The execution graph's nodes. Empty, or absent, for a flat plan (D-100). */
  nodes?: readonly PlanNode[];
  existing?: PlanContract;
}): PlanContract {
  return PlanContractSchema.parse({
    ...args.identity,
    level: args.level.level,
    outcome: args.outcome,
    acceptance_criteria: args.criteria,
    scope: args.scope,
    base: args.base,
    // Absent rather than empty: a plan either groups its criteria or does not,
    // and `nodes: []` would be a third state meaning neither.
    ...(args.nodes !== undefined && args.nodes.length > 0 ? { nodes: args.nodes } : {}),
    ...levelAdditions(
      args.level.level,
      args.scope,
      args.level.derivation,
      (args.existing ?? {}) as Record<string, unknown>,
    ),
  });
}

/**
 * What `approve` will not sign: a P3 contract whose decision fields nobody has
 * stated. Approving them unstated would make the level a label rather than a
 * decision.
 */
/** The literal text before a glob's first wildcard: the part that names a real place. */
function staticPrefix(glob: string): string {
  const cut = glob.search(/[*?[{]/);
  return cut === -1 ? glob : glob.slice(0, cut);
}

/**
 * A scope that reaches into what judges the attempt is refused here, with the
 * reason, rather than at the seal after an attempt has run (D-045). Overlap is
 * decided on the static prefixes: either glob naming a place inside the other's
 * is an overlap. That refuses `packages/**` against a protected
 * `packages/review/**` too, deliberately — the answer is a narrower scope.
 */
/** `a/b` is inside `a/b/…` and is `a/b` itself; it is not inside `a/bc`. */
function inside(path: string, prefix: string): boolean {
  const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return path === base || path.startsWith(`${base}/`);
}

export function judgingOverlap(
  allowed: readonly string[],
  judging: readonly JudgingRule[],
): Array<{ scope: string; judging: JudgingRule }> {
  const overlaps: Array<{ scope: string; judging: JudgingRule }> = [];
  for (const scope of allowed) {
    const s = staticPrefix(scope);
    for (const rule of judging) {
      const j = staticPrefix(rule.path);
      // A judging glob with no literal prefix (`**/*.pem`) names no place a
      // scope could be compared with; the seal still enforces it.
      if (j.length === 0) continue;
      // A scope with no literal prefix (`**`, `**/*.ts`) names every place,
      // so it reaches every judging path there is.
      if (s.length === 0 || inside(s, j) || inside(j, s)) overlaps.push({ scope, judging: rule });
    }
  }
  return overlaps;
}

/**
 * Every requirement id a criterion cites is one the spec carries.
 *
 * The schema checks the shape and stops there: what requirements exist is a
 * fact about a Markdown file, so the set is supplied here and by `perbo edit`,
 * which is the only other thing that writes a criterion. A contract with no
 * spec behind it cites nothing, and a citation on one is refused rather than
 * kept as a reference to nowhere.
 */
export function assertRequirementsCarried(
  contract: PlanContract,
  requirementIds: readonly string[],
  specPath: string | null,
  remedy = "",
): void {
  const unknown = unknownRequirementIds(contract, requirementIds);
  if (unknown.length === 0) return;
  throw new UsageError(
    `the contract cites ${unknown.length} requirement${unknown.length === 1 ? "" : "s"} ` +
      `${specPath === null ? "and no spec was drafted from" : `${specPath} does not carry`}: ` +
      unknown.map((each) => `${each.criterion_id} cites ${each.requirement_id}`).join("; ") +
      ". A criterion records the requirement it was drafted from (D-103), and an id nothing " +
      `declares is a reference to nowhere${remedy}`,
  );
}

export function assertApprovable(
  contract: PlanContract,
  key: string,
  judging: readonly JudgingRule[] = [{ path: ".perbo/**", source: "store" }],
): void {
  const overlaps = judgingOverlap(contract.scope.paths_allowed, judging);
  if (overlaps.length > 0) {
    throw new UsageError(
      `${key} cannot be approved: its scope reaches what judges the attempt — ` +
        // The source travels with the path: `scripts/validate_docs.py` alone
        // says a file is out of bounds, `checks[check_docs].definition_path`
        // says the scope was reaching for the check that grades the attempt.
        overlaps.map((o) => `${o.scope} overlaps protected ${o.judging.path} (${o.judging.source})`).join("; ") +
        `. The runner would refuse the change at the seal, after an attempt had been paid for. ` +
        `Narrow the scope: perbo edit ${key} --path <glob outside the protected paths>`,
    );
  }
  if (contract.level !== "P3") return;
  const unstated = (["decision_record", "named_approver", "alternatives", "contingency"] as const).filter(
    (field) => {
      const value = contract[field];
      return Array.isArray(value) ? value.includes(UNSTATED) : value === UNSTATED;
    },
  );
  if (unstated.length === 0) return;
  throw new UsageError(
    `${key} derives to P3 and ${unstated.join(", ")} ${unstated.length === 1 ? "is" : "are"} ` +
      `not yet stated. These are decisions only a person makes: perbo edit ${key}, state them, ` +
      "then approve",
  );
}

/**
 * The contract in `<KEY>.contract.json` against its counter-seal in
 * `<KEY>.draft.json`: refused if the two differ, and equally if the counter-seal
 * is gone or no longer parses.
 *
 * `admit` writes the two files from one object and `perbo edit` rewrites both,
 * so they agree unless something else wrote one of them — a text editor, a
 * script, a patch applied to the store. That difference is not an edit and is
 * not counted as one: it is a contract nobody was shown, and approving it would
 * hand the runner a scope, a criterion or an outcome that never passed through
 * the command that re-derives the level and records what changed.
 *
 * **A missing or unreadable counter-seal is refused too**, or the check would be
 * one anybody could opt out of by deleting the file they were about to edit,
 * and it would hold against a slip and against nothing else. What makes that
 * safe to require is `admission.counter_sealed_at`: the ticket's own record that
 * the pair was written. Null there means a ticket admitted before counter-seals
 * existed — nothing is required of it and nothing compared, because for such a
 * ticket a difference is the work of an earlier `perbo edit` that rewrote only
 * one file, not a hand edit, and refusing it would strand tickets in stores that
 * are already on disk. One `perbo edit` seals such a ticket from then on.
 *
 * Every field is compared, not only the three a person edits. A base commit or
 * a level that differs between the two files is the same hand edit by a
 * different route, and naming it is cheaper than the argument about whether it
 * mattered.
 *
 * Called at approval and again by `loadAdmitted`, which is what `perbo run
 * --ticket` binds an attempt through. Approval is where a person can still put
 * it right; execution is where it would otherwise stop mattering that they
 * hadn't, since an approved contract is immutable and an attempt is judged
 * against it.
 */
export function assertContractSealed(
  ticket: Ticket,
  contract: PlanContract,
  draft: DraftSnapshotFile,
  /** What the caller was about to do, for the refusal's first words. */
  action: "run" | "approved" | "edited" = ticket.approved_at !== null ? "run" : "approved",
): void {
  const sealedAt = ticket.admission.counter_sealed_at;
  if (sealedAt === null) return;
  const key = ticket.key;

  const problem =
    draft.kind === "absent"
      ? `${key}.draft.json is missing, and this ticket records the contract as having been ` +
        `written to it at ${sealedAt}`
      : draft.kind === "unreadable"
        ? `${key}.draft.json cannot be read: ${draft.reason}`
        : describeContractDifference(contract, draft.snapshot.contract, key);
  if (problem === null) return;

  // An unapproved ticket can still be put right, and there is exactly one
  // command that does it. An approved one cannot: the contract is immutable
  // (ADR-0016), so `perbo edit` refuses it, and the honest remedies are the
  // file the pair came from and new work.
  const remedy =
    ticket.approved_at !== null
      ? "An approved contract is immutable (ADR-0016), so this is not an edit to redo: restore " +
        `both files from version control, and if the contract should change, admit that as new work.`
      : draft.kind === "snapshot"
        ? `Change a contract the one way that records it: perbo edit ${key} ` +
          `--outcome "..." --criterion "what :: how it is proven" --path "<glob>", or perbo edit ` +
          `${key} for the editor. That rewrites both files and re-derives the level from the scope.`
        : `Restore ${key}.draft.json from version control, which also restores how the contract ` +
          "was drafted; or, if the contract as it now stands is the one you mean to approve, read " +
          `it and write the pair again from it: perbo edit ${key}.`;

  throw new UsageError(
    `${key} cannot be ${action}: ${problem}. ` +
      "Those two files are written together by admission and by `perbo edit` and by nothing " +
      "else, so a contract that has lost its counter-seal, or no longer matches it, is one " +
      `nobody was shown, and not one to start an attempt against. ${remedy}`,
  );
}

/** Where the two copies differ, named by path, or null when they do not. */
function describeContractDifference(
  sealed: PlanContract,
  drafted: PlanContract,
  key: string,
): string | null {
  const differences = contractDifferences(drafted, sealed);
  if (differences.length === 0) return null;
  return (
    `${key}.contract.json and the contract recorded beside it in ${key}.draft.json differ at ` +
    `${differences.length} field${differences.length === 1 ? "" : "s"} — ${differences.join(", ")}`
  );
}

/** The drafting transport, the reviewer's own, constrained to the draft schema. */
function draftingModel(provider: DraftProvider, modelId: string | null): Model {
  return createModel(provider, { submitSchema: CONTRACT_DRAFT_JSON_SCHEMA, modelId });
}

export interface Resolved {
  outcome: string;
  criteria: AcceptanceCriterion[];
  paths: string[];
  prohibited: string[];
  criteriaSource: "typed" | "file" | "drafted" | "spec";
  issue: SourceIssue | null;
  drafted: DraftResult | null;
  /** The file `--from-file` or `--from-spec` read, resolved. Null for every other source. */
  sourcePath: string | null;
  /** Keys this work follows: typed with `--depends-on`, else what the draft proposed against the board. */
  dependsOn: string[];
  /** The graph the draft proposed, with ids. Empty where the plan is flat. */
  nodes: PlanNode[];
  edges: GraphEdge[];
  /** Read from the spec's own No-Gos heading, never drafted (D-100). */
  noGos: string[];
  /** The spec this was drafted from, as the admission record carries it. */
  spec: { path: string; content_sha256: string } | null;
  /** The requirement ids the spec carries, which a criterion may cite. */
  requirementIds: string[];
}

/** One admission under way: what was asked for, and what it is run against. */
interface Admitting {
  args: AdmissionInput;
  cwd: string;
  now: Date;
  /** Progress while a model drafts, and what was left off the board. */
  diagnostics: Diagnostics;
  model?: Model;
  fetchIssue?: (reference: string) => Promise<GitHubIssue>;
}

/**
 * The issue the draft is made from, from whichever source was named.
 *
 * One function so there is one shape and one call afterwards: `--from-file`
 * reads external-trust text off the disk and `--from` reads it out of GitHub,
 * and past this point nothing downstream can tell — or needs to tell — which
 * of the two it was holding.
 */
function readSource(
  input: Admitting,
): Promise<{ issue: SourceIssue; path: string | null; spec: Spec | null }> {
  const { args } = input;
  if (args.fromSpec !== null) {
    // A spec is drafted from as an issue is: it is read here into the same
    // shape, and everything downstream of this point holds one thing. What it
    // adds travels beside the issue, not inside it — the requirement ids the
    // drafter may cite, and the No-Gos, which are the spec's own and never a
    // model's (D-103, D-100).
    const path = resolve(input.cwd, args.fromSpec);
    const { spec, markdown } = readSpecFile(path);
    return Promise.resolve({
      issue: { reference: specReference(path), title: spec.title, body: markdown },
      path,
      spec,
    });
  }
  if (args.fromFile !== null) {
    // Resolved against the working directory, like every other path this
    // command takes, so `--from-file issue.md` means the one in front of you.
    // The resolved path is what travels on: it is the one that names the same
    // file when the ticket is read from another directory or another machine.
    const path = resolve(input.cwd, args.fromFile);
    return Promise.resolve({ issue: readIssueFile(path), path, spec: null });
  }
  return (input.fetchIssue ?? fetchGitHubIssue)(args.from!).then((issue) => ({
    issue,
    path: null,
    spec: null,
  }));
}

/** `spec:<slug>`, from the folder the `spec.md` sits in: what D-103 names it by. */
function specReference(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0);
  const folder = segments[segments.length - 2];
  return `spec:${folder ?? segments[segments.length - 1] ?? "spec"}`;
}

/** The SHA-256 of the spec as read for drafting: the same bytes the drafter saw, not a second read. */
const contentHash = (text: string): string =>
  `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

function typedCriteria(input: Admitting): AcceptanceCriterion[] {
  const { args } = input;
  const raw = args.criteriaFile
    ? [...args.criteria, ...readCriteriaFile(resolve(input.cwd, args.criteriaFile))]
    : args.criteria;
  const manual: ManualVerifier = { reviewer: args.manualReviewer, reason: args.manualReason };
  return raw.map((line, index) => parseCriterion(line, index, manual));
}

function resolveTyped(input: Admitting): Resolved {
  const { args } = input;
  if (!args.title) throw new UsageError("--outcome is required: one sentence, what will be true");
  const criteria = typedCriteria(input);
  if (criteria.length === 0) {
    throw new UsageError(
      "at least one --criterion is required. A ticket with no acceptance criteria has nothing " +
        "for review to judge, and admitting it would produce a contract that cannot fail",
    );
  }
  if (args.paths.length === 0) {
    throw new UsageError(
      "at least one --path is required. Scope bounds what the executor may touch and what counts " +
        "as an escape; an unbounded ticket has no scope guard at all",
    );
  }
  return {
    outcome: args.title,
    criteria,
    paths: args.paths,
    prohibited: args.prohibited,
    criteriaSource: args.criteriaFile ? "file" : "typed",
    issue: null,
    drafted: null,
    sourcePath: null,
    dependsOn: args.dependsOn,
    nodes: [],
    edges: [],
    noGos: [],
    spec: null,
    requirementIds: [],
  };
}

/**
 * The tickets in flight, as the drafter is shown them: keys it may depend on,
 * and scopes to keep clear of. Drafts awaiting approval are on it too — the
 * next ticket from the same epic follows one the person has not yet approved.
 */
function board(dir: string, leftOff: (key: string) => void): BoardEntry[] {
  const inFlight = new Set<string>(["plan_review", ...QUEUE_HOLDING_STATES]);
  return listTickets(dir)
    .filter((ticket) => inFlight.has(ticket.state))
    .flatMap((ticket) => {
      // A ticket whose contract cannot be read is stepped over, as `list`
      // steps over a ticket it cannot read: one broken record does not stop
      // every admission after it. Said, because the drafter is then told
      // that ticket is not in flight.
      let paths_allowed: readonly string[];
      try {
        paths_allowed = readContract(dir, ticket.key).scope.paths_allowed;
      } catch {
        leftOff(ticket.key);
        return [];
      }
      return [
        {
          key: ticket.key,
          state: ticket.state,
          priority: ticket.priority,
          outcome: ticket.title,
          paths_allowed,
          approved: ticket.approved_at !== null,
        },
      ];
    });
}

/** Smaller than a review's: the drafter opens a few files to name a scope, not to judge a change. */
const DRAFT_READ_LIMITS = {
  maxFiles: 8,
  maxBytesPerFile: 32 * 1024,
  maxTotalBytes: 128 * 1024,
  maxTreeEntries: 600,
};

/**
 * Draft from the issue or the spec, then let every typed flag override its
 * part: `--outcome` the outcome, any `--criterion` all the criteria, any
 * `--path` all the globs.
 *
 * One function for all three sources, deliberately: a pasted file, a fetched
 * issue and a committed spec are the same external-trust text once read, and a
 * second path to the model is a second place for that to stop being true. What
 * a spec adds — the ids a criterion may cite, and the No-Gos — travels beside
 * the text, never inside the instruction position.
 */
async function resolveDrafted(input: Admitting): Promise<Resolved> {
  const { args, diagnostics } = input;
  const repositoryRoot = resolve(input.cwd, args.target.repo);
  let issue: SourceIssue;
  let sourcePath: string | null;
  let spec: Spec | null;
  let drafted: DraftResult;
  try {
    ({ issue, path: sourcePath, spec } = await readSource(input));
    // A spec is kept in the repository it is drafted for and committed with
    // the change (D-103), so its recorded path is repository-relative; one
    // outside the repository has no such path, and is refused before a model
    // is asked anything.
    if (spec !== null && sourcePath !== null) {
      const within = relative(repositoryRoot, sourcePath);
      if (within.startsWith("..") || isAbsolute(within)) {
        throw new UsageError(
          `--from-spec names ${sourcePath}, which is outside ${repositoryRoot}. A spec lives in the ` +
            "repository it is drafted for, at specs/<slug>/spec.md, and is committed with the change (D-103)",
        );
      }
      // And in a folder of its own under the spec folder (D-103): admission
      // records that folder whole and the loop commits it, so a `spec.md` at
      // the root of the repository, or under a folder the repository keeps
      // other things in, would put all of it on the branch.
      const specs = specFolder(storeDir(repositoryRoot, args.target.store));
      if (onePieceOfWork(within.split(sep).join("/"), specs) === null) {
        throw new UsageError(
          `--from-spec names ${sourcePath}, which is not one piece of work's spec. A spec lives at ` +
            `${specs}/<slug>/spec.md, in a folder of its own, because admission records that ` +
            "folder whole and the loop commits it on the ticket's branch (D-103)",
        );
      }
      // And reached without a link: its pages are written beside it.
      try {
        assertNoSymlink(repositoryRoot, within.split(sep).join("/"));
      } catch (error) {
        if (!(error instanceof PlanningError)) throw error;
        throw new UsageError(`--from-spec: ${error.message}`);
      }
    }
    const model = input.model ?? draftingModel(args.provider, args.model);
    diagnostics.stderr(
      `read ${issue.reference}: ${issue.title}\ndrafting the contract with ${model.provider} ` +
        `${model.model_id}; nothing runs until you approve it\n`,
    );
    drafted = await draftContract({
      title: issue.title,
      body: issue.body,
      ...(issue.url !== undefined ? { url: issue.url } : {}),
      // Carried so a flagged line is reported at the line of the file the
      // person will open, not at an offset into the text this assembled.
      ...(issue.source_lines !== undefined ? { sourceLines: issue.source_lines } : {}),
      ...(spec === null
        ? {}
        : { sourceKind: "spec" as const, requirementIds: spec.requirements.map((r) => r.id) }),
      reference: issue.reference,
      repositoryRoot,
      repositoryId: repositoryId(repositoryRoot),
      defaultProhibited: args.prohibited,
      defaultGenerated: args.generated,
      board: board(storeDir(repositoryRoot, args.target.store), (key) =>
        diagnostics.stderr(`${key} is in flight but its contract cannot be read; it is left off the board\n`),
      ),
      reader: new RepoReader(repositoryRoot, DRAFT_READ_LIMITS),
      model,
    });
  } catch (error) {
    if (error instanceof PlanningError) throw new UsageError(error.message);
    if (error instanceof ProviderError) {
      throw new UsageError(
        `the draft could not be produced (${error.kind}): ${error.message}. Admit the work by ` +
          "hand with --outcome, --criterion and --path, or try again",
      );
    }
    throw error;
  }

  const typed = typedCriteria(input);
  const criteria =
    typed.length > 0
      ? typed
      : drafted.draft.acceptance_criteria.map((criterion, index) =>
          AcceptanceCriterionSchema.parse({
            id: `ac_${index + 1}`,
            text: criterion.text,
            expected_verification: { kind: criterion.kind, assertion: criterion.assertion },
            ...(criterion.requirement_id === undefined
              ? {}
              : { requirement_id: criterion.requirement_id }),
          }),
        );
  // A graph is a statement about the drafted criteria and the drafted scope,
  // by position. Typing either replaces what it was a statement about, so the
  // graph goes with it rather than being reindexed onto something else. The
  // person still has `perbo edit --graph-edit` to build one.
  const overridden = typed.length > 0 ? "--criterion" : args.paths.length > 0 ? "--path" : null;
  if (overridden !== null && drafted.draft.nodes.length > 0) {
    diagnostics.stderr(
      `${overridden} replaces what the drafted graph divided, so the graph is not kept. ` +
        "Build one with perbo edit KEY --graph-edit.\n",
    );
  }
  const graph =
    overridden === null
      ? {
          nodes: drafted.draft.nodes.map((node, index) =>
            PlanNodeSchema.parse({
              id: `node_${index + 1}`,
              title: node.title,
              criteria: node.criteria.map((at) => `ac_${at + 1}`),
              paths: node.paths,
            }),
          ),
          edges: drafted.draft.edges.map((edge) => ({
            from: `node_${edge.from + 1}`,
            to: `node_${edge.to + 1}`,
          })),
        }
      : { nodes: [], edges: [] };
  return {
    outcome: args.title ?? drafted.draft.outcome,
    criteria,
    paths: args.paths.length > 0 ? args.paths : drafted.draft.proposed_scope.paths_allowed,
    prohibited: [...new Set([...args.prohibited, ...drafted.draft.proposed_scope.paths_prohibited_extra])],
    criteriaSource: spec === null ? "drafted" : "spec",
    issue,
    drafted,
    sourcePath,
    dependsOn: args.dependsOn.length > 0 ? args.dependsOn : drafted.draft.depends_on,
    nodes: graph.nodes,
    edges: graph.edges,
    noGos: spec?.no_gos ?? [],
    spec:
      spec === null || sourcePath === null
        ? null
        : {
            // Relative to the repository, because the spec is committed in it
            // and the ticket outlives the directory a person typed the path in.
            path: relative(repositoryRoot, sourcePath).split(sep).join("/"),
            content_sha256: contentHash(issue.body),
          },
    requirementIds: spec?.requirements.map((requirement) => requirement.id) ?? [],
  };
}

/**
 * What one admission wrote: the ticket, the contract it is bound by, the
 * approach beside it and the draft it came from, with what the reading of it
 * needs.
 */
export interface AdmissionReport {
  /** A new ticket, or the same ticket drafted from its spec again (D-103). */
  readonly kind: "admitted" | "re-drafted";
  readonly key: string;
  readonly ticket: Ticket;
  readonly contract: PlanContract;
  readonly approach: ApproachRecord | null;
  readonly draft: DraftSnapshot["draft"] | null;
  readonly level: LevelChoice;
  /** What the admission read: the outcome, the criteria, the scope and the graph. */
  readonly resolved: Resolved;
  /** Where the ticket was written, from where the command was run. */
  readonly storedAt: string;
  /** The node pages written beside the spec, from the repository's root. */
  readonly pages: readonly string[];
  /** The scope is the model's proposal: nothing named a path. */
  readonly scopeProposed: boolean;
}

/**
 * Admit one piece of work as a ticket.
 *
 * Synchronous for typed admission, which every test and script relies on; a
 * promise when `from`, `fromFile` or `fromSpec` is given, because drafting
 * calls a model.
 */
export function admit(
  input: AdmissionInput,
  context: CommandContext & Partial<AdmitDeps>,
): AdmissionReport | Promise<AdmissionReport> {
  return admitting(
    {
      args: input,
      cwd: context.cwd,
      now: context.now,
      diagnostics: context.diagnostics,
      ...(context.model === undefined ? {} : { model: context.model }),
      ...(context.fetchIssue === undefined ? {} : { fetchIssue: context.fetchIssue }),
    },
    Date.now(),
  );
}

/**
 * Admit one piece of work as a draft, which is how a caller in this process
 * admits: the queue, the endpoint and the interview reach this and there is
 * no approving from here (D-072, ADR-0023 §4).
 */
export function admitDraft(
  input: DraftAdmission,
  context: CommandContext & Partial<AdmitDeps>,
): AdmissionReport | Promise<AdmissionReport> {
  // Read as a draft, which is strict and has no `approve` among its fields:
  // an object carrying one is refused here rather than quietly stripped, so a
  // caller that believed it could approve is told that it cannot.
  return admit({ ...readInput(DraftAdmissionSchema, input), approve: false }, context);
}

function admitting(input: Admitting, started: number): AdmissionReport | Promise<AdmissionReport> {
  const flag =
    input.args.from !== null
      ? "--from"
      : input.args.fromFile !== null
        ? "--from-file"
        : input.args.fromSpec !== null
          ? "--from-spec"
          : null;
  if (flag !== null) {
    // D-072 licenses drafting only because a person reads the draft before it
    // binds anything. Approving in the same command would hand the runner a
    // scope nobody read, which is the ADR-0023 §4 case D-072 argued around.
    // The source makes no difference: text off the disk is external too.
    if (input.args.approve) {
      throw new UsageError(
        `${flag} drafts the contract with a model, so it cannot be approved in the same command: ` +
          "read the draft, then `perbo approve <key>`",
      );
    }
    // Starting over is re-drafting from a spec, which is the only source a
    // ticket's plan can be drafted again from: `--from` and `--from-file` name
    // a document the ticket was never drafted from, and the flags a caller
    // built by hand are checked here as a command line's are.
    if (input.args.startOver !== null && flag !== "--from-spec") {
      throw new UsageError(
        `--start-over ${input.args.startOver} re-drafts a ticket from its spec, so it needs the ` +
          "spec: perbo admit --from-spec specs/<slug>/spec.md --start-over " + input.args.startOver,
      );
    }
    // Whether this ticket can be re-drafted at all is asked before a model is,
    // as a spec outside the repository is: a ticket already approved is one
    // nothing can change, and finding that out after a draft has been paid for
    // is the whole of what it costs.
    if (input.args.startOver !== null) {
      const repositoryRoot = resolve(input.cwd, input.args.target.repo);
      assertRedraftable(
        storeDir(repositoryRoot, input.args.target.store),
        input.args.startOver,
        relative(repositoryRoot, resolve(input.cwd, input.args.fromSpec!)).split(sep).join("/"),
      );
    }
    return resolveDrafted(input).then((resolved) =>
      input.args.startOver === null
        ? admitted(input, started, resolved)
        : redraft(input, started, resolved, input.args.startOver),
    );
  }
  return admitted(input, started, resolveTyped(input));
}

function admitted(input: Admitting, started: number, resolved: Resolved): AdmissionReport {
  const { args, now } = input;
  const repositoryRoot = resolve(input.cwd, args.target.repo);
  const dir = storeDir(repositoryRoot, args.target.store);

  const key = nextKey(dir, args.prefix);
  const { ticket_id, plan_id } = idsFor(key, now);
  const repository_id = repositoryId(repositoryRoot);
  const base_commit = headCommit(repositoryRoot);

  const scope: Scope = {
    repository_id,
    paths_allowed: resolved.paths,
    // The spec folders (D-103) and what this repository prohibits for every
    // ticket (D-105) join whatever the draft and the flags named: a spec is
    // what the contract was drafted from, and a path put on the standing list
    // binds work admitted after it without anybody restating it.
    paths_prohibited: [
      ...new Set([
        ...resolved.prohibited,
        ...prohibitedSpecPaths(dir),
        ...standingProhibited(dir).map((entry) => entry.path),
      ]),
    ],
    generated_paths: args.generated,
    expansion_budget_files: args.expansionBudget,
  };
  const level = chooseLevel(scope, args.level);
  const contract = assembleContract({
    identity: { plan_id, version: 1, ticket_id },
    level,
    outcome: resolved.outcome,
    criteria: resolved.criteria,
    scope,
    nodes: resolved.nodes,
    base: {
      base_commit,
      context_manifest_hash: contextManifestHash({ base_commit, ...scope }),
      captured_at: now.toISOString(),
    },
  });
  assertRequirementsCarried(contract, resolved.requirementIds, resolved.spec?.path ?? null);
  // Refused before anything is written: a P3 with unstated decisions cannot be
  // approved, so `--approve` must not create a ticket that then cannot be.
  if (args.approve) assertApprovable(contract, key, readJudgingPaths(dir));

  let ticket = TicketSchema.parse({
    schema_version: TICKET_SCHEMA_VERSION,
    ticket_id,
    key,
    title: resolved.outcome,
    state: "plan_review",
    priority: args.priority,
    labels: args.labels,
    depends_on: resolved.dependsOn,
    source: sourceOf(args, resolved.issue, resolved.sourcePath),
    repository_root: repositoryRoot,
    plan_id,
    plan_version: 1,
    approved_at: null,
    admitted_at: now.toISOString(),
    updated_at: now.toISOString(),
    admission: {
      elapsed_ms: Date.now() - started,
      criteria_source: resolved.criteriaSource,
      criteria_count: resolved.criteria.length,
      drafted_at: resolved.drafted ? now.toISOString() : null,
      spec: resolved.spec,
      human_elapsed_ms: null,
      edit_count: null,
      // The contract and the copy inside the draft snapshot are written from
      // one object, a few lines below, and this says so: from here on approval
      // and execution require the pair and compare it.
      counter_sealed_at: now.toISOString(),
      level_source: level.source,
      derived_level: level.derivation.level,
    },
    history: [
      {
        at: now.toISOString(),
        from: null,
        to: "plan_review",
        note: resolved.issue
          ? `admitted from ${resolved.sourcePath ?? resolved.issue.reference}, contract drafted`
          : args.source
            ? `admitted from ${args.source}`
            : "admitted",
      },
    ],
  });

  const snapshot: DraftSnapshot = {
    schema_version: 1,
    key,
    rendered_at: now.toISOString(),
    criteria_source: resolved.criteriaSource,
    contract,
    /** Nothing has been edited yet; `perbo edit` appends to this. */
    edits: [],
    draft:
      resolved.drafted && resolved.issue
        ? {
            issue: {
              reference: resolved.issue.reference,
              url: resolved.issue.url ?? null,
              /** Null for a fetched issue; the file this one was read from. */
              path: resolved.sourcePath,
              title: resolved.issue.title,
            },
            proposed: resolved.drafted.draft,
            model: resolved.drafted.model,
            unknown_roots: resolved.drafted.unknown_roots,
            // Kept beside the draft, not only printed: what the issue tried on
            // the drafter is part of what a person is approving against.
            issue_authored_attempts: resolved.drafted.issue_authored_attempts,
            issue_authored_attempts_found: resolved.drafted.issue_authored_attempts_found,
            files_read: resolved.drafted.files_read,
          }
        : null,
  };

  recordIssued(dir, key);
  // The node pages are written last, so what they need is checked first: a
  // spec folder, nodes folder or page that is a link refuses the admission
  // with no ticket, contract or snapshot written. The key issued above stays
  // issued, as every key once issued does.
  assertPagesWritable(repositoryRoot, resolved, contract);
  writeContract(dir, ticket, contract);
  writeDraftSnapshot(dir, snapshot);
  // The approach, where there is one to record: a plan with nodes carries the
  // order between them, suggested or not yet, and a spec carries its No-Gos.
  // Neither is contract, so neither is counter-sealed and neither is frozen at
  // approval (D-100, ADR-0016).
  const approach: ApproachRecord | null =
    resolved.nodes.length > 0 || resolved.noGos.length > 0
      ? {
          schema_version: APPROACH_SCHEMA_VERSION,
          ticket_id,
          plan_id,
          edges: resolved.edges,
          no_gos: resolved.noGos,
        }
      : null;
  if (approach) writeApproachRecord(dir, key, approach);
  if (args.approve) {
    const moved = transition(ticket, "ready", "contract approved at admission", now);
    ticket = TicketSchema.parse({
      ...moved,
      approved_at: now.toISOString(),
      admission: { ...moved.admission, human_elapsed_ms: 0, edit_count: 0 },
    });
  }
  // The page per node, beside the spec the plan was drafted from (D-103).
  // Nothing for a ticket drafted from an issue, which has no folder. Written
  // before the ticket, because the pages are among the files the record below
  // says the loop commits.
  const pages = regenerateNodePages({ repositoryRoot, ticket, contract });
  ticket = withSpecFiles({ dir, repositoryRoot, ticket });
  const path = writeTicket(dir, ticket);

  return {
    kind: "admitted",
    key,
    ticket,
    contract,
    approach,
    draft: snapshot.draft,
    level,
    resolved,
    storedAt: relative(input.cwd, path),
    pages: (pages?.written ?? []).map((page) => relative(repositoryRoot, page).split(sep).join("/")),
    scopeProposed: resolved.drafted !== null && args.paths.length === 0,
  };
}

/**
 * The ticket with the files the loop commits first on its branch recorded
 * beside the spec's path and hash (D-103), and unchanged for one admitted
 * without a spec.
 */
function withSpecFiles(args: { dir: string; repositoryRoot: string; ticket: Ticket }): Ticket {
  const spec = args.ticket.admission.spec;
  if (spec === null) return args.ticket;
  return TicketSchema.parse({
    ...args.ticket,
    admission: {
      ...args.ticket.admission,
      spec: {
        ...spec,
        files: specCommitFiles({
          repositoryRoot: args.repositoryRoot,
          store: args.dir,
          specPath: spec.path,
        }),
      },
    },
  });
}

/**
 * The ticket with the names its spec carries that this repository has
 * recorded beside the spec's path and hash (D-103), and the files the loop
 * commits re-taken from that same moment — and unchanged for one admitted
 * without a spec.
 *
 * Whether the symbol index could be believed as that was read is recorded with
 * them. An index that could not be contributes no `@Symbol` to the baseline,
 * so no later reading of this ticket can call a symbol gone; recording that it
 * happened is what lets the reading say so instead of calling the spec current.
 *
 * Written at approval and at no other moment, because that is when the plan was
 * agreed against the repository as it stood: a name the repository had then and
 * has lost is a stale spec, and a name it did not have is the work the plan is
 * for. Reading this at admission instead would take the baseline before the
 * person had seen the contract, and reading it later would take it after the
 * work had begun to change the answer. Admission has no second call for the
 * case where it approves too, because it never does: `--approve` is refused
 * beside every flag that drafts from a document, and a ticket typed on the
 * command line has no spec (D-072).
 *
 * `files` is re-taken with the same walk `withSpecFiles` runs at admission
 * (`specCommitFiles`), so the loop commits the folder as it stood at approval
 * rather than at admission. Its `spec.md` entry is never hashed a second time
 * for this: it is set to the `content_sha256` this same read already took, so
 * the two fields can never disagree about the spec's own bytes.
 */
function withNamesThatResolved(args: { dir: string; ticket: Ticket }): Ticket {
  const spec = args.ticket.admission.spec;
  if (spec === null) return args.ticket;
  const baseline = specBaseline({
    repositoryRoot: args.ticket.repository_root,
    specPath: spec.path,
  });
  // What the spec said when it was approved, so a later reading judges an
  // edit made after approval — which is the rule D-103 states. The hash
  // admission took is from when the contract was drafted, and the spec is
  // ordinarily edited between the two, while the draft is being read.
  // A spec that could not be read leaves admission's hash standing, and its
  // files with it: there is nothing fresher this read took them from.
  const content_sha256 = baseline.content_sha256 ?? spec.content_sha256;
  const files =
    baseline.content_sha256 === null
      ? spec.files
      : specCommitFiles({
          repositoryRoot: args.ticket.repository_root,
          store: args.dir,
          specPath: spec.path,
        }).map((file) => (file.path === spec.path ? { ...file, content_sha256 } : file));
  return TicketSchema.parse({
    ...args.ticket,
    admission: {
      ...args.ticket.admission,
      spec: {
        ...spec,
        content_sha256,
        files,
        names_that_resolved: baseline.names,
        symbols_judged_at_approval: baseline.symbols_judged,
      },
    },
  });
}

/** What the node pages need, asked before a record is written (D-103). */
function assertPagesWritable(repositoryRoot: string, resolved: Resolved, contract: PlanContract): void {
  if (resolved.spec === null) return;
  try {
    assertNodePagesWritable({
      repositoryRoot,
      specFolder: dirname(resolve(repositoryRoot, resolved.spec.path)),
      contract,
    });
  } catch (error) {
    if (!(error instanceof PlanningError)) throw error;
    throw new UsageError(`the node pages beside ${resolved.spec.path} cannot be written: ${error.message}`);
  }
}

/**
 * The ticket a `--start-over` names, if its plan may be drafted again: one in
 * `plan_review` that nobody has approved. Read before the model is called and
 * again when the draft comes back.
 */
function assertRedraftable(dir: string, key: string, specPath: string): Ticket {
  const ticket = readTicket(dir, key);
  if (ticket.approved_at !== null) {
    throw new UsageError(
      `${key} was approved at ${ticket.approved_at}, and an approved contract is immutable ` +
        "(ADR-0016). A change to it is new work: admit it",
    );
  }
  if (ticket.state !== "plan_review") {
    throw new UsageError(
      `${key} is ${ticket.state}; only a ticket in plan_review may be re-drafted from its spec`,
    );
  }
  // The recorded path is the ticket's provenance, which staleness is later
  // judged against: starting over keeps it, so any other spec is other work.
  const recorded = ticket.admission.spec;
  if (recorded === null) {
    throw new UsageError(
      `${key} was not drafted from a spec, so there is no spec to start over from. A plan ` +
        "drafted from a spec is admitted with perbo admit --from-spec",
    );
  }
  if (recorded.path !== specPath) {
    throw new UsageError(
      `${key} was drafted from ${recorded.path}, and starting over drafts it again from that ` +
        `spec. ${specPath} is another: admit it as work of its own`,
    );
  }
  return ticket;
}

/**
 * `perbo admit --from-spec <path> --start-over <KEY>`: draft this ticket's
 * plan again from its spec (D-103).
 *
 * The same ticket and the same `ticket_id`, a new plan version. What was
 * drafted is replaced whole — the outcome, the criteria, the graph and the
 * scope — so the graph edits made since the first draft, and the node paths
 * they set, go with it. What is in the spec survives because it is read from
 * the spec: its No-Gos, and every edit a person made to the document.
 *
 * Nothing else is admitted. Re-drafting is the one thing that changes a plan
 * other than an edit (D-100), and the confirmation before it is the desktop's:
 * a command line is already deliberate.
 */
function redraft(
  input: Admitting,
  started: number,
  resolved: Resolved,
  key: string,
): AdmissionReport {
  const { args, now } = input;
  const repositoryRoot = resolve(input.cwd, args.target.repo);
  const dir = storeDir(repositoryRoot, args.target.store);

  if (resolved.spec === null) {
    throw new UsageError(`--start-over ${key} re-drafts a ticket from its spec, so it needs the spec`);
  }
  const ticket = assertRedraftable(dir, key, resolved.spec.path);
  const before = readContract(dir, key);
  assertContractMatches(ticket, before);
  const draft = readDraftSnapshotFile(dir, key);
  // The re-draft is recorded in the same log the edits are, so the log has to
  // be the one that vouches for the contract standing now.
  assertContractSealed(ticket, before, draft, "edited");
  if (draft.kind !== "snapshot") {
    throw new UsageError(
      `${key} has no draft snapshot to record a re-draft against` +
        (draft.kind === "unreadable" ? `: ${draft.reason}` : "") +
        `. Restore it from version control, or run perbo edit ${key} --outcome "..." once to write one`,
    );
  }

  const scope: Scope = {
    repository_id: repositoryId(repositoryRoot),
    paths_allowed: resolved.paths,
    paths_prohibited: [...new Set([...resolved.prohibited, ...prohibitedSpecPaths(dir)])],
    generated_paths: args.generated,
    expansion_budget_files: args.expansionBudget,
  };
  const level = chooseLevel(scope, args.level);
  // Pinned to the tree the re-draft actually read, not to the one the first
  // draft was captured against: the drafter opened this checkout's files.
  const base_commit = headCommit(repositoryRoot);
  const contract = assembleContract({
    identity: { plan_id: before.plan_id, version: before.version + 1, ticket_id: before.ticket_id },
    level,
    outcome: resolved.outcome,
    criteria: resolved.criteria,
    scope,
    nodes: resolved.nodes,
    base: {
      base_commit,
      context_manifest_hash: contextManifestHash({ base_commit, ...scope }),
      captured_at: now.toISOString(),
    },
  });
  assertRequirementsCarried(contract, resolved.requirementIds, resolved.spec?.path ?? null);

  const snapshot: DraftSnapshot = {
    ...draft.snapshot,
    contract,
    criteria_source: resolved.criteriaSource,
    edits: [
      // Every edit still in force was made to a contract that no longer
      // exists, so it stops counting and stops being undoable — the log keeps
      // it, and says why.
      ...draft.snapshot.edits.map((edit) => ({ ...edit, replaced: true })),
      {
        at: now.toISOString(),
        changes: [],
        author: "you" as const,
        summary: `re-drafted from the spec (plan version ${contract.version})`,
        keys: [],
        before: {},
        after: {},
        undone: false,
        replaced: false,
        undoes: null,
      },
    ],
    draft:
      resolved.drafted && resolved.issue
        ? {
            issue: {
              reference: resolved.issue.reference,
              url: resolved.issue.url ?? null,
              path: resolved.sourcePath,
              title: resolved.issue.title,
            },
            proposed: resolved.drafted.draft,
            model: resolved.drafted.model,
            unknown_roots: resolved.drafted.unknown_roots,
            issue_authored_attempts: resolved.drafted.issue_authored_attempts,
            issue_authored_attempts_found: resolved.drafted.issue_authored_attempts_found,
            files_read: resolved.drafted.files_read,
          }
        : draft.snapshot.draft,
  };

  // The node pages are written last, so what they need is checked first: a
  // spec folder, nodes folder or page that is a link refuses the re-draft
  // with the ticket, its contract and its snapshot as they were.
  assertPagesWritable(repositoryRoot, resolved, contract);
  writeContract(dir, ticket, contract);
  writeDraftSnapshot(dir, snapshot);
  const approach: ApproachRecord | null =
    resolved.nodes.length > 0 || resolved.noGos.length > 0
      ? {
          schema_version: APPROACH_SCHEMA_VERSION,
          ticket_id: contract.ticket_id,
          plan_id: contract.plan_id,
          edges: resolved.edges,
          no_gos: resolved.noGos,
        }
      : null;
  if (approach) writeApproachRecord(dir, key, approach);
  else deleteApproachRecord(dir, key);

  const updated: Ticket = TicketSchema.parse({
    ...ticket,
    title: contract.outcome,
    plan_version: contract.version,
    updated_at: now.toISOString(),
    admission: {
      ...ticket.admission,
      elapsed_ms: Date.now() - started,
      criteria_source: resolved.criteriaSource,
      criteria_count: resolved.criteria.length,
      drafted_at: now.toISOString(),
      spec: resolved.spec,
      // The person's clock and their edits both start again: this is a plan
      // they have not read yet.
      human_elapsed_ms: null,
      edit_count: recordedEdits(snapshot).count,
      counter_sealed_at: now.toISOString(),
      level_source: level.source,
      derived_level: level.derivation.level,
    },
    history: [
      ...ticket.history,
      {
        at: now.toISOString(),
        from: ticket.state,
        to: ticket.state,
        note: `re-drafted from ${resolved.spec?.path ?? resolved.sourcePath ?? "its spec"}, plan version ${contract.version}`,
      },
    ],
  });
  const pages = regenerateNodePages({ repositoryRoot, ticket: updated, contract });
  const path = writeTicket(dir, withSpecFiles({ dir, repositoryRoot, ticket: updated }));

  return {
    kind: "re-drafted",
    key,
    ticket: updated,
    contract,
    approach,
    draft: snapshot.draft,
    level,
    resolved,
    storedAt: relative(input.cwd, path),
    pages: (pages?.written ?? []).map((page) => relative(repositoryRoot, page).split(sep).join("/")),
    scopeProposed: resolved.drafted !== null && args.paths.length === 0,
  };
}

/** The human rendering: outcome, criteria, scope and level, then the next step. */
function renderAdmitted(report: AdmissionReport): string {
  const { key, ticket, contract, level, resolved } = report;
  const drafted = resolved.drafted;
  const criteria = resolved.criteria
    .map(
      (criterion) =>
        `    ${criterion.id}  ${criterion.text}\n` +
        `          proven by (${criterion.expected_verification.kind}): ` +
        `${criterion.expected_verification.assertion}\n`,
    )
    .join("");
  const levelLine =
    `${contract.level} ` +
    (level.source === "raised"
      ? `(raised from ${level.derivation.level}: ${level.derivation.reasons.join("; ")})`
      : `(derived: ${level.derivation.reasons.join("; ")})`);
  const unknown =
    drafted && drafted.unknown_roots.length > 0
      ? `\n            not in the tree today: ${drafted.unknown_roots.join(", ")}`
      : "";
  // Printed whether the model mentioned them or not: the issue is external
  // text, and what it tried on the drafter is something the person approving
  // reads before they decide, not after.
  //
  // The headline number is what the text held, not what this listed. They part
  // company when a body carries more attempts than the listing takes, and that
  // body — one written to bury the report in its own noise — is precisely the
  // one where a number that quietly meant "twenty, or more" would mislead.
  const found = drafted?.issue_authored_attempts_found ?? 0;
  const listed = drafted?.issue_authored_attempts ?? [];
  const attempts =
    found > 0
      ? `  flagged   ${found} issue-authored attempt${found === 1 ? "" : "s"} — read as data, ` +
        `not followed\n` +
        listed
          .map(
            (attempt) =>
              `            line ${attempt.line} ${attempt.kind}: ${attempt.what}\n` +
              `              "${attempt.quote}"\n`,
          )
          .join("") +
        (found > listed.length
          ? `            and ${found - listed.length} more, not listed: only the first ` +
            `${listed.length} are shown\n`
          : "")
      : "";
  const head = drafted
    ? `\ndrafted ${key} (${ticket.state}) from ` +
      `${resolved.sourcePath ?? resolved.issue?.reference} in ` +
      `${formatDuration(ticket.admission.elapsed_ms)} — ${drafted.model.provider} ` +
      `${drafted.model.model_id}, ` +
      `${costPhrase(costOf({ micros: drafted.model.cost_micros, basis: drafted.model.cost_basis }))}\n`
    : `\nadmitted ${key} (${ticket.state}) in ${formatDuration(ticket.admission.elapsed_ms)}\n`;
  const next = ticket.approved_at
    ? `\nApproved. The contract is immutable from here.\n  perbo run --ticket ${key}\n`
    : drafted
      ? `\nThe model drafted this; nothing runs until you approve it. Edit anything, then approve:\n` +
        `  perbo edit ${key}\n  perbo approve ${key}\n`
      : `\nRead the contract, then approve it:\n  perbo edit ${key}\n  perbo approve ${key}\n`;
  // The graph as recorded: each node with the criteria it covers and the paths
  // it lands in, then the order and the No-Gos, which are approach and live in
  // their own file. `perbo inspect` says the same with the size beside it.
  const graph =
    resolved.nodes.length > 0
      ? `  graph\n` +
        resolved.nodes
          .map(
            (node) =>
              `    ${node.id}  ${node.title}\n` +
              `          criteria: ${node.criteria.join(", ")}\n` +
              `          paths:    ${node.paths.join(", ")}\n`,
          )
          .join("") +
        (report.approach !== null && report.approach.edges.length > 0
          ? `    order     ${report.approach.edges
              .map((edge) => `${edge.from} -> ${edge.to}`)
              .join(", ")}  (approach: it may change during execution)\n`
          : "")
      : "";
  const noGos =
    report.approach !== null && report.approach.no_gos.length > 0
      ? `  no-gos    from the spec, kept out of the contract\n` +
        report.approach.no_gos.map((noGo) => `            ${noGo}\n`).join("")
      : "";
  return (
    head +
    `  contract  ${contract.plan_id} v1, ${levelLine}, ${resolved.criteria.length} criteria\n` +
    `  base      ${contract.base.base_commit.slice(0, 12)}\n` +
    `  outcome   ${contract.outcome}\n` +
    `  criteria\n${criteria}` +
    `  scope     ${contract.scope.paths_allowed.join(", ")}` +
    (report.scopeProposed ? "  (proposed by the model)" : "") +
    unknown +
    "\n" +
    (ticket.depends_on.length > 0 ? `  after     ${ticket.depends_on.join(", ")}\n` : "") +
    graph +
    noGos +
    (drafted ? `  rationale ${drafted.draft.rationale}\n` : "") +
    attempts +
    `  stored    ${report.storedAt}` +
    (drafted ? " (draft beside it)\n" : "\n") +
    next +
    "\nAdmitting takes ownership of this one piece of work. Nothing else moved.\n"
  );
}

/** The re-draft's rendering: what changed, where the pages went, and the next step. */
function renderRedrafted(report: AdmissionReport): string {
  const { key, contract, resolved } = report;
  return (
    `${key} re-drafted from ${resolved.spec?.path ?? "its spec"}: plan version ${contract.version}, ` +
    `${resolved.criteria.length} criteria, ${resolved.nodes.length} node` +
    `${resolved.nodes.length === 1 ? "" : "s"}\n` +
    `  The graph edits made to the last version are dropped and kept in the log, marked replaced.\n` +
    report.pages.map((page) => `  ${page}\n`).join("") +
    `\nRead it once more, then approve it:\n  perbo approve ${key}\n`
  );
}

/** The spec's own pages, listed under the admission they were written for. */
const renderPages = (report: AdmissionReport): string =>
  report.pages.length === 0
    ? ""
    : `\n  spec      ${report.resolved.spec?.path ?? "spec.md"}\n` +
      report.pages.map((page) => `            ${page}\n`).join("");

/**
 * Admitting one piece of work, as the record of it and as what a person reads.
 *
 * Reached by the terminal through its line below, and by a caller in this
 * process — the queue, the endpoint, the interview — through
 * {@link admitDraft}, over the same typed input.
 */
export const admitReport: CommandReport<
  AdmissionInput,
  { json: boolean },
  AdmissionReport,
  AdmitDeps
> = {
  run: admit,
  toJson: (report) => ({
    ticket: report.ticket,
    contract: report.contract,
    approach: report.approach,
    draft: report.draft,
  }),
  render(report, _output, target): Rendered {
    if (target.json) {
      return {
        stdout: `${JSON.stringify(admitReport.toJson!(report), null, 2)}\n`,
        stderr: "",
        exitCode: EXIT_CODES.approve,
      };
    }
    return {
      stdout: `${report.key}  ${report.ticket.title}\n`,
      stderr:
        report.kind === "admitted"
          ? renderAdmitted(report) + renderPages(report)
          : renderRedrafted(report),
      exitCode: EXIT_CODES.approve,
    };
  },
};

/**
 * Admitting a draft, as a caller in this process reaches it: the same run and
 * the same rendering over input that has no `approve` to set.
 */
export const admitDraftReport: CommandReport<
  DraftAdmission,
  { json: boolean },
  AdmissionReport,
  AdmitDeps
> = { ...admitReport, run: admitDraft };

export const admitCommandLine: ReportCommand<
  AdmissionInput,
  { json: boolean },
  AdmissionReport,
  AdmitDeps
> = {
  kind: "report",
  name: "admit",
  grammars: [ADMIT_GRAMMAR],
  jsonWhenPiped: false,
  grammarFor: () => ADMIT_GRAMMAR,
  read: readAdmission,
  ...admitReport,
};

/**
 * What `perbo edit` recorded the **person** changing, across every edit,
 * deduplicated.
 *
 * The fields a person had to touch, not the number of times they touched them:
 * two passes over the outcome is one field the rendering got wrong, and
 * counting it twice would make the friction instrument (D-003) a measure of how
 * often the command was run. For a ticket edited once — every ticket in the
 * record so far — this is the number `approve` used to compute by diffing the
 * two files, from the same `contractEditCount` and in the same words.
 *
 * An edit the interview applied is left out (D-100). The instrument asks how
 * much of the drafted contract a person had to correct by hand; a change their
 * agent session made on their behalf answers a different question, and folding
 * the two together would make a rising count unreadable.
 */
export function recordedEdits(snapshot: DraftSnapshot): { count: number; changes: string[] } {
  const changes = [
    ...new Set(
      snapshot.edits
        // An edit the re-draft replaced changed a contract that no longer
        // exists (D-103): counting it would say a person corrected the draft
        // they are looking at, which they have not.
        .filter((edit) => edit.author === "you" && !edit.replaced)
        .flatMap((edit) => edit.changes),
    ),
  ];
  return { count: changes.length, changes };
}

/**
 * What approving asks for: which store, and which ticket in it.
 *
 * `--json` is not part of it. The desktop passes the flag and this command has
 * no JSON form; taking it as input would say it had one.
 */
export const ApprovalInputSchema = z.strictObject({
  target: StoreTargetSchema,
  key: z.string().min(1, "approve requires a ticket key, e.g. PRB-1"),
});
export type ApprovalInput = z.infer<typeof ApprovalInputSchema>;

export function approve(input: ApprovalInput, context: CommandContext): number {
  const now = context.now;
  const { key } = input;
  const dir = storeFor(context.cwd, input.target);

  const existing = readTicket(dir, key);
  if (existing.approved_at !== null) {
    context.diagnostics.stderr(`${key} was already approved at ${existing.approved_at}\n`);
    return EXIT_CODES.approve;
  }
  const contract = readContract(dir, key);
  assertContractMatches(existing, contract);
  const draft = readDraftSnapshotFile(dir, key);
  // Before the scope is judged and before anything is written: a pair of files
  // that disagree is a contract with no agreed content to judge.
  assertContractSealed(existing, contract, draft);
  assertApprovable(contract, key, readJudgingPaths(dir));

  // D-003's instrument, written here because this is the moment it ends: the
  // person's time from first seeing the contract, and how much of it they
  // changed before signing it.
  //
  // For a counter-sealed ticket the edits are the ones `perbo edit` recorded as
  // it applied them: with the two contracts held in step by the check above, a
  // difference between the files is never one of them and is never reported as
  // one. For a ticket with no counter-seal the difference is all there is, and
  // it is what the version that wrote that store measured — the two numbers
  // agree for every ticket either version could produce.
  const snapshot = draft.kind === "snapshot" ? draft.snapshot : null;
  const edits = snapshot
    ? existing.admission.counter_sealed_at === null
      ? contractEditCount(snapshot.contract, contract)
      : recordedEdits(snapshot)
    : null;
  const human_elapsed_ms = Math.max(0, now.getTime() - Date.parse(existing.admitted_at));
  const moved = transition(existing, "ready", "contract approved", now);
  // D-103's baseline beside D-003's instrument: the names this repository has
  // as the plan is signed against it, which is what a later reading measures a
  // stale spec by.
  const approved = withNamesThatResolved({
    dir,
    ticket: TicketSchema.parse({
      ...moved,
      approved_at: now.toISOString(),
      admission: {
        ...moved.admission,
        human_elapsed_ms,
        edit_count: edits ? edits.count : null,
      },
    }),
  });
  writeTicket(dir, approved);
  context.diagnostics.stderr(
    `${key} approved. ${contract.plan_id} v${contract.version} is immutable from here.\n` +
      `  ${formatHumanElapsed(human_elapsed_ms)} from first rendering to approval, ` +
      (edits
        ? `${edits.count} edit${edits.count === 1 ? "" : "s"}` +
          (edits.count > 0 ? ` (${edits.changes.join(", ")})` : "")
        : "edits unknown (no draft snapshot)") +
      `\n  perbo run --ticket ${key}\n`,
  );
  return EXIT_CODES.approve;
}

const STATE_WIDTH = 19;

/** Said on stderr in both modes: a pipe reading stdout never sees it. */
const EMPTY_STORE_HINT =
  "\nAdmit the thing you are about to do. Your backlog stays where it is.\n" +
  '  perbo admit --outcome "..." --criterion "... :: ..." --path "src/**"\n';

/** Bumped when a field of the document below changes meaning or leaves it. */
export const LIST_JSON_SCHEMA_VERSION = 1;

/**
 * What `perbo list --json` writes, and the whole of what it writes.
 *
 * The shape is stated in [docs/design/list-json.md](../../../../docs/design/list-json.md)
 * and parsed here on the way out, so the document and the emitted bytes cannot
 * drift apart without one of them failing.
 *
 * **An object, not the bare array this used to print.** A bare array leaves a
 * script no room to be told anything about the listing it is holding — which
 * store it came from, whether `--all` was in force, how many tickets the filter
 * hid — and every one of those is a fact a caller otherwise has to guess from
 * the argv it passed. Adding them later to an array would have meant changing
 * the top-level type, which is the one change no consumer survives.
 *
 * **A ticket entry is the stored ticket, verbatim.** Not a projection of the
 * five columns the table draws: the table is a rendering for a person at 80
 * columns and a script is not reading at 80 columns. Verbatim also means there
 * is no second field list to keep in step with `TicketSchema`, and no way for
 * the two renderings to disagree about a ticket (decisions 3 and 4 in
 * docs/design/list-json.md). `state` is the stored lifecycle state, the
 * same string the `STATE` column prints, and `history` is every transition the
 * ticket has recorded, in order and uncollapsed.
 */
export const ListJsonSchema = z.strictObject({
  schema_version: z.literal(LIST_JSON_SCHEMA_VERSION),
  /** The store the listing was read from, absolute. */
  store: z.string().min(1),
  /** The filter this listing was taken under, so a caller need not infer it. */
  filter: z.strictObject({ all: z.boolean() }),
  /** `shown` is `tickets.length`; `total` is the store before the filter. */
  counts: z.strictObject({
    shown: z.number().int().min(0),
    total: z.number().int().min(0),
  }),
  /** Every ticket the table would print, in the order it would print them. */
  tickets: z.array(TicketSchema),
});
export type ListJson = z.infer<typeof ListJsonSchema>;

/** The document for one listing, parsed rather than assembled and trusted. */
export function listJson(input: {
  store: string;
  all: boolean;
  shown: readonly Ticket[];
  total: number;
}): ListJson {
  return ListJsonSchema.parse({
    schema_version: LIST_JSON_SCHEMA_VERSION,
    store: input.store,
    filter: { all: input.all },
    counts: { shown: input.shown.length, total: input.total },
    tickets: input.shown,
  });
}

/**
 * What one listing read: the store it came from, the filter it was taken
 * under, and the tickets.
 *
 * The document is the report, built once: the table a person reads and the
 * record `--json` prints are two renderings of one listing rather than two
 * listings that have to agree.
 */
export interface ListReport {
  readonly document: ListJson;
}

export const ListInputSchema = z.strictObject({
  target: StoreTargetSchema,
  /** Settled tickets too, rather than the active ones alone. */
  all: z.boolean(),
});
export type ListInput = z.infer<typeof ListInputSchema>;

export function list(input: ListInput, context: CommandContext): ListReport {
  const dir = storeFor(context.cwd, input.target);
  const all = listTickets(dir);
  return {
    document: listJson({
      store: dir,
      all: input.all,
      shown: input.all ? all : all.filter(isActive),
      total: all.length,
    }),
  };
}

/** The listing as a person reads it: two lines a ticket, at a fixed width. */
function renderListing(document: ListJson): string {
  const rows = document.tickets.map((ticket) => ({
    key: ticket.key,
    state: ticket.state,
    title: ticket.title,
    // Kind and all: an absolute path and a Jira key are both "a string in the
    // source column" and a person should not have to tell them apart by eye.
    source: ticketSourceLabel(ticket.source) ?? "—",
    priority: ticket.priority,
    // Why a blocked ticket waits, and a re-level that did not level an open
    // branch, from the queue's own record — the one line a person needs
    // before they go looking for the ticket ahead.
    waits: describeScheduling(ticket.scheduling, ticket.state),
  }));
  const keyWidth = Math.max(6, ...rows.map((row) => row.key.length));
  return (
    `${"TICKET".padEnd(keyWidth)}  ${"STATE".padEnd(STATE_WIDTH)}  OUTCOME\n` +
    rows
      .map(
        (row) =>
          `${row.key.padEnd(keyWidth)}  ${row.state.padEnd(STATE_WIDTH)}  ${row.title}\n` +
          `${" ".repeat(keyWidth)}  ${" ".repeat(STATE_WIDTH)}  ${row.priority}${
            row.source === "—" ? "" : ` · ${row.source}`
          }${row.waits === null ? "" : ` · ${row.waits}`}\n`,
      )
      .join("")
  );
}

const LIST_FLAGS = {
  "--repo": valueFlag(),
  "--store": valueFlag(),
  "--all": switchFlag(),
  "--json": switchFlag(),
} satisfies FlagTable;

const LIST_GRAMMAR: Grammar<typeof LIST_FLAGS> = {
  command: "list",
  flags: LIST_FLAGS,
  positionals: {
    min: 0,
    max: 0,
    refusal: "list takes no ticket key: it prints the admitted work, e.g. perbo list --all",
  },
  afterDoubleDash: "positionals",
};

/**
 * Every admitted ticket, as the listing's record and as the table a person reads.
 *
 * Reached by the terminal through its line below, and by a caller in this
 * process — the queue's endpoint — over the same typed input.
 */
export const listReport: CommandReport<ListInput, { json: boolean }, ListReport> = {
  run: list,
  toJson: (report) => report.document,
  render(report, _output, target): Rendered {
    const { counts, filter } = report.document;
    // Before every other branch, including the empty-store one: in this mode
    // stdout carries one JSON document and nothing else, and an empty store is
    // a listing of no tickets rather than an occasion for advice. The advice is
    // still worth giving, so it goes to stderr where a pipe does not see it.
    if (target.json) {
      return {
        stdout: `${JSON.stringify(report.document, null, 2)}\n`,
        stderr: counts.total === 0 ? EMPTY_STORE_HINT : "",
        exitCode: EXIT_CODES.approve,
      };
    }
    if (counts.total === 0) {
      return {
        stdout: "No admitted work.\n",
        stderr: EMPTY_STORE_HINT,
        exitCode: EXIT_CODES.approve,
      };
    }
    return {
      stdout: renderListing(report.document),
      stderr: `\n${counts.shown} of ${counts.total} shown${
        filter.all ? "" : " (active only; --all for the rest)"
      }\n`,
      exitCode: EXIT_CODES.approve,
    };
  },
};

export const listCommandLine: ReportCommand<ListInput, { json: boolean }, ListReport> = {
  kind: "report",
  name: "list",
  grammars: [LIST_GRAMMAR],
  jsonWhenPiped: false,
  grammarFor: () => LIST_GRAMMAR,
  read(argv) {
    const line = parseArgv(LIST_GRAMMAR, argv);
    return {
      input: readInput(ListInputSchema, {
        target: { repo: line.flags["--repo"] ?? ".", store: line.flags["--store"] ?? null },
        all: line.flags["--all"] === true,
      }),
      output: { json: line.flags["--json"] === true },
    };
  },
  ...listReport,
};

const APPROVE_FLAGS = {
  "--repo": valueFlag(),
  "--store": valueFlag(),
  // Accepted because the desktop passes it on every approval. Approving
  // writes no record to stdout, so it selects nothing.
  "--json": switchFlag(),
} satisfies FlagTable;

const APPROVE_GRAMMAR: Grammar<typeof APPROVE_FLAGS> = {
  command: "approve",
  flags: APPROVE_FLAGS,
  positionals: { min: 1, max: 1, refusal: "approve requires a ticket key, e.g. PRB-1" },
  afterDoubleDash: "positionals",
};

export const approveCommandLine: NarratedCommand<ApprovalInput, { json: boolean }> = {
  kind: "narrated",
  name: "approve",
  grammars: [APPROVE_GRAMMAR],
  grammarFor: () => APPROVE_GRAMMAR,
  read(argv) {
    const line = parseArgv(APPROVE_GRAMMAR, argv);
    return {
      input: readInput(ApprovalInputSchema, {
        target: { repo: line.flags["--repo"] ?? ".", store: line.flags["--store"] ?? null },
        key: line.positionals[0],
      }),
      output: { json: line.flags["--json"] === true },
    };
  },
  run: (input, _output, context) => approve(input, context),
};

export { TicketStoreError };

/** The results that judged a round: those a node did not run (D-107). */
const wholeChange = (checks: readonly unknown[]): readonly unknown[] =>
  checks.filter(
    (check) => !(typeof check === "object" && check !== null && "node" in check && check.node !== undefined),
  );

/**
 * The states a completed run passed through, derived from what the result
 * proves rather than from progress prose.
 *
 * Each step is claimed only where the structured record shows it happened: a
 * workspace exists, an attempt was recorded, checks ran, a review was produced.
 * Parsing the progress lines would have been easier and would have made a
 * ticket's history a function of log wording.
 */
export function statesObserved(result: {
  rounds: ReadonlyArray<{ checks: readonly unknown[]; review: unknown }>;
  outcome: string;
}): Array<{ to: Parameters<typeof transition>[1]; note: string }> {
  const path: Array<{ to: Parameters<typeof transition>[1]; note: string }> = [
    { to: "provisioning", note: "worktree provisioned and materialized" },
  ];
  const last = result.rounds[result.rounds.length - 1];
  if (result.rounds.length > 0) {
    path.push({
      to: "executing",
      note: `${result.rounds.length} attempt${result.rounds.length === 1 ? "" : "s"} executed`,
    });
    // The verification stage is claimed whenever an attempt ran, including when
    // it had nothing to run. Zero checks is a fact about the repository's
    // configuration, not a stage that was skipped — and gating this on
    // `checks.length > 0` stranded the ticket in `executing` on any repository
    // with no pinned checks, because `executing -> independent_review` has no
    // row and the walk below then had nowhere legal to go.
    path.push({
      to: "verifying",
      note:
        last && wholeChange(last.checks).length > 0
          ? `${wholeChange(last.checks).length} deterministic checks ran`
          : "no deterministic checks are configured for this repository",
    });
  }
  // Round 0 carries the one independent review; a remediation round carries a
  // verification of that review's findings, not a second review (D-061). So
  // the stage is claimed when any round was reviewed, or a ticket that was
  // approved after remediation has no legal path to pr_open and strands.
  if (result.rounds.some((round) => round.review)) {
    path.push({ to: "independent_review", note: "reviewed independently" });
  }

  switch (result.outcome) {
    case "approved":
      path.push({ to: "pr_open", note: "approved; a human merges it" });
      break;
    // SCP-194: `remediation_stalled` joins these three. A round closed none of
    // the findings it was given; the change set is on the branch and the open
    // findings are named, so a person picks it up from the state a
    // `changes_requested` ticket is already in.
    case "changes_requested":
    case "escalated":
    case "remediation_exhausted":
    case "remediation_stalled":
      path.push({ to: "changes_requested", note: `the gate closed: ${result.outcome}` });
      break;
    default:
      path.push({
        to: "failed",
        note:
          result.outcome === "review_failed"
            ? "the review did not complete: the provider failed, or every verdict it returned " +
              "was one the plan could not accept — not the change (retry)"
            : result.outcome === "base_conflict"
              ? "the branch cannot reach the base it would be merged into and the round given " +
                "the conflict did not resolve it — not the change (a re-run merges " +
                "the base up again)"
              : `the attempt did not complete: ${result.outcome}`,
      });
  }
  return path;
}

/**
 * The refusal `applyObservedPath` raises when the evidence points at a state the
 * transition table cannot reach from where the walk ended.
 *
 * A distinct type rather than a bare `Error` because a caller has to tell it
 * from a corrupt ticket: the refusal is a fact about the evidence and is worth
 * printing as a reason, while a ticket that no longer validates is a fault. Both
 * abort the write; only one of them is something a person can act on.
 */
export class UnreachableStateError extends Error {
  readonly from: Ticket["state"];
  readonly to: Ticket["state"];

  constructor(from: Ticket["state"], to: Ticket["state"]) {
    // Wording preserved from the bare `Error` this replaced: a message that
    // drifts from the record of the run that produced it is the contradiction
    // class this repository treats as a defect.
    super(
      `the run ended ${to} and the ticket is ${from}, which has no row to it. ` +
        "Refusing rather than inventing the states in between: a fabricated history is worse than " +
        "an unrecorded one",
    );
    this.name = "UnreachableStateError";
    this.from = from;
    this.to = to;
  }
}

/**
 * Walk a ticket along an observed path, skipping any step the state machine has
 * no row for. A run that terminated before executing has no `executing` step to
 * record, and inventing one to keep the walk tidy would be a lie in the history.
 *
 * **The terminal step is not optional.** Skipping an intermediate stage is
 * honest — it did not happen. Skipping the last one leaves the ticket claiming
 * a state the run has already left, which is how a completed run ended with a
 * ticket saying `executing` and a pull request open. If the observed path
 * cannot reach the terminal state, the ticket is moved there through whatever
 * legal route exists and the detour is written into the history rather than
 * hidden.
 */
export function applyObservedPath(
  ticket: Ticket,
  path: ReadonlyArray<{ to: Parameters<typeof transition>[1]; note: string }>,
  at: Date,
): Ticket {
  let current = ticket;
  for (const step of path) {
    try {
      current = transition(current, step.to, step.note, at);
    } catch (error) {
      // A missing row is expected. Anything else — a ticket that no longer
      // validates — is a real failure and must not be swallowed as one.
      if (!(error instanceof IllegalTransitionError)) throw error;
    }
  }

  const terminal = path[path.length - 1];
  if (!terminal || current.state === terminal.to) return current;

  // The terminal state could not be reached from where the observed steps left
  // the ticket. **This is refused rather than routed around.** Walking the
  // ticket through intermediate states it was never in would write a history
  // that reads as observation, which is the failure this function's own comment
  // warns about — and it is worse than a loud stop, because a wrong history
  // outlives the run that produced it.
  throw new UnreachableStateError(current.state, terminal.to);
}

/** Load an admitted ticket and its contract, for `perbo run --ticket`. */
export function loadAdmitted(
  cwd: string,
  repo: string,
  store: string | null,
  key: string,
): { dir: string; ticket: Ticket; contract: PlanContract } {
  const dir = storeDir(resolve(cwd, repo), store);
  const ticket = readTicket(dir, key);
  if (ticket.approved_at === null) {
    throw new UsageError(
      `${key} is ${ticket.state}: its contract has not been approved, and execution binds to an ` +
        `approved contract. Read it, then: perbo approve ${key}`,
    );
  }
  const contract = readContract(dir, key);
  assertContractMatches(ticket, contract);
  // The counter-seal again, at the other end: approval checked the pair, and
  // nothing rewrites either file afterwards, so a contract that has drifted
  // from it since has drifted after somebody signed it. This is the moment it
  // matters most — the attempt binds to this contract and review judges the
  // work against it — and it is the moment no person is looking.
  assertContractSealed(ticket, contract, readDraftSnapshotFile(dir, key));
  return { dir, ticket, contract };
}

export { readTicket, storeDir, writeTicket };
