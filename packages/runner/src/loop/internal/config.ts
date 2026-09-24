import { z } from "zod";
import {
  DEFAULT_MERGE_MODE,
  DEFAULT_SPEC_FOLDER,
  EFFORT_LEVELS,
  EffortLevelSchema,
  effortFits,
  ExecutorSkillsSchema,
  LimitsTableSchema,
  MaterializationManifestSchema,
  MergeModeSchema,
  SpecFileSchema,
  StandingProhibitedSchema,
  TicketSourceSchema,
  isRepositoryRelativeFolder,
  type SpecFile,
  type StandingProhibitedEntry,
} from "@perbo/contracts";
import { MODEL_PROVIDERS } from "@perbo/model";
import { PinnedCheckSchema } from "../../checks/index.js";
import { DEFAULT_DELIVERED_CHECKS_BOUND_MS } from "../../delivery.js";

/**
 * What a run is configured with, and what the write guard refuses.
 *
 * The schema is the loop's whole input surface: `perbo run`, the desktop and
 * every test build one of these and nothing else. It is here rather than in
 * `@perbo/contracts` because it names the runner's own satellites — the pinned
 * checks, the delivery bound — and nothing outside this package parses it.
 */

/**
 * The three places a run's base branch can come from, in the order they are
 * read: the branch the checkout is on, a `base_ref` somebody configured, the
 * remote's declared default branch — which is what a detached checkout, having
 * no branch of its own, falls back to.
 *
 * Defined once, here, because the run configuration, the record a run writes
 * about itself and the lines the CLI prints all name the same three and must
 * not drift into three spellings of them.
 */
export const BaseSourceSchema = z.enum(["branch", "config", "remote_default"]);
export type BaseSource = z.infer<typeof BaseSourceSchema>;

/** One merged ticket's approved contract, as the conflict brief states it (SCP-227). */
export const MergedTicketContextSchema = z.strictObject({
  ticket_key: z.string().min(1),
  outcome: z.string().min(1),
  criteria: z.array(z.string().min(1)),
  paths_allowed: z.array(z.string().min(1)),
});

