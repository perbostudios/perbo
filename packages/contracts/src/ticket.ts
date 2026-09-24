import { posix, win32 } from "node:path";
import { z } from "zod";
import { PlanIdSchema, TicketIdSchema } from "./ids.js";
import { DeliveredCheckSchema, DeliveryChecksStateSchema, GithubCredentialSchema } from "./github.js";
import { PlanLevelSchema } from "./plan.js";

/**
 * The native ticket (ADR-0027, docs/03, roadmap item 11).
 *
 * A ticket exists because somebody **admitted** work. That is the whole of the
 * entity's reason to exist and it is why there is no importer here, no backlog
 * sync and no way to create one in bulk: ADR-0027's amendment puts ownership
 * transfer at a single named event, and an entity that could arrive by any
 * other route would make "migration is never a precondition" untrue in the
 * schema rather than only in the prose.
 *
 * Phase 1 is admitted tickets, dependencies, labels and priorities over a flat
 * list. `project_id` and `cycle_id` are Phase 2 and are absent rather than
 * nullable — a strict object makes them unrepresentable, which is the same
 * device the plan contract uses to keep `steps` out of itself.
 */

/**
 * The states in `diagrams/ticket-lifecycle.dot`, verbatim and in order.
 *
 * The enum is the whole lifecycle; **Stage 3 drives a subset of it**, and the
 * subset is `TICKET_STATES_REACHABLE` below. Naming only the reachable ones
 * here would have put the diagram and the code into contradiction the first
 * time deployment linkage arrived, and this repository has that contradiction
 * as its primary defect class.
 */
export const TICKET_STATES = [
  "draft",
  "specifying",
  "plan_review",
  "ready",
  "provisioning",
  "executing",
  "verifying",
  "independent_review",
  "pr_open",
  "merged",
  // D-083: the other thing a pull request becomes. Terminal for the record and
  // re-runnable for the work.
  "closed",
  "done",
  "deployed",
  "observing",
  "changes_requested",
  "plan_invalid",
  "blocked",
  "failed",
  "cancelled",
  "inconclusive",
  "rolled_back",
] as const;
export const TicketStateSchema = z.enum(TICKET_STATES);
export type TicketState = (typeof TICKET_STATES)[number];

/**
 * What Stage 3 can actually put a ticket into. Everything else in the enum
 * belongs to a milestone whose mechanism does not exist yet — `deployed` and
 * `observing` need the opt-in deployment link, `rolled_back` needs health
 * observation.
 */
export const TICKET_STATES_REACHABLE = [
  "plan_review",
  "ready",
  "provisioning",
  "executing",
  "verifying",
  "independent_review",
  "pr_open",
  // Reached by `perbo sync`, from what local `gh` reports — a person's
  // merge, or, where D-077's `merge` switch is set to the loop, the runner's
  // own merge step, which `sync` then reads back the same way. Never by the
  // executor: `self_merge` is on its prohibited list either way.
  "merged",
  // D-083: reached by `perbo sync`, from `gh` reporting the pull request
  // closed and unmerged. Never by the executor, which has no way to close one.
  "closed",
  "changes_requested",
  "failed",
  "cancelled",
  // Reached by `perbo serve`, from the ticket's own `depends_on` and from
  // scope overlap with a ticket ahead of it in the queue (SCP-008 criterion
  // 5). Left the same way, by the queue, when what it waits on has merged.
  "blocked",
  // D-103: reached by `perbo run --ticket` finding the spec stale before the
  // attempt starts. Terminal: no row leaves it.
  "plan_invalid",
] as const satisfies readonly TicketState[];

export const TICKET_PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export const TicketPrioritySchema = z.enum(TICKET_PRIORITIES);
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/** The trackers a reference can name. A pasted file is not one of them. */
export const TICKET_TRACKER_KINDS = ["github", "jira", "linear"] as const;
export const TICKET_SOURCE_KINDS = [...TICKET_TRACKER_KINDS, "file", "none"] as const;
export const TicketSourceKindSchema = z.enum(TICKET_SOURCE_KINDS);
export type TicketSourceKind = (typeof TICKET_SOURCE_KINDS)[number];

/**
 * Absolute on either platform's rules, not on the one this process happens to
 * be running under. A ticket record travels with the repository, so a path
 * written on a POSIX machine is read on a Windows one and the check that
 * rejected it there would be a fact about the reader rather than the record.
 */
const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((path) => posix.isAbsolute(path) || win32.isAbsolute(path), {
    error: "a file source's reference must be an absolute path: it is read from another directory",
  });

/**
 * The mirror of {@link AbsolutePathSchema}, for the one path a ticket record
 * must **not** hold absolutely: where its repository is.
 *
 * Absolute on either platform's rules is refused here for the same reason it is
 * required there — the record travels. A `repository_root` of
 * `/Users/somebody/perbo` is a fact about the machine that ran `admit` and
 * about no other, so a clone of the repository on a second machine read it and
 * pointed `run` and `sync` at a directory that was not the checkout it had just
 * been asked about, or did not exist at all.
 */
const RelativePathSchema = z
  .string()
  .min(1)
  .refine((path) => !posix.isAbsolute(path) && !win32.isAbsolute(path), {
    error:
      "repository_root must be relative: a ticket is committed and read from other clones, " +
      "and an absolute path names the machine that admitted it",
  });

/**
 * Absolute on either platform's rules, for a caller that has to decide what a
 * stored path means rather than validate one. Same test as
 * {@link AbsolutePathSchema}, which is why it is the one both use.
 */
export function isAbsolutePath(path: string): boolean {
  return posix.isAbsolute(path) || win32.isAbsolute(path);
}

/** What every source carries whatever it is: a link, if there is one, and the title then. */
const sourceCommon = {
  url: z.url().nullable(),
  /** Recorded at admission and never refreshed: it is provenance, not a mirror. */
  title_at_admission: z.string().min(1).nullable(),
};

/**
 * Where the work was before it was admitted. A reference, and deliberately
 * nothing more: the external tracker keeps its own fields and receives a narrow
 * one-way status projection, and there is no field here that could hold a
 * mirrored copy of one.
 *
 * A union on `kind` rather than one object with a nullable reference, because
 * what the reference *is* depends entirely on the kind and the two illegal
 * combinations were both reachable before: a tracker source with nothing to
 * point at, and `none` — the kind that means "the work started here" — carrying
 * a reference anyway. `--from-file` wrote the second one, so a pasted file was
 * indistinguishable in the record from work that came from nowhere, and every
 * reader that switched on the kind had to guess from the shape of the string.
 * `file` is its own kind for that reason.
 */
