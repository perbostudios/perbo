import {
  EditingSessionSchema,
  INTERVIEW_NEEDS_A_TITLE,
  INTERVIEW_WROTE_THE_SPEC,
  PREVIEW_BYTE_CAP,
  TaskModelsSchema,
  parseStored,
} from "../shared/protocol.js";
import {
  applyGraphEdit,
  blockingEdit,
  EMPTY_SPEC_TEXT,
  emptyApproach,
  readSpecSections,
  renderNodePage,
  renderSpec,
  requirementNodes,
  retitleSpec,
  specSlug,
  specTitleFromMessage,
  undoGraphEdit,
  type GraphEditOutcome,
  type Spec,
  assertionsChangedSinceDraft,
  promiseTexts,
  type DriftFinding,
  type DriftVerdict,
} from "@perbo/planning/browser";
import {
  EFFORT_LEVELS,
  isNeverReadPath,
  planNodes,
  planSizeCounts,
  sameName,
  sizeEstimate,
  TICKET_TRANSITIONS,
  type ApproachRecord,
  type EffortLevel,
  type StandingProhibitedEntry,
} from "@perbo/contracts/browser";
import {
  ContractEditing,
  interviewModelFor,
  interviewProviderFor,
  keepsPersonsTitle,
  REREAD_COULD_NOT_START,
  sectionsOf,
  specFindings,
  turnOverlapped,
  type EditingOwner,
  type PromisePair,
  type TurnMark,
} from "../shared/contract-editing.js";
import { ChangeMarks } from "../shared/change-marks.js";
import { assembleLiveGraph } from "../shared/graph-live.js";
import { busyMessage, exclusiveJob, heldRepository, isLive, journal, lane } from "../shared/jobs.js";
import {
  DELETE_TICKET_GONE,
  DELETE_WAITS_FOR_COMMANDS,
  deletePullRequestOpen,
} from "../shared/discard.js";
import type {
  PlanContract,
  ReviewArtifact,
  RunBundle,
  SymbolIndex,
  Ticket,
  UnsupportedRepository,
} from "@perbo/contracts";
import { answer } from "./handlers.js";
import { SettingsSchema } from "../shared/protocol.js";
import type {
  Detail,
  Draft,
  ExplorerFile,
  Job,
  ManifestEditor,
  Snapshot,
  TaskRow,
  TaskSummary,
  Change,
  ChangeInput,
  EditingSession,
  ModelCatalog,
  ModelProvider,
  SpecSections,
  SpecView,
  GraphCriterionView,
  GraphEditView,
  GraphLiveView,
  GraphView,
  InterviewDoing,
  InterviewEntry,
  InterviewStatus,
} from "../shared/protocol.js";

/**
 * The sample records, and the one bridge that answers requests over them. No
 * native process, credential, repository or network operation is reachable
 * here. The same screens and transitions render native records in Electron.
 */
const repoId = "80000000-0000-4000-8000-000000000001";
const landingId = "80000000-0000-4000-8000-000000000002";
export const at = "2026-09-08T09:40:00.000Z";
const base = "a1b2c3d" + "0".repeat(33);
/** The finding the sample review raises, and the key a round's closure names (D-061). */
const FINDING_KEY = "d".repeat(64);
/** When the remediation round recorded that closure, which is after the review. */
const closedAt = "2026-09-08T10:10:00.000Z";
export const plans = new Map<string, PlanContract>();
/** The order between a plan's nodes and the spec's No-Gos, beside the ticket (D-100). */
const approaches = new Map<string, ApproachRecord>();
export const approved = new Set<string>();
export const decisionsAnswered = new Set<string>();
/** The answers recorded as principles, in order, as `.perbo/principles.md` holds them (D-065). */
export const principlesRecorded: string[] = [];
/**
 * The answers a person gave on the "Decisions required" page, by ticket, as
 * `perbo verdict --decide` records them: each closes its finding
 * (D-NEW-a-person-s-answer-closes-a-routed-finding).
 */
export const decisionsTaken = new Map<
  string,
  Array<{
    finding_key: string;
    choice: "approach" | "let_it_decide" | "ship_as_is";
    note: string;
    decided_at: string;
  }>
>();
/** Whether a decision on the ticket hands a finding to the executor for a round. */
export function decisionsHandWork(key: string): boolean {
  return (decisionsTaken.get(key) ?? []).some((row) => row.choice !== "ship_as_is");
}
/** Whether every finding the sample review routed to a person has an answer. */
export function everyDecisionTaken(key: string): boolean {
  const taken = new Set((decisionsTaken.get(key) ?? []).map((row) => row.finding_key));
  return reviewFor(key)
    .findings.filter((finding) => finding.routing === "blocks" || finding.routing === "escalates")
    .every((finding) => taken.has(finding.key));
}
const criteriaText = [
  "A signup POST queues exactly one activation email.",
  "No email is sent for a duplicate signup inside five minutes.",
  "A send failure is retried three times, then dead-lettered.",
];
const activationOutcome =
  "New users receive an activation email within 60 seconds of signing up.";
/** The sample whose run was stopped, and the spec it was drafted from. */
const stoppedKey = "PRB-415";
const stoppedSlug = "retire-the-legacy-csv-importer";
let next = 422;
/** The next sample ticket a sample admission hands back, keyed in sequence. */
export function newSampleTicket(title: string, state: Ticket["state"]): Ticket {
  return sample(next++, title, state);
}
function sample(number: number, title: string, state: Ticket["state"]): Ticket {
  const key = "PRB-" + number;
  // Every identifier is the one its schema declares, because the Graph pane's
  // edits are applied here by `@perbo/planning`, which validates the whole
  // contract after each one: a sample the schema would refuse could not be
  // edited at all.
  const contract = {
    plan_id: "plan_preview_" + number,
    version: 1,
    ticket_id: "ticket_preview_" + number,
    level: "P1",
    outcome: activationOutcome,
    acceptance_criteria: criteriaText.map((text, index) => ({
      id: "ac_" + (index + 1),
      text,
      expected_verification: { kind: "test", assertion: text },
    })),
    // The graph the drafter suggested (D-100): the Explorer reads it to say which
    // nodes name a path, and the Graph pane curates it.
    nodes: [
      {
        id: "node_1",
        title: "Queue one activation email per signup",
        criteria: ["ac_1", "ac_2"],
        paths: ["packages/auth/**"],
      },
      {
        id: "node_2",
        title: "Retry a failed send, then dead-letter it",
        criteria: ["ac_3"],
        paths: ["packages/queue/**"],
      },
    ],
    scope: {
      repository_id: "repo_preview",
      paths_allowed: ["packages/auth/**", "packages/queue/**"],
      paths_prohibited: [".github/workflows/**", "infra/**", "**/*.env*"],
      generated_paths: [],
      expansion_budget_files: 3,
    },
    base: {
      base_commit: base,
      context_manifest_hash: `sha256:${"b".repeat(64)}`,
      captured_at: at,
    },
  } as unknown as PlanContract;
  plans.set(key, contract);
  approaches.set(key, {
    schema_version: 1,
    ticket_id: contract.ticket_id,
    plan_id: contract.plan_id,
    edges: [{ from: "node_1", to: "node_2" }],
    no_gos: ["Nothing is sent to an address that has unsubscribed."],
  });
  if (state === "pr_open" || state === "merged") approved.add(key);
  return {
    schema_version: 1,
    ticket_id: contract.ticket_id,
    key,
    title,
    state,
    priority: "normal",
    labels: [],
    depends_on: [],
    source: {
      kind: "none",
      reference: null,
      url: null,
      title_at_admission: null,
    },
    repository_root: "/sample/webstore",
    plan_id: contract.plan_id,
    plan_version: 1,
    approved_at: state === "plan_review" ? null : at,
    admitted_at: at,
    updated_at: at,
    // `spec` is null and not left out: the host's ticket reads back through
    // its schema, which defaults it, and a page that asks whether a ticket
    // was drafted from a spec reads the same answer here.
    admission: { elapsed_ms: 100, criteria_source: "typed", criteria_count: 3, spec: null },
    delivery: {
      state:
        state === "merged"
          ? "merged"
          : state === "closed"
            ? "closed"
            : state === "pr_open"
              ? "open"
              : "none",
      pull_request_url: ["pr_open", "merged", "closed"].includes(state)
        ? "https://github.com/example/webstore/pull/418"
        : null,
      pull_request_number: ["pr_open", "merged", "closed"].includes(state)
        ? 418
        : null,
      observed_at: at,
      branch: "retry-activation-email",
      // The loop's own delivery, as the host's schema reads a record that
      // names no other: what a merge press asks before it publishes.
      opened_by: ["pr_open", "merged", "closed"].includes(state) ? "loop" : null,
      arm: "loop",
    },
    history: [],
  } as unknown as Ticket;
}
function row(number: number, title: string, state: Ticket["state"]): TaskRow {
  return { repoId, repository: "webstore", ticket: sample(number, title, state) };
}
/** What each sample ticket's attempts cost, which `taskSummary` reports. */
const sampleCosts = new Map<string, number>([["PRB-398", 610_000]]);
const home = [
  row(412, "Activation email never sent on signup", "changes_requested"),
  row(377, "Backfill the audit table", "pr_open"),
  row(398, "Rate-limit the invite endpoint", "executing"),
  row(404, "Cache the pricing table response", "verifying"),
  // The run somebody stopped. Its ticket is `failed` and its attempt sealed,
  // which is where a stop inside the executor's window leaves the record, and
  // the stopped page is what it opens on.
  row(415, "Retire the legacy CSV importer", "failed"),
  row(421, "Split the settings page into tabs", "plan_review"),
];
home.forEach((row, index) => {
  row.ticket.updated_at = new Date(Date.parse(at) - index * 1000).toISOString();
});
/** The archive's sample rows: the key, its title, what it cost, how it was delivered, and where. */
const archived = [
  [409, "Retry the webhook dispatcher three times", "$2.14", "#418 · 2 Sep", "webstore"],
  [402, "Reject signups with a plus-addressed duplicate", "$0.91", "#411 · 31 Aug", "webstore"],
  [396, "Show runway on the billing page", "$3.40", "closed unmerged", "landing"],
  [390, "Move session cookies to the shared domain", "$0.62", "#399 · 28 Aug", "webstore"],
  [385, "Dead-letter the invoice sync job", "$1.77", "#394 · 26 Aug", "webstore"],
  [381, "Debounce the search-as-you-type request", "$0.48", "#388 · 24 Aug", "landing"],
  [374, "Expire password reset links after an hour", "$0.83", "#379 · 21 Aug", "webstore"],
  [366, "Paginate the members table", "$1.12", "#371 · 19 Aug", "webstore"],
  [359, "Stop double-charging annual upgrades", "$2.86", "#364 · 16 Aug", "webstore"],
  [352, "Log webhook retries with a request id", "$0.54", "#357 · 14 Aug", "landing"],
] as const;
const archive: TaskRow[] = archived.map(
  ([number, title, cost, delivery, repository], index) => {
    const result = row(number, title, delivery === "closed unmerged" ? "closed" : "merged");
    sampleCosts.set(result.ticket.key, Math.round(Number(cost.replace("$", "")) * 1_000_000));
    result.repoId = repository === "landing" ? landingId : repoId;
    result.repository = repository;
    result.ticket.updated_at = new Date(
      Date.parse(at) - (index + 1) * 86_400_000,
    ).toISOString();
    return result;
  },
);
for (let i = 0; i < 118; i++) {
  const result = row(300 - i, "Sample archived task " + (i + 11), "merged");
  sampleCosts.set(result.ticket.key, 1_000_000);
  result.ticket.updated_at = new Date(
    Date.parse(at) - (i + 11) * 86_400_000,
  ).toISOString();
  archive.push(result);
}
export const initial: Snapshot = {
  version: "0.1.0",
  settings: SettingsSchema.parse({
    name: "Lian",
    onboardingComplete: true,
    executorModel: "sonnet-class",
    reviewerProvider: "codex-cli",
    reviewerModel: "o-class",
    minutes: 12,
    commands: 40,
    ticketDollars: 2.5,
  }),
  repositories: [
    {
      id: repoId,
      name: "example/webstore",
      path: "~/code/webstore",
      branch: "main",
      head: base,
      dirty: false,
      configured: true,
      error: null,
      testCommand: "pnpm test",
      manifestCount: 3,
      prohibitedPaths: [".github/**", "infra/**", "**/*.env*"],
    },
    {
      id: landingId,
      name: "example/landing",
      path: "~/code/landing",
      branch: "main",
      head: "9f0e1a2" + "0".repeat(33),
      dirty: false,
      configured: false,
      error: null,
    },
  ],
  tasks: [...home, ...archive],
  // The run somebody stopped, as the journal keeps it. A stop aborts the job
  // and the CLI seals the attempt; what marks the ticket as one to pick up
  // again is this record beside it, because nothing is running for it now.
  jobs: [
    {
      id: "80000000-0000-4000-8000-000000000415",
      repoId,
      key: stoppedKey,
      resultKey: null,
      kind: "run",
      label: "Run engineering loop",
      state: "cancelled",
      startedAt: "2026-09-08T04:10:00.000Z",
      endedAt: "2026-09-08T04:22:00.000Z",
      log: "Interactive sample. No CLI or repository is accessed.",
      error: null,
      result: null,
      publish: false,
    },
  ],
  errors: [],
  titles: {},
  taskModels: {},
  asks: {},
  lastOpened: {},
  // Every sample ticket that finished before today is filed; #409 stays on Home in green until it is archived by hand (S4).
  archived: archive.filter((row) => row.ticket.key !== "PRB-409").map((row) => row.repoId + ":" + row.ticket.key),
  power: { holding: false, detail: null, since: null },
};
/** The boards' branch and diff figures, per sample ticket; everything else gets a small deterministic diff. */
const sampleDiffs: Record<string, [string, number, number, number]> = {
  "PRB-412": ["perbo/412-activation-mail", 4, 148, 22],
  "PRB-377": ["perbo/377-audit-backfill", 5, 96, 14],
  "PRB-409": ["perbo/409-webhook-retry", 3, 72, 19],
  "PRB-398": ["perbo/398-invite-ratelimit", 6, 61, 8],
  "PRB-404": ["perbo/404-pricing-cache", 3, 40, 6],
  "PRB-402": ["perbo/402-plus-duplicates", 2, 38, 11],
  "PRB-396": ["perbo/396-billing-runway", 7, 120, 64],
  "PRB-390": ["perbo/390-shared-cookie", 2, 27, 9],
  "PRB-385": ["perbo/385-invoice-dead-letter", 3, 54, 6],
  "PRB-381": ["perbo/381-search-debounce", 1, 16, 3],
  "PRB-374": ["perbo/374-reset-expiry", 4, 88, 41],
  "PRB-366": ["perbo/366-members-paging", 2, 31, 12],
  "PRB-359": ["perbo/359-annual-double-charge", 6, 205, 77],
  "PRB-352": ["perbo/352-onboarding-copy", 1, 9, 2],
};
export function sampleSummary(key: string): TaskSummary {
  const row = snapshot.tasks.find((entry) => entry.ticket.key === key);
  if (!row) throw new Error("Sample task not found.");
  const known = sampleDiffs[key];
  const number = Number(key.replace(/^PRB-/, ""));
  // The line under the title on its contract page, as the host reads it off the contract.
  const outcome = plans.get(key)?.outcome ?? null;
  if (row.ticket.state === "plan_review" || row.ticket.state === "ready")
    return { branch: null, attempts: 0, latestAttemptAt: null, costMicros: null, costBasis: "none", diff: null, note: null, outcome };
  return {
    branch: known?.[0] ?? `perbo/${number}-sample`,
    attempts: 1,
    latestAttemptAt: row.ticket.updated_at,
    costMicros: sampleCosts.get(key) ?? 610_000,
    costBasis: "priced",
    diff: known
      ? { files: known[1], additions: known[2], deletions: known[3] }
      : { files: 2, additions: 20 + (number % 7), deletions: 4 + (number % 3) },
    note: null,
    outcome,
  };
}
export const snapshot: Snapshot = new URLSearchParams(location.search).has("empty")
  ? {
      ...initial,
      settings: SettingsSchema.parse({}),
      repositories: [],
      tasks: [],
      archived: [],
    }
  : initial;