export const TicketRunConfigSchema = z.strictObject({
  ticket_key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  /**
   * The ticket's own source record, so the pull request can say where the work
   * came from. Null when the loop is driven from a bare `--config` with no
   * ticket behind it: the body then leaves the line out rather than inventing
   * one.
   */
  ticket_source: TicketSourceSchema.nullable().default(null),
  /**
   * The branch the ticket's delivery record names, which the run keeps rather
   * than deriving a new one (D-098). The CLI sets it from that record and from
   * nothing else: no configuration file can set it, so it is null on a run with
   * no ticket behind it. Provisioning keeps it only where its middle segment is
   * this ticket's own id (`recordedBranch`).
   */
  delivery_branch: z.string().min(1).nullable().default(null),
  repository_root: z.string().min(1),
  base_ref: z.string().min(1).default("HEAD"),
  /**
   * Which of the three {@link BaseSourceSchema} sources named `base_ref`. Null
   * where the caller handed the loop a whole configuration without saying —
   * nothing here derives one, so this stays an absence rather than becoming a
   * guess. The CLI resolves the source itself before it starts a run, so a run
   * it started always names one.
   */
  base_ref_origin: z
    .union([
      BaseSourceSchema,
      /**
       * `checkout` is what `branch` was called while the checkout was the only
       * derivation there was. A run configuration written by a version that
       * spelled it that way still parses, and still means the branch this
       * checkout is on — the value was renamed, not redefined, so reading it as
       * `branch` loses nothing.
       */
      z.literal("checkout").transform((): "branch" => "branch"),
    ])
    .nullable()
    .default(null),
  worktree_root: z.string().min(1),
  bundle_root: z.string().min(1),
  quarantine_root: z.string().min(1),
  state_root: z.string().min(1),
  /** Pinned before the attempt starts and immutable while it runs (D-045). */
  checks: z.array(PinnedCheckSchema).default([]),
  protected_tests: z.array(z.string().min(1)).default([]),
  /**
   * Globs that judge an attempt on this repository — its review policy, its
   * corpus, its fixtures (D-045). The runner refuses a change to any of them.
   * `.perbo/**` is always protected; this names the rest.
   */
  protected_paths: z.array(z.string().min(1)).default([]),
  /**
   * The standing prohibited list: what this repository refuses a write to for
   * every ticket, whatever the contract says (D-105). Read when a run starts
   * rather than copied onto the contract at admission, so an entry added after
   * a ticket was admitted binds its later runs. A hand-written file may hold
   * bare globs; the desktop's explorer writes each entry with what put it there.
   */
  paths_prohibited: StandingProhibitedSchema.default([]),
  /**
   * Where this repository keeps its specs (D-103). Its folder is a standing
   * prohibited path for the executor, beside the default `specs/`: a spec is
   * the intent the contract was drafted from, and an attempt that edited one
   * would be rewriting the statement it is judged against.
   */
  specs: z
    .string()
    .min(1)
    .refine(isRepositoryRelativeFolder, {
      message: "specs names a repository-relative folder, for example \"specs\" or \"docs/specs\"",
    })
    .default(DEFAULT_SPEC_FOLDER),
  /**
   * The files the loop commits first on the ticket's branch (D-103): the spec
   * folder as it stood at approval, with the `CONTEXT.md` and ADR changes the
   * interview made beside it, each with the SHA-256 of those bytes —
   * admission's, on a spec approval could not read.
   *
   * Derived from the ticket's admission record by the caller, because the
   * runner holds no ticket store. Empty for a ticket admitted from an issue or
   * by hand, and for a run with no ticket behind it: the loop then makes no
   * spec commit and excludes nothing from the change set.
   */
  spec_files: z.array(SpecFileSchema).default([]),
  agent_binary: z.string().min(1).optional(),
  agent_provider: z.enum(["claude-cli", "codex-cli"]).default("claude-cli"),
  executor_skills: ExecutorSkillsSchema.default([]),
  model: z.string().min(1).optional(),
  reviewer_model: z.string().min(1).nullable().default(null),
  reviewer_provider: z.enum(MODEL_PROVIDERS).default("claude-cli"),
  /**
   * How hard the executor's model and the reviewer's model think, each in its
   * own provider's words (`EFFORT_LEVELS`). Null sends nothing on Claude
   * Code; Codex starts at medium and the API at high. A provider setting like
   * the model: it changes neither the reviewer's prompt nor its policy (D-079).
   */
  effort: EffortLevelSchema.nullable().default(null),
  reviewer_effort: EffortLevelSchema.nullable().default(null),
  /**
   * The hard cap on remediation rounds (SCP-194), above the progress rule
   * rather than instead of it: a round that closed a finding earns the next
   * until this or the ticket budget stops it, and a round that closed nothing
   * ends the ticket well before either.
   */
  max_remediation_rounds: z.number().int().min(0).default(6),
  limits: LimitsTableSchema.prefault({ organisation: "local" }),
  /** ADR-0026: retaining the bytes the model saw is what buys `re_executable`. */
  retain_context: z.boolean().default(true),
  publish: z.boolean().default(false),
  /**
   * Who merges the pull request the loop opened (SCP-202, D-077).
   *
   * `person` — the default, and the decision rather than a convenience — is a
   * person's click, which is D-041's answer and stays it for `main` and for
   * any customer repository. `loop` is D-077's, for the integration branch,
   * once the loop has cleared D-076's bar; the founder flips it, and until
   * then the mechanism is built and idle.
   */
  merge: MergeModeSchema.default(DEFAULT_MERGE_MODE),
  /**
   * SCP-227: a re-level run. The branch already reached `pr_open`; this run
   * merges the base's tip into it and judges the result without an executor
   * — the pinned checks alone where the base brought in nothing inside the
   * contract's scope, a fresh independent review where it did, and a conflict
   * round where the merge stops. It pushes, reads the merge step and opens
   * nothing new. `level` says there was nothing to do.
   */
  relevel: z.boolean().default(false),
  /**
   * The approved contracts of the tickets that merged into the base under the
   * branch, for the conflict brief: what a person resolving it would read
   * first. Person-approved text, assembled by the caller from its store.
   */
  relevel_context: z.array(MergedTicketContextSchema).default([]),
  materialization_manifest: MaterializationManifestSchema.nullable().default(null),
  /**
   * Where the person's recorded principles live (D-065 option 3). Defaults to
   * `<repository_root>/.perbo/principles.md`; the CLI sets it from the ticket
   * store so `--store` users' principles are the ones consulted.
   */
  principles_path: z.string().nullable().default(null),
  /**
   * The spec's No-Gos, read from the ticket's approach record (D-100). They
   * are approach rather than contract, so they brief the executor and gate
   * nothing; the caller reads the record, because the runner holds no ticket
   * store. Empty for a ticket with none and for a run with no ticket behind it.
   */
  no_gos: z.array(z.string().min(1)).default([]),
  /**
   * How many runs this ticket has started, its own history included, with this
   * one counted: the run number the root attempt id is minted from, which is
   * what makes a second run of one immutable contract a distinct attempt chain
   * rather than a collision with the first.
   *
   * Null where nothing tracks the ticket — a bare `--config` run has no ticket
   * history behind it — and the runner then counts the runs its own attempts
   * record already holds.
   */
  runs_started: z.number().int().min(1).nullable().default(null),
  /**
   * SCP-154: the execution bundle of an attempt a ceiling cut, whose retained
   * `change.diff` this run's first attempt starts from. The diff is applied
   * into the worktree before the executor is invoked and the attempt is
   * recorded as a continuation of the cut one. Null — the default — is a run
   * that starts from the base commit and nothing else.
   */
  resume_from: z.string().min(1).nullable().default(null),
  /**
   * The ceiling on reading the checks GitHub runs on the head this run opens a
   * pull request over, in milliseconds of the run's own wall clock.
   *
   * Fifteen minutes by default, which is above this repository's own CI. It is
   * a ceiling and not a wait: the read ends the moment every check has
   * concluded, and a repository whose CI is slower than the bound records what
   * had not finished as `unchecked` rather than holding the run open.
   *
   * Zero waits for nothing — one read, and whatever it says. `publish: false`
   * reads nothing at all, because there is no pull request to read checks on.
   */
  delivery_checks_bound_ms: z.number().int().min(0).default(DEFAULT_DELIVERED_CHECKS_BOUND_MS),
}).superRefine((value, context) => {
  for (const [key, provider, effort] of [
    ["effort", value.agent_provider, value.effort],
    ["reviewer_effort", value.reviewer_provider, value.reviewer_effort],
  ] as const) {
    if (effort !== null && !effortFits(provider, effort))
      context.addIssue({
        code: "custom",
        path: [key],
        message: `${provider} takes ${EFFORT_LEVELS[provider].join(", ")}, not ${effort}`,
      });
  }
}).transform((value) => ({ ...value, agent_binary: value.agent_binary ?? (value.agent_provider === "codex-cli" ? "codex" : "claude"), model: value.model ?? (value.agent_provider === "codex-cli" ? "gpt-5.6-terra" : "claude-opus-5") }));
export type TicketRunConfig = z.infer<typeof TicketRunConfigSchema>;

/**
 * What the write guard refuses: the contract's own prohibitions, and whatever
 * this repository standing-prohibited when the run started (D-105): the run
 * configuration is read once, at the start of the run. One list, so the hook,
 * the transcript reading, the seal's assertion and the brief's sentence cannot
 * hold different answers.
 */
export function guardProhibitedPaths(
  contractProhibited: readonly string[],
  config: {
    paths_prohibited: readonly StandingProhibitedEntry[];
    spec_files?: readonly SpecFile[];
  },
): string[] {
  return [
    ...new Set([
      ...contractProhibited,
      ...config.paths_prohibited.map((entry) => entry.path),
      // D-103: the files the branch's spec commit holds. The loop made that
      // commit before the executor started, and the change set the review
      // reads leaves them out — so a write to one would land in the pull
      // request with nothing judging it.
      ...(config.spec_files ?? []).map((file) => file.path),
    ]),
  ];
}