export const TicketSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.enum(TICKET_TRACKER_KINDS),
    /** `owner/repo#412` or `PROJ-88`. A tracker source with nothing to point at is not one. */
    reference: z.string().min(1),
    ...sourceCommon,
  }),
  z.strictObject({
    kind: z.literal("file"),
    /** The file `--from-file` read, resolved: the only way back to what was admitted. */
    reference: AbsolutePathSchema,
    ...sourceCommon,
  }),
  z.strictObject({
    kind: z.literal("none"),
    /** The work started here, so there is nothing to reference. */
    reference: z.null(),
    ...sourceCommon,
  }),
]);
export type TicketSource = z.infer<typeof TicketSourceSchema>;

/**
 * How a source reads to a person, kind and all. Null when there is nothing to
 * show — `none` with no link is not a source that failed to render.
 *
 * One function because `inspect`, `list` and the pull-request body were each
 * printing the bare reference and each leaving the reader to infer what kind of
 * thing it was. An absolute path and a Jira key do not look alike, but a person
 * reading a pull request should not have to tell them apart by eye.
 */
export function ticketSourceLabel(source: TicketSource): string | null {
  if (source.kind === "none") return source.url === null ? null : `link ${source.url}`;
  return `${source.kind} ${source.reference}`;
}

/**
 * A human-facing key, `PRB-118`. Distinct from `ticket_id`, which is opaque and
 * is what every other contract references — the key is for people to type and
 * the id is for things to point at, and conflating them makes a renumbering a
 * data migration.
 */
export const TicketKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,6}$/, "ticket key must look like PRB-118");

export const TICKET_SCHEMA_VERSION = 1;

/**
 * Who opened the pull request on a ticket's branch: `loop` when this ticket's
 * own run opened it, `direct` when the registered comparison arm's own agent
 * did (SCP-206), `hand_off` when a person did.
 *
 * `loop` and `direct` are one fact about two arms — the arm's own automation
 * opened it — which is why `unattendedMergeStatus` reads them alike; `hand_off`
 * is the other fact, that a person did.
 *
 * Stated here rather than beside the functions that decide it, because the
 * delivery record below carries the decision and the record has to be able to
 * name its own values.
 */
export const PullRequestAttributionSchema = z.enum(["loop", "direct", "hand_off"]);
export const PULL_REQUEST_ATTRIBUTIONS = PullRequestAttributionSchema.options;
export type PullRequestAttribution = z.infer<typeof PullRequestAttributionSchema>;

/**
 * Which arm produced a delivery record (SCP-198, SCP-206).
 *
 * `loop` is `perbo run --ticket`: a contract, an executor, an independent
 * review and remediation before a pull request exists. `direct` is the
 * registered comparison arm — one coding-agent invocation given the same
 * approved text and told to open a pull request itself.
 *
 * The default is `loop` and it is load-bearing: every record written before
 * this field existed was the loop's, so defaulting is the truth about them
 * rather than a convenience.
 */
export const DELIVERY_ARMS = ["loop", "direct"] as const;
export const DeliveryArmSchema = z.enum(DELIVERY_ARMS);
export type DeliveryArm = z.infer<typeof DeliveryArmSchema>;

/**
 * Which way a review that could not resolve every criterion reached its end.
 *
 * `incomplete_remediated` — every criterion the review could not resolve hung
 * on a finding the executor may be handed, so a remediation round ran on those
 * findings and the re-review that followed reached the run's verdict.
 * `incomplete_escalated` — at least one such criterion had no remediable cause,
 * or no round was left to spend, so a person decided without a round running.
 *
 * Both can end in an escalation, and they are different facts about the loop:
 * one asked a person after trying, the other asked without. Null is every run
 * whose review resolved its criteria, and every record written before the field
 * existed.
 */
export const INCOMPLETE_REVIEW_PATHS = ["incomplete_remediated", "incomplete_escalated"] as const;
export const IncompleteReviewPathSchema = z.enum(INCOMPLETE_REVIEW_PATHS);
export type IncompleteReviewPath = z.infer<typeof IncompleteReviewPathSchema>;

/**
 * Why a ticket waits (SCP-008 criterion 5): a `depends_on` key the person
 * wrote that has not merged, or a ticket ahead of it in the queue whose scope
 * this one's reaches. Nothing else — a wait the queue cannot name from a
 * record a person approved is not one it may impose.
 */
export const WAIT_REASONS = ["depends_on", "scope_overlap"] as const;
export const WaitReasonSchema = z.enum(WAIT_REASONS);
export type WaitReason = z.infer<typeof WaitReasonSchema>;

export const WaitSchema = z.strictObject({
  /** The ticket waited on. */
  key: TicketKeySchema,
  reason: WaitReasonSchema,
  /**
   * For `scope_overlap`: what the ticket ahead holds that this one's scope
   * reaches — its globs before it has sealed, the paths it changed after.
   * Empty for a dependency.
   */
  paths: z.array(z.string().min(1)),
  /** The state the ticket waited on was in when this was decided; null where the store does not hold it. */
  state: TicketStateSchema.nullable(),
});
export type Wait = z.infer<typeof WaitSchema>;

/**
 * The queue's reading of the ticket, written whole each time it is decided.
 *
 * Stored rather than derived at read time so that `perbo list --json` keeps
 * its rule — nothing in it is computed — and so the reason a ticket is
 * `blocked` is on the record the person is looking at, not in the head of the
 * process that put it there.
 */
/**
 * The last re-level the queue ran for this ticket that did not leave the
 * branch level (SCP-227): the base tip it ran against and how the run ended.
 *
 * Written so the queue does not spend the same reconciliation round against
 * the same base tip every minute — a round that came back to the same
 * conflict has answered the question, and asking again is the same answer
 * paid for twice. The queue tries again once the base has moved past this
 * tip, and a person can run the ticket by hand at any time.
 */
