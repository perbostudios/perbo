import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  CLOSURE_AUTHORITIES,
  CostBasisSchema,
  FINDING_ROUTINGS,
  ReviewDecisionSchema,
  costOf,
  parseUnifiedDiff,
  rollCosts,
} from "@perbo/contracts";
import type { Cost, Ticket } from "@perbo/contracts";
import { assembleLiveGraph } from "../shared/graph-live.js";
import type { LiveCheck, LiveNodeInput, LiveReview } from "../shared/graph-live.js";
import type {
  GraphEditView,
  GraphLiveView,
  InterviewEdit,
  TaskSummary,
  UsageLedger,
} from "../shared/protocol.js";

/**
 * Reads of the CLI's own records that the desktop makes directly: the attempts
 * record the loop appends to and the bundle manifests it seals. Only the fields
 * a card, a row or the ledger needs are named; a record written by a later
 * version still parses.
 */
export const StoredAttemptSchema = z.looseObject({
  attempt_id: z.string().min(1),
  branch: z.string().min(1).optional(),
  created_at: z.string().optional(),
  /** Absent, or null, where the attempt sealed no change set at all. */
  changeset_id: z.string().min(1).nullable().optional(),
  usage: z
    .looseObject({
      cost_micros: z.number().int().min(0).optional(),
      cost_basis: z.string().optional(),
      wall_clock_ms: z.number().int().min(0).optional(),
    })
    .optional(),
  termination: z.looseObject({ reason: z.string() }).optional(),
});
export type StoredAttempt = z.infer<typeof StoredAttemptSchema>;
const AttemptsRecordSchema = z.looseObject({
  ticket_id: z.string().min(1),
  attempts: z.array(StoredAttemptSchema),
});
const BundleManifestSchema = z.looseObject({
  bundle_id: z.string().min(1),
  kind: z.string(),
  created_at: z.string().optional(),
  /**
   * What the bundle was made from. A closure verification's manifest carries
   * `findings_closed`, which the loop writes as the finding keys whose row
   * came back `closed`, comma-separated (`loop.ts`, the `cv_` bundle).
   */
  inputs: z.looseObject({ findings_closed: z.string().optional() }).optional(),
  subject_id: z.string(),
  ticket_id: z.string(),
  artifacts: z
    .array(
      z.looseObject({
        name: z.string(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        bytes: z.number().int().min(0),
        retained: z.boolean(),
      }),
    )
    .default([]),
});
export type BundleManifest = z.infer<typeof BundleManifestSchema>;

/**
 * An attempt the runner stopped rather than one that finished (D-096).
 *
 * `stalled` is the only one of these a run has by default — no tool activity
 * for the stall window — and the rest happen where a repository set a ceiling
 * or where the executor is billed per token.
 */
const EARLY_STOP_REASONS = new Set([
  "stalled",
  "wall_clock_exceeded",
  "command_ceiling_exceeded",
  "iteration_ceiling_exceeded",
  "round_iteration_ceiling_exceeded",
  "token_ceiling_exceeded",
  "cost_ceiling_exceeded",
]);
export const isEarlyStop = (reason: string | undefined): boolean =>
  reason !== undefined && EARLY_STOP_REASONS.has(reason);
/** A record can name a basis this version cannot price, and an unpriced one is counted. */
const BASIS = CostBasisSchema.catch("unavailable");
/**
 * What one attempt cost. A record carrying no figure at all, and one naming a
 * basis this version cannot price, are both unpriced: `unavailable` and
 * `not_incurred` are not zero dollars.
 */
const attemptCost = (attempt: StoredAttempt): Cost =>
  costOf({
    micros: attempt.usage?.cost_micros ?? 0,
    basis:
      attempt.usage?.cost_micros === undefined
        ? "unavailable"
        : BASIS.parse(attempt.usage.cost_basis ?? "transport_reported"),
  });

export function readAttempts(path: string): {
  attempts: StoredAttempt[];
  error: string | null;
} {
  if (!existsSync(path)) return { attempts: [], error: null };
  try {
    const parsed = AttemptsRecordSchema.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    return parsed.success
      ? { attempts: parsed.data.attempts, error: null }
      : { attempts: [], error: "The attempts record could not be read." };
  } catch {
    return { attempts: [], error: "The attempts record could not be read." };
  }
}

/**
 * The edits `<KEY>.draft.json` records, as the Graph pane lists them (D-100).
 *
 * Loose like the attempts record above and for the same reason: the snapshot is
 * `perbo edit`'s file and outlives the desktop version reading it, and an edit
 * written before summaries existed still has to list. Its number is its place
 * in the array, one upward, because that is what `--undo` takes.
 */
const AppliedEditSchema = z.looseObject({
  at: z.string().min(1),
  author: z.enum(["you", "interview"]).default("you"),
  summary: z.string().min(1).nullable().default(null),
  changes: z.array(z.string()).default([]),
  undone: z.boolean().default(false),
  replaced: z.boolean().default(false),
  undoes: z.number().int().positive().nullable().default(null),
  /** The entity keys it changed either side: `node:<id>`, `criterion:<id>`, `edge:<from>-><to>`. */
  before: z.record(z.string(), z.unknown()).default({}),
  after: z.record(z.string(), z.unknown()).default({}),
});
const DraftSnapshotSchema = z.looseObject({ edits: z.array(AppliedEditSchema).default([]) });

/**
 * The same records, for a reader to whom they are advice rather than evidence.
 *
 * A draft record that cannot be read is worth refusing an edit over — it is
 * what says who changed the plan. It is not worth refusing to show the
 * contract over: the page that approves would fail to load entirely, and
 * Approve would be unreachable rather than merely unadvised.
 */
export function readDraftEditRecordsOrNone(path: string): z.infer<typeof AppliedEditSchema>[] {
  try {
    return readDraftEditRecords(path);
  } catch {
    return [];
  }
}

function readDraftEditRecords(path: string): z.infer<typeof AppliedEditSchema>[] {
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    raw = undefined;
  }
  const parsed = DraftSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      "This ticket's draft record could not be read, and it is what says who changed the plan. Restore it from version control.",
    );
  }
  return parsed.data.edits;
}

