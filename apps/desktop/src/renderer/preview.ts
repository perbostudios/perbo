import {
  HELP_LINKS,
  EditingSessionSchema,
  INTERVIEW_NEEDS_A_TITLE,
  PREVIEW_BYTE_CAP,
  RequestSchema,
  TaskModelsSchema,
} from "../shared/protocol.js";
import {
  EMPTY_SPEC_TEXT,
  mergeSpecText,
  readSpecSections,
  renderSpec,
  requirementNodes,
  specSlug,
  specTitleFromMessage,
  type Spec,
} from "@perbo/planning/spec-text";
import {
  applyGraphEdit,
  blockingEdit,
  emptyApproach,
  undoGraphEdit,
  type GraphEditOutcome,
} from "@perbo/planning/graph-edit";
import { renderNodePage } from "@perbo/planning/node-page-text";
import { impactReport } from "@perbo/planning/impact";
import { planNodes } from "@perbo/contracts/plan";
import { planSizeCounts, sizeEstimate } from "@perbo/contracts/size";
import { ContractEditing, interviewProviderFor, openDrafts, type EditingOwner } from "../shared/contract-editing.js";
import { archiveCsv, archiveRows } from "../shared/archive.js";
import { nodeState } from "../shared/graph-state.js";
import { busyMessage, exclusiveJob, isLive, lane } from "../shared/jobs.js";
import type {
  PlanContract,
  ReviewArtifact,
  SymbolIndex,
  Ticket,
  UnsupportedRepository,
} from "@perbo/contracts";
import type { ApproachRecord } from "@perbo/contracts/approach";
import type { GraphEdit } from "@perbo/contracts/graph-edit";
import type { StandingProhibitedEntry } from "@perbo/contracts/standing";
import { isNeverReadPath, matchesAny } from "@perbo/contracts/paths";
import { SettingsSchema } from "../shared/protocol.js";
import type {
  DesktopBridge,
  Detail,
  Draft,
  ExplorerFile,
  Job,
  ManifestEditor,
  ReplyMap,
  Request,
  Snapshot,
  TaskRow,
  TaskSummary,
  Change,
  ChangeInput,
  SpecSections,
  SpecView,
  GraphCriterionView,
  GraphEditView,
  GraphLiveView,
  GraphView,
  InterviewEntry,
  InterviewStatus,
} from "../shared/protocol.js";

/** The supplied mockup's records, isolated behind the browser-only bridge.
 * No native process, credential, repository or network operation is available here.
 * The same screens and transitions render native records in Electron.
 */
const repoId = "80000000-0000-4000-8000-000000000001";
const landingId = "80000000-0000-4000-8000-000000000002";
const at = "2026-09-08T09:40:00.000Z";
const base = "a1b2c3d" + "0".repeat(33);
const plans = new Map<string, PlanContract>(),
  /** The order between a plan's nodes and the spec's No-Gos, beside the ticket (D-100). */
  approaches = new Map<string, ApproachRecord>(),
  approved = new Set<string>(),
  decisionsAnswered = new Set<string>();
const criteriaText = [
  "A signup POST queues exactly one activation email.",
  "No email is sent for a duplicate signup inside five minutes.",
  "A send failure is retried three times, then dead-lettered.",
];
const activationOutcome =
  "New users receive an activation email within 60 seconds of signing up.";