export const sampleManifests = new Map<
  string,
  {
    digest: string;
    value: {
      entries: ManifestEditor["entries"];
      offLimits: string[];
    };
    testCommand: string;
  }
>();
const listeners = new Set<(change: Change) => void>();
/** What the bridge hands a renderer: every change these records emit, until it lets go. */
export function subscribe(listener: (change: Change) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const emit = (input: ChangeInput = { kind: "records", repoId: null, key: null }): void => {
  snapshot.sequence = (snapshot.sequence ?? 0) + 1;
  const change = { ...input, sequence: snapshot.sequence };
  for (const listener of listeners) listener(structuredClone(change));
};
/** The preferences as they now stand, as the host announces them after any of them changes. */
export const emitPreferences = (): void =>
  emit({ kind: "preferences", settings: snapshot.settings, asks: snapshot.asks ?? {}, titles: snapshot.titles ?? {}, taskModels: snapshot.taskModels ?? {}, archived: snapshot.archived ?? [] });
export function ticketRow(key: string): TaskRow {
  const row = snapshot.tasks.find((row) => row.ticket.key === key);
  if (!row) throw new Error("Sample task not found.");
  return row;
}
/** Whether the lifecycle has a row taking `ticket` from `from` to `to` with this note, its guard read against the ticket. */
const rowAllows = (ticket: Ticket, from: Ticket["state"], to: Ticket["state"], note: string): boolean =>
  TICKET_TRANSITIONS.some((row) => row.from === from && row.to === to && (row.when?.(ticket, note) ?? true));

/**
 * Move a sample ticket as the CLI moves one: through `steps`, the states a
 * run's result proves, each a row the lifecycle allows (`TICKET_TRANSITIONS`)
 * and each its own history row with its note, then when it last moved. A step
 * with no row refuses the whole move and leaves the ticket where it was.
 */
export function moveTicket(ticket: Ticket, steps: readonly { to: Ticket["state"]; note: string }[]): void {
  const walk = steps.map((step, index) => ({ from: index === 0 ? ticket.state : steps[index - 1]!.to, ...step }));
  const refused = walk.find((step) => !rowAllows(ticket, step.from, step.to, step.note));
  if (refused) throw new Error(`${ticket.key} cannot move from ${refused.from} to ${refused.to}: the lifecycle has no row for it.`);
  const now = new Date().toISOString();
  ticket.history = [...ticket.history, ...walk.map((step) => ({ at: now, ...step }))];
  ticket.state = walk.at(-1)?.to ?? ticket.state;
  ticket.updated_at = now;
}

/**
 * Bring a sample ticket back to `ready` for a new attempt as `perbo run`
 * reopens one: by the shortest route the lifecycle's rows allow, each state
 * on the way noted as reopened through, and `ready` with `note`. A ticket the
 * rows give no route back is refused, and left where it was.
 */
export function reopenTicket(ticket: Ticket, note: string): void {
  const noteFor = (to: Ticket["state"]): string => (to === "ready" ? note : `reopened through ${to} to start a new attempt`);
  const queue: Ticket["state"][][] = [[]];
  const seen = new Set<Ticket["state"]>([ticket.state]);
  while (queue.length > 0) {
    const route = queue.shift()!;
    const from = route.at(-1) ?? ticket.state;
    for (const row of TICKET_TRANSITIONS) {
      if (row.from !== from || seen.has(row.to) || !rowAllows(ticket, from, row.to, noteFor(row.to))) continue;
      if (row.to === "ready") return moveTicket(ticket, [...route, row.to].map((to) => ({ to, note: noteFor(to) })));
      seen.add(row.to);
      queue.push([...route, row.to]);
    }
  }
  throw new Error(`${ticket.key} is ${ticket.state}, which the lifecycle has no route out of back to ready.`);
}
export function applyDraft(ticket: Ticket, draft: Draft): void {
  const plan = plans.get(ticket.key)!;
  plan.outcome = draft.outcome;
  plan.scope.paths_allowed = draft.paths;
  // The sample admits as `perbo admit` does: the draft's prohibited marks join
  // the repository's standing list and the defaults every admission starts with.
  plan.scope.paths_prohibited = [
    ...new Set([
      ...draft.prohibited,
      ...standingFor(repoId).map((entry) => entry.path),
      ".github/**",
      "infra/**",
      "**/*.pem",
      "**/.env*",
    ]),
  ];
  if ("acceptance_criteria" in plan) {
    plan.acceptance_criteria = draft.criteria.map((criterion, index) => ({
      id: "ac_" + (index + 1),
      text: criterion.text,
      expected_verification: {
        kind: criterion.kind,
        assertion: criterion.assertion,
      },
    }));
    // The criteria and the scope are what a graph divided, and this replaces
    // both, so the graph goes with them — as `admit` drops a drafted graph when
    // `--criterion` or `--path` replaces what it divided (D-100).
    delete plan.nodes;
    approaches.set(ticket.key, { ...approaches.get(ticket.key)!, edges: [] });
    graphEdits.delete(ticket.key);
  }
  ticket.admission.criteria_count = draft.criteria.length;
}
/**
 * The sample sealed change set: three paths inside the plan's own nodes and
 * one nobody planned for, so the Graph pane's outside row has something real
 * to show (SCP-317). One list, read by the task screen and by the graph.
 */
const sampleChanges: Detail["attempts"][number]["changes"] = [
  { path: "packages/queue/retry.ts", change_kind: "modified", additions: 64, deletions: 9 },
  { path: "packages/queue/retry.test.ts", change_kind: "modified", additions: 52, deletions: 1 },
  { path: "packages/auth/signup.ts", change_kind: "modified", additions: 18, deletions: 4 },
  { path: "docs/activation-email.md", change_kind: "added", additions: 31, deletions: 0 },
];
/** The pinned checks, once over the whole change and once per node (D-107). */
const sampleChecks: { name: string; status: string; node: string | null }[] = [
  { name: "Typecheck", status: "passed", node: null },
  { name: "Lint", status: "passed", node: null },
  { name: "Tests", status: "passed", node: null },
  { name: "Tests", status: "passed", node: "node_1" },
  { name: "Tests", status: "failed", node: "node_2" },
];
/**
 * The execution bundle the stopped attempt sealed (ADR-0013, ADR-0026).
 *
 * A stop inside the executor's window terminates the attempt and still writes
 * this, which is why `--resume-from` has something to be given: the stopped
 * page offers the last attempt's retained changes on the strength of it.
 */
const stoppedBundle: RunBundle = {
  schema_version: 1,
  bundle_id: "bundle_" + "415a".repeat(4),
  kind: "execution",
  created_at: at,
  subject_id: "preview-attempt-" + stoppedKey,
  ticket_id: "ticket_preview_415",
  inputs: { base_commit: base, resumed_from: null },
  context_manifest: [],
  versions: {
    code: "0.1.0",
    prompt: "interview@1",
    policy: "policy@1",
    model: "sonnet-class",
    tool: "claude-code",
  },
  usage: {
    input_tokens: 41_200,
    output_tokens: 6_140,
    cost_micros: 430_000,
    cost_basis: "transport_reported",
    cost_partial: true,
    wall_clock_ms: 11 * 60_000,
  },
  artifacts: [],
  errors: [],
  transitions: [
    { at, from: "executing", to: "failed", reason: "the attempt did not complete: terminated" },
  ],
  retention: { class: "replay_retained", expires_at: null },
  redaction: {
    secret_content_sha256: [],
    secret_value_count: 0,
    redactions: 0,
    excluded_paths: [],
  },
  replayability: "forensic",
  replayability_reason: "The attempt was stopped, so its context bytes were not retained.",
};
/**
 * The review on record. A remediation round does not replace it: a round is
 * verified rather than reviewed again (D-061), so this stays escalating and
 * what answers its finding is the closure the round recorded beside it.
 */
function reviewFor(key: string): ReviewArtifact {
  const plan = plans.get(key)!,
    criteria = "acceptance_criteria" in plan ? plan.acceptance_criteria : [];
  return {
    review_id: "rev_preview",
    created_at: at,
    target: { base_commit: base, head_commit: "c".repeat(40) },
    decision: "escalate",
    coverage: criteria.map((criterion, index) => ({
      criterion_id: criterion.id,
      status: index !== 2 ? "met" : "cannot_determine",
      verification_strength: index !== 2 ? "directly_verified" : "asserted_only",
      evidence: {
        assertion: criterion.expected_verification.assertion,
        location: {
          file: index === 2 ? "queue/retry.test.ts" : "auth/signup.test.ts",
          line: [142, 171, 88][index] ?? 42,
        },
        ref: "unit",
      },
      note: null,
    })),
    findings: [
      {
        key: FINDING_KEY,
        rule_id: "product.dead_letter",
        criterion_id: "ac_3",
        severity: "major",
        routing: "escalates",
        status: "open",
        blocking: true,
        blocking_reason: "Criterion 03 leaves a product choice unresolved.",
        closure: "human",
        direction: "positive",
        file: "packages/queue/retry.ts",
        line: 67,
        statement: "Where should a permanently failed email go?",
      },
    ],
  } as unknown as ReviewArtifact;
}
export function detail(key: string): Detail {
  const { ticket } = ticketRow(key),
    contract = plans.get(key)!;
  // The round that answered the review's finding: a second attempt carrying
  // the verification, never a second review (D-061).
  const remediated = approved.has(key);
  const reviewed = {
    id: "preview-attempt-" + key,
    run: 1,
    round: 0,
    startedAt: at,
    outcome: "escalate",
    // `reason: detail`, as the host joins the termination the runner recorded.
    termination: "completed: Sample attempt complete",
    model: "sonnet-class",
    costMicros: 610_000,
    costBasis: "sample",
    partial: false,
    ceilings: [{ resource: "attempt_commands", used: 23, ceiling: 40, hit: false }],
    review: reviewFor(key),
    reviewDecision: "escalate",
    changes: sampleChanges,
    // What gates the change is the whole-change run; a node's own result is
    // evidence for that node's review (D-107).
    checks: sampleChecks
      .filter((check) => check.node === null)
      .map((check) => ({ name: check.name, status: check.status, detail: "Sample result" })),
    verification: null,
    // A stopped attempt still seals its execution bundle, and that bundle is
    // what another attempt carries on from. The sample's other attempts retain
    // nothing, so both offers the stopped page makes — carrying on, and
    // starting the attempt again — are there to see.
    bundles: key === stoppedKey ? [stoppedBundle] : [],
  } satisfies Detail["attempts"][number];
  const closing = {
    ...reviewed,
    id: "preview-round-" + key,
    round: 1,
    startedAt: closedAt,
    outcome: "approve",
    costMicros: 1_330_000,
    review: null,
    reviewDecision: null,
    verification: {
      all_closed: true,
      deterministic_failure: null,
      open_keys: [],
      per_finding: [
        { finding_key: FINDING_KEY, status: "closed", pointer: "packages/queue/dead_letters.ts:1" },
      ],
    },
  } satisfies Detail["attempts"][number];
  const attempts =
    ticket.state === "plan_review" ? [] : remediated ? [reviewed, closing] : [reviewed];
  return {
    ticket,
    contract,
    // Read as the host reads it: the spec's requirements against the plan's
    // citations, both from the sample's own records.
    specFindings: (() => {
      const slug = specOf.get(ticket.key);
      if (slug === undefined || !("acceptance_criteria" in contract)) return [];
      return specFindings(readSpecSections(specFiles()[slug] ?? "").requirements, contract.acceptance_criteria);
    })(),
    // Read as the host reads it, from the sample's own edit records.
    changedAssertions: assertionsChangedSinceDraft(
      (graphEdits.get(ticket.key) ?? []).map((edit) => ({
        before: edit.before,
        undone: edit.undone,
        replaced: edit.replaced,
        undoes: edit.undoes,
      })),
      "acceptance_criteria" in contract ? contract.acceptance_criteria : [],
    ),
    digest: String(ticket.plan_version).repeat(64),
    attempts,
    cost: {
      micros: attempts.reduce((sum, attempt) => sum + (attempt.costMicros ?? 0), 0),
      partial: false,
      unavailable: 0,
    },
    principles: principlesRecorded.map((principle) => `- ${principle}\n`).join(""),
    // The rows `perbo verdict --decide` would hold for this ticket.
    verdicts: (decisionsTaken.get(key) ?? []).map((row) => ({
      review: { reference: key, ticket_id: ticket.ticket_id, ticket_key: key, pull_request_url: null },
      finding_key: row.finding_key,
      rule_id: "product.dead_letter",
      routing: "escalates",
      decision: "decide",
      choice: row.choice,
      author: "Sample person",
      decided_at: row.decided_at,
      note: row.note,
      superseded_at: null,
    })),
    effective: { stallMinutes: 12, ticketDollars: 2.5 },
    report: { sample: true },
  };
}
/**
 * The executor's retained transcript, in the records' own format: what a run
 * leaves behind is provider output, which the screen interprets for display
 * and nothing else ([ADR-0023](../../../../docs/adr/0023-untrusted-context-boundary.md)).
 */
export function sampleTranscript(): string {
  const message = (text: string): string =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
  return [
    message(
      "The queue stores webhook failures in webhook_failures, keyed by delivery. Activation mail " +
        "has no equivalent, so criterion 03 has nowhere to record a permanent failure. Two shapes " +
        "are possible: reuse that table’s shape for a new one, or widen the existing queue row.",
    ),
    message(
      "This is a choice the contract does not settle, and it changes the shape of the diff rather " +
        "than a line of it. Pausing to ask instead of picking for you.",
    ),
    JSON.stringify({
      item: {
        type: "commandExecution",
        command: "pnpm test --filter queue",
        aggregatedOutput:
          "RUN v2.1.4 /worktrees/ayo_wt_2\n✓ auth/signup.test.ts (2 tests) 412ms\n" +
          "✓ queue/retry.test.ts (3 tests) 388ms\nTest Files 12 passed (12)\n     Tests 186 passed (186)",
      },
    }),
    message(
      "Answer received: a new dead_letters table. Writing the migration first, then the terminal branch.",
    ),
  ].join("\n");
}
/** The labels the native host gives each command, kind for kind, so a refusal names what the person sees there. */
const LABELS: Record<string, string> = {
  draft: "Draft a task contract",
  admit: "Save task contract",
  edit: "Update task contract",
  graphEdit: "Change the plan's graph",
  graphUndo: "Undo a plan edit",
  drift: "Read the plan against the spec",
  run: "Run engineering loop",
  decide: "Run engineering loop",
  doctor: "Check repository readiness",
  sync: "Refresh delivery from GitHub",
  publish: "Open the pull request",
  principle: "Record a product decision",
  verdict: "Record finding feedback",
};
export function job(
  kind: string,
  repository: string,
  key: string | null,
  operation: (job: Job) => void,
  delay = 1000,
  owner?: EditingOwner,
  /** Called once the job has settled and been said, however it ended. */
  settled?: () => void,
): Job {
  const blocking = lane(kind) === "exclusive" ? exclusiveJob(snapshot.jobs) : undefined;
  if (blocking) throw new Error(busyMessage(blocking.label));
  const job: Job = {
    id: crypto.randomUUID(),
    repoId: repository,
    key,
    kind,
    label: LABELS[kind] ?? kind,
    state: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    log: "Interactive sample. No CLI or repository is accessed.",
    error: null,
    resultKey: null,
    result: null,
    ...(owner ? { editing: owner } : {}),
  };
  snapshot.jobs = journal([...snapshot.jobs, job]);
  if (owner) editing.started(owner, job);
  emit({ kind: "progress", job });
  setTimeout(
    () => {
      if (job.state !== "running") return;
      try {
        operation(job);
        job.state = "completed";
      } catch (error) {
        job.state = "failed";
        job.error = String(error instanceof Error ? error.message : error);
      }
      job.endedAt = new Date().toISOString();
      void editing.settled(job).catch((error: unknown) => {
        job.error = String(error);
        job.state = "failed";
      }).finally(() => {
        emit({ kind: "records", repoId: repository, key: job.resultKey ?? key, job });
        settled?.();
      });
    },
    new URLSearchParams(location.search).has("slow") ? 8000 : delay,
  );
  return job;
}
/**
 * The explorer's sample repository: a tracked file list, a little text, and a
 * standing prohibited list kept where the sample's own records are. The same
 * rules the native host applies are applied here, so the pane can be driven in
 * a browser without Electron and behaves the same when it reaches one.
 */
const SAMPLE_FILES: Record<string, string[]> = {
  [repoId]: [
    ".env.local",
    "README.md",
    "packages/auth/package.json",
    "packages/auth/src/signup.ts",
    "packages/auth/test/signup.test.ts",
    "packages/queue/src/retry.ts",
    "packages/queue/src/dead-letters.sql",
    "packages/queue/src/fixtures/orders.json",
    "packages/queue/src/generated/schema.ts",
    "packages/ui/brand/logo.png",
    "packages/ui/src/theme.ts",
    "secrets/deploy.pem",
    "specs/activation-email/spec.md",
  ],
  [landingId]: [
    "README.md",
    "src/index.html",
    "src/styles.css",
    "src/signup/form.html",
    "src/migrations/0001-signups.sql",
  ],
};
const SAMPLE_TEXT: Record<string, string> = {
  "packages/auth/src/signup.ts":
    "import { queue } from \"@webstore/queue\";\n\n" +
    "export async function signup(email: string): Promise<void> {\n" +
    "  await queue.push({ kind: \"activation\", email });\n" +
    "}\n",
  "packages/queue/src/retry.ts":
    "// Three attempts, then the dead-letter table.\n" +
    "export const MAX_ATTEMPTS = 3;\n" +
    "\n" +
    "/** Push one job, and send it to the dead-letter table if it never lands. */\n" +
    "export async function retryQueue(job: Job): Promise<void> {\n" +
    "  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {\n" +
    "    if (await push(job)) return;\n" +
    "  }\n" +
    "  await deadLetter(job);\n" +
    "}\n" +
    "\n" +
    "/** How often a job is retried, and how long it waits between attempts. */\n" +
    "export interface RetryPolicy {\n" +
    "  attempts: number;\n" +
    "  backoffMs: number;\n" +
    "}\n",
  "specs/activation-email/spec.md":
    "# Activation email\n\n## Outcome\n\nNew users receive an activation email within 60 seconds.\n",
};
/**
 * The sample repositories' symbol and import index, as `perbo index` would
 * build it (D-015). The Spec pane completes `@Symbol` from this and marks
 * what it does not hold; the Impact pane's importer warnings follow its
 * edges. Written out rather than parsed, because a browser has no checkout
 * to parse against.
 *
 * `example/landing` answers `supported: false`, which is a different fact
 * from an index holding no files: a repository outside TypeScript and
 * JavaScript has no names to check a spec against and no imports to follow,
 * so nothing there is marked and only its path classes are warned about.
 *
 * The commit is 40 characters, as a real one `perbo index` writes, and
 * deliberately not this sample repository's own head: the index is a cache
 * with a commit on it and nothing keeps it fresh, so what a pane shows is the
 * commit the names were read at, which a person compares against the
 * checkout themselves. Both panes print only its first 7 characters.
 */
export const SAMPLE_INDEX: Record<string, SymbolIndex | UnsupportedRepository> = {
  [repoId]: {
    schema_version: 1,
    built_at: "2026-09-14T09:00:00.000Z",
    head_commit: "9f2c1abccccccccccccccccccccccccccccccccc",
    working_tree: "clean",
    files: [
      {
        path: "packages/auth/src/signup.ts",
        exports: [{ name: "signup", kind: "function", line: 3 }],
        imports: [
          { specifier: "@webstore/queue", resolved: "packages/queue/src/retry.ts", external: false, line: 1 },
        ],
      },
      {
        path: "packages/auth/test/signup.test.ts",
        exports: [],
        imports: [
          { specifier: "../src/signup.js", resolved: "packages/auth/src/signup.ts", external: false, line: 1 },
          { specifier: "vitest", resolved: null, external: true, line: 2 },
        ],
      },
      {
        path: "packages/queue/src/retry.ts",
        exports: [
          { name: "MAX_ATTEMPTS", kind: "variable", line: 2 },
          { name: "retryQueue", kind: "function", line: 5 },
          { name: "RetryPolicy", kind: "interface", line: 13 },
        ],
        imports: [],
      },
      {
        path: "packages/queue/src/generated/schema.ts",
        exports: [
          { name: "DeadLetterRow", kind: "type", line: 4 },
          { name: "*", kind: "re-export", line: 9 },
        ],
        imports: [],
      },
      {
        path: "packages/ui/src/theme.ts",
        exports: [
          { name: "theme", kind: "variable", line: 3 },
          { name: "ThemeTokens", kind: "interface", line: 11 },
        ],
        imports: [
          { specifier: "@webstore/auth", resolved: "packages/auth/src/signup.ts", external: false, line: 1 },
        ],
      },
    ],
    skipped: [],
  },
  [landingId]: {
    supported: false,
    // The sentence `perbo index` writes, over the extensions this sample
    // repository's own tracked list carries.
    reason:
      "no tracked TypeScript or JavaScript file outside node_modules, dist and .perbo: the " +
      "symbol index reads .ts .tsx .mts .cts .js .jsx .mjs .cjs and this repository tracks none " +
      "of them there",
    languages_seen: [".css", ".html", ".md", ".sql"],
  },
};
/**
 * Sample files whose size is declared rather than counted: a binary one, and
 * one past the preview's cap, so the refusals can be seen without carrying a
 * quarter of a megabyte of sample text.
 */
const SAMPLE_BYTES: Record<string, number> = {
  "packages/ui/brand/logo.png": 24_576,
  "packages/queue/src/fixtures/orders.json": PREVIEW_BYTE_CAP + 4_096,
};
/** What the sample repositories standing-prohibit before anybody marks anything (D-105, SCP-336). */
const SAMPLE_STANDING: Record<string, StandingProhibitedEntry[]> = {
  [repoId]: [
    {
      path: "specs/**",
      draft: null,
      source: "written in .perbo/config.json",
      added_at: null,
    },
  ],
};
/** Kept where the sample's editing sessions are kept, so a reload holds what was marked. */
export function standingFor(id: string): StandingProhibitedEntry[] {
  const stored: unknown = JSON.parse(localStorage.getItem("perbo:preview-standing") ?? "null");
  if (stored === null || typeof stored !== "object") return SAMPLE_STANDING[id] ?? [];
  return (stored as Record<string, StandingProhibitedEntry[]>)[id] ?? [];
}
function writeStanding(id: string, entries: readonly StandingProhibitedEntry[]): void {
  const stored: unknown = JSON.parse(localStorage.getItem("perbo:preview-standing") ?? "null");
  const all =
    stored !== null && typeof stored === "object"
      ? (stored as Record<string, StandingProhibitedEntry[]>)
      : structuredClone(SAMPLE_STANDING);
  localStorage.setItem("perbo:preview-standing", JSON.stringify({ ...all, [id]: [...entries] }));
}
/** A sample file with no text of its own reads as a stub, so every listed file previews. */
function sampleText(path: string): string | null {
  if (SAMPLE_TEXT[path]) return SAMPLE_TEXT[path]!;
  if (/\.(png|jpe?g|gif|webp|ico|woff2?)$/.test(path)) return null;
  return `// ${path}\n// This sample file's text is not part of the preview.\n`;
}
export function sampleFiles(id: string): string[] {
  const listed = SAMPLE_FILES[id];
  if (!listed) throw new Error("This sample repository is no longer connected.");
  return listed;
}
/** The read the native host performs, over sample bytes: the same refusals, in the same words. */
export function sampleRead(id: string, requested: string): ExplorerFile {
  if (requested.startsWith("/") || /^[A-Za-z]:[\\/]/.test(requested))
    throw new Error(
      "Name the file the way the repository does, relative to its root. Perbo does not take an absolute path from a screen.",
    );
  const path = requested.replace(/^\.\//, "");
  if (path === "" || path.split("/").includes(".."))
    throw new Error("That path would leave the repository. Name a file inside it.");
  if (isNeverReadPath(path))
    throw new Error(
      "Perbo never lists nor reads this path: it may hold a secret, Git metadata or agent configuration. That it exists is reportable; its contents are not.",
    );
  const files = sampleFiles(id);
  if (!files.includes(path)) {
    if (files.some((entry) => entry.startsWith(path + "/")))
      throw new Error(`${path} is a folder. The tree already lists what is in it.`);
    throw new Error(`${path} is not a tracked file in this repository.`);
  }
  const text = sampleText(path);
  const bytes = SAMPLE_BYTES[path] ?? new TextEncoder().encode(text ?? "").length;
  if (bytes > PREVIEW_BYTE_CAP)
    return {
      path,
      bytes,
      text: null,
      refusal: `${path} is larger than the 256 KiB the preview reads, so nothing is shown rather than part of it. Open it in your editor.`,
    };
  if (text === null)
    return { path, bytes, text: null, refusal: `${path} is a binary file. There is nothing here to read.` };
  return { path, bytes, text, refusal: null };
}

/**
 * The sample repository's `specs/` folder, held where the sample's editing
 * sessions are held. The Markdown, the slug and the requirement ids are
 * `@perbo/planning`'s own, so this preview assigns the ids the command line
 * would; what it stands in for is the filesystem, which a browser has none of.
 */
const SPECS_KEY = "perbo:preview-specs";
/**
 * Take the sample spec folder with the work it described, as the host does.
 *
 * Deleting a piece of work deletes all of it, at every stage; the writing is
 * left only where another planning is still writing it or another ticket was
 * drafted from it (D-129).
 */
export function removeSpecFile(slug: string, except: { sessionId: string | null }): void {
  const held = editingRecords().some(
    (each) => each.id !== except.sessionId && each.specSlug === slug && each.phase !== "discarded",
  );
  if (held) return;
  // No ticket is excused: one still on the board is one that still names this
  // file, whether or not the caller meant to delete it, and a plan is read
  // against the spec it names (D-103).
  const drafted = snapshot.tasks.some(
    (each) => each.ticket.admission.spec?.path === `specs/${slug}/spec.md`,
  );
  if (drafted) return;
  const { [slug]: gone, ...rest } = specFiles();
  void gone;
  localStorage.setItem(SPECS_KEY, JSON.stringify(rest));
}

export const specFiles = (): Record<string, string> => {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SPECS_KEY) ?? "{}");
    return raw !== null && typeof raw === "object" ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
};
export const saveSpec = (slug: string, markdown: string): void => {
  localStorage.setItem(SPECS_KEY, JSON.stringify({ ...specFiles(), [slug]: markdown }));
};
const EMPTY_SECTIONS: SpecSections = {
  outcome: "",
  requirements: "",
  no_gos: "",
  rabbit_holes: "",
  notes: "",
};
/** The spec a session holds, read back from the folder: the file is canonical. */
export function specView(id: string): SpecView {
  const session = editing.read(id);
  if (session.specSlug === null)
    return { slug: null, path: null, title: "", sections: EMPTY_SECTIONS, requirements: [] };
  const markdown = specFiles()[session.specSlug] ?? "";
  const read = readSpecSections(markdown);
  const held = session.key ? plans.get(session.key) : undefined;
  const contract = held && "acceptance_criteria" in held ? held : null;
  const carried = requirementNodes(
    {
      requirements: read.requirements.flatMap((each) =>
        each.id === null ? [] : [{ id: each.id, text: each.text }],
      ),
    },
    contract,
  );
  return {
    slug: session.specSlug,
    path: `specs/${session.specSlug}/spec.md`,
    title: read.text.title,
    sections: {
      outcome: read.text.outcome,
      requirements: read.text.requirements,
      no_gos: read.text.no_gos,
      rabbit_holes: read.text.rabbit_holes,
      notes: read.text.notes,
    },
    requirements: read.requirements.map((each) => ({
      id: each.id,
      text: each.text,
      nodes: carried.find((carry) => carry.id === each.id)?.nodes ?? [],
    })),
  };
}