/** Every edit, as the Graph pane and the plan's history list them. */
export function readDraftEdits(path: string): GraphEditView[] {
  return readDraftEditRecords(path).map((edit, index) => ({
    n: index + 1,
    at: edit.at,
    author: edit.author,
    // A flag edit carries no summary, only the fields it replaced.
    summary: edit.summary ?? (edit.changes.length > 0 ? edit.changes.join(", ") : "an edit"),
    undone: edit.undone,
    replaced: edit.replaced,
    undoes: edit.undoes,
  }));
}

/**
 * The last edit `<KEY>.draft.json` records with `by` as its author, or null
 * where it records none.
 *
 * What the chat's card for an `edit_plan` or an `undo_edit` is drawn from: the
 * edit the command wrote down, rather than the session's own account of what
 * it did ([ADR-0023](../../../../docs/adr/0023-untrusted-context-boundary.md)).
 * An undo is itself an edit, and names the one it reversed.
 *
 * The author is what links the record to the card, because the last edit of
 * all is not always the interview's: the Graph pane edits the same plan
 * through the same path, and one made there while the interview was working
 * lands after it.
 */
export function readLatestDraftEdit(path: string, by: InterviewEdit["author"]): InterviewEdit | null {
  const edits = readDraftEditRecords(path);
  const at = edits.findLastIndex((edit) => edit.author === by);
  const last = edits[at];
  if (!last) return null;
  const summary = last.summary ?? (last.changes.length > 0 ? last.changes.join(", ") : "an edit");
  return {
    n: at + 1,
    author: last.author,
    // Clipped to what a conversation line holds. `perbo edit` caps none of
    // these — a `set_node_paths` summary carries every glob it was given — and
    // a line the record rejects is one the chat never draws.
    summary: summary.slice(0, 300),
    undone: last.undone,
    undoes: last.undoes,
    before: entityKeys(last.before),
    after: entityKeys(last.after),
  };
}