let next = 422;
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
    admission: { elapsed_ms: 100, criteria_source: "typed", criteria_count: 3 },
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
    },
    history: [],
  } as unknown as Ticket;
}
function row(
  number: number,
  title: string,
  state: Ticket["state"],
  summary: TaskRow["summary"],
): TaskRow {
  return {
    repoId,
    repository: "webstore",
    ticket: sample(number, title, state),
    ...(summary ? { summary } : {}),
  };
}
const home = [
  row(412, "Activation email never sent on signup", "changes_requested", {
    created: "22 min ago",
    stage: 4,
    description:
      "Activation mail is queued but never sent for a fresh signup. One decision is waiting: where a permanently failed send should be retained.",
  }),
  row(377, "Backfill the audit table", "pr_open", {
    created: "yesterday",
    stage: 6,
    description:
      "Both loops finished and the reviewer approved. 3 of 3 criteria directly verified — the merge is the only thing left, and it is yours.",
  }),
  row(398, "Rate-limit the invite endpoint", "executing", {
    created: "1h ago",
    stage: 2,
    description:
      "Editing packages/api/invite.ts — step 3 of the agent’s own plan.",
    progress: 58,
    elapsed: "4m 12s",
    cost: "$0.61",
    files: 6,
  }),
  row(404, "Cache the pricing table response", "verifying", {
    created: "2h ago",
    stage: 3,
    description:
      "Running typecheck, lint and 184 tests on the sealed change set. Nothing needed from you unless one of them fails.",
  }),
  row(421, "Split the settings page into tabs", "plan_review", {
    created: "3h ago",
    stage: 1,
    description:
      "Criteria drafted and the contract is compiled, waiting for your approval before the loop starts.",
  }),
];
home.forEach((row, index) => {
  row.ticket.updated_at = new Date(Date.parse(at) - index * 1000).toISOString();
});
const archived = [
  [
    409,
    "Retry the webhook dispatcher three times",
    4,
    4,
    "$2.14",
    "#418 · 2 Sep",
    "webstore",
  ],
  [
    402,
    "Reject signups with a plus-addressed duplicate",
    3,
    3,
    "$0.91",
    "#411 · 31 Aug",
    "webstore",
  ],
  [
    396,
    "Show runway on the billing page",
    2,
    3,
    "$3.40",
    "closed unmerged",
    "landing",
  ],
  [
    390,
    "Move session cookies to the shared domain",
    2,
    2,
    "$0.62",
    "#399 · 28 Aug",
    "webstore",
  ],
  [
    385,
    "Dead-letter the invoice sync job",
    3,
    3,
    "$1.77",
    "#394 · 26 Aug",
    "webstore",
  ],
  [
    381,
    "Debounce the search-as-you-type request",
    2,
    2,
    "$0.48",
    "#388 · 24 Aug",
    "landing",
  ],
  [
    374,
    "Expire password reset links after an hour",
    3,
    3,
    "$0.83",
    "#379 · 21 Aug",
    "webstore",
  ],
  [
    366,
    "Paginate the members table",
    2,
    2,
    "$1.12",
    "#371 · 19 Aug",
    "webstore",
  ],
  [
    359,
    "Stop double-charging annual upgrades",
    4,
    4,
    "$2.86",
    "#364 · 16 Aug",
    "webstore",
  ],
  [
    352,
    "Log webhook retries with a request id",
    2,
    2,
    "$0.54",
    "#357 · 14 Aug",
    "landing",
  ],
] as const;
const archive: TaskRow[] = archived.map(
  ([number, title, met, total, cost, delivery, repository], index) => {
    const result = row(
      number,
      title,
      delivery === "closed unmerged" ? "closed" : "merged",
      { criteriaMet: met, criteriaTotal: total, cost, delivery },
    );
    result.repoId = repository === "landing" ? landingId : repoId;
    result.repository = repository;
    result.ticket.updated_at = new Date(
      Date.parse(at) - (index + 1) * 86_400_000,
    ).toISOString();
    return result;
  },
);
for (let i = 0; i < 118; i++) {
  const result = row(300 - i, "Sample archived task " + (i + 11), "merged", {
    criteriaMet: 2,
    criteriaTotal: 2,
    cost: "$1.00",
    delivery: "sample",
  });
  result.ticket.updated_at = new Date(
    Date.parse(at) - (i + 11) * 86_400_000,
  ).toISOString();
  archive.push(result);
}
const initial: Snapshot = {
  mode: "preview",
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
  jobs: [],
  errors: [],
  titles: {},
  taskModels: {},
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
function sampleSummary(key: string): TaskSummary {
  const row = snapshot.tasks.find((entry) => entry.ticket.key === key);
  if (!row) throw new Error("Sample task not found.");
  const known = sampleDiffs[key];
  const number = Number(key.replace(/^PRB-/, ""));
  if (row.ticket.state === "plan_review" || row.ticket.state === "ready")
    return { branch: null, attempts: 0, latestAttemptAt: null, costMicros: null, costBasis: "none", diff: null, note: null };
  return {
    branch: known?.[0] ?? `perbo/${number}-sample`,
    attempts: 1,
    latestAttemptAt: row.ticket.updated_at,
    costMicros: row.summary?.cost ? Math.round(Number(row.summary.cost.replace("$", "")) * 1_000_000) : 610_000,
    costBasis: "priced",
    diff: known
      ? { files: known[1], additions: known[2], deletions: known[3] }
      : { files: 2, additions: 20 + (number % 7), deletions: 4 + (number % 3) },
    note: null,
  };
}
const snapshot: Snapshot = new URLSearchParams(location.search).has("empty")
  ? {
      ...initial,
      settings: SettingsSchema.parse({}),
      repositories: [],
      tasks: [],
      archived: [],
    }
  : initial;
const sampleManifests = new Map<
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
const emit = (input: ChangeInput = { kind: "records", repoId: null, key: null }): void => {
  snapshot.sequence = (snapshot.sequence ?? 0) + 1;
  const change = { ...input, sequence: snapshot.sequence };
  for (const listener of listeners) listener(structuredClone(change));
};
function ticketRow(key: string): TaskRow {
  const row = snapshot.tasks.find((row) => row.ticket.key === key);
  if (!row) throw new Error("Sample task not found.");
  return row;
}
function applyDraft(ticket: Ticket, draft: Draft): void {
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
function reviewFor(key: string): ReviewArtifact {
  const isApproved = approved.has(key),
    plan = plans.get(key)!,
    criteria = "acceptance_criteria" in plan ? plan.acceptance_criteria : [];
  return {
    review_id: "rev_preview",
    created_at: at,
    target: { base_commit: base, head_commit: "c".repeat(40) },
    decision: isApproved ? "approve" : "escalate",
    coverage: criteria.map((criterion, index) => ({
      criterion_id: criterion.id,
      status: isApproved || index !== 2 ? "met" : "cannot_determine",
      verification_strength:
        isApproved || index !== 2 ? "directly_verified" : "asserted_only",
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
    findings: isApproved
      ? []
      : [
          {
            key: "d".repeat(64),
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
function detail(key: string): Detail {
  const { ticket } = ticketRow(key),
    contract = plans.get(key)!;
  const isApproved = approved.has(key),
    waiting = !isApproved && ticket.state === "changes_requested";
  const sample: NonNullable<Detail["sample"]> = {
    progress: waiting ? 52 : 38,
    stage: waiting ? 4 : ticket.state === "verifying" ? 3 : 2,
    current: "Editing packages/queue/retry.ts",
    elapsed: "21m",
    steps: [
      {
        text: "Worktree materialised from a1b2c3d with 3 manifest files",
        time: "39s",
        state: "complete",
      },
      {
        text: "Read packages/queue — found the webhook failure table",
        time: "1m 04s",
        state: "complete",
      },
      {
        text: "Wrote the retry path in auth/signup.ts",
        time: "2m 11s",
        state: "complete",
      },
      {
        text: "Editing queue/retry.ts — dead-letter behaviour",
        time: "now",
        state: "current",
      },
      {
        text: "Run pnpm test, typecheck, lint and the scope ledger",
        time: "queued",
        state: "queued",
      },
      {
        text: "Hand the sealed change set to the reviewer",
        time: "queued",
        state: "queued",
      },
    ],
    decisions: waiting
      ? [
          {
            id: "dead-letter",
            title: "Where should a permanently failed email go?",
            context:
              "Criterion 03 says “dead-lettered”. The queue has no dead-letter table, so this changes the shape of the diff rather than a line of it.",
            options: [
              {
                title: "A new dead_letters table",
                detail:
                  "Matches how packages/queue already stores webhook failures, so the reviewer can check it against tests that exist.",
                recommended: true,
                metadata: ["+1 migration", "reversible", "~2 min more"],
              },
              {
                title: "A status column on the existing table",
                detail:
                  "Smaller diff. Failures then compete with live rows for the same index.",
              },
              {
                title: "Log it and drop it",
                detail:
                  "Cheapest. Criterion 03 becomes provable only by a log assertion — marked asserted_only.",
              },
            ],
          },
          {
            id: "retention",
            title: "How long should a dead-lettered row be kept?",
            context:
              "Choose how long failed deliveries remain available for inspection.",
            options: [
              {
                title: "30 days, then a scheduled purge",
                detail:
                  "Keeps recent failures available without growing the table forever.",
                recommended: true,
              },
              {
                title: "Keep rows until manually removed",
                detail: "Retains every failure for investigation.",
              },
            ],
          },
          {
            id: "retry",
            title: "Should the retry delay be configurable?",
            context: "Choose the behaviour to ship with this change.",
            options: [
              {
                title: "Hard-code 30s for now, note it in the PR",
                detail: "Keep the first version simple.",
                recommended: true,
              },
              {
                title: "Make the delay configurable",
                detail: "Expose the retry delay as a setting.",
              },
            ],
          },
        ]
      : [],
    transcript: [
      {
        author: "Executor",
        label: "plan · 2m 04s",
        text: "The queue stores webhook failures in webhook_failures, keyed by delivery. Activation mail has no equivalent, so criterion 03 has nowhere to record a permanent failure. Two shapes are possible: reuse that table’s shape for a new one, or widen the existing queue row.",
      },
      {
        author: "Executor",
        label: "decision raised · 4m 12s",
        text: "This is a choice the contract does not settle, and it changes the shape of the diff rather than a line of it. Pausing to ask instead of picking for you.",
      },
      {
        author: "Executor",
        label: "resume · 5m 52s",
        text: "Answer received: a new dead_letters table. Writing the migration first, then the terminal branch.",
      },
      {
        author: "Reviewer",
        label: "review · 11m 08s",
        text: "I have the diff, the three criteria and the check output. I do not have the executor’s account of what it did, by design.",
      },
      {
        author: "Reviewer",
        label: "finding · 11m 40s",
        text: "Criterion 03 is proven by queue/retry.test.ts:88, which never ran — describe.skip is still in the file. 184 tests passed and not one of them touched retry behaviour. Marking it asserted_only and returning it to the executor.",
      },
    ],
    terminal:
      "$ pnpm test --filter queue\nRUN v2.1.4 /worktrees/ayo_wt_2\n✓ auth/signup.test.ts (2 tests) 412ms\n✓ queue/retry.test.ts (3 tests) 388ms\nTest Files 12 passed (12)\n     Tests 186 passed (186)",
  };
  return {
    ticket,
    contract,
    digest: String(ticket.plan_version).repeat(64),
    attempts:
      ticket.state === "plan_review"
        ? []
        : [
            {
              id: "preview-attempt-" + key,
              run: 1,
              round: 0,
              startedAt: at,
              outcome: isApproved ? "approve" : "escalate",
              termination: "Sample attempt complete",
              model: "sonnet-class",
              costMicros: isApproved ? 1940000 : 610000,
              costBasis: "sample",
              partial: false,
              ceilings: [
                {
                  resource: "attempt_commands",
                  used: 23,
                  ceiling: 40,
                  hit: false,
                },
              ],
              review: reviewFor(key),
              reviewDecision: isApproved ? "approve" : "escalate",
              changes: sampleChanges,
              // What gates the change is the whole-change run; a node's own
              // result is evidence for that node's review (D-107).
              checks: sampleChecks
                .filter((check) => check.node === null)
                .map((check) => ({
                  name: check.name,
                  status: check.status,
                  detail: "Sample result",
                })),
              verification: null,
              bundles: [],
            },
          ],
    cost: {
      micros:
        ticket.state === "plan_review" ? 0 : isApproved ? 1940000 : 610000,
      partial: false,
      unavailable: 0,
    },
    principles: "",
    verdicts: [],
    effective: { stallMinutes: 12, ticketDollars: 2.5 },
    report: { sample: true },
    sample,
  };
}
/** The labels the native host gives each command, kind for kind, so a refusal names what the person sees there. */
const LABELS: Record<string, string> = {
  draft: "Draft a task contract",
  admit: "Save task contract",
  edit: "Update task contract",
  graphEdit: "Change the plan's graph",
  graphUndo: "Undo a plan edit",
  run: "Run engineering loop",
  decide: "Run engineering loop",
  doctor: "Check repository readiness",
  sync: "Refresh delivery from GitHub",
  principle: "Record a product decision",
  verdict: "Record finding feedback",
};
function job(
  kind: string,
  repository: string,
  key: string | null,
  operation: (job: Job) => void,
  delay = 1000,
  owner?: EditingOwner,
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
  snapshot.jobs = [...snapshot.jobs.slice(-39), job];
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
      }).finally(() => emit({ kind: "records", repoId: repository, key: job.resultKey ?? key, job }));
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
const SAMPLE_INDEX: Record<string, SymbolIndex | UnsupportedRepository> = {
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
function standingFor(id: string): StandingProhibitedEntry[] {
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
function sampleFiles(id: string): string[] {
  const listed = SAMPLE_FILES[id];
  if (!listed) throw new Error("This sample repository is no longer connected.");
  return listed;
}
/** The read the native host performs, over sample bytes: the same refusals, in the same words. */
function sampleRead(id: string, requested: string): ExplorerFile {
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
const specFiles = (): Record<string, string> => {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SPECS_KEY) ?? "{}");
    return raw !== null && typeof raw === "object" ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
};
const saveSpec = (slug: string, markdown: string): void => {
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
function specView(id: string): SpecView {
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
const specOf = new Map<string, string>();
const graphLog = (key: string): PreviewGraphEdit[] => {
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
function writeGraphEdit(
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
  ticket.title = outcome.contract.outcome;
}

/** `perbo edit --undo <n>`, with D-100's rule about a later edit in the way. */
function undoGraphEditAt(key: string, number: number): void {
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
 * What the sample records say about a sample graph (SCP-317), through the same
 * derivation the host uses: the sealed change set, the pinned checks per node
 * and the review artifact's coverage, and nothing the executor said. The
 * sample has one review of one plan, so the host's staleness and closure reads
 * have nothing to answer here.
 */
function liveFor(key: string, nodes: readonly { id: string; paths: readonly string[]; criteria: readonly string[] }[]): GraphLiveView {
  const { ticket } = ticketRow(key);
  if (ticket.state === "plan_review" || ticket.state === "ready")
    return {
      attempt: null,
      nodes: nodes.map((node) => ({
        id: node.id,
        state: "untouched",
        changed: [],
        checks: [],
        criteria: node.criteria.map((id) => ({ id, state: "unbound", strength: null, evidence: null, finding: null })),
      })),
      outside: [],
      note: null,
    };
  const review = reviewFor(key);
  const bound = new Map(review.coverage.map((entry) => [entry.criterion_id, entry]));
  const open = new Map(
    review.findings
      .filter((finding) => finding.criterion_id !== null && finding.status === "open")
      .map((finding) => [finding.criterion_id!, finding.statement]),
  );
  const changed = sampleChanges.map((change) => change.path);
  return {
    attempt: "preview-attempt-" + key,
    nodes: nodes.map((node) => {
      const touched = changed.filter((path) => matchesAny(path, node.paths)).sort();
      const ran = sampleChecks
        .filter((check) => check.node === node.id)
        .map((check) => ({ name: check.name, status: check.status }));
      const criteria = node.criteria.map((id) => {
        const binding = bound.get(id);
        const place = binding?.evidence?.location ?? null;
        return {
          id,
          state: binding?.status ?? ("unbound" as const),
          strength: binding?.verification_strength ?? null,
          evidence: place ? (place.line ? `${place.file}:${place.line}` : place.file) : (binding?.evidence?.ref ?? null),
          finding: open.get(id) ?? null,
        };
      });
      return {
        id: node.id,
        state: nodeState({ touched, ran, criteria }),
        changed: touched,
        checks: ran,
        criteria,
      };
    }),
    outside:
      nodes.length === 0
        ? []
        : changed.filter((path) => !nodes.some((node) => matchesAny(path, node.paths))).sort(),
    note: null,
  };
}

/** One plan's graph, its size and its history, as the native host reads them. */
function graphView(repoId: string, key: string): GraphView {
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
 * Draft a plan from a spec, as `admit --from-spec` does: one criterion per
 * requirement, each citing it, grouped into two nodes so a requirement's node
 * is something to look at.
 */
function draftFromSpec(key: string, markdown: string, slug: string): void {
  const read = readSpecSections(markdown);
  const plan = plans.get(key)!;
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
  specOf.set(key, slug);
}

const editingRecords = () => EditingSessionSchema.array().parse(JSON.parse(localStorage.getItem("perbo:preview-editing") ?? "[]"));
const editing = new ContractEditing({
  records: editingRecords,
  persist: (records) => {
    const previous = EditingSessionSchema.array().parse(JSON.parse(localStorage.getItem("perbo:preview-editing") ?? "[]"));
    localStorage.setItem("perbo:preview-editing", JSON.stringify(records));
    for (const record of records) if (JSON.stringify(previous.find((entry) => entry.id === record.id)) !== JSON.stringify(record)) emit({ kind: "editing", sessionId: record.id });
  },
  repository: (id) => {
    if (!snapshot.repositories.some((repo) => repo.id === id)) throw new Error("This sample repository is no longer connected.");
  },
  defaults: (repoId, key) => TaskModelsSchema.strip().parse(snapshot.taskModels?.[repoId + ":" + key] ?? snapshot.settings),
  detail: async (repoId, key) => {
    if (!snapshot.tasks.some((row) => row.repoId === repoId && row.ticket.key === key)) throw new Error("Sample task not found in this repository.");
    return structuredClone(detail(key));
  },
  start: (request, owner) => previewRequest(request, owner),
  stop: async (jobId) => { await previewRequest({ kind: "cancel", jobId }); },
  id: () => crypto.randomUUID(),
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
const sampleInterviews = new Set<string>();
/** The sample sessions working on what they will say next, as the host tracks. */
const sampleWorking = new Set<string>();
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
function askingOf(id: string): { entry: number; answered: number } | null {
  try {
    return editing.read(id).asking;
  } catch {
    return null;
  }
}
/** Say what the asking is now, with no line to add — the host's own push. */
function askingChanged(id: string): void {
  emit({
    kind: "interview",
    sessionId: id,
    running: sampleInterviews.has(id),
    entry: null,
    asking: askingOf(id),
    working: sampleWorking.has(id),
  });
}
/** Kept as the host keeps it, so the conversation survives a reload here too. */
function converse(id: string, line: InterviewEntry["line"]): InterviewEntry {
  const entry = editing.converse(id, line, new Date().toISOString());
  emit({
    kind: "interview",
    sessionId: id,
    running: sampleInterviews.has(id),
    entry,
    asking: askingOf(id),
    working: sampleWorking.has(id),
  });
  return entry;
}
function interviewStatus(id: string): InterviewStatus {
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
function nameSpecFromTurn(id: string, text: string): void {
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
  editing.recordSpec(id, slug);
  converse(id, {
    kind: "note",
    text:
      `Named specs/${slug} from your first message.`,
  });
}
function startSampleInterview(id: string): InterviewStatus {
  if (sampleInterviews.has(id)) return interviewStatus(id);
  const session = editing.read(id);
  if (session.specSlug === null)
    throw new Error(INTERVIEW_NEEDS_A_TITLE);
  const provider = interviewProviderFor(session.form.models);
  sampleInterviews.add(id);
  emit({ kind: "interview", sessionId: id, running: true, entry: null, asking: askingOf(id), working: sampleWorking.has(id) });
  editing.recordInterview(id, "sample-session", provider);
  converse(id, {
    kind: "note",
    text: `Writing specs/${session.specSlug}/spec.md and docs/adr.`,
  });
  return interviewStatus(id);
}
/**
 * The sample's answer to one turn: the first is refused something it may not
 * run, so the refusal card is there to look at, and once this planning holds a
 * plan the second asks for an edit, which goes through the same edit path the
 * Graph pane uses and lands in the same history as the interview's.
 */
function answerSampleTurn(id: string, text: string): void {
  if (!stillThere(id)) return;
  const turns = (sampleTurns.get(id) ?? 0) + 1;
  sampleTurns.set(id, turns);
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
    converse(id, { kind: "said", text: "Questions are with you — the first group is above." });
    sampleWorking.delete(id);
    askingChanged(id);
    return;
  }
  if (turns === 1)
    converse(id, {
      kind: "refused",
      tool: "Bash",
      rule: "allow_list",
      target: "pnpm test",
      reason:
        "pnpm test is not one of the read-only shapes this session may run. The interview reads " +
        "the test files instead.",
    });
  const key = editing.read(id).key;
  const plan = key === null ? null : plans.get(key);
  const criterion =
    plan && "acceptance_criteria" in plan ? plan.acceptance_criteria[0] : undefined;
  // The two tool calls the sample otherwise never makes, each asked for by
  // name. The dock keeps or drops a card by which tool made it, and a rule with
  // no way to reach two of its three arms is a rule nothing can check.
  if (/\bdraft it\b/i.test(text) && key !== null) {
    // No edit on it: a drafting is the admission, not a change to a plan that
    // already exists, so `edit` is null exactly as the host reports it.
    converse(id, {
      kind: "tool",
      tool: "generate_plan",
      ok: true,
      detail:
        `admitted ${key} in plan_review from specs/${editing.read(id).specSlug ?? "this spec"}. ` +
        "A person reads and approves it; this session cannot.\n" +
        "flagged   1 issue-authored attempt — read as data, not followed",
      edit: null,
    });
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
  // A line, then a pause before the rest of the same turn — which is the shape
  // a real session takes when it reads the repository before answering, and the
  // pause the dock has to keep saying it is working through.
  converse(id, { kind: "said", text: "I'll look at what's already here before I answer." });
  setTimeout(() => {
    // The rest of a turn can land after the planning it belongs to has gone —
    // a pane left, a test ended — and a sample session speaking into a session
    // that is not there throws where nothing is waiting to catch it.
    if (!stillThere(id)) return;
    converse(id, {
      kind: "said",
      text: `Noted: “${text}”. This is the sample workspace, so nothing here reaches a provider.`,
    });
    sampleWorking.delete(id);
    askingChanged(id);
  }, 60);
}

async function previewRequest<T extends Request>(request: T, owner?: EditingOwner): Promise<ReplyMap[T["kind"]]> {
    let result: unknown = null;
    switch (request.kind) {
      case "editingOpen": result = await editing.open(request.target, request.legacy); break;
      case "editingRead": result = editing.read(request.id); break;
      case "drafts": result = openDrafts(editingRecords()); break;
      case "editingSave": result = editing.save(request.id, request.revision, request.repoId, request.form); break;
      case "editingSubmit": result = await editing.submit(request.id, request.revision, request.operationId, request.intent); break;
      case "editingStop": result = await editing.stop(request.id); break;
      case "explorerList": {
        const tracked = sampleFiles(request.repoId);
        const files = tracked.filter((path) => !isNeverReadPath(path)).sort();
        result = { files, hidden: tracked.length - files.length, standing: standingFor(request.repoId) };
        break;
      }
      case "explorerRead": result = sampleRead(request.repoId, request.path); break;
      case "graphRead": result = graphView(request.repoId, request.key); break;
      case "graphEdit":
      case "graphUndo":
        result = job(
          request.kind,
          request.repoId,
          request.key,
          (job) => {
            if (request.kind === "graphUndo") undoGraphEditAt(request.key, request.edit);
            else {
              const edit: GraphEdit = request.edit;
              writeGraphEdit(
                request.key,
                (state) =>
                  applyGraphEdit(
                    state,
                    edit,
                    graphLog(request.key)
                      .flatMap((each) => each.keys)
                      .filter((key) => key.startsWith("node:") || key.startsWith("criterion:"))
                      .map((key) => key.slice(key.indexOf(":") + 1)),
                  ),
                null,
              );
            }
            job.resultKey = request.key;
          },
          120,
        );
        break;
      case "explorerMark": {
        // As on the real host: an approved contract's scope is frozen, and a
        // mark against one could never be compiled in. The standing list is
        // the repository's rather than this ticket's, so it stays writable.
        const marking = editing.read(request.id);
        const held = marking.key === null ? undefined : snapshot.tasks.find((entry) => entry.ticket.key === marking.key);
        if (held?.ticket.approved_at && request.always !== true)
          throw new Error(
            "This contract is approved, so its scope is frozen. Start over from the spec to plan it again.",
          );
        result = editing.mark(request.id, request.revision, request.path, request.mark, request.always);
        break;
      }
      case "explorerUndo": result = editing.undo(request.id, request.revision, request.edit); break;
      case "editingDiscard": {
        // The ticket this planning drafted goes with it, as it does on the
        // real host: a plan thrown away must not leave its ticket on the board
        // with no way back to the plan. One that has run is not a draft and
        // stays.
        const held = editing.read(request.id);
        result = editing.discard(request.id, request.revision);
        sampleInterviews.delete(request.id);
        emit({ kind: "interview", sessionId: request.id, running: false, entry: null, asking: askingOf(request.id), working: false });
        const drafted = held.key === null ? undefined : snapshot.tasks.find((entry) => entry.ticket.key === held.key);
        if (
          drafted &&
          ["draft", "specifying", "plan_review", "ready", "plan_invalid"].includes(drafted.ticket.state)
        ) {
          snapshot.tasks = snapshot.tasks.filter((entry) => entry !== drafted);
          plans.delete(held.key!);
          emit({ kind: "records", repoId: held.repoId, key: null });
        }
        break;
      }
      case "interviewStart": {
        const session = editing.read(request.id);
        if (session.repoId !== request.repoId)
          throw new Error("This planning belongs to another repository.");
        result = startSampleInterview(request.id);
        break;
      }
      case "interviewTurn": {
        if (!sampleInterviews.has(request.id)) {
          nameSpecFromTurn(request.id, request.text);
          startSampleInterview(request.id);
        }
        // The turn is with the session: it is working until it has answered,
        // as the host reports of a real one.
        sampleWorking.add(request.id);
        converse(request.id, { kind: "turn", text: request.text });
        editing.answerAsking(request.id, request.text);
        askingChanged(request.id);
        const text = request.text;
        setTimeout(() => answerSampleTurn(request.id, text), 120);
        result = interviewStatus(request.id);
        break;
      }
      case "interviewStop":
        sampleInterviews.delete(request.id);
        sampleWorking.delete(request.id);
        emit({ kind: "interview", sessionId: request.id, running: false, entry: null, asking: askingOf(request.id), working: false });
        converse(request.id, { kind: "note", text: "The interview ended: you stopped it." });
        result = interviewStatus(request.id);
        break;
      case "specRead": result = specView(request.id); break;
      case "symbolIndex": {
        const index = SAMPLE_INDEX[request.repoId];
        if (index === undefined)
          throw new Error(
            "This repository is no longer connected. Choose it again in Settings.",
          );
        result =
          "supported" in index
            ? { supported: false, reason: index.reason, languages: index.languages_seen }
            : {
                supported: true,
                names: index.files.flatMap((file) =>
                  file.exports
                    // `export * from` records the name `*`, which is not a name
                    // a spec can refer to.
                    .filter((each) => each.name !== "*")
                    .map((each) => ({ name: each.name, kind: each.kind, path: file.path })),
                ),
                headCommit: index.head_commit,
                workingTree: index.working_tree,
                builtAt: index.built_at,
              };
        break;
      }
      case "impactRead": {
        const session = editing.read(request.id);
        const tracked = sampleFiles(session.repoId).filter((path) => !isNeverReadPath(path));
        const index = SAMPLE_INDEX[session.repoId];
        if (index === undefined) throw new Error("This sample repository is no longer connected.");
        const markdown = session.specSlug === null ? null : (specFiles()[session.specSlug] ?? null);
        result = {
          ...impactReport({ scope: session.form.draft.paths, tracked, spec: markdown, index }),
          readAt: new Date().toISOString(),
        };
        break;
      }
      case "specSave": {
        const session = editing.read(request.id);
        if (session.repoId !== request.repoId)
          throw new Error("This planning belongs to another repository.");
        const slug = session.specSlug ?? specSlug(request.title);
        const existing = specFiles()[slug];
        if (session.specSlug === null && existing !== undefined)
          throw new Error(`specs/${slug}/spec.md already exists. Give this one a title of its own.`);
        const current = existing === undefined ? null : readSpecSections(existing);
        // The same merge the host does (SCP-321): a section this writer did not
        // change takes whatever the file says, and one both changed is refused
        // rather than overwritten.
        const merged = mergeSpecText({
          base: { title: request.base.title, ...request.base.sections },
          next: { title: request.title, ...request.sections },
          current: current?.text ?? EMPTY_SPEC_TEXT,
        });
        if (merged.conflicting.length > 0) {
          result = { view: specView(request.id), conflicting: merged.conflicting };
          break;
        }
        const rendered = renderSpec(merged.text, {
          highWater: current?.highWater ?? 0,
          existing: current?.requirements ?? [],
        });
        saveSpec(slug, rendered.markdown);
        editing.recordSpec(request.id, slug);
        result = { view: specView(request.id), conflicting: [] };
        break;
      }
      case "generatePlan":
      case "startOver":
        result = job(
          "draft",
          request.repoId,
          request.kind === "startOver" ? request.key : null,
          (job) => {
            const session = editing.read(request.id);
            if (session.specSlug === null) throw new Error("Write the spec before generating a plan from it.");
            const markdown = specFiles()[session.specSlug] ?? "";
            if (request.kind === "startOver") {
              const { ticket } = ticketRow(request.key);
              if (ticket.approved_at) throw new Error("An approved contract is immutable.");
              draftFromSpec(request.key, markdown, session.specSlug);
              ticket.plan_version += 1;
              job.resultKey = request.key;
              return;
            }
            const ticket = sample(next++, readSpecSections(markdown).text.title || "Untitled work", "plan_review");
            draftFromSpec(ticket.key, markdown, session.specSlug);
            ticket.title = plans.get(ticket.key)!.outcome;
            snapshot.tasks.push({ repoId: request.repoId, repository: "webstore", ticket });
            job.resultKey = ticket.key;
          },
          1400,
          owner,
        );
        break;
      case "login":
        throw new Error("This is a sample workspace. The desktop app opens your terminal on the provider's sign-in command.");
      case "openHelp":
        window.open(HELP_LINKS[request.page], "_blank", "noopener");
        break;
      case "snapshot":
        result = {
          ...structuredClone(snapshot),
          drafts: openDrafts(editingRecords()),
          interviews: [...sampleInterviews],
          working: [...sampleWorking],
        };
        break;
      case "repositorySnapshot": {
        const repository = snapshot.repositories.find((entry) => entry.id === request.repoId);
        if (!repository) throw new Error("This sample repository is no longer connected.");
        result = structuredClone({ repository, tasks: snapshot.tasks.filter((entry) => entry.repoId === request.repoId), errors: [] });
        break;
      }
      case "detail":
        if (!snapshot.tasks.some((row) => row.repoId === request.repoId && row.ticket.key === request.key)) throw new Error("Sample task not found in this repository.");
        result = detail(request.key);
        break;
      case "manifest":
        result = structuredClone(
          sampleManifests.get(request.repoId) ?? {
            digest: "1".repeat(64),
            testCommand: "pnpm test",
            value: {
              offLimits: [".github/**", "infra/**", "**/*.env*"],
              entries: [
                ".env.local",
                ".certs/dev.pem",
                "fixtures/seed.json",
              ].map((path) => ({
                path,
                source_path: path,
                kind: "file" as const,
                strategy: "copy" as const,
                secret: true,
                required: true,
                reason: "Sample local setup",
              })),
            },
          },
        );
        break;
      case "saveManifest":
        sampleManifests.set(request.repoId, {
          digest: "2".repeat(64),
          value: request.value,
          testCommand: "pnpm test",
        });
        snapshot.repositories = snapshot.repositories.map((repo) =>
          repo.id === request.repoId
            ? {
                ...repo,
                manifestCount: request.value.entries.length,
                prohibitedPaths: request.value.offLimits,
              }
            : repo,
        );
        emit();
        break;
      case "models":
        result = {
          provider: request.provider,
          source: "sample",
          discoveredAt: new Date().toISOString(),
          models: (request.provider === "codex-cli"
            ? [
                ["o-class", "O-class", "Sample reviewer"],
                ["codex-sample", "Codex sample", "Sample coding model"],
              ]
            : [
                ["sonnet-class", "Sonnet-class", "Sample executor"],
                ["opus-sample", "Opus sample", "Sample reasoning model"],
              ]
          ).map(([id, label, description], index) => ({
            id,
            label,
            description,
            isDefault: index === 0,
          })),
        };
        break;
      case "providers":
        result = [
          {
            id: "claude",
            name: "Claude Code",
            installed: true,
            authenticated: true,
            detail: "Sample connection · subscription CLI",
            loginCommand: "claude auth login",
            roles: ["Execution", "Independent review", "Planning"],
          },
          {
            id: "codex",
            name: "Codex",
            installed: true,
            authenticated: true,
            detail: "Sample connection · subscription CLI",
            loginCommand: "codex login",
            roles: ["Execution", "Independent review", "Planning"],
          },
        ];
        break;
      case "saveSettings":
        snapshot.settings = request.settings;
        result = request.settings;
        emit({ kind: "preferences", settings: snapshot.settings, titles: snapshot.titles ?? {}, taskModels: snapshot.taskModels ?? {}, archived: snapshot.archived ?? [] });
        break;
      case "archive": {
        const entries = request.keys.map((key) => request.repoId + ":" + ticketRow(key).ticket.key);
        snapshot.archived = request.archived
          ? [...new Set([...(snapshot.archived ?? []), ...entries])]
          : (snapshot.archived ?? []).filter((entry) => !entries.includes(entry));
        emit({ kind: "preferences", settings: snapshot.settings, titles: snapshot.titles ?? {}, taskModels: snapshot.taskModels ?? {}, archived: snapshot.archived });
        break;
      }
      case "discard": {
        const row = ticketRow(request.key);
        if (!["draft", "specifying", "plan_review", "ready", "plan_invalid"].includes(row.ticket.state))
          throw new Error("Only a contract that has never run can be deleted. This one has moved past the contract stage.");
        snapshot.tasks = snapshot.tasks.filter((entry) => entry !== row);
        plans.delete(request.key);
        emit({ kind: "records", repoId: request.repoId, key: null });
        break;
      }
      case "taskSummary":
        if (!snapshot.tasks.some((row) => row.repoId === request.repoId && row.ticket.key === request.key)) throw new Error("Sample task not found in this repository.");
        result = sampleSummary(request.key);
        break;
      case "usage":
        // The boards' figures, labelled as a sample by the preview indicator; the desktop reads its own records.
        result = {
          readAt: new Date().toISOString(),
          ledger: { month: new Date().toISOString().slice(0, 7), spentMicros: 24_500_000, pricedAttempts: 41, unpricedAttempts: 0, ticketsRun: 34, ticketsMerged: 18, stoppedShort: 2, averageMergedMicros: 1_380_000 },
          providers: [
            { id: "claude", name: "Claude Code", role: "default executor", plan: "Max · 20×", detail: "Sample plan · read from the provider's reply", windows: [
              { label: "Session · 5-hour window", usedPercent: 78, resetsAt: new Date(Date.now() + 108 * 60_000).toISOString() },
              { label: "Weekly · all models", usedPercent: 41, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
              { label: "Weekly · opus-class", usedPercent: 12, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
            ] },
            { id: "codex", name: "Codex", role: "default reviewer", plan: "Pro", detail: "Sample plan · read from the provider's reply", windows: [
              { label: "Session · 5-hour window", usedPercent: 23, resetsAt: new Date(Date.now() + 133 * 60_000).toISOString() },
              { label: "Weekly · all models", usedPercent: 18, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
            ] },
            { id: "anthropic", name: "Anthropic API", role: null, plan: null, windows: null, detail: "No API key on this machine, so there is no plan to report." },
          ],
          notes: [],
        };
        break;
      case "rename":
        snapshot.titles = {
          ...snapshot.titles,
          [request.repoId + ":" + request.key]: request.title,
        };
        emit({ kind: "preferences", settings: snapshot.settings, titles: snapshot.titles ?? {}, taskModels: snapshot.taskModels ?? {}, archived: snapshot.archived ?? [] });
        break;
      case "chooseRepository":
        if (!snapshot.repositories.length)
          snapshot.repositories = [...initial.repositories];
        result = snapshot.repositories[0];
        emit({ kind: "repositories" });
        break;
      case "forgetRepository":
        snapshot.repositories = snapshot.repositories.filter(
          (repo) => repo.id !== request.repoId,
        );
        snapshot.tasks = snapshot.tasks.filter(
          (row) => row.repoId !== request.repoId,
        );
        emit();
        break;
      case "doctor":
        result = job("doctor", request.repoId, null, (job) => {
          const repo = snapshot.repositories.find(
            (repo) => repo.id === request.repoId,
          )!;
          if (request.writeConfig) repo.configured = true;
          job.log =
            "Sample readiness check\n✓ Git checkout available\n✓ pnpm test detected\n✓ Worktree preparation available\n3 manifest files selected";
        });
        break;
      case "draft":
      case "admit":
        result = job(
          request.kind,
          request.repoId,
          null,
          (job) => {
            const ticket = sample(
              next++,
              request.kind === "draft"
                ? "Activation email never sent on signup"
                : request.draft.outcome,
              "plan_review",
            );
            applyDraft(
              ticket,
              request.kind === "draft"
                ? {
                    outcome: request.outcome,
                    criteria: criteriaText.map((text) => ({
                      text,
                      assertion: text,
                      kind: "test",
                    })),
                    paths: ["packages/auth/**", "packages/queue/**"],
                    prohibited: [],
                  }
                : request.draft,
            );
            snapshot.tasks.push({
              repoId: request.repoId,
              repository: "webstore",
              ticket,
            });
            if (request.models) {
              snapshot.taskModels = {
                ...snapshot.taskModels,
                [request.repoId + ":" + ticket.key]: request.models,
              };
              emit({ kind: "preferences", settings: snapshot.settings, titles: snapshot.titles ?? {}, taskModels: snapshot.taskModels, archived: snapshot.archived ?? [] });
            }
            job.resultKey = ticket.key;
          },
          request.kind === "draft" ? 2200 : 1100,
          owner,
        );
        break;
      case "edit":
        result = job("edit", request.repoId, request.key, (job) => {
          const { ticket } = ticketRow(request.key);
          if (!snapshot.tasks.some((row) => row.repoId === request.repoId && row.ticket.key === request.key)) throw new Error("Sample task not found in this repository.");
          if (ticket.approved_at) throw new Error("An approved contract cannot be edited.");
          if (detail(request.key).digest !== request.digest) throw new Error("The contract changed since you viewed it.");
          applyDraft(ticket, request.draft);
          ticket.plan_version += 1;
          if (request.models) {
            snapshot.taskModels = {
              ...snapshot.taskModels,
              [request.repoId + ":" + ticket.key]: request.models,
            };
            emit({ kind: "preferences", settings: snapshot.settings, titles: snapshot.titles ?? {}, taskModels: snapshot.taskModels, archived: snapshot.archived ?? [] });
          }
          job.resultKey = request.key;
        }, 1000, owner);
        break;
      case "run":
      case "decide": {
        const row = ticketRow(request.key);
        // Nothing moves until the command is accepted: a refused run leaves the ticket where it was.
        result = job(
          request.kind,
          request.repoId,
          request.key,
          () => {
            if (!decisionsAnswered.has(request.key))
              row.ticket.state = "changes_requested";
            else {
              row.ticket.state = "pr_open";
              row.ticket.delivery.state = "open";
              row.ticket.delivery.pull_request_number = 418;
              row.ticket.delivery.pull_request_url =
                "https://github.com/example/webstore/pull/418";
              approved.add(request.key);
            }
          },
          2600,
        );
        row.ticket.approved_at = at;
        row.ticket.state = "executing";
        delete row.summary;
        if (request.kind === "decide") decisionsAnswered.add(request.key);
        break;
      }
      case "principle":
      case "verdict":
        result = job(request.kind, request.repoId, request.key, () => {
          decisionsAnswered.add(request.key);
        });
        break;
      case "cancel": {
        const active = snapshot.jobs.find((job) => job.id === request.jobId);
        // As the host has it: a job that has finished is not one a stop can reach.
        if (!active || !isLive(active)) throw new Error("That command is no longer active.");
        active.state = "cancelled";
        active.endedAt = new Date().toISOString();
        if (active.key && ["run", "decide"].includes(active.kind)) ticketRow(active.key).ticket.state = "cancelled";
        await editing.settled(active);
        emit({ kind: "records", repoId: active.repoId, key: active.resultKey ?? active.key, job: active });
        break;
      }
      case "sync":
        result = job("sync", request.repoId, request.key, () => {
          const { ticket } = ticketRow(request.key);
          if (ticket.delivery.state === "open") {
            ticket.state = "merged";
            ticket.delivery.state = "merged";
            ticket.delivery.observed_at = new Date().toISOString();
          }
        });
        break;
      case "openPullRequest":
        break; // The UI shows the GitHub handoff; no external site opens in this sandbox.
      case "openWorktree":
      case "openRepository":
        throw new Error(
          "This is a sample repository. The desktop app opens your real folder.",
        );
      case "output":
        if (!snapshot.tasks.some((row) => row.repoId === request.repoId && row.ticket.key === request.key)) throw new Error("Sample task not found in this repository.");
        if (request.attemptId && !detail(request.key).attempts.some((entry) => entry.id === request.attemptId)) throw new Error("The selected attempt does not belong to this task.");
        result = { transcript: null, diff: null, notes: [] };
        break;
      case "exportArchive": {
        result = archiveCsv(archiveRows(snapshot, request), snapshot.titles);
        await navigator.clipboard.writeText(result as string);
        break;
      }
      case "export": {
        const data = request.key
          ? detail(request.key)
          : snapshot.tasks.filter((row) => row.repoId === request.repoId);
        result = JSON.stringify(data, null, 2);
        await navigator.clipboard.writeText(result as string);
        break;
      }
    }
    return result as ReplyMap[T["kind"]];
}
export const previewBridge: DesktopBridge = {
  request: (request) => previewRequest(RequestSchema.parse(request) as typeof request),
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
