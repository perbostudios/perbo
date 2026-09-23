import { createHash } from "node:crypto";
import { z } from "zod";
import { ExecutorSkillReceiptSchema } from "./executor-skills.js";
import { SealedCommitSchema } from "./changeset.js";
import { CostBasisSchema } from "./cost.js";
import {
  AttemptIdSchema,
  ChangeSetIdSchema,
  CommitShaSchema,
  PlanIdSchema,
  RepositoryIdSchema,
  TicketIdSchema,
} from "./ids.js";
import { PlanLevelSchema } from "./plan.js";
import { BundleIdSchema } from "./runbundle.js";
import {
  AutonomyClassSchema,
  NeutralisationRecordSchema,
  PermissionProfileSchema,
  ProhibitedActionSchema,
} from "./permission.js";

/**
 * `ExecutionAttempt` (docs/04, "Execution attempt").
 *
 * A ticket is stable; an attempt is one run pinned to a plan version and a base
 * commit. Retries and remediation rounds append attempts — nothing here is ever
 * rewritten, because "a retry does not overwrite the previous attempt's
 * history" is a property the whole replay story rests on.
 */

export const WORKSPACE_PROVIDERS = [
  "local_worktree",
  "hosted_sandbox",
  "enterprise_runner",
] as const;
export const WorkspaceProviderSchema = z.enum(WORKSPACE_PROVIDERS);

export const TERMINATION_REASONS = [
  "completed",
  "no_changes",
  /**
   * The attempt changed nothing, and commands it asked for were refused on the
   * way (SCP-163).
   *
   * Distinct from `no_changes` because the two mean opposite things about the
   * executor. An executor that read the tree and decided the work was already
   * done changed nothing on purpose; an executor whose clean-up, whose scratch
   * directory and whose type-check were refused changed nothing because it was
   * never able to. Measured on AYO-13, where thirteen of fifty-three commands
   * were denied and the run was recorded as though the agent had simply
   * declined to act. The count of refusals is in the detail, and the refusals
   * themselves are on the attempt's command records with the rule and the
   * target each was judged on.
   */
  "no_changes_after_denials",
  "agent_error",
  /**
   * The agent exited because the **model transport** gave up, not because the
   * work failed: the provider answered with a retryable status until the
   * agent's own retries were exhausted (HTTP 529 `overloaded` is the one that
   * has been observed) and the process ended without running the ticket.
   *
   * Distinct from `agent_error` because the two mean opposite things to a
   * reader and to the loop. An `agent_error` is evidence about the attempt; a
   * transport that was overloaded for a minute is evidence about the weather,
   * and a ticket that ran no command must not be `failed` for it. The loop
   * starts one further attempt from the same base before it gives up, and the
   * detail carries the last status and the transport's own error text so the
   * record says which it was.
   */
  "transport_unavailable",
  "wall_clock_exceeded",
  "command_ceiling_exceeded",
  "iteration_ceiling_exceeded",
  /**
   * A remediation round reached `round_iterations` (D-092).
   *
   * Its own reason rather than `iteration_ceiling_exceeded` because the two
   * name different settings, and everything a person does next depends on
   * which: the key to raise, the number that was in force, and whether the
   * round was sized for closing findings or the attempt for building.
   */
  "round_iteration_ceiling_exceeded",
  "token_ceiling_exceeded",
  "cost_ceiling_exceeded",
  /**
   * The executor showed no tool activity for `attempt_stall_ms` (D-096).
   *
   * A hang, not a ceiling on the work: nothing bounds how long an attempt runs
   * or what it spends, and what the stall detector measures is the gap since
   * the last tool call or tool result the runner saw on the stream. A long
   * attempt working steadily never reaches it, and an attempt that reaches it
   * had stopped doing anything a while ago. The run ends here rather than
   * starting another attempt over the sealed work: a cost cut stopped an
   * attempt that was making progress, and this one stopped an attempt that was
   * not, so the same brief against the same tree would hang the same way.
   */
  "stalled",
  "prohibited_action",
  "unlisted_egress_host",
  "agent_configuration_present",
  "scope_escape",
  "host_suspended",
  "cancelled",
  "workspace_error",
  /**
   * The runner let through something it exists to stop, and the record says so
   * rather than passing the consequence on (SCP-195).
   *
   * The one that produces it today is a sealed change set carrying a path the
   * contract does not admit a write under: the pre-execution guard refuses
   * those before they happen, so a path that survived to the seal means a write
   * the guard could not see — and that is a hole in the guard, not a finding
   * for the review to buy.
   */
  "runner_defect",
] as const;
export const TerminationReasonSchema = z.enum(TERMINATION_REASONS);
export type TerminationReason = (typeof TERMINATION_REASONS)[number];