export const ReconciliationSchema = z.strictObject({
  base_tip: z.string().regex(/^[0-9a-f]{7,40}$/),
  /** `perbo run --relevel`'s exit code: what the run said, in the one number a parent process gets. */
  exit_code: z.number().int(),
  at: z.iso.datetime(),
  /** What the re-level answered — a refusal's message, or the outcome and detail of a run that completed without levelling — so `list` says why and not only that. Null on a record written before this was kept. */
  reason: z.string().nullable().default(null),
});
export type Reconciliation = z.infer<typeof ReconciliationSchema>;
export type ReconciliationInput = z.input<typeof ReconciliationSchema>;

export const SchedulingSchema = z.strictObject({
  waits_on: z.array(WaitSchema),
  /**
   * When `waits_on` last changed. The queue writes the record only where the
   * reading differs from what is stored, so a ticket that has never waited
   * keeps `null` rather than a timestamp a minute old.
   */
  decided_at: z.iso.datetime().nullable(),
  reconciliation: ReconciliationSchema.nullable().default(null),
});
export type Scheduling = z.infer<typeof SchedulingSchema>;

/** One file the spec commit holds, by repository-relative path and content hash. */
export const SpecFileSchema = z.strictObject({
  path: z.string().min(1),
  content_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/, "a spec file's hash must be sha256:<64 hex>"),
});
export type SpecFile = z.infer<typeof SpecFileSchema>;

/**
 * The spec a contract was drafted from (D-103): its path relative to the
 * repository, the SHA-256 of the bytes the contract was approved from — which
 * is what a later read compares against to find the spec stale — the files the
 * loop commits first on the ticket's branch, and the names the repository had
 * when the plan was approved, which is the other half of that reading.
 *
 * The hash is admission's until `perbo approve` replaces it with the bytes it
 * read, because between drafting and approving is when a person reads the draft
 * and edits the spec, and D-103 makes an edit **after approval** the stale one.
 * It stays admission's on a spec approval could not read.
 *
 * `files` covers the spec's own folder and whatever the interview changed
 * beside it: `CONTEXT.md` and the ADR folder. Admission's is the first cut,
 * and `perbo approve` re-takes it the same way it re-takes the hash above,
 * so the `spec.md` entry here always carries the same hash as
 * `content_sha256`; it too stays admission's on a spec approval could not
 * read. `files` is empty on a record written before the loop committed
 * anything, which {@link admittedSpecFiles} reads as the spec alone, and that
 * is what such a ticket's branch carries.
 */
export const AdmittedSpecSchema = z.strictObject({
  path: z.string().min(1),
  content_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/, "spec hash must be sha256:<64 hex>"),
  files: z.array(SpecFileSchema).default([]),
  /**
   * The names the spec carries — paths as it spells them, symbols with their
   * `@` — that this repository had when the plan was approved. Written at
   * approval and nowhere else, because that is the moment the plan was agreed
   * against the repository as it stood.
   *
   * *Had* is git's tree for a path and the symbol index for a symbol. A record
   * travels between checkouts, so a path is here only where the tracked tree
   * holds it: a build output one machine carries is that machine's and not the
   * repository's, and recording it would have a fresh clone read the spec as
   * one that has lost a file.
   *
   * It is what makes a name stale: a name in this list that no longer resolves
   * is code the repository has lost, and a name not in it is code the plan is
   * for and has yet to write. Without it every spec describing work still to do
   * would be stale on its ticket's first run.
   *
   * `null` on a record written before the list existed, and on one approved by
   * a version that did not record it. Such a record has no baseline to measure
   * against, so the names in its spec are reported unjudged rather than stale —
   * the same reading an index that cannot be believed gets. An empty list is a
   * different answer: the spec was approved naming nothing this repository had.
   */
  names_that_resolved: z.array(z.string().min(1)).nullable().default(null),
  /**
   * Whether the symbol index was evidence about this checkout when the plan was
   * approved, and so whether the `@Symbol` half of `names_that_resolved` was
   * taken at all.
   *
   * False leaves that half empty: the index is stamped with a commit and a
   * clean-or-not tree (D-015), and approving at another commit or over
   * uncommitted changes in tracked files means it says nothing about the tree
   * the plan was signed against. Editing the spec in `plan_review` — the
   * ordinary thing to do while reading the draft — is itself such a change, so
   * this is not a rare state.
   *
   * It is recorded because the reading side cannot tell that from a spec whose
   * symbols the repository genuinely did not have. Without it the symbol half
   * would go missing in silence and a later `perbo inspect` would call the
   * spec current over a name that had gone; with it, those names are reported
   * unjudged and `perbo index` is named as what fixes the next admission.
   *
   * `true` on a record written before this was recorded: such a record was
   * written by a version that took the baseline exactly as this one does, so
   * reading it as judged leaves those tickets as they were.
   */
  symbols_judged_at_approval: z.boolean().default(true),
});
export type AdmittedSpec = z.infer<typeof AdmittedSpecSchema>;

/**
 * The files the loop commits for an admission record, in the order it recorded
 * them, and the spec alone for a record written before the list existed.
 */
export function admittedSpecFiles(spec: AdmittedSpec): SpecFile[] {
  if (spec.files.length > 0) return [...spec.files];
  return [{ path: spec.path, content_sha256: spec.content_sha256 }];
}

