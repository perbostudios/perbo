import { createHash } from "node:crypto";
import { z } from "zod";
import { BASELINE_COMPARISON_MINIMUM, medianMs } from "../stopwatch.js";

/**
 * The E1 ledger: one partner's ten timed direct-agent tickets, sealed, and the
 * ratio the product is later held to on the same ten (D-038, SCP-080).
 *
 * `../stopwatch.ts` is the stopwatch — one person, one reading, one machine. This
 * is what the readings are *for*: E1 asks whether real work moves faster than
 * the workflow it replaces, and that question is only answerable if the number
 * it is compared against was written down before the product touched the
 * partner. So the rules here are about time and about what may still be
 * changed, and every one of them is a refusal rather than a warning:
 *
 * - a baseline is complete at **exactly ten** tickets, each with a work-start,
 *   a pull-request-opened time and self-reported interruptions subtracted from
 *   the recorded wall clock;
 * - the thresholds are agreed **before** the first measurement, and cannot be
 *   re-agreed once a ticket has been timed against them;
 * - a baseline is **sealed** before the first product run, and a sealed
 *   baseline cannot be added to, edited or reconstructed — the seal carries a
 *   digest of the ten readings, so a later edit is visible rather than silent;
 * - the ratio is computed from product runs of **those ten identifiers** and
 *   nothing else. Admission friction, abandonment reason, voluntary routing,
 *   mid-flow abandonment and each defect the product caught are recorded
 *   beside it and never inside it, because a ratio that quietly absorbs them
 *   answers a different question than the one D-038 asks;
 * - the AI stand-in's own agent-direct baseline is a subject like any other and
 *   is reported as its own result. Nothing pools it with a partner's: the
 *   cohort read refuses it by construction rather than by convention.
 *
 * Nothing here decides whether E1 passed. It computes what was measured, says
 * what is still missing, and leaves a result that names its own gaps.
 */

export const E1_SCHEMA_VERSION = 1;

/** D-038 times ten tickets per partner. Complete means ten — not nine, not eleven. */
export const E1_BASELINE_SIZE = BASELINE_COMPARISON_MINIMUM;

/** The learning-curve allowance runs through the fifth product ticket. */
export const E1_LEARNING_CURVE_TICKETS = 5;

/**
 * Who is being measured. A partner is a person whose baseline can carry E1; the
 * AI stand-in's is `agent_direct`, which is evidence about the product and
 * never evidence about a partner (SCP-080, D-058).
 */
export const E1_ARMS = ["partner", "agent_direct"] as const;
export const E1ArmSchema = z.enum(E1_ARMS);
export type E1Arm = (typeof E1_ARMS)[number];

export const E1SubjectIdSchema = z
  .string()
  .regex(/^[0-9a-z][0-9a-z_-]{1,39}$/, "a subject id is lowercase, 2-40 characters of [a-z0-9_-]");

/**
 * A work item's identifier in the partner's own tracker, which is what makes
 * the baseline and the product run comparable at all. Never one of this
 * product's ids: the baseline is timed on the workflow Perbo has not touched.
 */
export const E1WorkItemIdSchema = z
  .string()
  .regex(/^[0-9A-Za-z][0-9A-Za-z._#/-]{0,63}$/, "a work item id is the partner's own, e.g. ACME-412");

export class E1StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "E1StateError";
  }
}

/** Raised where a read would put the stand-in's arm and a partner's in one number. */
export class E1PoolingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "E1PoolingError";
  }
}

/**
 * The pass thresholds, as D-038 states them, defaulted here and overridable per
 * partner — because the agreement is with a partner and it is theirs to read
 * before they sign it.
 */
export const E1_DEFAULT_THRESHOLDS = {
  ratio_by_ticket_10: 1.0,
  ratio_through_ticket_5: 1.25,
  min_voluntary_routing_rate: 0.5,
  max_mid_flow_abandonment_rate: 0.2,
  min_defects_caught: 1,
} as const;

export const E1ThresholdsSchema = z.strictObject({
  /**
   * When the partner agreed to these numbers in writing. It has to precede
   * their first timed ticket, and the ledger refuses a ticket that starts
   * before it — a threshold agreed after the measurement is a threshold chosen
   * to fit the measurement.
   */
  agreed_at: z.iso.datetime(),
  /** Who agreed, in their own words: a name, a role, both. */
  agreed_with: z.string().min(1),
  /** Where the written agreement lives — an email, a document, a signed page. */
  record: z.string().min(1),
  ratio_by_ticket_10: z.number().positive(),
  ratio_through_ticket_5: z.number().positive(),
  min_voluntary_routing_rate: z.number().min(0).max(1),
  max_mid_flow_abandonment_rate: z.number().min(0).max(1),
  min_defects_caught: z.number().int().min(0),
});
export type E1Thresholds = z.infer<typeof E1ThresholdsSchema>;