/**
 * BYOK, recorded (D-009). `subscription` means the agent authenticated with the
 * user's own login and Perbo never saw a credential; `user_api_key` means the
 * user's key was already in the environment. There is no third value, because
 * there is no arrangement in which the platform funds inference.
 */
export const CREDENTIAL_CLASSES = ["subscription", "user_api_key", "unknown"] as const;
export const CredentialClassSchema = z.enum(CREDENTIAL_CLASSES);
export type CredentialClass = (typeof CREDENTIAL_CLASSES)[number];

export const AgentInvocationSchema = z.strictObject({
  adapter: z.string().min(1),
  binary_path: z.string().min(1),
  binary_version: z.string().min(1),
  /** sha256 of the binary, so a bundle identifies what actually executed. */
  binary_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  model: z.string().min(1),
  credential_class: CredentialClassSchema,
  /**
   * The exact argv, recorded rather than reconstructed. D-009's exit evidence
   * requires the invocation shape to be recorded and asserted rather than left
   * to whichever flag the first implementation happened to use.
   */
  argv: z.array(z.string()),
  /** sha256 of the argv with the prompt removed: the shape, not the request. */
  shape_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  neutralisation: NeutralisationRecordSchema,
});
export type AgentInvocation = z.infer<typeof AgentInvocationSchema>;

/** One command the agent asked for, allowed or denied. Denials are recorded too. */
export const CommandRecordSchema = z.strictObject({
  sequence: z.number().int().min(0),
  tool: z.string().min(1),
  /** Redacted against the secret index before it is written anywhere. */
  detail: z.string(),
  decision: z.enum(["allowed", "denied"]),
  denial_reason: z.string().nullable(),
  /**
   * The rule that refused it, by identifier: `write_outside_worktree` where a
   * target left the worktree, `command_allow_list` where the verb is not one
   * the profile carries, `command_deny_list` where it is named as refused.
   * Null on an admitted command, and defaulted so a record written before the
   * field existed parses (SCP-163).
   */
  denial_rule: z.string().min(1).nullable().default(null),
  /**
   * What that rule was judged on: the target path as the command spelled it —
   * `~/backup.json`, `/tmp/evidence` — for a rule about a write, and the
   * command itself for a rule about a name. A refusal a person can act on has
   * to name the thing to change, not only the sentence about it.
   */
  denial_target: z.string().min(1).nullable().default(null),
  /**
   * The directory the command was judged from, relative to the worktree root,
   * or `unknown` after a directory move the guard could not read. The executor
   * runs its shell commands in one shell whose working directory persists
   * between calls, so a refusal on a relative path is only readable beside it.
   *
   * Null where the record is not a shell line — a file tool takes an absolute
   * path and does not run in that shell — and where the command was denied
   * before it reached the guard. Defaults to null so a record written before
   * this field existed parses.
   */
  cwd: z.string().min(1).nullable().default(null),
  /**
   * Which reading the recorded decision is (SCP-177). `pre_execution_hook` —
   * the runner judged the call before the tool ran and the agent enforced the
   * answer, so an `allowed` here is a call that ran and a `denied` here is a
   * call that did not. `transcript_reading` — the runner judged the `tool_use`
   * block after the fact, which can only describe what already happened.
   * `agent_permission_layer` — the agent's own allow-list refused it and the
   * runner learned so from the result envelope.
   *
   * Null on a record written before the pre-execution judgement existed, and
   * on one the hook did not judge.
   */
  decided_by: z
    .enum(["pre_execution_hook", "transcript_reading", "agent_permission_layer", "runner_admission"])
    .nullable()
    .default(null),
  /**
   * Set where the runner's two readings of the same call disagreed: the
   * enforced decision is the one above, and this says in one sentence what the
   * other reading made of it. The two use the same resolver, so a disagreement
   * is a fact about the directory each was judged from or about the tree
   * changing between them, and it is worth a person's attention either way.
   */
  second_reading: z.string().min(1).nullable().default(null),
  /**
   * The agent that made the call (D-106): the role a subagent was started
   * from, and null for the executor's own top-level session. The role rather
   * than the agent's id, because it is the name a person reads and the one
   * both of the runner's readings can produce — the stream carries the
   * subagent-starting call's `subagent_type` (the call is named `Agent`, or
   * `Task` under its former name) and the guard's hook is handed `agent_type`,
   * while only the hook is handed the id. Two subagents of one role are told
   * apart by their calls' `sequence`, not by this.
   *
   * Defaults to null so a record written before the field existed parses.
   */
  agent: z.string().min(1).nullable().default(null),
  at: z.iso.datetime(),
});
export type CommandRecord = z.infer<typeof CommandRecordSchema>;