/** The entity keys of one side of an edit, clipped to what the line holds. */
const entityKeys = (side: Record<string, unknown>): string[] =>
  Object.keys(side)
    .filter((key) => key.length > 0)
    .slice(0, 200)
    .map((key) => key.slice(0, 200));

/**
 * The bundle manifests in a directory, each carrying the name of the file it
 * was read from.
 *
 * `file` is the name `readdirSync` gave, never the recorded `bundle_id`: a
 * manifest is repository content and its id is whatever the file says, so a
 * caller that wants the file back — deleting one with its ticket — would
 * otherwise rebuild a path out of content and reach whatever that content
 * names.
 */
export function listBundles(directory: string): Array<BundleManifest & { file: string }> {
  if (!existsSync(directory)) return [];
  const manifests: Array<BundleManifest & { file: string }> = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = BundleManifestSchema.safeParse(
        JSON.parse(readFileSync(join(directory, name), "utf8")),
      );
      if (parsed.success) manifests.push({ ...parsed.data, file: name });
    } catch {
      // A manifest that is not JSON is stepped over, as the CLI steps over it.
    }
  }
  return manifests;
}

/** One retained object, read only when it is a regular file of the recorded size and hash, and under the display limit. */
export function readObject(
  path: string,
  artifact: { name: string; sha256: string; bytes: number },
): { text: string; note: null } | { text: null; note: string } {
  if (!existsSync(path))
    return {
      text: null,
      note:
        artifact.name + " was recorded but its bytes are no longer available.",
    };
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 2_000_000)
      return {
        text: null,
        note:
          artifact.name +
          " exceeds the 2 MB desktop display limit or is not a regular file.",
      };
    const buffer = Buffer.alloc(stat.size + 1);
    const bytes = buffer.subarray(
      0,
      readSync(descriptor, buffer, 0, buffer.length, 0),
    );
    if (
      bytes.length !== artifact.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
    )
      return {
        text: null,
        note:
          artifact.name +
          " does not match its recorded content hash; it has not been displayed.",
      };
    return { text: bytes.toString("utf8"), note: null };
  } finally {
    closeSync(descriptor);
  }
}

const diffTotals = new Map<
  string,
  { files: number; additions: number; deletions: number }
>();
/** Totals of a sealed diff, cached by content hash: an object never changes under its hash. */
export function diffSummary(
  objectsDirectory: string,
  artifact: { name: string; sha256: string; bytes: number },
): {
  totals: { files: number; additions: number; deletions: number } | null;
  note: string | null;
} {
  const cached = diffTotals.get(artifact.sha256);
  if (cached) return { totals: cached, note: null };
  let read: ReturnType<typeof readObject>;
  try {
    read = readObject(join(objectsDirectory, artifact.sha256), artifact);
  } catch {
    return {
      totals: null,
      note: artifact.name + " could not be read from the bundle store.",
    };
  }
  if (read.text === null) return { totals: null, note: read.note };
  const files = parseUnifiedDiff(read.text);
  const totals = {
    files: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
  diffTotals.set(artifact.sha256, totals);
  return { totals, note: null };
}

/** The card's account of one ticket: its branch, what its attempts cost, and the latest sealed diff. */
export function summariseTicket(input: {
  ticket: Ticket;
  attempts: StoredAttempt[];
  attemptsError: string | null;
  bundles: BundleManifest[];
  objectsDirectory: string;
}): Omit<TaskSummary, "outcome"> {
  const { ticket, attempts, bundles } = input;
  const latest = attempts.at(-1);
  const cost = rollCosts(attempts.map(attemptCost));
  const notes: string[] = [];
  if (input.attemptsError) notes.push(input.attemptsError);
  let diff: TaskSummary["diff"] = null;
  if (latest) {
    const execution = bundles.find(
      (bundle) =>
        bundle.kind === "execution" &&
        bundle.subject_id === latest.attempt_id &&
        bundle.ticket_id === ticket.ticket_id,
    );
    const artifact = execution?.artifacts.find(
      (entry) => entry.name === "change.diff" && entry.retained,
    );
    if (artifact) {
      const summary = diffSummary(input.objectsDirectory, artifact);
      diff = summary.totals;
      if (summary.note) notes.push(summary.note);
    } else if (execution)
      notes.push("The latest attempt's diff was not retained.");
  }
  return {
    branch: ticket.delivery.branch ?? latest?.branch ?? null,
    attempts: attempts.length,
    latestAttemptAt: latest?.created_at ?? null,
    costMicros: cost.priced ? cost.micros : null,
    costBasis:
      cost.components === 0 ? "none" : cost.unavailable === 0 ? "priced" : "unpriced",
    diff,
    note: notes.length ? notes.join(" ") : null,
  };
}

const monthOf = (value: string | undefined): string | null => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return (
    date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0")
  );
};
export const currentMonth = (now = new Date()): string =>
  now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");