/**
 * The Graph pane over the sample plans (D-100).
 *
 * Every operation is applied by `@perbo/planning`, which is the code
 * `perbo edit --graph-edit` runs: the same schema, the same refusals and the
 * same record of what each edit touched. What this stands in for is the ticket
 * store, which a browser has none of — the plans, their approach records and
 * the edit log live in memory beside the sample tickets.
 */

/** One recorded edit, with what an undo needs to put back. */
interface PreviewGraphEdit extends GraphEditView {
  keys: string[];
  before: Record<string, unknown>;
  /** What the edit changed, in the words the admission count counts (D-072). */
  changes: string[];
}
const graphEdits = new Map<string, PreviewGraphEdit[]>();
/** Which spec a sample ticket was drafted from, as admission records it (D-103). */
export const specOf = new Map<string, string>();
/**
 * The spec the stopped sample was drafted from, and the admission record that
 * says so.
 *
 * Planning the work again reads this file and admits a new plan from it, so
 * the file has to be in the sample repository's folder — written once, and
 * left as it is where the sample workspace already holds it, because a person
 * who edited it is reading their own words back.
 */
specOf.set(stoppedKey, stoppedSlug);
ticketRow(stoppedKey).ticket.admission.spec = {
  path: `specs/${stoppedSlug}/spec.md`,
  content_sha256: "sha256:" + "0".repeat(64),
  files: [],
  names_that_resolved: null,
  symbols_judged_at_approval: false,
};
if (specFiles()[stoppedSlug] === undefined)
  saveSpec(
    stoppedSlug,
    [
      "# Retire the legacy CSV importer",
      "",
      "## Outcome",
      "",
      "Every import goes through the current parser, and the legacy path is gone.",
      "",
      "## Requirements",
      "",
      "- R1: An upload of either dialect is read by the current parser.",
      "- R2: A file the parser refuses is reported with the line it stopped at.",
      "- R3: The legacy importer and its routes are removed.",
      "",
      "## No-Gos",
      "",
      "- Nothing is sent to an address that has unsubscribed.",
      "",
      "## Rabbit holes",
      "",
      "## Notes",
      "",
    ].join("\n"),
  );