/**
 * Every outbound host, allowed or denied. On the local provider this is
 * observation of what the agent *asked for*, not interception of sockets —
 * ADR-0004's amendment is explicit that the local provider gets detection
 * rather than prevention, and overstating it here would be the lie that matters.
 */
export const EgressRecordSchema = z.strictObject({
  host: z.string().min(1),
  decision: z.enum(["allowed", "denied"]),
  observed_in: z.string().min(1),
  at: z.iso.datetime(),
});
export type EgressRecord = z.infer<typeof EgressRecordSchema>;

/**
 * Final transport accounting is authoritative for every token field. Without
 * it, the fields are sums of the latest provisional usage for each distinct
 * assistant request observed before the attempt stopped.
 */
export const AttemptUsageSchema = z.strictObject({
  /** Every input token the transport reported, cache creation and reads included. */
  input_tokens: z.number().int().min(0),
  /**
   * The subset of `input_tokens` written into the prompt cache. Kept apart
   * because the provider rate card prices cache creation separately from
   * fresh input. Defaults to zero for records written before it existed.
   */
  cache_creation_input_tokens: z.number().int().min(0).default(0),
  /**
   * The subset of `input_tokens` served from the prompt cache. The token
   * ceiling counts only the fresh remainder — a cached read is the same
   * prompt arriving again — so a reader needs this to see what was counted.
   * Defaults to zero for records written before it existed.
   */
  cache_read_input_tokens: z.number().int().min(0).default(0),
  /** Output under the final-or-provisional accounting rule above. */
  output_tokens: z.number().int().min(0),
  cost_micros: z.number().int().min(0),
  /** Historical Claude attempt records were transport-reported. */
  cost_basis: CostBasisSchema.default("transport_reported"),
  /**
   * The attempt was stopped before its transport wrote a final accounting
   * line, so token figures are the assistant-request sums read by the stop and
   * cost is either the transport's last running total or a list-rate estimate
   * over those sums. Absent on an attempt that ran to completion, and on
   * records written before the field existed.
   */
  cost_partial: z.boolean().optional(),
  /**
   * The adapter's raw fresh-input-plus-output counter used for the token
   * ceiling. This can exceed billed usage when one request produces repeated
   * assistant envelopes. Absent on historical records, whose counter is
   * reconstructed from their pre-deduplication token fields.
   */
  token_ceiling_tokens: z.number().int().min(0).optional(),
  wall_clock_ms: z.number().int().min(0),
  commands: z.number().int().min(0),
  iterations: z.number().int().min(0),
});
export type AttemptUsage = z.infer<typeof AttemptUsageSchema>;

/**
 * Mid-attempt human input. Phase 1 almost certainly does not build steering,
 * but the slot exists now: the moment it does, ADR-0023's "what did the model
 * read" guarantee acquires an input, and an unrecorded one breaks it silently.
 */
export const UserInstructionSchema = z.strictObject({
  at: z.iso.datetime(),
  actor: z.string().min(1),
  text: z.string().min(1),
});

export const EnvironmentRecordSchema = z.strictObject({
  manifest_hash: z.string().min(1),
  /**
   * Whether a lockfile pinned what this attempt's install resolved. False means
   * the install resolved its own versions, so the tree the attempt was judged
   * on is not reproducible from the repository alone. Defaulted true because
   * every attempt recorded before the field existed required a lockfile.
   */
  install_pinned: z.boolean().default(true),
  materialized_paths: z.array(z.string().min(1)),
  /** Hashes only. The index exists so exclusion can be by content, not by name. */
  secret_content_sha256: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
  port_range_start: z.number().int().min(0),
  port_range_end: z.number().int().min(0),
  database_schema: z.string().min(1).nullable(),
  env_names_passed: z.array(z.string().min(1)),
  env_names_dropped: z.number().int().min(0),
});