/**
 * One reading. `wall_clock_ms` is the clock as it ran, `interruption_ms` is
 * what the person says they were not working, and `elapsed_ms` is the
 * subtraction — all three stored, so what was reported can be read back rather
 * than inferred from a difference.
 */
const timedFields = {
  work_started_at: z.iso.datetime(),
  pull_request_opened_at: z.iso.datetime(),
  interruption_ms: z.number().int().min(0),
  wall_clock_ms: z.number().int().min(0),
  elapsed_ms: z.number().int().min(0),
};

function checkTiming(
  value: {
    work_started_at: string;
    pull_request_opened_at: string;
    interruption_ms: number;
    wall_clock_ms: number;
    elapsed_ms: number;
  },
  ctx: z.RefinementCtx,
): void {
  const clock = Date.parse(value.pull_request_opened_at) - Date.parse(value.work_started_at);
  if (clock <= 0) {
    ctx.addIssue({
      code: "custom",
      message: "the pull request was opened at or before work started",
      path: ["pull_request_opened_at"],
    });
    return;
  }
  if (value.wall_clock_ms !== clock) {
    ctx.addIssue({
      code: "custom",
      message: `wall_clock_ms is ${value.wall_clock_ms}, but the two times are ${clock}ms apart`,
      path: ["wall_clock_ms"],
    });
  }
  if (value.interruption_ms > clock) {
    ctx.addIssue({
      code: "custom",
      message: `${value.interruption_ms}ms of interruptions do not fit in a ${clock}ms wall clock`,
      path: ["interruption_ms"],
    });
  }
  if (value.elapsed_ms !== value.wall_clock_ms - value.interruption_ms) {
    ctx.addIssue({
      code: "custom",
      message: "elapsed_ms is not the wall clock with the interruptions taken out",
      path: ["elapsed_ms"],
    });
  }
}

/** Where the three times came from: a stopwatch this tool ran, or a person's report. */
export const E1_TIMING_SOURCES = ["stopwatch", "reported"] as const;
export const E1TimingSourceSchema = z.enum(E1_TIMING_SOURCES);

export const E1BaselineTicketSchema = z
  .strictObject({
    work_item_id: E1WorkItemIdSchema,
    title: z.string().min(1),
    ...timedFields,
    source: E1TimingSourceSchema,
    /** The `bl_…` stopwatch entry this was taken from, where it was taken from one. */
    stopwatch_id: z.string().min(1).nullable(),
    recorded_at: z.iso.datetime(),
  })
  .superRefine(checkTiming);
export type E1BaselineTicket = z.infer<typeof E1BaselineTicketSchema>;

/** A defect the product caught that the direct path would have merged, one row each. */
export const E1DefectSchema = z.strictObject({
  work_item_id: E1WorkItemIdSchema,
  summary: z.string().min(1),
  /** Where it can be read: a review comment, a finding id, a pull-request URL. */
  evidence: z.string().min(1).nullable(),
  recorded_at: z.iso.datetime(),
});
export type E1Defect = z.infer<typeof E1DefectSchema>;

/**
 * One run of the same work item through the product.
 *
 * The confounders sit here, beside the times and outside them. `admission_
 * friction_ms` is time spent getting the work admitted rather than done, which
 * D-003's native ticket ownership adds and the direct path never had; it is
 * recorded so a reader can see it, and it is not subtracted from anything.
 */