/**
 * The drift verdict kept beside each sample ticket, as `perbo drift` keeps it
 * at `.perbo/tickets/<KEY>.drift.json`
 * (D-128): keyed by the spec and the
 * plan's promise texts, and held while neither moves.
 */
export const driftRecords = new Map<string, DriftVerdict>();
/**
 * A sample digest: the shape `perbo drift` keys its record by, over the same
 * bytes, so a verdict holds and lets go exactly when the real one would. Not
 * SHA-256 — the renderer has no synchronous one, and what is being stood in
 * for is the key, not the hash.
 */
function sampleDigest(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return "sha256:" + hash.toString(16).padStart(8, "0").repeat(8);
}
/** The two keys a verdict is held by, for this ticket as it stands now. */
export function driftKeys(key: string): { spec: string; promises: string } | null {
  const slug = specOf.get(key);
  const plan = plans.get(key);
  if (slug === undefined || plan === undefined) return null;
  const criteria = "acceptance_criteria" in plan ? plan.acceptance_criteria : [];
  return {
    spec: sampleDigest(specFiles()[slug] ?? ""),
    promises: sampleDigest(JSON.stringify(promiseTexts({ outcome: plan.outcome, criteria }))),
  };
}
/**
 * The sample's reading of the plan against the spec: where a criterion's
 * words no longer answer the requirement it cites, where a requirement has no
 * criterion, and where the outcome has parted. A plan `draftFromSpec` made
 * agrees by construction; one a person reworded on the Plan or Graph pane, or
 * whose spec they edited, is what this finds. The options are in the person's
 * own voice, as the real reading's are, because picking one sends its words
 * to the interview as a turn (ADR-0023 §4).
 */