/**
 * Where a resumed attempt's starting tree came from (SCP-154).
 *
 * An attempt a ceiling cut leaves its work in the retained `change.diff` of its
 * execution bundle. `perbo run --resume-from <bundle_id>` applies those bytes
 * into the new attempt's worktree before the executor is invoked, and this is
 * the record of it: which bundle, whose attempt, and the exact bytes by hash.
 * The predecessor is named on `continues_attempt_id` as well, because a resume
 * is a continuation in the same sense a remediation round is.
 */
export const ResumedFromSchema = z.strictObject({
  /** The execution bundle the diff was read from. It is referenced, never replaced. */
  bundle_id: BundleIdSchema,
  /** The attempt that bundle records: this attempt's predecessor. */
  attempt_id: AttemptIdSchema,
  /** The content address of the diff bytes, as the bundle store holds them. */
  diff_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** One sentence, written by the runner, naming the bundle the work came from. */
  note: z.string().min(1),
});
export type ResumedFrom = z.infer<typeof ResumedFromSchema>;

/**
 * A wait the loop sat out inside an attempt (SCP-193).
 *
 * A provider that answers `429 … You've hit your session limit · resets 4:30am
 * (Europe/London)` has told the run when it can work again. Recording the wait
 * on the attempt rather than only printing it is what makes it survive: the
 * attempts record is on disk, so a `run` restarted while the loop was parked
 * reads the same instant and honours the remainder rather than immediately
 * spending another attempt against a limit that is still in force.
 *
 * `until` is an instant, not a wall-clock time: the provider states its reset
 * in a named zone, and a record that kept the words rather than the instant
 * would be re-parsed by every reader against whatever zone that reader is in.
 * `quoted` keeps the provider's own words beside it so a person can see what
 * was read.
 */
export const AttemptWaitSchema = z.strictObject({
  /**
   * Why the loop waited. One value today: a provider limit that named its own
   * reset. It is an enum rather than a string so a later reason has to be
   * declared rather than spelled.
   */
  reason: z.enum(["provider_reset"]),
  /** When the wait began, and the instant the loop resumed at. */
  started_at: z.iso.datetime(),
  until: z.iso.datetime(),
  waited_ms: z.number().int().min(0),
  /** The IANA zone the provider stated its reset time in. */
  zone: z.string().min(1),
  /** The provider's own sentence, as the transport wrote it. */
  quoted: z.string().min(1),
});
export type AttemptWait = z.infer<typeof AttemptWaitSchema>;

/**
 * A commit, and whether it passed the materialization manifest's verify command.
 *
 * The commit travels with the answer because "the base verified" is only
 * meaningful about a named commit: an attempt's worktree starts at the
 * contract's base when it creates the branch and at the branch's own sealed
 * head when it takes one over, and a verify run at the second says nothing
 * about the first.
 */
export const VerifiedCommitSchema = z.strictObject({
  /** The commit the verify command ran at. */
  commit: CommitShaSchema,
  /** The verify command exited zero there. */
  verified: z.boolean(),
});
export type VerifiedCommit = z.infer<typeof VerifiedCommitSchema>;

/**
 * The longest agent or thread id a re-injection's target carries. Neither id in
 * use is longer than a UUID, so a value past this is the wrong field in the record,
 * not a long id; the room above a UUID is for a provider that lengthens its
 * ids without a schema change here.
 */
export const BRIEF_TARGET_MAX_CHARS = 200;

/**
 * One time this attempt's brief was given back after a compaction (D-096).
 *
 * Small on purpose. What the record has to answer is that it happened, where
 * it went and when; the text itself is the round's brief, which the execution
 * bundle holds as `prompt.txt`, plus a state block composed from the records
 * this same attempt carries. A second copy of either would be a second thing
 * to drift.
 */
export const BriefReinjectionSchema = z.strictObject({
  /**
   * The agent or thread it went to: a subagent's `agent_id` on Claude, the
   * thread id on Codex, and null for the attempt's own top-level session
   * (ADR-0038).
   */
  target: z.string().min(1).max(BRIEF_TARGET_MAX_CHARS).nullable().default(null),
  /**
   * Which mechanism carried it: Claude Code's `SessionStart` hook under the
   * `compact` matcher, or `thread/inject_items` answering a Codex
   * `contextCompaction` item.
   */
  mechanism: z.enum(["session_start_hook", "thread_inject_items"]),
  at: z.iso.datetime(),
});
export type BriefReinjection = z.infer<typeof BriefReinjectionSchema>;