export const TicketSchema = z.strictObject({
  schema_version: z.literal(TICKET_SCHEMA_VERSION),
  ticket_id: TicketIdSchema,
  key: TicketKeySchema,
  /**
   * What the ticket is called (D-127).
   * Display only: the plan contract's `outcome` is its own.
   */
  title: z.string().min(1),
  state: TicketStateSchema,
  priority: TicketPrioritySchema,
  labels: z.array(z.string().min(1)),
  /** Other tickets that must be done first. Keys, because a person writes them. */
  depends_on: z.array(TicketKeySchema),
  /** What the queue last decided this ticket waits on. Defaults to nothing, which is every record written before the queue existed. */
  scheduling: SchedulingSchema.default({ waits_on: [], decided_at: null, reconciliation: null }),
  source: TicketSourceSchema,
  /**
   * The checkout this ticket's work happens in, **resolved**: an absolute path
   * on the machine holding the ticket in memory, which is what `run` and `sync`
   * hand to git.
   *
   * Not what is on disk. The stored form is {@link StoredTicketSchema}'s — a
   * path relative to the store, or absent — and the store resolves it against
   * the clone it read the file out of. The two shapes are separate types rather
   * than one nullable field so that neither side can be used as the other by
   * accident: a value read here is always a real directory, and a value written
   * there is never one machine's.
   */
  repository_root: z.string().min(1),
  /** The plan contract admission drafted. One ticket, one plan, many versions. */
  plan_id: PlanIdSchema,
  plan_version: z.number().int().positive(),
  /** Set when the contract is approved; immutable from that moment (ADR-0016). */
  approved_at: z.iso.datetime().nullable(),
  admitted_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  /**
   * ADR-0027's own measurement, recorded per ticket because E1 cannot be
   * interpreted without it: a partner who abandons over admission friction is
   * not distinguishable from one who abandons because the loop is slow.
   */
  admission: z.strictObject({
    /**
     * The `admit` command's own runtime: from the process starting to the
     * ticket existing. It measures the machine, not the person — the person's
     * time is `human_elapsed_ms`.
     */
    elapsed_ms: z.number().int().min(0),
    /**
     * How the criteria arrived. `imported` means from the source's own text;
     * `drafted` means a model drafted them from the source and a person then
     * edited and approved (the founder's decision of 2026-09-02, under ADR-0023
     * §4: the draft is never executed, only the approved contract is); `spec`
     * is the same drafting from a spec committed in the repository (D-103),
     * which is the only source that carries requirement ids.
     */
    criteria_source: z.enum(["typed", "imported", "file", "drafted", "spec"]),
    criteria_count: z.number().int().min(1),
    /** When the model's draft was produced. Null unless a model drafted them. */
    drafted_at: z.iso.datetime().nullable().default(null),
    /**
     * The spec this contract was drafted from (D-103), and every file the loop
     * commits with it. Null for every other source, and defaulted so a ticket
     * admitted before specs existed reads back as having none, which it has.
     */
    spec: AdmittedSpecSchema.nullable().default(null),
    /**
     * Wall clock from the contract first being shown (`admitted_at`) to
     * `approved_at` — the admission-friction instrument D-003 and ADR-0027 ask
     * for. Written at approval; null until then.
     */
    human_elapsed_ms: z.number().int().min(0).nullable().default(null),
    /**
     * How many fields `perbo edit` changed between the contract as first
     * rendered and the contract that was approved: the outcome, each criterion
     * added, removed or reworded, each scope glob added or removed. A field
     * edited twice counts once — it is one field the rendering got wrong.
     *
     * Written by each edit and again at approval. For a counter-sealed ticket
     * (see `counter_sealed_at`) it comes from the record the draft snapshot
     * keeps of what each edit applied, and a difference between the two files
     * is never counted as an edit — approval refuses that ticket instead. For a
     * ticket with no counter-seal it is still the difference between the two
     * files, which is what the version that wrote that store measured.
     */
    edit_count: z.number().int().min(0).nullable().default(null),
    /**
     * When the contract was last written to both files at once — the ticket's
     * own record that a counter-seal exists for it.
     *
     * `admit` writes `<KEY>.contract.json` and the copy inside
     * `<KEY>.draft.json` together, `perbo edit` rewrites both, and nothing else
     * writes either. Approval and `perbo run --ticket` therefore require the
     * pair to be present and identical, and refuse the ticket otherwise: a
     * contract that differs from its counter-seal, or has lost it, is one
     * nobody was shown.
     *
     * Null means no counter-seal was ever written for this ticket, which is a
     * ticket admitted before they were. Those keep the older behaviour — the
     * pair is not required and not compared — because for them a difference is
     * the work of an `perbo edit` that only rewrote one file, and refusing
     * them would strand every unapproved and every approved-but-unrun ticket in
     * an existing store. A single `perbo edit` counter-seals such a ticket
     * from then on.
     *
     * It is a record, not a proof: everything here is a file the person owns,
     * and someone who edits the contract can edit this too. What it buys is
     * that a hand edit is no longer a single-file change that nothing notices.
     */
    counter_sealed_at: z.iso.datetime().nullable().default(null),
    /**
     * Where the plan level came from. `derived` is `derivePlannedRisk` over the
     * declared scope; `raised` means a person raised it above the derivation
     * with `--level`. A person may never lower it (D-010). Null for a ticket
     * admitted while the level was still typed.
     */
    level_source: z.enum(["derived", "raised"]).nullable().default(null),
    /** The level the scope derived to, before any raise. */
    derived_level: PlanLevelSchema.nullable().default(null),
  }),
  /**
   * What local `git`/`gh` last reported about this ticket's delivery.
   *
   * Written whole every time it is observed, never patched — the poller it
   * comes from is idempotent by construction and this record inherits that.
   * GitHub stays authoritative for the pull request; this is a cache of what it
   * said and when, which is why `observed_at` sits beside the values rather
   * than being inferable from `updated_at`.
   */
  delivery: z
    .strictObject({
      branch: z.string().min(1).nullable(),
      pull_request_url: z.string().min(1).nullable(),
      pull_request_number: z.number().int().positive().nullable(),
      state: z.enum(["none", "open", "merged", "closed"]),
      observed_at: z.iso.datetime().nullable(),
      /**
       * SCP-173: who opened the pull request this record names, decided when
       * that number first entered the record and never revised afterwards.
       *
       * The rest of this record is a cache of what `gh` said; this one field is
       * a fact about the loop's own doing, and it is here because nothing else
       * on the ticket can carry it. `recordDelivery` writes `loop` because the
       * run it is recording opened the pull request itself, and `perbo sync`
       * writes `hand_off` for a number the record has never held on a ticket no
       * run is inside — SCP-157's case, decided whatever state that pull
       * request is in, so that a stranger's pull request seen while it was
       * `closed` is still a stranger's when it reopens.
       *
       * Null is "nothing has decided": no pull request, a record written before
       * this field existed, or an observation nothing can attribute — the pull
       * request a stranded ticket's dead run may or may not have opened. For
       * those `attributePullRequest` falls back to the number matching, which
       * is what it did before this field, so an old store keeps its old answer
       * rather than a worse one. `attributionOnRecord` states the whole rule.
       */
      opened_by: PullRequestAttributionSchema.nullable().default(null),
      /**
       * SCP-192: whether GitHub can still merge this pull request into its
       * base, as `gh` last reported it.
       *
       * The loop opens a pull request over a branch it has just merged the base
       * into, so it is mergeable at the moment it opens; the base moving
       * afterwards is what takes that away, and only GitHub can see it. Three
       * answers rather than a boolean because GitHub computes mergeability
       * asynchronously: `unknown` is "not yet", and recording it as a conflict
       * would send a person to re-run a ticket whose branch is fine.
       *
       * Null is a record nothing has observed this on — one written before the
       * field existed, or a ticket with no pull request.
       */
      mergeable: z.enum(["mergeable", "conflicting", "unknown"]).nullable().default(null),
      /**
       * SCP-196: whether any commit `gh` lists on this pull request was
       * authored outside the loop — decided from each commit's own message,
       * never from who git records as its author. The loop pushes under a
       * credential that can read as a person's, and a merge-up or seal commit
       * it made (`mergeUp`, `sealChangeSet`) carries its attempt id in the
       * message regardless of whose name is on it; `commitCarriesLoopAttempt`
       * is the check, and `unattendedMergeStatus` is what reads this beside
       * `opened_by` to decide whether a merge went unattended.
       *
       * Null where `gh` named no commits to judge this on: no pull request, a
       * `gh` too old to answer, or a record written before this field existed.
       */
      commits_outside_loop: z.boolean().nullable().default(null),
      /**
       * SCP-200: which credential path GitHub was read or written through for
       * this record — `GH_TOKEN` from the process's own environment, or the
       * machine's shared `gh` login. Never the token itself.
       *
       * A cache of what the last GitHub-side step used, like the rest of this
       * record: `recordDelivery` writes the path the run published through and
       * `perbo sync` overwrites it with the path it polled through. Null where
       * nothing has reached GitHub for this ticket, or on a record written
       * before the field existed.
       */
      github_credential: GithubCredentialSchema.nullable().default(null),
      /**
       * SCP-206: which arm this record belongs to, decided by whatever wrote
       * it first and never revised afterwards.
       *
       * It is not a cache of anything `gh` says — GitHub cannot tell a pull
       * request the loop opened from one a direct agent opened — so `perbo
       * sync` carries it across the record it rewrites rather than reading it.
       * `stops` and `escapes` read both arms through the same fields, and this
       * is the only field that says which of the two a row is.
       */
      arm: DeliveryArmSchema.default("loop"),
      /**
       * SCP-202: which arm's automation performed the merge, written by the
       * step that performed it and by nothing else.
       *
       * Not a cache of anything `gh` says — GitHub reports who the merge was
       * authenticated as, which is the same credential the loop pushes under —
       * so, like `arm` and `opened_by`, `perbo sync` carries it across the
       * record it rewrites rather than reading it.
       *
       * Null is every merge that is not the loop's own: a person's click, and
       * every record written before the switch existed. That asymmetry is the
       * honest one — this field can only ever be first-hand about a merge this
       * system made — and it is what D-077's reversal trigger counts, since a
       * merge a person made and then reverted says nothing about the loop.
       */
      merged_by: DeliveryArmSchema.nullable().default(null),
      /**
       * Which way the run's review reached its end where it could not resolve
       * every criterion, written by the run and by nothing else.
       *
       * Not a cache of anything `gh` says — GitHub cannot see whether a
       * remediation round ran — so, like `arm` and `merged_by`, `perbo sync`
       * carries it across the record it rewrites rather than reading it. It
       * describes the latest run recorded here: a re-run whose review resolved
       * its criteria writes null over it, because that is what that run did.
       */
      incomplete_review: IncompleteReviewPathSchema.nullable().default(null),
      /**
       * The checks on the head this pull request was opened over, as the run
       * that opened it read them and as every later `perbo sync` re-reads
       * them: one entry per check, with `unchecked` where nothing had
       * concluded by the time the reader stopped waiting.
       *
       * A check that fails only on the reviewer's checkout is invisible to the
       * gate that opened the pull request unless the gate reads it, and this
       * is where that reading is kept.
       */
      checks: z.array(DeliveredCheckSchema).default([]),
      /**
       * What those conclusions add up to: `green`, `checks_failed`, or
       * `unchecked` where nothing concluded in time. Null where nothing has
       * read them — no pull request, or a record written before the field
       * existed — which is a third answer rather than a pass.
       */
      checks_state: DeliveryChecksStateSchema.nullable().default(null),
    })
    .default({
      branch: null,
      pull_request_url: null,
      pull_request_number: null,
      state: "none",
      observed_at: null,
      opened_by: null,
      mergeable: null,
      commits_outside_loop: null,
      github_credential: null,
      arm: "loop",
      merged_by: null,
      incomplete_review: null,
      checks: [],
      checks_state: null,
    }),
  /** Appended to, never rewritten. A run not recorded is lost permanently. */
  history: z
    .array(
      z.strictObject({
        at: z.iso.datetime(),
        from: TicketStateSchema.nullable(),
        to: TicketStateSchema,
        note: z.string().min(1),
        /**
         * SCP-173: whether this row records a **hand-off** — a person opened
         * the pull request the loop did not.
         *
         * Written on every row that moves a `failed` ticket to `pr_open`, both
         * ways round: `true` for a hand-off and `false` for the loop's own pull
         * request outliving a re-run that failed. The two share the row's
         * states, which is why a reader has to ask this rather than read them.
         * Absent on every other kind of row, where the question does not arise.
         *
         * Optional rather than defaulted: a hand-off recorded before this field
         * existed says so in its note alone, and defaulting would write `false`
         * over those rows and lose the only record there is. Read it through
         * `isHandOff`, which falls back to the note for exactly them — and,
         * because rows written since always carry the flag, for nothing else.
         */
        handed_off: z.boolean().optional(),
      }),
    )
    .min(1),
});
export type Ticket = z.infer<typeof TicketSchema>;