export function sampleDriftFindings(key: string): DriftFinding[] {
  const slug = specOf.get(key);
  const plan = plans.get(key);
  if (slug === undefined || plan === undefined || !("acceptance_criteria" in plan)) return [];
  const read = readSpecSections(specFiles()[slug] ?? "");
  const findings: DriftFinding[] = [];
  const outcome = read.text.outcome.split("\n")[0] ?? "";
  if (outcome.trim() !== plan.outcome.trim())
    findings.push({
      heading: "The outcome",
      difference: `The spec's Outcome says "${outcome.trim()}"; the plan's outcome says "${plan.outcome.trim()}".`,
      options: [
        { label: `Reword the plan's outcome to say: ${outcome.trim()}`, detail: null, recommended: true },
        { label: `Change the spec's Outcome to say: ${plan.outcome.trim()}`, detail: null, recommended: false },
      ],
    });
  const stated = read.requirements.flatMap((each) =>
    each.id === null ? [] : [{ id: each.id, text: each.text }],
  );
  const answered = new Set<string>();
  plan.acceptance_criteria.forEach((criterion, index) => {
    const cited = stated.find((each) => each.id === criterion.requirement_id);
    if (cited === undefined) {
      // A criterion that cites nothing — a compile of a basic ticket's
      // criteria on its contract numbers them afresh — answers a requirement in the same words, or promises
      // something the spec does not ask for.
      const worded = stated.find((each) => each.text.trim() === criterion.text.trim());
      if (worded !== undefined) {
        answered.add(worded.id);
        return;
      }
      findings.push({
        heading: `Criterion ${index + 1}`,
        difference: `Criterion ${index + 1} promises "${criterion.text}", which no requirement in the spec asks for.`,
        options: [
          { label: `Drop criterion ${index + 1} from the plan.`, detail: null, recommended: false },
          {
            label: `Add a requirement to the spec for: ${criterion.text}`,
            detail: "The spec takes the plan's promise.",
            recommended: true,
          },
        ],
      });
      return;
    }
    answered.add(cited.id);
    if (cited.text.trim() === criterion.text.trim()) return;
    // The recommendation is written second here, as a model may write it in
    // any place: the card is what puts it first, and a sample that already
    // had it first would show nothing of that.
    findings.push({
      heading: `Criterion ${index + 1} and ${cited.id}`,
      difference: `${cited.id} asks for "${cited.text}"; criterion ${index + 1} promises "${criterion.text}".`,
      options: [
        {
          label: `Change ${cited.id} in the spec to say: ${criterion.text}`,
          detail: "The spec takes the plan's words.",
          recommended: false,
        },
        {
          label: `Reword criterion ${index + 1} to say: ${cited.text}`,
          detail: "The plan goes back to what the spec asks for.",
          recommended: true,
        },
      ],
    });
  });
  for (const requirement of stated)
    if (!answered.has(requirement.id))
      findings.push({
        heading: requirement.id,
        difference: `The spec states ${requirement.id}, "${requirement.text}", and no criterion answers it.`,
        options: [
          { label: `Add a criterion for ${requirement.id}: ${requirement.text}`, detail: null, recommended: true },
          { label: `Drop ${requirement.id} from the spec.`, detail: null, recommended: false },
        ],
      });
  return findings.slice(0, 6);
}
/** Keep this verdict for the ticket, at the state it was read. */
export function recordDrift(
  key: string,
  origin: DriftVerdict["origin"],
  findings: DriftFinding[],
  cached: boolean,
  keys = driftKeys(key),
): DriftVerdict {
  if (keys === null) throw new Error("This ticket was not drafted from a spec.");
  const verdict: DriftVerdict = {
    ...keys,
    origin,
    findings,
    dismissed: false,
    checked_at: new Date().toISOString(),
    model: null,
    key,
    cached,
  };
  driftRecords.set(key, verdict);
  return verdict;
}
/**
 * The spec of a ticket still being planned, titled with the name the person
 * gave it, as the host titles it; an approved one's spec is left as approval
 * read it. The verdict keyed on the bytes before is carried to the renamed
 * bytes, as the host carries it. True where the spec was renamed.
 */
export function nameSampleSpec(repoId: string, key: string, title: string): boolean {
  const renamed = snapshot.tasks.find((row) => row.repoId === repoId && row.ticket.key === key);
  const slug = renamed?.ticket.admission.spec?.path.split("/").at(-2);
  const markdown = slug === undefined ? undefined : specFiles()[slug];
  if (slug === undefined || markdown === undefined || renamed?.ticket.approved_at) return false;
  const named = retitleSpec(markdown, title);
  saveSpec(slug, named);
  const record = driftRecords.get(key);
  if (record?.spec === sampleDigest(markdown)) driftRecords.set(key, { ...record, spec: sampleDigest(named) });
  return true;
}
/**
 * The ticket a drift request is about, as the host derives it from the
 * session: refused where the planning has been thrown away, there is no spec,
 * no plan, or a plan that is approved and so frozen, in the host's own words.
 */
export function driftTarget(id: string): string {
  const session = editing.read(id);
  if (session.phase === "discarded")
    throw new Error("This planning has been thrown away, and its plan with it.");
  if (session.specSlug === null)
    throw new Error("Write the spec before reading it against the plan.");
  if (session.key === null)
    throw new Error("Draft a plan from the spec before reading the two against each other.");
  const row = snapshot.tasks.find((each) => each.ticket.key === session.key);
  if (row?.ticket.approved_at)
    throw new Error(
      `${session.key} is approved, and what it promises was settled with it. The spec is no ` +
        "longer this page's to read it against.",
    );
  return session.key;
}
export const graphLog = (key: string): PreviewGraphEdit[] => {
  const held = graphEdits.get(key);
  if (held) return held;
  const made: PreviewGraphEdit[] = [];
  graphEdits.set(key, made);
  return made;
};

/** A spec as the page renderer reads it, from the sections the folder holds. */
function specFor(slug: string): Spec | null {
  const markdown = specFiles()[slug];
  if (markdown === undefined) return null;
  const read = readSpecSections(markdown);
  const lines = (section: string): string[] =>
    section
      .split("\n")
      .map((line) => line.replace(/^[-*]\s*/, "").trim())
      .filter((line) => line.length > 0);
  return {
    title: read.text.title,
    outcome: read.text.outcome.trim(),
    requirements: read.requirements.flatMap((each) =>
      each.id === null ? [] : [{ id: each.id, text: each.text }],
    ),
    no_gos: lines(read.text.no_gos),
    rabbit_holes: lines(read.text.rabbit_holes),
    notes: read.text.notes.trim(),
  };
}

/** What each key an edit touched is called where the count is kept. */
function changesFrom(outcome: GraphEditOutcome): string[] {
  return outcome.keys.map((key) => {
    const id = key.slice(key.indexOf(":") + 1);
    const gone = outcome.after[key] === null || outcome.after[key] === undefined;
    if (key.startsWith("edge:")) return `edge ${gone ? "-" : "+"}${id.replace("->", " -> ")}`;
    const added = outcome.before[key] === null || outcome.before[key] === undefined;
    return `${id} ${added ? "added" : gone ? "removed" : "changed"}`;
  });
}

/** Apply one edit, or an undo of one, and record it as the CLI records it: with the engine's own summary, unless an undo names the edit it undid. */
export function writeGraphEdit(
  key: string,
  run: (state: { contract: PlanContract; approach: ApproachRecord }) => GraphEditOutcome,
  undoes: number | null,
  summary?: string,
  author: "you" | "interview" = "you",
): void {
  const { ticket } = ticketRow(key);
  const contract = plans.get(key)!;
  const approach = approaches.get(key) ?? emptyApproach(contract);
  const outcome = run({ contract, approach });
  if (ticket.approved_at !== null && !outcome.approachOnly)
    throw new Error(
      "A node's criteria and paths are contract, which is immutable from approval (ADR-0016). The order between nodes may still change.",
    );
  plans.set(key, outcome.contract);
  approaches.set(key, outcome.approach);
  const log = graphLog(key);
  log.push({
    n: log.length + 1,
    at: new Date().toISOString(),
    author,
    summary: summary ?? outcome.summary,
    undone: false,
    replaced: false,
    undoes,
    keys: outcome.keys,
    before: outcome.before,
    changes: changesFrom(outcome),
  });
  ticket.admission.edit_count = new Set(
    log.filter((edit) => edit.author === "you" && !edit.replaced).flatMap((edit) => edit.changes),
  ).size;
  ticket.updated_at = new Date().toISOString();
}

/** `perbo edit --undo <n>`, with D-100's rule about a later edit in the way. */
export function undoGraphEditAt(key: string, number: number): void {
  const log = graphLog(key);
  const target = log[number - 1];
  if (!target) throw new Error(`There is no edit ${number} to undo.`);
  if (target.undone) throw new Error(`Edit ${number} (${target.summary}) is already undone.`);
  if (target.replaced)
    throw new Error(
      `Edit ${number} was made to a plan that has since been re-drafted from the spec, so there is no contract left for it to be undone from.`,
    );
  if (target.undoes !== null)
    throw new Error(`Edit ${number} undid edit ${target.undoes}, and an undo is not undone.`);
  const blocking = blockingEdit(log, number);
  if (blocking)
    throw new Error(
      `Edit ${number} cannot be undone: edit ${blocking.at} (${log[blocking.at - 1]?.summary ?? "no summary"}) changed ${blocking.keys.join(", ")} after it. Undo edit ${blocking.at} first (D-100).`,
    );
  writeGraphEdit(key, (state) => undoGraphEdit(state, target.before), number, `undid edit ${number}`);
  target.undone = true;
}

/**
 * What the sample records say about a sample graph (SCP-317). The records are
 * assembled from the samples and read by {@link assembleLiveGraph}, the same
 * derivation the host runs over a repository's own, so a closure, a stale
 * review and a check's scope read here exactly as they read there.
 */
function liveFor(key: string, nodes: readonly { id: string; paths: readonly string[]; criteria: readonly string[] }[]): GraphLiveView {
  const { ticket } = ticketRow(key);
  const before = ticket.state === "plan_review" || ticket.state === "ready";
  const review = reviewFor(key);
  return assembleLiveGraph(
    nodes,
    before
      ? { attempt: null, changed: [], sealed: false, checks: [], review: null, closures: [] }
      : {
          attempt: "preview-attempt-" + key,
          changed: sampleChanges.map((change) => change.path),
          sealed: true,
          // The loop narrows a pinned check to a node's own changed files
          // (D-107); a sample check with no node is the whole command.
          checks: sampleChecks.map((check) => ({
            name: check.name,
            status: check.status,
            node: check.node ? { id: check.node, scope: "files" } : null,
          })),
          review: {
            planVersion: ticket.plan_version,
            createdAt: at,
            coverage: review.coverage,
            findings: review.findings,
          },
          // What the round since that review closed (D-061), and what a
          // person decided, which is what takes the finding off the node the
          // criterion belongs to.
          closures: [
            ...(approved.has(key) ? [{ createdAt: closedAt, closed: [FINDING_KEY] }] : []),
            ...(decisionsTaken.get(key) ?? [])
              .filter((row) => row.choice === "ship_as_is")
              .map((row) => ({ createdAt: row.decided_at, closed: [row.finding_key] })),
          ],
        },
    ticket.plan_version,
  );
}