/** What this machine spent in a month, from retained attempts alone: every number is a sum, never an estimate. */
export function ledgerFor(
  records: { ticket: Ticket; attempts: StoredAttempt[] }[],
  month: string,
): UsageLedger {
  const ledger: UsageLedger = {
    month,
    spentMicros: 0,
    pricedAttempts: 0,
    unpricedAttempts: 0,
    ticketsRun: 0,
    ticketsMerged: 0,
    stoppedShort: 0,
    averageMergedMicros: null,
  };
  let mergedSpend = 0,
    mergedPriced = 0;
  for (const { ticket, attempts } of records) {
    const inMonth = attempts.filter(
      (attempt) => monthOf(attempt.created_at) === month,
    );
    if (inMonth.length) ledger.ticketsRun++;
    // A ticket, not an attempt: three early stops on one ticket read as one ticket stopped.
    if (inMonth.some((attempt) => isEarlyStop(attempt.termination?.reason)))
      ledger.stoppedShort++;
    const spent = rollCosts(inMonth.map(attemptCost));
    ledger.pricedAttempts += spent.priced;
    ledger.unpricedAttempts += spent.unavailable;
    ledger.spentMicros += spent.micros;
    if (ticket.state === "merged" && monthOf(ticket.updated_at) === month) {
      ledger.ticketsMerged++;
      const cost = rollCosts(attempts.map(attemptCost));
      if (cost.priced > 0 && cost.unavailable === 0) {
        mergedPriced++;
        mergedSpend += cost.micros;
      }
    }
  }
  ledger.averageMergedMicros = mergedPriced
    ? Math.round(mergedSpend / mergedPriced)
    : null;
  return ledger;
}

/**
 * A pinned check result as this file reads one: the node it ran for, and
 * whether it passed. Loose for the same reason the records above are.
 */
const StoredCheckSchema = z.looseObject({
  name: z.string().min(1).optional(),
  check_id: z.string().min(1).optional(),
  status: z.string(),
  /**
   * The node it was narrowed to, and how far: `files` is a run over that node's
   * own changed test files, `task` the whole command where it could not be
   * narrowed (D-107). Only the first is evidence about the node.
   */
  node: z.looseObject({ node_id: z.string().min(1), scope: z.string().optional() }).optional(),
});
const StoredChecksSchema = z.union([
  z.array(StoredCheckSchema),
  z.looseObject({ checks: z.array(StoredCheckSchema) }).transform((value) => value.checks),
]);
/**
 * The review artifact as this file reads one: the evidence bindings and the
 * findings, which are the only account of a criterion's state that is not the
 * executor's own (ADR-0023). Loose, so an artifact a later version wrote still
 * reads here rather than leaving the pane with nothing.
 */