/**
 * A ticket as it is **written to and read from a file**.
 *
 * The one difference from {@link TicketSchema} is `repository_root`, and it is
 * the difference between a record that travels and one that does not. A ticket
 * file is committed: it is read back out of a fresh clone, out of a worktree,
 * out of a colleague's machine and out of CI, and the directory the repository
 * sits in is different in every one of them. So the file records where the
 * repository is *relative to the store the file is in* — `..` for the ordinary
 * `<repo>/.perbo` — and the reader resolves it against the store it actually
 * loaded. Absent means the same as `..`, which is what a ticket admitted before
 * this field was relative reads as once its author's absolute path has been
 * dropped: nothing about the writing machine survives into the reading one.
 */
export const StoredTicketSchema = TicketSchema.extend({
  repository_root: RelativePathSchema.optional(),
});
export type StoredTicket = z.infer<typeof StoredTicketSchema>;

/** One row of a ticket's history: a state it moved to, and why. */
export type TicketHistoryEntry = Ticket["history"][number];

/**
 * The transitions Stage 3 can drive, as data.
 *
 * A table rather than a switch, for the same reason the blocking matrix is a
 * lookup: an illegal transition should be a missing row that can be printed,
 * not a branch somebody forgot to write.
 */
export interface TicketTransition {
  from: TicketState;
  to: TicketState;
  /**
   * SCP-206: a row only some records may take, decided from the record itself
   * rather than from the evidence a caller holds.
   *
   * Guarding on the record keeps the reconciler's own refusal intact: a loop
   * ticket whose evidence disagrees with itself still cannot be walked to a
   * state no unguarded row reaches, because the guard says nothing about
   * evidence and everything about which arm the row belongs to — or, for the
   * one row a single step of the loop takes, about the note that step writes.
   */
  when?: (ticket: Pick<Ticket, "delivery">, note: string) => boolean;
}