/** One plan's graph, its size and its history, as the native host reads them. */
export function graphView(repoId: string, key: string): GraphView {
  const { ticket } = ticketRow(key);
  if (!snapshot.tasks.some((row) => row.repoId === repoId && row.ticket.key === key))
    throw new Error("Sample task not found in this repository.");
  const contract = plans.get(key)!;
  const criteria: GraphCriterionView[] =
    "acceptance_criteria" in contract
      ? contract.acceptance_criteria.map((criterion) => ({
          id: criterion.id,
          text: criterion.text,
          kind: criterion.expected_verification.kind,
          assertion: criterion.expected_verification.assertion,
          requirement: criterion.requirement_id ?? null,
          manual:
            criterion.expected_verification.kind === "manual"
              ? {
                  reviewer: criterion.expected_verification.manual_reviewer ?? "",
                  reason: criterion.expected_verification.manual_reason ?? "",
                }
              : null,
        }))
      : [];
  const held = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const nodes = planNodes(contract);
  const slug = specOf.get(key) ?? null;
  const spec = slug === null ? null : specFor(slug);
  const files = sampleFiles(repoId);
  return {
    key,
    state: ticket.state,
    approved: ticket.approved_at !== null,
    outcome: contract.outcome,
    nodes: nodes.map((node) => ({
      id: node.id,
      title: node.title,
      criteria: node.criteria.flatMap((id) => {
        const criterion = held.get(id);
        return criterion ? [criterion] : [];
      }),
      paths: [...node.paths],
      page:
        spec === null || slug === null
          ? null
          : {
              path: `specs/${slug}/nodes/${node.id}.md`,
              text: renderNodePage({ node, spec, contract, notes: "" }),
            },
    })),
    criteria,
    edges: [...(approaches.get(key)?.edges ?? [])],
    pathsAllowed: [...contract.scope.paths_allowed],
    size: sizeEstimate(
      planSizeCounts({
        nodes,
        criteria: criteria.length,
        paths_allowed: contract.scope.paths_allowed,
        paths_prohibited: contract.scope.paths_prohibited,
        trackedFiles: files,
      }),
    ),
    live: liveFor(key, nodes),
    editCount: ticket.admission.edit_count ?? 0,
    history: graphLog(key).map((edit) => ({
      n: edit.n,
      at: edit.at,
      author: edit.author,
      summary: edit.summary,
      undone: edit.undone,
      replaced: edit.replaced,
      undoes: edit.undoes,
    })),
    digest: String(ticket.plan_version).repeat(64),
  };
}

/**
 * What a ticket drafted from a spec is called, as `admit` calls it where
 * nothing drafted a name, which is always here because the sample has no
 * drafter: the spec's title, unless another ticket in the repository carries
 * it, else the plan's outcome (D-127). With `keepTitle`, as `admit
 * --keep-title` calls it, the spec's title is the person's name and stands
 * whatever another ticket is called.
 * Read after the plan is drafted, which is where the outcome comes from.
 */
function specTicketName(repo: string, key: string, markdown: string, keepTitle: boolean): string {
  const title = readSpecSections(markdown).text.title.replace(/\s+/g, " ").trim();
  const taken =
    !keepTitle &&
    snapshot.tasks.some(
      (row) => row.repoId === repo && row.ticket.key !== key && sameName(row.ticket.title, title),
    );
  return title.length > 0 && !taken ? title : plans.get(key)!.outcome;
}

/**
 * Draft a plan from a spec, as `admit --from-spec` does: one criterion per
 * requirement, each citing it, grouped into two nodes so a requirement's node
 * is something to look at. Where `planning` records the person titling the
 * spec and it still states that title, it is `--keep-title`: the ticket takes
 * the spec's title and the spec is left as it is (D-127).
 */
export function draftFromSpec(key: string, markdown: string, slug: string, planning: EditingSession | undefined): void {
  const read = readSpecSections(markdown);
  const keepTitle = planning !== undefined && keepsPersonsTitle(planning, read.text.title);
  const plan = plans.get(key)!;
  // The spec this plan was drafted from, as the CLI records it on admission.
  // Written here because the picker reads it: a ticket is what says a spec has
  // a plan, and a ticket the CLI admitted has no editing session to say it
  // instead (D-129). A sample hash, since nothing
  // here judges staleness — the shape is what is being stood in for.
  const row = snapshot.tasks.find((each) => each.ticket.key === key);
  if (row)
    row.ticket.admission.spec = {
      path: `specs/${slug}/spec.md`,
      content_sha256: "sha256:" + "0".repeat(64),
      files: [],
      names_that_resolved: null,
      symbols_judged_at_approval: false,
    };
  plan.outcome = read.text.outcome.split("\n")[0] || read.text.title || "Untitled work";
  if (!("acceptance_criteria" in plan)) return;
  const carried = read.requirements.filter((each) => each.id !== null);
  plan.acceptance_criteria = carried.map((requirement, index) => ({
    id: "ac_" + (index + 1),
    text: requirement.text,
    expected_verification: { kind: "test", assertion: requirement.text },
    requirement_id: requirement.id!,
  }));
  const half = Math.ceil(carried.length / 2) || 1;
  plan.nodes = carried.length > 1
    ? [
        {
          id: "node_1",
          title: "First part",
          criteria: plan.acceptance_criteria.slice(0, half).map((each) => each.id),
          paths: plan.scope.paths_allowed.slice(0, 1),
        },
        {
          id: "node_2",
          title: "Second part",
          criteria: plan.acceptance_criteria.slice(half).map((each) => each.id),
          paths: plan.scope.paths_allowed.slice(0, 1),
        },
      ].filter((node) => node.criteria.length > 0)
    : undefined;
  // A re-draft replaces the plan the edits were made to (D-103): they stay in
  // the log, marked replaced, and none of them can be undone from here.
  for (const edit of graphEdits.get(key) ?? []) edit.replaced = true;
  approaches.set(key, {
    ...approaches.get(key)!,
    edges: (plan.nodes?.length ?? 0) > 1 ? [{ from: "node_1", to: "node_2" }] : [],
    no_gos: read.text.no_gos
      .split("\n")
      .map((line) => line.replace(/^[-*]\s*/, "").trim())
      .filter((line) => line.length > 0),
  });
  // Named as `admit` names it, and the spec titled with that name as `admit`
  // titles it, before the verdict below is keyed on the spec
  // (D-127).
  if (row) {
    row.ticket.title = specTicketName(row.repoId, key, markdown, keepTitle);
    if (!keepTitle) saveSpec(slug, retitleSpec(markdown, row.ticket.title));
  }
  specOf.set(key, slug);
  // A plan just drafted agrees with its spec by construction, and the verdict
  // says so at these hashes, as `admit` seeds it.
  recordDrift(key, "drafted", [], false);
}

export const editingRecords = () => parseStored(EditingSessionSchema.array(), JSON.parse(localStorage.getItem("perbo:preview-editing") ?? "[]"), 'localStorage["perbo:preview-editing"]');
function persistEditing(records: EditingSession[]): void {
  const previous = editingRecords();
  localStorage.setItem("perbo:preview-editing", JSON.stringify(records));
  for (const record of records) if (JSON.stringify(previous.find((entry) => entry.id === record.id)) !== JSON.stringify(record)) emit({ kind: "editing", sessionId: record.id });
}
export const editing = new ContractEditing({
  records: editingRecords,
  persist: persistEditing,
  repository: (id) => {
    if (!snapshot.repositories.some((repo) => repo.id === id)) throw new Error("This sample repository is no longer connected.");
  },
  defaults: (repoId, key) => TaskModelsSchema.strip().parse(snapshot.taskModels?.[repoId + ":" + key] ?? snapshot.settings),
  detail: async (repoId, key) => {
    if (!snapshot.tasks.some((row) => row.repoId === repoId && row.ticket.key === key)) throw new Error("Sample task not found in this repository.");
    return structuredClone(detail(key));
  },
  start: (request, owner) => answer(request, owner),
  stop: async (jobId) => { await answer({ kind: "cancel", jobId }); },
  id: () => crypto.randomUUID(),
  // The sample repository keeps its specs in the default folder.
  specFolder: () => "specs",
  standing: (id) => standingFor(id),
  setStanding: (id, entries) => {
    writeStanding(id, entries);
    emit({ kind: "records", repoId: id, key: null });
  },
});
editing.recover();

/**
 * The sample interview (D-102, SCP-313): what the dock is driven against in a
 * browser, with no process, no provider and no repository behind it.
 *
 * It follows the same shape the host relays — the person's turn, what the
 * session said, a call the guard refused, and a plan edit through the one
 * validated edit path — so the chat can be seen and tested without Electron
 * and behaves the same when it reaches one.
 */
export const sampleInterviews = new Set<string>();
/**
 * How many turns each sample session owes the person, as the host counts
 * them: a second turn sent before the first is answered is owed too, and the
 * session is working until the last of them is over.
 */
export const sampleWorking = new Map<string, number>();
export const isWorking = (id: string): boolean => sampleWorking.has(id);
/**
 * What each sample turn in flight is doing that its lines do not show yet, as
 * the host keeps it: writing the spec, or holding a line still to be said.
 * Cleared by the next line the turn records.
 */
const sampleDoing = new Map<string, InterviewDoing>();
const doingOf = (id: string): InterviewDoing | null =>
  isWorking(id) ? (sampleDoing.get(id) ?? null) : null;
const sampleTurns = new Map<string, number>();
/** Whether this planning is still there to be spoken to. */
function stillThere(id: string): boolean {
  try {
    editing.read(id);
    return true;
  } catch {
    return false;
  }
}
/** The asking this planning is putting, or null where it holds none or has gone. */
export function askingOf(id: string): { entry: number; answered: number } | null {
  try {
    return editing.read(id).asking;
  } catch {
    return null;
  }
}
/** Push this planning's interview as it stands, with the line just added, if any — the host's own push. */
function interviewChanged(id: string, entry: InterviewEntry | null): void {
  const running = sampleInterviews.has(id);
  emit({ kind: "interview", sessionId: id, running, entry, asking: askingOf(id), working: isWorking(id), doing: doingOf(id) });
}
/** Say what the asking is now, with no line to add. */
export function askingChanged(id: string): void {
  interviewChanged(id, null);
}
/** Kept as the host keeps it, so the conversation survives a reload here too. */
export function converse(id: string, line: InterviewEntry["line"]): InterviewEntry {
  const entry = editing.converse(id, line, new Date().toISOString());
  if (line.kind !== "note") sampleDoing.delete(id);
  interviewChanged(id, entry);
  return entry;
}
/**
 * The sample session's own words, as the host relays them: none once the note
 * has handed the written spec over and the person has said nothing since,
 * because the note is what the turn says (D-102).
 */
function sessionSaid(id: string, text: string): void {
  if (afterTheNote.has(id)) return;
  converse(id, { kind: "said", text });
}
export function interviewStatus(id: string): InterviewStatus {
  const session = editing.read(id);
  return {
    id,
    running: sampleInterviews.has(id),
    interview: session.interviewSession,
    conversation: session.conversation,
  };
}
/**
 * The host's own naming of an unnamed spec from the person's first turn, in
 * the preview's terms: the same title, the same slug, the same note.
 */
export function nameSpecFromTurn(id: string, text: string): void {
  const session = editing.read(id);
  if (session.specSlug !== null) return;
  let title;
  try {
    title = specTitleFromMessage(text);
  } catch {
    throw new Error(INTERVIEW_NEEDS_A_TITLE);
  }
  const slug = specSlug(title);
  if (specFiles()[slug] !== undefined)
    throw new Error(
      `specs/${slug}/spec.md already exists, and '${title}' takes the same folder. ` +
        "Two pieces of work are two specs: give this one a title of its own, or open the spec " +
        "that is already there",
    );
  saveSpec(slug, renderSpec({ ...EMPTY_SPEC_TEXT, title }, { highWater: 0, existing: [] }).markdown);
  editing.recordSpec(id, slug, title);
  converse(id, { kind: "note", text: `Named specs/${slug} from your first message.` });
}
/**
 * The preview's model catalogs, shaped as each provider reports its own,
 * efforts included; the API reports none, so its rows offer no effort control.
 */