export const E1ProductRunSchema = z
  .strictObject({
    work_item_id: E1WorkItemIdSchema,
    work_started_at: z.iso.datetime(),
    /** Null when the run was abandoned mid-flow: there is no pull request to time to. */
    pull_request_opened_at: z.iso.datetime().nullable(),
    interruption_ms: z.number().int().min(0),
    wall_clock_ms: z.number().int().min(0).nullable(),
    elapsed_ms: z.number().int().min(0).nullable(),
    /** Recorded, never subtracted (D-003). */
    admission_friction_ms: z.number().int().min(0),
    abandoned_mid_flow: z.boolean(),
    abandonment_reason: z.string().min(1).nullable(),
    defects_caught: z.array(E1DefectSchema),
    recorded_at: z.iso.datetime(),
  })
  .superRefine((run, ctx) => {
    if (run.abandoned_mid_flow) {
      if (run.pull_request_opened_at !== null || run.elapsed_ms !== null) {
        ctx.addIssue({
          code: "custom",
          message: "an abandoned run has no pull request and no elapsed time",
          path: ["pull_request_opened_at"],
        });
      }
      if (run.abandonment_reason === null) {
        ctx.addIssue({
          code: "custom",
          message: "an abandoned run records why it was abandoned",
          path: ["abandonment_reason"],
        });
      }
      return;
    }
    if (run.pull_request_opened_at === null || run.wall_clock_ms === null || run.elapsed_ms === null) {
      ctx.addIssue({
        code: "custom",
        message: "a run that was not abandoned records a pull request and the time it took",
        path: ["pull_request_opened_at"],
      });
      return;
    }
    checkTiming(
      {
        work_started_at: run.work_started_at,
        pull_request_opened_at: run.pull_request_opened_at,
        interruption_ms: run.interruption_ms,
        wall_clock_ms: run.wall_clock_ms,
        elapsed_ms: run.elapsed_ms,
      },
      ctx,
    );
    for (const defect of run.defects_caught) {
      if (defect.work_item_id !== run.work_item_id) {
        ctx.addIssue({
          code: "custom",
          message: `a defect on ${defect.work_item_id} is filed under the run for ${run.work_item_id}`,
          path: ["defects_caught"],
        });
      }
    }
  });
export type E1ProductRun = z.infer<typeof E1ProductRunSchema>;

/**
 * Voluntary routing is a rate over *eligible work*, not over the ten — D-038
 * asks what share of the work a partner could have sent through the product
 * they sent without being asked. So it is counted where it happens, over a
 * named period, and it never touches the ratio.
 */
export const E1RoutingObservationSchema = z
  .strictObject({
    period: z.string().min(1),
    eligible: z.number().int().min(1),
    routed_voluntarily: z.number().int().min(0),
    /** Work routed because somebody asked for it, which is not what E1 counts. */
    routed_on_request: z.number().int().min(0),
    observed_at: z.iso.datetime(),
  })
  .superRefine((observation, ctx) => {
    const seen = observation.routed_voluntarily + observation.routed_on_request;
    if (seen > observation.eligible) {
      ctx.addIssue({
        code: "custom",
        message: `${seen} routed items do not fit in ${observation.eligible} eligible ones`,
        path: ["routed_voluntarily"],
      });
    }
  });
export type E1RoutingObservation = z.infer<typeof E1RoutingObservationSchema>;

export const E1SealSchema = z.strictObject({
  sealed_at: z.iso.datetime(),
  /** The ten, in the order they were timed. The ratio's whole population. */
  work_item_ids: z.array(E1WorkItemIdSchema).length(E1_BASELINE_SIZE),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/, "a seal digest is sha256:<64 hex>"),
});
export type E1Seal = z.infer<typeof E1SealSchema>;

export const E1SubjectSchema = z.strictObject({
  subject_id: E1SubjectIdSchema,
  arm: E1ArmSchema,
  /** Agreed before the first measurement, and not re-agreed after it. */
  thresholds: E1ThresholdsSchema,
  tickets: z.array(E1BaselineTicketSchema).max(E1_BASELINE_SIZE),
  /** Null until sealed. Once set, nothing above it may change. */
  seal: E1SealSchema.nullable(),
  runs: z.array(E1ProductRunSchema),
  routing: z.array(E1RoutingObservationSchema),
  opened_at: z.iso.datetime(),
});
export type E1Subject = z.infer<typeof E1SubjectSchema>;

export const E1LedgerSchema = z
  .strictObject({
    schema_version: z.literal(E1_SCHEMA_VERSION),
    subjects: z.array(E1SubjectSchema),
  })
  .superRefine((ledger, ctx) => {
    const seen = new Set<string>();
    for (const subject of ledger.subjects) {
      if (seen.has(subject.subject_id)) {
        ctx.addIssue({
          code: "custom",
          message: `two subjects are called ${subject.subject_id}`,
          path: ["subjects"],
        });
      }
      seen.add(subject.subject_id);
    }
  });
export type E1Ledger = z.infer<typeof E1LedgerSchema>;