/**
 * D-083: the guard both rows off `pr_open` besides the merge are written under
 * — the delivery record saying `gh` reports this pull request closed.
 *
 * What each row records is a pull request that closed, so a record still
 * reporting it open has no business on either. Guarding on the record rather
 * than on evidence a caller holds is the same device the arm row uses: it says
 * nothing about who is asking and everything about which records may go there.
 */
const pullRequestIsClosed = (ticket: Pick<Ticket, "delivery">): boolean =>
  ticket.delivery.state === "closed";

/**
 * How the row a decided delivery writes begins: the one note that takes a
 * ticket from `provisioning` to `pr_open`
 * (D-NEW-a-person-s-answer-closes-a-routed-finding).
 */
export const DECIDED_DELIVERY_NOTE = "every finding the review routed to a person is decided";

export const TICKET_TRANSITIONS: ReadonlyArray<TicketTransition> = [
  { from: "plan_review", to: "ready" },
  { from: "plan_review", to: "cancelled" },
  { from: "ready", to: "provisioning" },
  { from: "ready", to: "cancelled" },
  // SCP-008 criterion 5: the queue's two rows. A ticket waits while a
  // dependency is unmerged or a ticket ahead of it holds a scope it reaches,
  // and is ready again when that is no longer so. Nothing runs from `blocked`;
  // a person running it by hand reopens it to `ready` first, which is their
  // decision to override the queue.
  { from: "ready", to: "blocked" },
  // D-103: a run refuses to start a ticket whose spec has been edited since
  // the contract was approved from it, or whose spec names code the repository
  // no longer has, and leaves the ticket here. Nothing goes the other way: the
  // contract was approved against a statement that has changed, and an
  // approved contract is immutable (ADR-0016), so the work is admitted again.
  { from: "ready", to: "plan_invalid" },
  { from: "blocked", to: "ready" },
  { from: "blocked", to: "cancelled" },
  { from: "provisioning", to: "executing" },
  { from: "provisioning", to: "failed" },
  { from: "executing", to: "verifying" },
  { from: "executing", to: "failed" },
  { from: "executing", to: "cancelled" },
  // SCP-206: the registered comparison arm reaches a pull request with no
  // independent review of its own — that absence is the property under
  // measurement — so its record has to be able to reach `pr_open` without
  // claiming one. Guarded on the record's arm rather than on the evidence, so
  // the reconciler's refusal for a loop ticket stands exactly where it stood,
  // and so `escapes`, which needs a merged record, can see this arm at all.
  {
    from: "executing",
    to: "pr_open",
    when: (ticket) => ticket.delivery.arm === "direct",
  },
  { from: "verifying", to: "independent_review" },
  { from: "verifying", to: "failed" },
  { from: "independent_review", to: "pr_open" },
  // D-NEW-a-person-s-answer-closes-a-routed-finding: a run that finds every
  // finding the last review routed to a person decided, on the commit that
  // review judged, executes and reviews nothing and goes where an approval
  // goes. Only the row that run writes takes it, so nothing that reconciles
  // evidence can reach `pr_open` from here without a review behind it.
  {
    from: "provisioning",
    to: "pr_open",
    when: (_ticket, note) => note.startsWith(DECIDED_DELIVERY_NOTE),
  },
  { from: "independent_review", to: "changes_requested" },
  // An attempt can terminate after its review — a ceiling reached on a
  // remediation round, or repository-supplied agent configuration found on
  // handover. Without this row the ticket had nowhere legal to go and was left
  // claiming `independent_review` for a run that did not complete.
  { from: "independent_review", to: "failed" },
  { from: "changes_requested", to: "ready" },
  { from: "changes_requested", to: "cancelled" },
  { from: "failed", to: "ready" },
  { from: "pr_open", to: "merged" },
  // D-083: a pull request GitHub closed without merging. `closed` is what the
  // record settles at, and `changes_requested` is where a D-073 CHANGES
  // REQUESTED verdict on that pull request puts it instead — the verdict is
  // the fact about the review, and mergeability a fact about a branch a closed
  // pull request no longer has. `perbo sync` is the only path onto either.
  { from: "pr_open", to: "closed", when: pullRequestIsClosed },
  { from: "pr_open", to: "changes_requested", when: pullRequestIsClosed },
  // What `failed` admits, and for the same reason: the work can be run again.
  // Nothing else — a closed pull request is not handed off, because there is
  // no open pull request left on the branch to hand off.
  { from: "closed", to: "ready" },
  // A `failed` ticket's branch carries a pull request. Two things put one
  // there — SCP-157's person finishing what the loop could not, and the loop's
  // own pull request from an earlier round outliving a re-run that failed —
  // and this row is both. `handOff` and `resumeAtPullRequest` below are the
  // only paths that take it; each refuses without pull-request evidence, which
  // this table has no way to check, and each records which of the two it was.
  { from: "failed", to: "pr_open" },
];

export class IllegalTransitionError extends Error {
  constructor(from: TicketState, to: TicketState) {
    // Guarded rows are left out: a message naming one would send a person to a
    // route their own record cannot take.
    const allowed = TICKET_TRANSITIONS.filter((row) => row.from === from && row.when === undefined).map(
      (row) => row.to,
    );
    super(
      `a ticket in ${from} cannot move to ${to}` +
        (allowed.length > 0
          ? ` (from ${from} it may go to: ${allowed.join(", ")})`
          : ` (${from} is terminal for now)`),
    );
    this.name = "IllegalTransitionError";
  }
}