export function sampleCatalog(provider: ModelProvider): ModelCatalog {
  const rows: [string, string, string, EffortLevel[]][] =
    provider === "codex-cli"
      ? [
          ["o-class", "O-class", "Sample reviewer", ["low", "medium", "high", "xhigh"]],
          ["codex-sample", "Codex sample", "Sample coding model", ["low", "medium", "high"]],
        ]
      : provider === "anthropic"
        ? [["claude-opus-5", "Claude Opus 5", "Sample API model", []]]
        : [
            ["claude-opus-5", "Opus 5", "Sample · best for everyday, complex tasks", [...EFFORT_LEVELS["claude-cli"]]],
            ["claude-opus-5-5", "Opus 5.5", "Sample · the chat's model where it is offered", [...EFFORT_LEVELS["claude-cli"]]],
            ["claude-fable-5-1", "Fable 5.1", "Sample · hardest and longest-running tasks", [...EFFORT_LEVELS["claude-cli"]]],
            ["claude-sonnet-5", "Sonnet 5", "Sample · routine tasks", [...EFFORT_LEVELS["claude-cli"]]],
            ["claude-haiku-4-5", "Haiku 4.5", "Sample · no effort setting", []],
          ];
  return {
    provider,
    source: "sample",
    discoveredAt: new Date().toISOString(),
    models: rows.map(([id, label, description, efforts], index) => ({
      id,
      label,
      description,
      isDefault: index === 0,
      efforts,
    })),
  };
}
export function startSampleInterview(id: string): InterviewStatus {
  if (sampleInterviews.has(id)) return interviewStatus(id);
  const session = editing.read(id);
  if (session.specSlug === null)
    throw new Error(INTERVIEW_NEEDS_A_TITLE);
  const provider = interviewProviderFor(session.form.models);
  sampleInterviews.add(id);
  askingChanged(id);
  // The chat's model, chosen from the sample catalog as the host chooses it from the provider's.
  const model = interviewModelFor(session.form.models, sampleCatalog("claude-cli").models.map((row) => row.id));
  editing.recordInterview(id, "sample-session", provider, model);
  converse(id, {
    kind: "note",
    text: `Writing specs/${session.specSlug}/spec.md and docs/adr.`,
  });
  return interviewStatus(id);
}
/** The chat of a planning that has been discarded, ended with it (D-102). */
export function endPlanningChat(id: string): void {
  sampleInterviews.delete(id);
  sampleWorking.delete(id);
  emit({ kind: "interview", sessionId: id, running: false, entry: null, asking: askingOf(id), working: false, doing: null });
}
/**
 * The end of the sample's interview, as the host's stop ends a real one:
 * stopping ends the turn, and what the turn had already written is written, so
 * the way on from a drafted spec is the person's whether the session is still
 * there or not and the note is said on this ending as it is on the turn's own
 * (D-102).
 *
 * Its own function because Generate plan makes the same ending: the chat is
 * stopped before the plan is drafted from what it left behind.
 */
export function stopSampleInterview(id: string): void {
  sampleInterviews.delete(id);
  sampleWorking.delete(id);
  windUpTurn(id);
  askingChanged(id);
  converse(id, { kind: "note", text: "The chat ended: you stopped it." });
  void rereadDrift(id);
}
/**
 * The end of a sample turn, as the host reports one: the session is no longer
 * working, the asking is said as it stands, and — with a record of problems
 * between the plan and the spec on the planning — the plan is read against
 * the spec again, since the turn was the answer to one, or a hand edit after
 * a resolved round (D-128).
 */
function endSampleTurn(id: string): void {
  const owed = (sampleWorking.get(id) ?? 0) - 1;
  if (owed > 0) sampleWorking.set(id, owed);
  else {
    sampleWorking.delete(id);
    windUpTurn(id);
  }
  askingChanged(id);
  if (owed <= 0) void rereadDrift(id);
}

/**
 * What the host does as a turn ends, however it ends. The spec is written and
 * the plan is the person's to generate from it, said where the write did not
 * say it: only where this planning holds no plan yet, and only where the spec
 * actually moved. And the change is marked on the panes, where the turns moved
 * anything: measured from the first turn owed to the end of the last, as the
 * host measures them, so a turn queued behind another is not lost from the
 * marks.
 */
function windUpTurn(id: string): void {
  saySpecIsDrafted(id, pairAtTurn.get(id));
  saidDrafted.delete(id);
  afterTheNote.delete(id);
  sampleDoing.delete(id);
  marks.recordChangeSince(id, pairAtTurn.get(id));
  pairAtTurn.delete(id);
}

/**
 * The sessions already handed the written spec this turn, as the host keeps
 * them: the write says it and the turn's endings say it where the write did
 * not, and the person needs it once.
 */
const saidDrafted = new Set<string>();
/**
 * The sessions whose written spec has been handed over since the person last
 * said anything, as the host keeps them: what the session says meanwhile is
 * not shown.
 */
export const afterTheNote = new Set<string>();

/**
 * The note the host puts once a turn has written the spec with no plan beside
 * it (D-102): the interview writes the spec and stops there, so the next act
 * is the person's — read and change it on the Spec pane, ask for a change in
 * the chat, or press Generate plan at the foot of the Spec pane. Words and no
 * button, as the host puts it.
 */
function saySpecIsDrafted(id: string, before: PromisePair | null | undefined): void {
  if (saidDrafted.has(id)) return;
  if (before === undefined) return;
  let session;
  try {
    session = editing.read(id);
  } catch {
    return;
  }
  if (session.key !== null) return;
  const now = session.specSlug === null ? null : specSectionsAt(session.specSlug);
  // A pair the sample could not read at the turn's start is a spec it had
  // nothing of, which is the very turn this is for: the first one.
  if (now === null || JSON.stringify(now) === JSON.stringify(before?.spec ?? null)) return;
  saidDrafted.add(id);
  afterTheNote.add(id);
  converse(id, { kind: "note", text: INTERVIEW_WROTE_THE_SPEC, notable: true });
}

/** The five sections of a spec as its file says them, or null where there is no file. */
export function specSectionsAt(slug: string): SpecSections | null {
  const markdown = specFiles()[slug];
  return markdown === undefined ? null : sectionsOf(readSpecSections(markdown).text);
}
/** The pair as it stood when the first turn owed began, keyed by planning, as the host keeps it. */
export const pairAtTurn = new Map<string, PromisePair | null>();
/**
 * The change marks (D-128) over the sample's records, marked as the host marks
 * them (D-120): the sample's specs are one set whatever the repository, and a
 * ticket's plan is the contract it holds. A line the chat would say of a
 * planning that has gone is not said.
 */
export const marks = new ChangeMarks<{ readonly id: string }>({
  read: (id) => editing.read(id),
  sessions: () => editingRecords(),
  repository: (id) => ({ id }),
  spec: (_repo, slug) => specSectionsAt(slug),
  contract: (_repo, key) => {
    const plan = plans.get(key);
    if (plan === undefined) throw new Error(`${key} has no contract.`);
    return plan;
  },
  recordChange: (id, change) => editing.recordChange(id, change),
  say: (id, line) => {
    if (stillThere(id)) converse(id, line);
  },
  // The sample's errors are its own words, with no credential in them.
  redact: (text) => text,
});

/**
 * The plannings with a reading of their plan against the spec in flight, as
 * the host keeps them: from the moment one is asked for until its job has
 * settled. A second asked for meanwhile is owed instead.
 */
export const readings = new Set<string>();
/** The plannings owed another reading once the one in flight settles. */
const rereadOwed = new Set<string>();
/**
 * How many times each ticket's problems have been forgotten — dismissed or
 * approved past — so a reading that started before one and lands after it
 * knows the state it read is gone.
 */
export const driftEpoch = new Map<string, number>();

/** A reading's job has settled: the next one owed to the planning starts. */
export function readingSettled(id: string): void {
  readings.delete(id);
  if (rereadOwed.delete(id)) void rereadDrift(id);
}

/**
 * Read the plan against the spec again, as the host does once a turn ends
 * with a record on the planning: never over a reading already in flight, but
 * never lost either — a turn that ends while one is running is owed its
 * reading, which starts as that one settles, and however many turns end
 * meanwhile owe one reading between them. A reading that cannot be started
 * is said in the chat, because the page is waiting on it.
 */