export const EMPTY_E1_LEDGER: E1Ledger = {
  schema_version: E1_SCHEMA_VERSION,
  subjects: [],
};

/**
 * The digest a seal carries: the ten readings, in order, as they were sealed.
 *
 * Over the timing fields and the identity, not over the whole record — a note
 * corrected after the fact is not a reconstructed measurement, and a digest
 * that moves for one would say nothing when the other happened.
 */
export function e1BaselineDigest(tickets: readonly E1BaselineTicket[]): string {
  const material = tickets.map((ticket) => [
    ticket.work_item_id,
    ticket.work_started_at,
    ticket.pull_request_opened_at,
    ticket.interruption_ms,
    ticket.wall_clock_ms,
    ticket.elapsed_ms,
  ]);
  return `sha256:${createHash("sha256").update(JSON.stringify(material), "utf8").digest("hex")}`;
}

export function e1Subject(ledger: E1Ledger, subject_id: string): E1Subject | null {
  return ledger.subjects.find((subject) => subject.subject_id === subject_id) ?? null;
}

function requireSubject(ledger: E1Ledger, subject_id: string): E1Subject {
  const subject = e1Subject(ledger, subject_id);
  if (!subject) {
    const known = ledger.subjects.map((one) => one.subject_id).join(", ");
    throw new E1StateError(
      `no baseline is open for ${subject_id}` + (known ? `; this ledger holds ${known}` : ""),
    );
  }
  return subject;
}

function replaceSubject(ledger: E1Ledger, subject: E1Subject): E1Ledger {
  return {
    ...ledger,
    subjects: ledger.subjects.map((existing) =>
      existing.subject_id === subject.subject_id ? subject : existing,
    ),
  };
}

/** Everything a sealed baseline refuses, in one place and in one sentence. */
function refuseIfSealed(subject: E1Subject, verb: string): void {
  if (subject.seal !== null) {
    throw new E1StateError(
      `${subject.subject_id}'s baseline was sealed at ${subject.seal.sealed_at} and cannot ${verb}: ` +
        "a baseline records the workflow before the product touched it, and that cannot be revisited",
    );
  }
}

export function openE1Subject(
  ledger: E1Ledger,
  input: { subject_id: string; arm: E1Arm; thresholds: E1Thresholds; now: Date },
): E1Ledger {
  if (e1Subject(ledger, input.subject_id)) {
    throw new E1StateError(`${input.subject_id} already has a baseline in this ledger`);
  }
  const subject_id = E1SubjectIdSchema.parse(input.subject_id);
  const thresholds = E1ThresholdsSchema.parse(input.thresholds);
  if (Date.parse(thresholds.agreed_at) > input.now.getTime()) {
    throw new E1StateError(
      `the thresholds are dated ${thresholds.agreed_at}, which is in the future`,
    );
  }
  const subject = E1SubjectSchema.parse({
    subject_id,
    arm: input.arm,
    thresholds,
    tickets: [],
    seal: null,
    runs: [],
    routing: [],
    opened_at: input.now.toISOString(),
  } satisfies E1Subject);
  return { ...ledger, subjects: [...ledger.subjects, subject] };
}

/**
 * One timed direct-agent ticket, from the three times a person can report.
 *
 * The subtraction happens here and is stored, so nothing downstream has to
 * decide whether a number already had the interruptions taken out.
 */
export function e1BaselineTicket(input: {
  work_item_id: string;
  title: string;
  work_started_at: Date;
  pull_request_opened_at: Date;
  interruption_ms: number;
  source?: "stopwatch" | "reported";
  stopwatch_id?: string | null;
  recorded_at: Date;
}): E1BaselineTicket {
  const wall_clock_ms = input.pull_request_opened_at.getTime() - input.work_started_at.getTime();
  const parsed = E1BaselineTicketSchema.safeParse({
    work_item_id: input.work_item_id,
    title: input.title,
    work_started_at: input.work_started_at.toISOString(),
    pull_request_opened_at: input.pull_request_opened_at.toISOString(),
    interruption_ms: input.interruption_ms,
    wall_clock_ms,
    elapsed_ms: wall_clock_ms - input.interruption_ms,
    source: input.source ?? "reported",
    stopwatch_id: input.stopwatch_id ?? null,
    recorded_at: input.recorded_at.toISOString(),
  });
  if (!parsed.success) throw new E1StateError(issueText(parsed.error));
  return parsed.data;
}