/**
 * The longest executor account an attempt record carries (D-092).
 *
 * A cap rather than an unbounded field because the account is the executor's
 * own prose and is quoted back into the next round's brief: an account that
 * ran away would cost the round it is meant to save. Longer text is truncated
 * with a marker rather than dropped.
 */
export const EXECUTOR_ACCOUNT_MAX_CHARS = 4_000;

export const EXECUTION_ATTEMPT_SCHEMA_VERSION = 1;

export const ExecutionAttemptSchema = z.strictObject({
  schema_version: z.literal(EXECUTION_ATTEMPT_SCHEMA_VERSION),
  attempt_id: AttemptIdSchema,
  /** The attempt that first provisioned this worktree; equals attempt_id at the root. */
  root_attempt_id: AttemptIdSchema,
  /**
   * Set on a remediation attempt: the attempt whose findings it answers — and
   * on a resumed attempt: the cut attempt whose retained diff it starts from.
   */
  continues_attempt_id: AttemptIdSchema.nullable(),
  remediation_round: z.number().int().min(0),
  created_at: z.iso.datetime(),

  ticket_id: TicketIdSchema,
  plan_id: PlanIdSchema,
  plan_version: z.number().int().positive(),
  planned_risk: PlanLevelSchema,
  repository_id: RepositoryIdSchema,
  base_ref: z.string().min(1),
  base_commit: CommitShaSchema,

  provider: WorkspaceProviderSchema,
  branch: z.string().min(1),
  worktree_path: z.string().min(1),

  autonomy_class: AutonomyClassSchema,
  permission_profile: PermissionProfileSchema,
  agent: AgentInvocationSchema,
  /** Host-selected guidance; never a provider-loaded skill or reviewer input (D-094). */
  executor_skills: z.array(ExecutorSkillReceiptSchema).default([]),
  environment: EnvironmentRecordSchema,

  commands: z.array(CommandRecordSchema),
  egress: z.array(EgressRecordSchema),
  prohibited_action_hits: z.array(
    z.strictObject({
      action: ProhibitedActionSchema,
      detail: z.string().min(1),
      at: z.iso.datetime(),
    }),
  ),
  user_instructions: z.array(UserInstructionSchema),

  usage: AttemptUsageSchema,
  termination: z.strictObject({
    reason: TerminationReasonSchema,
    detail: z.string(),
  }),

  changeset_id: ChangeSetIdSchema.nullable(),
  head_commit: CommitShaSchema.nullable(),
  /**
   * The commits of `base_commit..head_commit` that were on the branch before
   * this attempt ran, oldest first — how many of the change set under review
   * this attempt did not produce. Empty where the attempt's own work is the
   * whole change set, and defaulted so a record written before it parses.
   */
  prior_commits: z.array(SealedCommitSchema).default([]),
  /**
   * Where the change set came from. `attempt` — this attempt sealed it.
   * `carried_forward` — the executor changed nothing and the branch head
   * stayed where the attempt found it, so the change set is the one earlier
   * attempts left on the branch.
   */
  change_set_origin: z.enum(["attempt", "carried_forward"]).default("attempt"),
  /**
   * The executor's own account of this change (D-092): the files it touched
   * and why, the tests it wrote, what it verified — read from its final
   * message and redacted like the attempt's other text.
   *
   * It is sealed here, beside the change set it describes, so the executor's
   * own next remediation round can be briefed with it instead of re-reading
   * the repository. It reaches that round and nothing else: the reviewer's
   * inputs are unchanged (D-061), so its independence is too.
   *
   * Null where the attempt wrote none — an empty final message, or an attempt
   * a ceiling cut before it spoke. Nothing here is invented, and defaulted so
   * a record written before the field existed parses.
   */
  executor_account: z.string().min(1).max(EXECUTOR_ACCOUNT_MAX_CHARS).nullable().default(null),
  /**
   * Every time this attempt's brief was given back after a compaction (D-096),
   * oldest first: the executor's own session and each subagent or thread of
   * it. Empty where nothing compacted, which is the ordinary case, and
   * defaulted so a record written before the field existed parses.
   */
  brief_reinjections: z.array(BriefReinjectionSchema).default([]),
  /**
   * The cut attempt's execution bundle this attempt was resumed from, or null
   * where the attempt started from the base commit alone. Defaulted, so a
   * record written before resuming existed parses.
   */
  resumed_from: ResumedFromSchema.nullable().default(null),
  /**
   * SCP-192: the base branch's tip this attempt's branch was merged with, or
   * null where the base had not moved under the run and there was nothing to
   * merge.
   *
   * It is not a second name for `base_commit`, which is what the change set was
   * measured against and is the same sha whenever a merge-up happened. It is
   * the answer to "did this round move the base under itself", which is what
   * makes a merge commit on the branch attributable to the loop rather than to
   * the executor. Defaulted, so a record written before merging up parses.
   */
  merged_base: CommitShaSchema.nullable().default(null),
  /**
   * D-103: the commit the branch's spec sits in — the first commit past the
   * contract's base, holding the files approval recorded and nothing else.
   *
   * The loop makes it before the executor is invoked and the run that made it
   * and every round after it name the same commit, so a reader asking which
   * part of the branch the review did not read has the answer here rather than
   * deriving it from the range. Null in four cases: a ticket admitted without
   * a spec, a base that already holds every recorded file so there was nothing
   * for a commit to add, a branch that already had commits when no run had
   * recorded a spec commit for it, and a record written before the loop
   * committed one at all.
   */
  spec_commit: CommitShaSchema.nullable().default(null),
  /**
   * SCP-263: the processes still running from inside the worktree when this
   * attempt ended, which the runner signalled before the worktree was removed.
   *
   * A process in a session of its own is outside every process group the
   * runner signals, so it survives the attempt that started it. Empty where the
   * sweep found none — which is the ordinary case — and defaulted, so a record
   * written before the sweep existed parses.
   */
  swept_processes: z
    .array(z.strictObject({ pid: z.number().int().positive(), command: z.string() }))
    .default([]),
  /**
   * Whether the contract's base commit passes the manifest's verify command,
   * with the commit that answer was measured on.
   *
   * It is the ticket's answer rather than the attempt's: it is measured once,
   * on the first attempt that provisions at the base, and every later attempt
   * of the ticket carries the same one. That is what the review is told as
   * `baseVerified`, so a pinned check failing on a tree whose base passes is
   * attributed to the change even when the attempt continued over commits an
   * earlier attempt sealed.
   *
   * Null where nothing has measured it — a record written before the field
   * existed, a ticket whose every attempt so far started somewhere other than
   * the base, and a manifest whose verify command measures nothing
   * (`git status --porcelain`, D-013). The review is then told nothing, which it
   * reads as unknown; `false` would say the base is broken, which is a
   * different claim.
   */
  base_verification: VerifiedCommitSchema.nullable().default(null),
  /**
   * The verify this attempt's own provisioning ran, and the commit it ran at.
   *
   * For an attempt that took over a branch, that commit is the ticket's own
   * sealed head rather than the contract's base, so it is recorded under its
   * own name and never stands in for `base_verification`. Null where the
   * manifest's verify did not run, where it measures nothing
   * (`git status --porcelain`, D-013), and on a record written before the field
   * existed.
   */
  provisioning_verify: VerifiedCommitSchema.nullable().default(null),
  /**
   * SCP-193: the wait the loop sat out before the attempt that followed this
   * one, or null where nothing parked the run. Written when the wait starts
   * rather than when it ends, so a process killed mid-wait leaves the record
   * that lets the next `perbo run` honour the remainder. Defaulted, so a
   * record written before parking existed parses.
   */
  wait: AttemptWaitSchema.nullable().default(null),
});
export type ExecutionAttempt = z.infer<typeof ExecutionAttemptSchema>;

/**
 * The invocation shape: argv with the prompt argument removed. Two attempts
 * that suppressed configuration the same way share this hash whatever they were
 * asked to do, which is what makes "the invocation shape is recorded and
 * asserted" a check rather than a note.
 */
export function invocationShapeHash(
  argv: readonly string[],
  promptIndexes: readonly number[],
): string {
  const shape = argv.filter((_, index) => !promptIndexes.includes(index));
  return createHash("sha256").update(shape.join(" "), "utf8").digest("hex");
}

export function attemptId(seed: string): string {
  return `att_${createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 16)}`;
}