const StoredReviewSchema = z.looseObject({
  /**
   * The plan it judged. A criterion id is only unique within a plan version —
   * a re-draft from the spec renumbers them — so a review of an older version
   * is not an account of these criteria. Absent on a record written before the
   * field, which is read as the plan it is beside.
   */
  plan_version: z.number().int().positive().optional(),
  created_at: z.string().optional(),
  coverage: z
    .array(
      z.looseObject({
        criterion_id: z.string().min(1),
        status: z.enum(["met", "not_met", "cannot_determine"]),
        verification_strength: z.enum(["directly_verified", "proxy", "asserted_only"]).optional(),
        evidence: z
          .looseObject({
            ref: z.string().min(1).nullable().optional(),
            location: z
              .looseObject({
                file: z.string().min(1),
                line: z.number().int().min(1).nullable().optional(),
              })
              .nullable()
              .optional(),
          })
          .nullable()
          .optional(),
      }),
    )
    .default([]),
  findings: z
    .array(
      z.looseObject({
        key: z.string().min(1).optional(),
        criterion_id: z.string().min(1).nullable().optional(),
        status: z.string().optional(),
        statement: z.string().min(1).optional(),
      }),
    )
    .default([]),
});

const FindingsOnRecordSchema = z.looseObject({
  decision: ReviewDecisionSchema,
  findings: z.array(
    z.looseObject({
      key: z.string(),
      rule_id: z.string(),
      status: z.enum(["open", "resolved", "waived"]),
      routing: z.enum(FINDING_ROUTINGS),
      closure: z.enum(CLOSURE_AUTHORITIES).nullable().default(null),
      statement: z.string(),
      blocking_reason: z.string().default(""),
    }),
  ),
});
export type FindingsOnRecord = z.infer<typeof FindingsOnRecordSchema>;

/**
 * The findings of a ticket's last review as the loop reads it — the newest
 * `rev_` bundle — which is what a person's answer has to be one the loop acts
 * on against (D-NEW-a-person-s-answer-closes-a-routed-finding). Null where no
 * review can be read.
 */
export function findingsOnRecord(
  bundles: readonly BundleManifest[],
  ticketId: string,
  objectsDirectory: string,
): FindingsOnRecord | null {
  const review = bundles
    .filter((bundle) => bundle.ticket_id === ticketId && bundle.kind === "review" && bundle.subject_id.startsWith("rev_"))
    .sort((left, right) => (left.created_at ?? "").localeCompare(right.created_at ?? ""))
    .at(-1);
  const artifact = review?.artifacts.find((entry) => entry.name === "review.json" && entry.retained);
  if (!artifact) return null;
  try {
    const text = readObject(join(objectsDirectory, artifact.sha256), artifact).text;
    const parsed = FindingsOnRecordSchema.safeParse(JSON.parse(text ?? "null"));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** One standing answer a person gave to a finding routed to them. */
export interface Decision {
  finding_key: string;
  /** The review the person named by its id, or null where they named the ticket or its pull request. */
  review_id: string | null;
  decided_at: string;
}

const VerdictsRecordSchema = z.object({
  verdicts: z.array(
    z
      .object({
        review: z.object({ ticket_id: z.string(), reference: z.string() }).passthrough(),
        finding_key: z.string(),
        decision: z.string(),
        choice: z.string().optional(),
        decided_at: z.string(),
        superseded_at: z.string().nullable(),
      })
      .passthrough(),
  ),
});

/**
 * The standing answers of one ticket that closed their finding as it stood —
 * shipped as it is — in the verdicts record `perbo verdict` writes
 * (D-NEW-a-person-s-answer-closes-a-routed-finding). An answer that handed the
 * finding to the executor closes nothing by itself: the round's verification
 * does, and the graph reads that where every closure is read. None where the
 * file is absent or cannot be read: `perbo inspect` is where a broken record
 * is reported, and a graph that failed on one would show nothing.
 */
export function readDecisions(path: string, ticketId: string): Decision[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = VerdictsRecordSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) return [];
    return parsed.data.verdicts
      .filter(
        (row) =>
          row.review.ticket_id === ticketId &&
          row.decision === "decide" &&
          row.choice === "ship_as_is" &&
          row.superseded_at === null,
      )
      .map((row) => ({
        finding_key: row.finding_key,
        review_id: row.review.reference.startsWith("rev_") ? row.review.reference : null,
        decided_at: row.decided_at,
      }));
  } catch {
    return [];
  }
}