async function rereadDrift(id: string): Promise<void> {
  if (!stillThere(id)) return;
  const session = editing.read(id);
  if (session.drift === null || session.key === null) return;
  const key = session.key;
  const live = snapshot.jobs.some((job) => job.kind === "drift" && job.key === key && isLive(job));
  if (readings.has(id) || live) {
    rereadOwed.add(id);
    return;
  }
  readings.add(id);
  try {
    // The host reads the ticket before the reading's job starts, and the page
    // is between the turn's end and the reading for that long: the same gap
    // here, so the page is held to the same rule.
    await new Promise((done) => setTimeout(done, 0));
    await answer({ kind: "driftCheck", id, state: null });
  } catch (error) {
    readings.delete(id);
    rereadOwed.delete(id);
    if (!stillThere(id)) return;
    converse(id, {
      kind: "note",
      text: `${REREAD_COULD_NOT_START}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * The problems over a ticket are forgotten — on one planning, or on every
 * planning over it — and a reading of it in flight is told so, as the host
 * tells one.
 */
export function forgetDrift(key: string, only: string | null): void {
  driftEpoch.set(key, (driftEpoch.get(key) ?? 0) + 1);
  for (const record of editingRecords())
    if (
      (only === null ? record.key === key : record.id === only) &&
      record.phase !== "discarded" &&
      record.drift !== null
    )
      editing.clearDrift(record.id);
}

/**
 * Land a reading on the planning it was of, as the host does: nothing is
 * recorded on a plan the person went past — dismissed or approved — while it
 * was read (D-128), and the state the asker read at is recorded only where no
 * turn overlapped the reading (D-NEW-basic-and-epic-flows).
 */
export function driftLanded(
  id: string,
  key: string,
  epoch: number,
  before: TurnMark,
  verdict: DriftVerdict,
  state: string | null,
): void {
  if ((driftEpoch.get(key) ?? 0) !== epoch) return;
  const row = snapshot.tasks.find((each) => each.ticket.key === key);
  if (row === undefined || row.ticket.approved_at) return;
  if (!stillThere(id)) return;
  const overlapped = turnOverlapped(before, editing.read(id), isWorking(id));
  if (overlapped && !isWorking(id)) rereadOwed.add(id);
  editing.landDrift(id, verdict, overlapped, (line) => converse(id, line), () => askingChanged(id));
  if (state !== null && !overlapped) editing.recordRead(id, state);
}

/**
 * The sample interview applying an answer to a problem, where the answer is
 * one of the shapes its own reading offers: a criterion reworded to the
 * spec's words, through the same edit path the Graph pane uses, or a
 * requirement reworded to the plan's, as a spec write. Anything else is not
 * an answer the sample knows how to apply, and the turn is answered as any
 * other. Returns whether it applied one.
 */
function applyDriftAnswer(id: string, key: string, text: string): boolean {
  const plan = plans.get(key);
  if (plan === undefined || !("acceptance_criteria" in plan)) return false;
  const reword = /^Reword criterion (\d+) to say: (.+)$/.exec(text.trim());
  if (reword !== null) {
    const criterion = plan.acceptance_criteria[Number(reword[1]) - 1];
    if (criterion === undefined) return false;
    const wording = reword[2]!.trim();
    writeGraphEdit(
      key,
      (state) =>
        applyGraphEdit(
          state,
          {
            op: "set_criterion",
            id: criterion.id,
            text: wording,
            expected_verification: criterion.expected_verification,
          },
          [],
        ),
      null,
      undefined,
      "interview",
    );
    const made = graphLog(key).at(-1)!;
    converse(id, {
      kind: "tool",
      tool: "edit_plan",
      ok: true,
      detail: `${key}: edit ${String(made.n)} — ${made.summary}`,
      edit: {
        n: made.n,
        author: made.author,
        summary: made.summary,
        undone: made.undone,
        undoes: made.undoes,
        before: Object.keys(made.before),
        after: made.keys,
      },
    });
    emit({ kind: "records", repoId: ticketRow(key).repoId, key });
    return true;
  }
  const respec = /^Change (R\d+) in the spec to say: (.+)$/.exec(text.trim());
  if (respec !== null) {
    const slug = editing.read(id).specSlug;
    const markdown = slug === null ? undefined : specFiles()[slug];
    if (slug === null || markdown === undefined) return false;
    const read = readSpecSections(markdown);
    const wording = respec[2]!.trim();
    const lines = read.text.requirements.split("\n");
    const at = lines.findIndex((line) => line.trim().startsWith(`- ${respec[1]}:`));
    if (at < 0) return false;
    lines[at] = `- ${respec[1]}: ${wording}`;
    const rendered = renderSpec(
      { ...read.text, requirements: lines.join("\n") },
      { highWater: read.highWater, existing: read.requirements },
    );
    saveSpec(slug, rendered.markdown);
    sessionSaid(id, `Changed ${respec[1]} in the spec to say: ${wording}`);
    emit({ kind: "records", repoId: ticketRow(key).repoId, key });
    return true;
  }
  return false;
}
/**
 * The sample's answer to one turn: the first is refused something it may not
 * run, so the refusal card is there to look at, and once this planning holds a
 * plan the second asks for an edit, which goes through the same edit path the
 * Graph pane uses and lands in the same history as the interview's.
 */
export function answerSampleTurn(id: string, text: string): void {
  if (!stillThere(id)) return;
  const turns = (sampleTurns.get(id) ?? 0) + 1;
  sampleTurns.set(id, turns);
  // Asking in its own words, with nothing to pick: what a session does when
  // the answer is the person's to write, and what the composer's rim is for.
  if (/\bask me plainly\b/i.test(text)) {
    // The turn's opening line, which the host holds until the turn shows what
    // it was — here, the whole of it — and the dock shows the session's
    // bubble with its dots meanwhile.
    sampleDoing.set(id, "speaking");
    askingChanged(id);
    setTimeout(() => {
      if (!sampleWorking.has(id) || !stillThere(id)) return;
      sessionSaid(id, "What should the dark mode start from — the light palette, or a palette of its own?");
      // And the turn ends a moment after it, as a real one does once its
      // last words are out: the question waits on the person only from there.
      setTimeout(() => {
        if (sampleWorking.has(id) && stillThere(id)) endSampleTurn(id);
      }, 400);
    }, 150);
    return;
  }
  // Asking with options, as the real session does through ask_options: two
  // groups, so the sample shows them put one at a time, and the first has two
  // parts that are read together.
  if (/\bask me\b/i.test(text)) {
    const asked = converse(id, {
      kind: "asked",
      groups: [
        {
          title: "How the queue is split",
          parts: [
            {
              question: "Where does the split go?",
              options: [
                { label: "Split at the read", detail: "The reader becomes its own node.", recommended: true },
                { label: "Split at the write", detail: "The writer becomes its own node.", recommended: false },
              ],
            },
            {
              question: "What proves it?",
              options: [
                { label: "A unit test per node", detail: null, recommended: false },
                { label: "One integration test", detail: null, recommended: false },
              ],
            },
          ],
        },
        {
          title: null,
          parts: [
            {
              question: "What happens to the old node?",
              options: [
                { label: "Delete it", detail: null, recommended: false },
                { label: "Keep it as a no-op", detail: null, recommended: false },
              ],
            },
          ],
        },
      ],
    });
    editing.beginAsking(id, asked.n);
    askingChanged(id);
    // The session closes the turn it asked in, as both transports do: the card
    // has to survive this.
    sessionSaid(id, "Questions are with you — the first group is above.");
    endSampleTurn(id);
    return;
  }
  if (turns === 1)
    converse(id, {
      kind: "refused",
      tool: "Bash",
      rule: "allow_list",
      target: "pnpm test",
      reason:
        "pnpm test is not one of the read-only shapes this session may run. The chat reads " +
        "the test files instead.",
    });
  const key = editing.read(id).key;
  const plan = key === null ? null : plans.get(key);
  const criterion =
    plan && "acceptance_criteria" in plan ? plan.acceptance_criteria[0] : undefined;
  // An answer to a problem between the plan and the spec, in the words the
  // sample's own reading offered: applied as the real interview applies a
  // turn, through the edit path for the plan and a spec write for the spec,
  // so the reading that follows the turn finds the problem closed and puts
  // the next. What is matched is the sentence the person picked or typed,
  // and it moves the plan or the spec the way any turn of theirs does; it
  // reaches no path, command or argument (ADR-0023 §4).
  if (key !== null && plan && "acceptance_criteria" in plan && applyDriftAnswer(id, key, text)) {
    endSampleTurn(id);
    return;
  }
  // The interview writing the spec, asked for by name: the one thing it does
  // that the sample otherwise never shows, and the turn it ends with the note
  // that hands the plan to the person.
  const slug = editing.read(id).specSlug;
  const markdown = slug === null ? undefined : specFiles()[slug];
  if (/\bwrite the spec\b/i.test(text) && slug !== null && markdown !== undefined) {
    // Said as the write is admitted, which is where the host says it: the spec
    // is a pane away and writing it is what the person waits through, so the
    // status line says so until it is written.
    sampleDoing.set(id, "writing_the_spec");
    askingChanged(id);
    setTimeout(() => {
      if (!sampleWorking.has(id) || !stillThere(id)) return;
      const read = readSpecSections(markdown);
      const rendered = renderSpec(
        {
          ...read.text,
          outcome:
            "A month view shows the days of one month, and a day shows what is on it.",
        },
        { highWater: read.highWater, existing: read.requirements },
      );
      saveSpec(slug, rendered.markdown);
      // And that it is written, right after the write, as the host says it:
      // the spec is readable now and the next act is the person's. No wait
      // before the reading here, where the host defers one — the sample writes
      // the file itself, so the bytes are already there on the line after the
      // write.
      saySpecIsDrafted(id, pairAtTurn.get(id));
      // And goes on working after it, as a real session can: a quiet tool
      // call the chat does not draw, which the dock would otherwise read as
      // work in hand under the note (D-102).
      converse(id, { kind: "tool", tool: "read_plan", ok: true, detail: "No plan yet.", edit: null });
      // And the session goes on composing after it, as a real one can: what
      // it says once the note is out is not shown, because the note is what
      // the turn says (D-102). The turn ends there, and saying so is what
      // takes the turn off the dock — a branch that returned without it would
      // leave the sample saying it is working for ever, which is the one
      // thing this pane must never do. Dropped where the turn has already been
      // wound up under it, by the press that drafts or by a stop.
      setTimeout(() => {
        if (!sampleWorking.has(id) || !stillThere(id)) return;
        sessionSaid(id, "That is the spec as I have it. Tell me what to change, or generate the plan.");
        endSampleTurn(id);
      }, 400);
    }, 150);
    return;
  }
  // The interview writing the Requirements in a form of its own — numbered
  // paragraphs rather than `- R1:` items — as a real session writing the file
  // with its own tools can. The pane reads them as requirements with no id,
  // and the drafter reads no requirement at all.
  if (/\bwrite the requirements\b/i.test(text) && slug !== null && markdown !== undefined) {
    saveSpec(
      slug,
      markdown.replace(
        /^## Requirements\n[^#]*/m,
        "## Requirements\n\nR1. A toggle in the header switches the theme.\n\n" +
          "R2. The choice is kept across reloads.\n\n",
      ),
    );
    endSampleTurn(id);
    return;
  }
  // A tool that was refused. The dock keeps these where it drops the ones that
  // worked, and shows the reason without asking, because that is the thing to
  // act on — a rule with no way to reach its refused arm is a rule nothing can
  // check.
  if (/\brefuse it\b/i.test(text)) {
    converse(id, {
      kind: "tool",
      tool: "edit_plan",
      ok: false,
      detail:
        "node_404 is not in this plan. read_plan reads the nodes it has, and an edge may only " +
        "name two of them.",
      edit: null,
    });
    endSampleTurn(id);
    return;
  }
  if (/\btake it back\b/i.test(text) && key !== null) {
    const last = graphLog(key).at(-1);
    if (last !== undefined && last.undoes === null && !last.undone) {
      undoGraphEditAt(key, last.n);
      const made = graphLog(key).at(-1)!;
      converse(id, {
        kind: "tool",
        tool: "undo_edit",
        ok: true,
        detail: `${key}: edit ${String(made.n)} — ${made.summary}`,
        edit: {
          n: made.n,
          author: made.author,
          summary: made.summary,
          undone: made.undone,
          undoes: made.undoes,
          before: Object.keys(made.before),
          after: made.keys,
        },
      });
      emit({ kind: "records", repoId: ticketRow(key).repoId, key });
      endSampleTurn(id);
      return;
    }
  }
  if (turns > 1 && key !== null && criterion !== undefined) {
    writeGraphEdit(
      key,
      (state) =>
        applyGraphEdit(
          state,
          {
            op: "set_criterion",
            id: criterion.id,
            text: `${criterion.text}, within 60 seconds`,
            expected_verification: criterion.expected_verification,
          },
          [],
        ),
      null,
      undefined,
      "interview",
    );
    const made = graphLog(key).at(-1)!;
    converse(id, {
      kind: "tool",
      tool: "edit_plan",
      ok: true,
      detail: `${key}: edit ${String(made.n)} — ${made.summary}`,
      edit: {
        n: made.n,
        author: made.author,
        summary: made.summary,
        undone: made.undone,
        undoes: made.undoes,
        before: Object.keys(made.before),
        after: made.keys,
      },
    });
    emit({ kind: "records", repoId: ticketRow(key).repoId, key });
  }
  // A line that reports something, then a pause before the rest of the same
  // turn — which is the shape a real session takes, and the pause the dock has
  // to keep saying it is working through. Not an announcement of what it is
  // about to do: the host drops one of those before anything has been done,
  // and the indicator says it better.
  sessionSaid(id, "Nothing here sets a colour mode yet.");

  // Asked to take its time, it pauses for longer than a line's words take to
  // replace its dots, so the pause itself is there to be seen.
  const pause = /\btake your time\b/i.test(text) ? 900 : 60;
  setTimeout(() => {
    // The rest of a turn can land after the planning it belongs to has gone —
    // a pane left, a test ended — and a sample session speaking into a session
    // that is not there throws where nothing is waiting to catch it.
    if (!stillThere(id)) return;
    sessionSaid(
      id,
      `Noted: “${text}”. This is the sample workspace, so nothing here reaches a provider.`,
    );
    endSampleTurn(id);
  }, pause);
}

/**
 * Delete a sample ticket with everything kept beside it, as the host's
 * `discardTicket` deletes its files, and answer with the reason it stays where
 * it does, in the host's words and in the host's order (D-129): a command
 * running in the repository holds every delete, and a ticket whose pull
 * request is open is the one stage a delete does not reach. The attempts and
 * the bundles they sealed are held beside the ticket here rather than in a
 * store of their own, so they go with it.
 */
export function discardTicket(repoId: string, key: string): string | null {
  if (heldRepository(snapshot.jobs, repoId)) return DELETE_WAITS_FOR_COMMANDS;
  const row = snapshot.tasks.find((entry) => entry.repoId === repoId && entry.ticket.key === key);
  if (row === undefined) return DELETE_TICKET_GONE;
  if (row.ticket.state === "pr_open") return deletePullRequestOpen(key);
  snapshot.tasks = snapshot.tasks.filter((entry) => entry !== row);
  plans.delete(key);
  approaches.delete(key);
  graphEdits.delete(key);
  approved.delete(key);
  specOf.delete(key);
  // The reading of the plan against its spec goes with the plan, as the host
  // drops `<KEY>.drift.json` beside the ticket.
  driftRecords.delete(key);
  // Its preferences, as the host forgets them: a key is never handed out
  // again, so once the ticket is gone they name nothing.
  const entry = repoId + ":" + key;
  const { [entry]: title, ...titles } = snapshot.titles ?? {};
  const { [entry]: models, ...taskModels } = snapshot.taskModels ?? {};
  void title;
  void models;
  snapshot.titles = titles;
  snapshot.taskModels = taskModels;
  snapshot.archived = (snapshot.archived ?? []).filter((item) => item !== entry);
  snapshot.lastOpened = Object.fromEntries(Object.entries(snapshot.lastOpened ?? {}).filter(([item]) => item !== entry));
  // And every planning over it, as the host discards them, with their chats
  // (D-102): a planning over a ticket that is gone has nothing left to open.
  const over = (session: EditingSession): boolean =>
    session.repoId === repoId && session.key === key && session.phase !== "discarded";
  const sessions = editingRecords();
  persistEditing(
    sessions.map((session) =>
      over(session)
        ? { ...session, phase: "discarded", resumeNew: false, revision: session.revision + 1 }
        : session,
    ),
  );
  for (const session of sessions.filter(over)) endPlanningChat(session.id);
  emitPreferences();
  emit({ kind: "records", repoId, key: null });
  return null;
}