/** Move a ticket, appending to its history. Refuses a transition with no row. */
export function transition(
  ticket: Ticket,
  to: TicketState,
  note: string,
  at: Date = new Date(),
): Ticket {
  const row = TICKET_TRANSITIONS.find(
    (candidate) =>
      candidate.from === ticket.state &&
      candidate.to === to &&
      (candidate.when?.(ticket, note) ?? true),
  );
  if (!row) throw new IllegalTransitionError(ticket.state, to);
  return TicketSchema.parse({
    ...ticket,
    state: to,
    updated_at: at.toISOString(),
    history: [...ticket.history, { at: at.toISOString(), from: ticket.state, to, note }],
  });
}

/**
 * The evidence a `failed` ticket cannot be moved to `pr_open` without: a pull
 * request on the ticket's own branch. A distinct type for the same reason
 * `UnreachableStateError` is one — a caller has to tell a refused hand-off
 * from a ticket that no longer validates.
 */
export class HandOffEvidenceError extends Error {
  constructor(ticket: Ticket) {
    super(`cannot move ${ticket.key} from failed to pr_open: no pull request is recorded on its branch`);
    this.name = "HandOffEvidenceError";
  }
}

/**
 * SCP-176: attribute a pull request from the ticket's own history alone, for
 * a delivery record that does not say who opened it — `opened_by: null`,
 * whether because the record predates the field or because nothing has
 * decided it since.
 *
 * The last row that moved the ticket to `pr_open` is the one that put it
 * behind the pull request in question, the same row `pullRequestWasHandedOff`
 * reads. A hand-off row is a person's. A row `from: "independent_review"` is
 * the loop's own ordinary path there, which a hand-off never takes — only
 * `handOff`/`resumeAtPullRequest` reach `pr_open` from `failed`, and a row
 * either of them wrote says which one round it was, explicitly. Anything
 * else — no `pr_open` row at all, or a `failed -> pr_open` row with neither a
 * flag nor a matching note to go on — is a record this function was never
 * given the means to attribute, so it says nothing rather than guessing.
 */
function attributionFromHistory(history: ReadonlyArray<TicketHistoryEntry>): PullRequestAttribution | null {
  const opened = history.findLast((entry) => entry.to === "pr_open");
  if (opened === undefined) return null;
  if (isHandOff(opened)) return "hand_off";
  if (opened.from === "independent_review") return "loop";
  if (opened.from === "failed" && opened.handed_off === false) return "loop";
  return null;
}

/**
 * SCP-173/SCP-176: attribute the pull request `gh` reports on a `failed`
 * ticket's branch, from the ticket's own delivery record and history.
 *
 * The record is written whole by `recordDelivery` the moment the loop opens a
 * pull request, and a later attempt failing never clears it — so a ticket that
 * reached `changes_requested`, was re-run and failed still names the number the
 * loop opened, and says on the record that the loop is who opened it. A number
 * the record has never held is somebody else's, and so is a number it holds
 * with `hand_off` against it, however long ago that was decided. Nothing here
 * asks `gh`; the observation is the caller's.
 *
 * `opened_by` being null is a record from before it existed, or one nothing
 * has decided since, and for those the number matching alone is not evidence
 * of anything: `attributionFromHistory` reads the ticket's own history for
 * what the delivery record cannot say. A record neither can attribute is
 * `null` — unknown, never defaulted to the loop for lack of a better answer.
 */
export function attributePullRequest(
  ticket: Pick<Ticket, "delivery" | "history">,
  observed: { pull_request_number: number | null },
): PullRequestAttribution | null {
  const recorded = ticket.delivery.pull_request_number;
  if (recorded === null || observed.pull_request_number === null) return "hand_off";
  if (observed.pull_request_number !== recorded) return "hand_off";
  return ticket.delivery.opened_by ?? attributionFromHistory(ticket.history);
}

/**
 * SCP-173/SCP-176: what `delivery.opened_by` should say once this observation
 * is written to the record — the counterpart of `attributePullRequest`, which
 * reads the record this decides.
 *
 * The two are separate because they answer different questions. That one asks
 * who to credit for a move being made now, and must answer for every case. This
 * one asks what the record may claim to know, and says null wherever nothing
 * decided it.
 *
 * A number already on the record keeps the attribution already on the record
 * when the record has one, whatever state that pull request is now in. That is
 * the whole of the fix for a stranger's pull request seen while it was
 * `closed`: sync does not walk the ticket then, but the record remembers whose
 * the number is, so reopening it is still a hand-off rather than a number the
 * record happens to name. A record with nothing decided — `opened_by: null` —
 * is decided from history the same way `attributePullRequest` decides it, so
 * a legacy record learns its answer once instead of asking history again on
 * every sync.
 *
 * A number the record has never held was opened by nothing this ticket did:
 * every pull request a run opens is recorded by the run that opened it. The one
 * exception is the run that opened one and died before recording it, which is
 * the ticket `midRun` describes — its branch may carry its own dead run's pull
 * request or a person's, and the record claiming either would be this function
 * inventing the provenance it exists to preserve.
 */
export function attributionOnRecord(
  ticket: Pick<Ticket, "delivery" | "history">,
  observed: { pull_request_number: number | null },
  evidence: {
    /** Whether a run of this ticket could still have opened it unrecorded. */
    midRun: boolean;
  },
): PullRequestAttribution | null {
  if (observed.pull_request_number === null) return null;
  if (observed.pull_request_number === ticket.delivery.pull_request_number) {
    return ticket.delivery.opened_by ?? attributionFromHistory(ticket.history);
  }
  return evidence.midRun ? null : "hand_off";
}

/**
 * The phrase a hand-off row's note carries, and the fallback `isHandOff` reads
 * on a row written before `handed_off` existed.
 *
 * Exported so the writer and the reader cannot drift: `sync` composes the note
 * from this constant and `isHandOff` looks for this constant, rather than each
 * carrying its own spelling of the same sentence.
 */
export const HAND_OFF_NOTE = "handed off: a person opened it, the loop did not";

/**
 * SCP-176: the phrase a row written by `resumeWithUnrecordedOpener` carries —
 * the counterpart of `HAND_OFF_NOTE` for a `failed -> pr_open` row that
 * attributes to neither a person nor the loop.
 */
export const OPENER_UNKNOWN_NOTE = "the opener is not recorded";