/**
 * The records a plan's execution graph is read from (D-100, SCP-317), and
 * nothing derived from them: {@link assembleLiveGraph} is where the deriving
 * happens, so the host and the sample host answer alike.
 *
 * The latest attempt is the one read: a change set is the branch against the
 * base rather than an attempt's own delta, so the latest holds all of it. The
 * latest review artifact is the one read for the same kind of reason — a
 * change gets one full review and every later round is verified rather than
 * reviewed again (D-061), so there is no newer account of a criterion.
 */
export function liveGraph(input: {
  nodes: readonly LiveNodeInput[];
  attempts: readonly StoredAttempt[];
  bundles: readonly BundleManifest[];
  ticketId: string;
  /**
   * The person's answers to findings routed to them, each of which closes its
   * finding as of when it was taken
   * (D-NEW-a-person-s-answer-closes-a-routed-finding).
   */
  decisions: readonly Decision[];
  /** The plan the ticket carries now, which a review has to have judged. */
  planVersion?: number;
  objectsDirectory: string;
}): GraphLiveView {
  const latest = input.attempts.at(-1);
  const mine = input.bundles.filter((bundle) => bundle.ticket_id === input.ticketId);
  const execution = latest
    ? mine.find((bundle) => bundle.kind === "execution" && bundle.subject_id === latest.attempt_id)
    : undefined;
  const read = (bundle: BundleManifest | undefined, name: string): string | null => {
    const artifact = bundle?.artifacts.find((entry) => entry.name === name && entry.retained);
    if (!artifact) return null;
    try {
      return readObject(join(input.objectsDirectory, artifact.sha256), artifact).text;
    } catch {
      return null;
    }
  };
  const parse = <T>(body: string | null, schema: z.ZodType<T>): T | null => {
    if (body === null) return null;
    try {
      const parsed = schema.safeParse(JSON.parse(body));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  const diff = read(execution, "change.diff");
  const checks: LiveCheck[] = (parse(read(execution, "checks.json"), StoredChecksSchema) ?? []).map(
    (check) => ({
      name: check.name ?? check.check_id ?? "Check",
      status: check.status,
      node: check.node ? { id: check.node.node_id, scope: check.node.scope } : null,
    }),
  );
  const newest = <T extends BundleManifest>(bundles: T[]): T | undefined =>
    [...bundles].sort((left, right) => (left.created_at ?? "").localeCompare(right.created_at ?? "")).at(-1);
  const reviewBundle = newest(
    mine.filter((bundle) => bundle.kind === "review" && bundle.subject_id.startsWith("rev_")),
  );
  const reviewed = parse(read(reviewBundle, "review.json"), StoredReviewSchema);
  const review: LiveReview | null = reviewed
    ? {
        planVersion: reviewed.plan_version,
        createdAt: reviewBundle?.created_at ?? reviewed.created_at ?? "",
        coverage: reviewed.coverage,
        findings: reviewed.findings,
      }
    : null;
  const closures = mine
    .filter((bundle) => bundle.subject_id.startsWith("cv_"))
    .map((bundle) => ({
      createdAt: bundle.created_at ?? "",
      closed: (bundle.inputs?.findings_closed ?? "")
        .split(",")
        .map((key) => key.trim())
        .filter((key) => key.length > 0),
    }))
    .concat(
      input.decisions
        .filter((row) => row.review_id === null || row.review_id === reviewBundle?.subject_id)
        .map((row) => ({ createdAt: row.decided_at, closed: [row.finding_key] })),
    );

  return assembleLiveGraph(
    input.nodes,
    {
      attempt: latest?.attempt_id ?? null,
      changed: diff === null ? null : parseUnifiedDiff(diff).map((file) => file.path),
      sealed: Boolean(latest?.changeset_id),
      checks,
      review,
      closures,
    },
    input.planVersion,
  );
}