function issueText(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

export function recordE1BaselineTicket(
  ledger: E1Ledger,
  subject_id: string,
  ticket: E1BaselineTicket,
): E1Ledger {
  const subject = requireSubject(ledger, subject_id);
  refuseIfSealed(subject, "take another ticket");
  if (subject.tickets.length >= E1_BASELINE_SIZE) {
    throw new E1StateError(
      `${subject_id}'s baseline already holds its ${E1_BASELINE_SIZE} tickets; seal it`,
    );
  }
  if (subject.tickets.some((existing) => existing.work_item_id === ticket.work_item_id)) {
    throw new E1StateError(`${ticket.work_item_id} is already timed in ${subject_id}'s baseline`);
  }
  if (Date.parse(ticket.work_started_at) < Date.parse(subject.thresholds.agreed_at)) {
    throw new E1StateError(
      `${ticket.work_item_id} started at ${ticket.work_started_at}, before the thresholds ` +
        `${subject_id} agreed at ${subject.thresholds.agreed_at}: a measurement taken before the ` +
        "bar was agreed is not measured against it",
    );
  }
  return replaceSubject(ledger, { ...subject, tickets: [...subject.tickets, ticket] });
}

/**
 * Agree the thresholds — once, and only while nothing has been measured.
 *
 * A partner may correct the record of an agreement they have not yet been
 * measured against. After the first ticket the numbers are fixed: a bar moved
 * to fit a measurement is not a bar.
 */
export function agreeE1Thresholds(
  ledger: E1Ledger,
  subject_id: string,
  thresholds: E1Thresholds,
): E1Ledger {
  const subject = requireSubject(ledger, subject_id);
  refuseIfSealed(subject, "have its thresholds re-agreed");
  if (subject.tickets.length > 0) {
    throw new E1StateError(
      `${subject_id} has ${subject.tickets.length} ticket(s) timed against the thresholds agreed ` +
        `at ${subject.thresholds.agreed_at}; they cannot be re-agreed now`,
    );
  }
  return replaceSubject(ledger, { ...subject, thresholds: E1ThresholdsSchema.parse(thresholds) });
}

export function sealE1Baseline(ledger: E1Ledger, subject_id: string, now: Date): E1Ledger {
  const subject = requireSubject(ledger, subject_id);
  refuseIfSealed(subject, "be sealed again");
  if (subject.tickets.length !== E1_BASELINE_SIZE) {
    throw new E1StateError(
      `${subject_id}'s baseline holds ${subject.tickets.length} of ${E1_BASELINE_SIZE} tickets; ` +
        "a baseline is complete at ten and is sealed complete",
    );
  }
  const seal = E1SealSchema.parse({
    sealed_at: now.toISOString(),
    work_item_ids: subject.tickets.map((ticket) => ticket.work_item_id),
    digest: e1BaselineDigest(subject.tickets),
  } satisfies E1Seal);
  return replaceSubject(ledger, { ...subject, seal });
}

/** Whether the ten readings are still the ten that were sealed. */
export function e1SealIntact(subject: E1Subject): boolean {
  if (subject.seal === null) return false;
  return (
    subject.tickets.length === subject.seal.work_item_ids.length &&
    subject.tickets.every(
      (ticket, index) => ticket.work_item_id === subject.seal!.work_item_ids[index],
    ) &&
    e1BaselineDigest(subject.tickets) === subject.seal.digest
  );
}

export function recordE1ProductRun(
  ledger: E1Ledger,
  subject_id: string,
  run: E1ProductRun,
): E1Ledger {
  const subject = requireSubject(ledger, subject_id);
  if (subject.seal === null) {
    throw new E1StateError(
      `${subject_id}'s baseline is not sealed (${subject.tickets.length} of ${E1_BASELINE_SIZE} ` +
        "tickets), and a product run recorded before it is sealed is a baseline captured after " +
        "first use. Seal the baseline first",
    );
  }
  if (subject.runs.some((existing) => existing.work_item_id === run.work_item_id)) {
    throw new E1StateError(
      `${run.work_item_id} already has a product run for ${subject_id}; the ratio pairs one run ` +
        "with one baseline reading",
    );
  }
  return replaceSubject(ledger, { ...subject, runs: [...subject.runs, run] });
}

export function recordE1Routing(
  ledger: E1Ledger,
  subject_id: string,
  observation: E1RoutingObservation,
): E1Ledger {
  const subject = requireSubject(ledger, subject_id);
  return replaceSubject(ledger, {
    ...subject,
    routing: [...subject.routing, E1RoutingObservationSchema.parse(observation)],
  });
}

/* ---------------------------------------------------------------- reading */

export interface E1Pair {
  work_item_id: string;
  baseline_elapsed_ms: number;
  /** Null where the product run is missing or was abandoned mid-flow. */
  product_elapsed_ms: number | null;
  ratio: number | null;
}

export interface E1RatioRead {
  /** Pairs where both sides have a reading; the whole of what the ratio is computed from. */
  matched: number;
  abandoned: number;
  missing_work_item_ids: string[];
  /**
   * Product runs whose work item is not one of the sealed ten. Recorded so the
   * exclusion is visible, and excluded so the ratio stays the one D-038 defines.
   */
  excluded_work_item_ids: string[];
  baseline_median_ms: number | null;
  product_median_ms: number | null;
  ratio: number | null;
  /** The same read over the first five product runs, which D-038 allows 1.25×. */
  through_ticket_5: { matched: number; ratio: number | null };
  pairs: E1Pair[];
}

/**
 * The confounders, each its own field.
 *
 * Every one of these is a number a reader needs to interpret the ratio and
 * none of them is allowed to move it. Admission friction in particular: under
 * native ticket ownership (D-003) the product adds a step the direct path did
 * not have, and burying it in the elapsed time would make the ratio look worse
 * while hiding why — while subtracting it would make the product look faster
 * than a partner's day actually got.
 */
export interface E1Confounders {
  admission_friction_median_ms: number | null;
  admission_friction_total_ms: number;
  abandonment_reasons: Array<{ work_item_id: string; reason: string }>;
  /** Over every recorded product run, not only the ten: abandonment is about the product. */
  mid_flow_abandonment_rate: number | null;
  /** Null when nothing was observed: unmeasured is not zero. */
  voluntary_routing_rate: number | null;
  routing_eligible: number;
  routing_voluntary: number;
  defects_caught: E1Defect[];
}

export const E1_VERDICTS = ["pass", "fail", "incomplete", "void"] as const;
export type E1Verdict = (typeof E1_VERDICTS)[number];

export interface E1Result {
  subject_id: string;
  arm: E1Arm;
  /** False for the stand-in's arm: it is evidence about the product, not about a partner. */
  counts_toward_e1: boolean;
  thresholds: E1Thresholds;
  baseline: {
    tickets: number;
    sealed_at: string | null;
    seal_intact: boolean;
    median_elapsed_ms: number | null;
  };
  ratio: E1RatioRead;
  confounders: E1Confounders;
  verdict: E1Verdict;
  /** Why the verdict is what it is, one line each, in the order they were found. */
  reasons: string[];
}

function ratioOf(baseline: readonly number[], product: readonly number[]): number | null {
  const base = medianMs(baseline);
  const value = medianMs(product);
  if (base === null || value === null || base === 0) return null;
  return value / base;
}

export function e1RatioRead(subject: E1Subject): E1RatioRead {
  const sealed = subject.seal?.work_item_ids ?? subject.tickets.map((one) => one.work_item_id);
  const runs = new Map(subject.runs.map((run) => [run.work_item_id, run]));
  const pairs: E1Pair[] = [];
  const missing_work_item_ids: string[] = [];
  let abandoned = 0;

  for (const work_item_id of sealed) {
    const ticket = subject.tickets.find((one) => one.work_item_id === work_item_id);
    const run = runs.get(work_item_id);
    // A sealed id with no reading behind it means the ten were edited after the
    // seal. `e1SealIntact` is what reports that; here it is simply missing,
    // rather than a crash on a record somebody tampered with.
    if (!ticket) {
      missing_work_item_ids.push(work_item_id);
      continue;
    }
    if (!run) {
      missing_work_item_ids.push(work_item_id);
      pairs.push({
        work_item_id,
        baseline_elapsed_ms: ticket.elapsed_ms,
        product_elapsed_ms: null,
        ratio: null,
      });
      continue;
    }
    if (run.abandoned_mid_flow || run.elapsed_ms === null) {
      abandoned += 1;
      pairs.push({
        work_item_id,
        baseline_elapsed_ms: ticket.elapsed_ms,
        product_elapsed_ms: null,
        ratio: null,
      });
      continue;
    }
    pairs.push({
      work_item_id,
      baseline_elapsed_ms: ticket.elapsed_ms,
      product_elapsed_ms: run.elapsed_ms,
      ratio: ticket.elapsed_ms === 0 ? null : run.elapsed_ms / ticket.elapsed_ms,
    });
  }

  const matchedPairs = pairs.filter((pair) => pair.product_elapsed_ms !== null);
  // The medians are taken over the same tickets on both sides. A baseline
  // median over ten and a product median over the six that finished compares
  // two different populations and reads as a result.
  const baselineMs = matchedPairs.map((pair) => pair.baseline_elapsed_ms);
  const productMs = matchedPairs.map((pair) => pair.product_elapsed_ms!);

  // "Through ticket 5" is the partner's fifth run through the product, in the
  // order they opened the pull requests — the learning curve is theirs, not the
  // order the baseline happened to be timed in.
  const byOpened = matchedPairs
    .map((pair) => ({ pair, run: runs.get(pair.work_item_id)! }))
    .sort(
      (a, b) =>
        Date.parse(a.run.pull_request_opened_at!) - Date.parse(b.run.pull_request_opened_at!),
    )
    .slice(0, E1_LEARNING_CURVE_TICKETS);

  return {
    matched: matchedPairs.length,
    abandoned,
    missing_work_item_ids,
    excluded_work_item_ids: subject.runs
      .filter((run) => !sealed.includes(run.work_item_id))
      .map((run) => run.work_item_id),
    baseline_median_ms: medianMs(baselineMs),
    product_median_ms: medianMs(productMs),
    ratio: ratioOf(baselineMs, productMs),
    through_ticket_5: {
      matched: byOpened.length,
      ratio: ratioOf(
        byOpened.map((one) => one.pair.baseline_elapsed_ms),
        byOpened.map((one) => one.pair.product_elapsed_ms!),
      ),
    },
    pairs,
  };
}

export function e1Confounders(subject: E1Subject): E1Confounders {
  const friction = subject.runs.map((run) => run.admission_friction_ms);
  const eligible = subject.routing.reduce((sum, one) => sum + one.eligible, 0);
  const voluntary = subject.routing.reduce((sum, one) => sum + one.routed_voluntarily, 0);
  return {
    admission_friction_median_ms: medianMs(friction),
    admission_friction_total_ms: friction.reduce((sum, one) => sum + one, 0),
    abandonment_reasons: subject.runs
      .filter((run) => run.abandonment_reason !== null)
      .map((run) => ({ work_item_id: run.work_item_id, reason: run.abandonment_reason! })),
    mid_flow_abandonment_rate:
      subject.runs.length === 0
        ? null
        : subject.runs.filter((run) => run.abandoned_mid_flow).length / subject.runs.length,
    voluntary_routing_rate: eligible === 0 ? null : voluntary / eligible,
    routing_eligible: eligible,
    routing_voluntary: voluntary,
    defects_caught: subject.runs.flatMap((run) => run.defects_caught),
  };
}

/**
 * One subject's E1 result, with its own gaps named.
 *
 * `incomplete` is the honest answer to a measurement that has not finished, and
 * it is not a failure: a rate nobody observed is null rather than zero, and a
 * ratio over four of ten tickets is not the ratio D-038 asks for. `void` is
 * narrower and worse — the sealed readings no longer hash to what was sealed,
 * so whatever this is, it is not the workflow before first use.
 */
export function e1Result(subject: E1Subject): E1Result {
  const ratio = e1RatioRead(subject);
  const confounders = e1Confounders(subject);
  const intact = e1SealIntact(subject);
  const reasons: string[] = [];
  let verdict: E1Verdict = "pass";
  // A measurement that has not finished cannot be called failed, and a record
  // that no longer hashes to what was sealed cannot be called anything else.
  const rank: Record<E1Verdict, number> = { pass: 0, fail: 1, incomplete: 2, void: 3 };
  const shortfall = (reason: string, level: E1Verdict): void => {
    reasons.push(reason);
    if (rank[level] > rank[verdict]) verdict = level;
  };

  if (subject.seal === null) {
    shortfall(
      `the baseline is not sealed: ${subject.tickets.length} of ${E1_BASELINE_SIZE} tickets timed`,
      "incomplete",
    );
  } else if (!intact) {
    shortfall(
      `the ten readings no longer match the digest sealed at ${subject.seal.sealed_at}: ` +
        "this is not a baseline captured before first use, and it is not evidence",
      "void",
    );
  }

  if (ratio.missing_work_item_ids.length > 0) {
    shortfall(
      `${ratio.missing_work_item_ids.length} of the ten have no product run yet ` +
        `(${ratio.missing_work_item_ids.join(", ")})`,
      "incomplete",
    );
  }
  if (ratio.ratio === null) {
    shortfall("no ticket has been run through the product and finished, so there is no ratio", "incomplete");
  } else {
    if (ratio.ratio > subject.thresholds.ratio_by_ticket_10) {
      shortfall(
        `the ratio is ${ratio.ratio.toFixed(2)}×, over the agreed ${subject.thresholds.ratio_by_ticket_10}×`,
        "fail",
      );
    }
    const early = ratio.through_ticket_5.ratio;
    if (early !== null && early > subject.thresholds.ratio_through_ticket_5) {
      shortfall(
        `the first ${ratio.through_ticket_5.matched} run(s) are at ${early.toFixed(2)}×, over the ` +
          `${subject.thresholds.ratio_through_ticket_5}× the learning curve allows`,
        "fail",
      );
    }
  }

  if (confounders.voluntary_routing_rate === null) {
    shortfall("voluntary routing has not been observed", "incomplete");
  } else if (confounders.voluntary_routing_rate < subject.thresholds.min_voluntary_routing_rate) {
    shortfall(
      `voluntary routing is ${percent(confounders.voluntary_routing_rate)}, under the agreed ` +
        `${percent(subject.thresholds.min_voluntary_routing_rate)}`,
      "fail",
    );
  }
  if (
    confounders.mid_flow_abandonment_rate !== null &&
    confounders.mid_flow_abandonment_rate >= subject.thresholds.max_mid_flow_abandonment_rate
  ) {
    shortfall(
      `mid-flow abandonment is ${percent(confounders.mid_flow_abandonment_rate)}, at or over the ` +
        `agreed ${percent(subject.thresholds.max_mid_flow_abandonment_rate)}`,
      "fail",
    );
  }
  if (confounders.defects_caught.length < subject.thresholds.min_defects_caught) {
    shortfall(
      `${confounders.defects_caught.length} defect(s) recorded that the direct path would have ` +
        `merged, under the agreed ${subject.thresholds.min_defects_caught}`,
      "fail",
    );
  }

  if (verdict === "pass") {
    reasons.push(
      `${ratio.matched} of the ten ran through the product at ${ratio.ratio!.toFixed(2)}× the ` +
        "same tickets' direct-agent median, and every agreed threshold is met",
    );
  }

  return {
    subject_id: subject.subject_id,
    arm: subject.arm,
    counts_toward_e1: subject.arm === "partner",
    thresholds: subject.thresholds,
    baseline: {
      tickets: subject.tickets.length,
      sealed_at: subject.seal?.sealed_at ?? null,
      seal_intact: intact,
      median_elapsed_ms: medianMs(subject.tickets.map((ticket) => ticket.elapsed_ms)),
    },
    ratio,
    confounders,
    verdict,
    reasons,
  };
}

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** Every subject's result, with the arms kept apart rather than merged. */
export interface E1Report {
  partners: E1Result[];
  agent_direct: E1Result[];
}

export function e1Report(ledger: E1Ledger): E1Report {
  const results = ledger.subjects.map(e1Result);
  return {
    partners: results.filter((result) => result.arm === "partner"),
    agent_direct: results.filter((result) => result.arm === "agent_direct"),
  };
}

export interface E1Cohort {
  partners: number;
  passing: number;
  /** D-038's cohort bar: four of six partners routing at least half their eligible work. */
  routing_at_threshold: number;
}

/**
 * The cohort read, over partners and over nobody else.
 *
 * The stand-in's arm is a real result and belongs in the report; what it must
 * never do is make a cohort look bigger or a rate look better. Passing one here
 * is a defect in the caller, so it raises rather than filtering silently.
 */
export function e1Cohort(results: readonly E1Result[]): E1Cohort {
  const standIn = results.filter((result) => result.arm !== "partner");
  if (standIn.length > 0) {
    throw new E1PoolingError(
      `the cohort read is over partners; ${standIn
        .map((result) => result.subject_id)
        .join(", ")} is an agent-direct baseline and is reported on its own`,
    );
  }
  return {
    partners: results.length,
    passing: results.filter((result) => result.verdict === "pass").length,
    routing_at_threshold: results.filter(
      (result) =>
        result.confounders.voluntary_routing_rate !== null &&
        result.confounders.voluntary_routing_rate >= result.thresholds.min_voluntary_routing_rate,
    ).length,
  };
}