/**
 * Whether a history row records a hand-off.
 *
 * The row's flag when it has one, and its note when it does not — the rows in
 * a store written before the flag existed say it in prose and there is no
 * migration that could reach them, since a ticket record travels with the
 * repository it belongs to. The note is read only on a row that could be a
 * hand-off at all, so that a row quoting the sentence for any other reason is
 * a row quoting a sentence.
 *
 * What it deliberately does not read for the answer is `from`/`to`.
 * `failed -> pr_open` is the row for *both* a hand-off and the loop's own pull
 * request outliving a failed re-run, so the edge locates the rows that were
 * asked the question and says nothing about how any of them answered.
 */
export function isHandOff(entry: TicketHistoryEntry): boolean {
  if (entry.handed_off !== undefined) return entry.handed_off;
  return entry.from === "failed" && entry.to === "pr_open" && entry.note.includes(HAND_OFF_NOTE);
}

/**
 * Whether the pull request the ticket is *at* was handed off.
 *
 * The last row that reached `pr_open` and no other: that row is the one that
 * put the ticket behind the pull request its delivery record now names, and it
 * is the pull request a reader is asking about. A hand-off further back was a
 * hand-off of some earlier pull request, and answering with it would say a
 * person opened the one on the ticket today.
 *
 * False for a ticket that never reached `pr_open`, which is a ticket with no
 * pull request for the question to be about.
 */
export function pullRequestWasHandedOff(ticket: Pick<Ticket, "history">): boolean {
  return pullRequestAttribution(ticket) === "hand_off";
}

/**
 * SCP-176: who the ticket's own history says opened the pull request it is
 * *at* — `hand_off`, `loop`, or `null` where the last row that reached
 * `pr_open` does not say. The tri-state counterpart of
 * `pullRequestWasHandedOff`, for a reader (`inspect`) that has to tell "the
 * loop" from "nobody recorded it" rather than collapse both to `false`.
 */
export function pullRequestAttribution(ticket: Pick<Ticket, "history">): PullRequestAttribution | null {
  return attributionFromHistory(ticket.history);
}

/**
 * SCP-157: move a `failed` ticket to `pr_open` because a person delivered
 * what the loop could not. The row it writes is marked `handed_off`.
 *
 * The evidence is the caller's alone — this never asks `gh` and never infers
 * a pull request that was not handed to it, so `sync` is the only caller that
 * can supply it truthfully. The note is the caller's too, for the same reason
 * every other transition's note is: this package moves the ticket, it does
 * not narrate the move.
 */
export function handOff(
  ticket: Ticket,
  evidence: { pull_request_url: string | null },
  note: string,
  at: Date = new Date(),
): Ticket {
  return fromFailedToPullRequest(ticket, evidence, "hand_off", note, at);
}

/**
 * SCP-173: move a `failed` ticket to `pr_open` because the pull request on its
 * branch is the loop's own — opened on an earlier round, and still there after
 * a re-run failed. The counterpart of `handOff`, and the row it writes is
 * marked `handed_off: false`, because nobody handed anything off.
 *
 * The same evidence rule and the same caller: `attributePullRequest` decides
 * which of the two this is, from the ticket's delivery record.
 */
export function resumeAtPullRequest(
  ticket: Ticket,
  evidence: { pull_request_url: string | null },
  note: string,
  at: Date = new Date(),
): Ticket {
  return fromFailedToPullRequest(ticket, evidence, "loop", note, at);
}

/**
 * SCP-176: move a `failed` ticket to `pr_open` because the pull request on its
 * branch can be attributed to neither a person nor the loop — a legacy
 * delivery record with `opened_by: null` and no history to decide it either.
 * The third of the three paths from `failed` to `pr_open`: the same evidence
 * guard as `handOff`/`resumeAtPullRequest`, but the row it writes carries no
 * `handed_off` flag at all, because nothing here knows one to write. `sync`
 * is the only caller that reaches this, once `attributePullRequest` has
 * already said `null`.
 */
export function resumeWithUnrecordedOpener(
  ticket: Ticket,
  evidence: { pull_request_url: string | null },
  note: string,
  at: Date = new Date(),
): Ticket {
  return fromFailedToPullRequest(ticket, evidence, null, note, at);
}

function fromFailedToPullRequest(
  ticket: Ticket,
  evidence: { pull_request_url: string | null },
  attribution: PullRequestAttribution | null,
  note: string,
  at: Date,
): Ticket {
  // Checked ahead of `transition` rather than left to it: `pr_open` is also
  // reachable from `independent_review`, and a move from there would be legal
  // by the table's own row but not by what these two functions are for.
  if (ticket.state !== "failed") throw new IllegalTransitionError(ticket.state, "pr_open");
  if (evidence.pull_request_url === null) throw new HandOffEvidenceError(ticket);
  const moved = transition(ticket, "pr_open", note, at);
  // The marking goes on the row `transition` just appended, and only there: it
  // is a fact about this move, not about the ticket. Written either way round
  // rather than only for a hand-off, so that a row this version wrote never
  // has to be read back off its prose. An unattributed move writes no flag at
  // all — `attribution === "hand_off"` would write `false` for it, the same
  // claim `resumeAtPullRequest` makes on purpose, and this move has no right
  // to make it.
  const history = [...moved.history];
  history[history.length - 1] =
    attribution === null
      ? history[history.length - 1]!
      : { ...history[history.length - 1]!, handed_off: attribution === "hand_off" };
  return TicketSchema.parse({ ...moved, history });
}

/** Whether the ticket is still moving. Drives the count in `perbo list`. */
export function isActive(ticket: Ticket): boolean {
  return !(["merged", "done", "cancelled", "inconclusive"] as TicketState[]).includes(ticket.state);
}

/**
 * The queue's reading, written whole. The lifecycle is `transition`'s to move;
 * this records why it was or was not moved, and when that was decided.
 */
export function withWaits(ticket: Ticket, waits: readonly Wait[], at: Date): Ticket {
  return TicketSchema.parse({
    ...ticket,
    scheduling: { ...ticket.scheduling, waits_on: [...waits], decided_at: at.toISOString() },
  });
}

/** The queue's record of a re-level that did not level the branch, or `null` to clear it. */
export function withReconciliation(ticket: Ticket, reconciliation: ReconciliationInput | null): Ticket {
  return TicketSchema.parse({ ...ticket, scheduling: { ...ticket.scheduling, reconciliation } });
}
