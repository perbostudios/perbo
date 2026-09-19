import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  invocationShapeHash,
  type BriefReinjection,
  type CommandRecord,
  type TerminationReason,
} from "@perbo/contracts";
import {
  DEFAULT_SUSPEND_INTERVAL_MS,
  DEFAULT_SUSPEND_THRESHOLD_MS,
  SuspendDetector,
} from "@perbo/workspace";
import type { AgentRequest, AgentResult } from "./adapter.js";
import type { AttemptCeilings } from "./ceilings.js";
import { reinjectedBrief } from "./brief.js";
import { CodexExecutorSession, CODEX_EXECUTOR_ARGV, type Usage } from "./codex-rpc.js";
import { EgressLog } from "./egress.js";
import { judgeCommand, matchesListEntry } from "./admission.js";
import { judgePreToolCall, type PreToolGuardState } from "./pretool.js";
import type { ProhibitedHit } from "./prohibited.js";
import { prepareScratchDirectory } from "./scratch.js";

const ChangeSchema = z
  .object({
    path: z.string(),
    kind: z
      .object({ type: z.string(), move_path: z.string().nullable().optional() })
      .passthrough(),
  })
  .passthrough();
const ItemSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    command: z.string().optional(),
    cwd: z.string().optional(),
    text: z.string().optional(),
    changes: z.array(ChangeSchema).optional(),
    /** `subAgentActivity` only: "started" | "interacted" | "interrupted". */
    kind: z.string().optional(),
    /** `subAgentActivity` only: the child thread this activity is about. */
    agentThreadId: z.string().optional(),
  })
  .passthrough();
const EventSchema = z
  // ADR-0038: an item notification names the thread it happened on, which is
  // how a child thread's compaction is told from the root's, and how a
  // subAgentActivity item names the thread that did the spawning (D-106).
  .object({ item: ItemSchema.optional(), threadId: z.string().optional() })
  .passthrough();
const ApprovalSchema = z
  .object({
    itemId: z.string(),
    command: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
    grantRoot: z.string().nullable().optional(),
    additionalPermissions: z.unknown().optional(),
    networkApprovalContext: z.unknown().optional(),
    /** D-106: which thread this approval belongs to, so it is judged with that thread's own state. */
    threadId: z.string().optional(),
  })
  .passthrough();
export type CodexItem = z.infer<typeof ItemSchema>;
type Item = CodexItem;

/** Inspection only: the native CLI owns execution; model text is never a host action parameter. */
export function codexCommandDecision(
  command: string,
  cwd: string,
  state: PreToolGuardState,
) {
  const rel = relative(state.root, cwd);
  if (
    !isAbsolute(cwd) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  )
    return {
      decision: "denied" as const,
      rule: "write_outside_worktree" as const,
      reason: "Command directory is outside the materialized worktree.",
      target: cwd,
    };
  const guard = { ...state, cwd };
  const { decision } = judgePreToolCall(
    {
      tool_name: "Bash",
      tool_input: { command },
      tool_use_id: "codex-approval",
    },
    guard,
    new Date(),
  );
  if (decision.decision === "denied" || decision.answer === "allow")
    return decision;
  const { inspection } = judgeCommand({
    tool: "Bash",
    detail: command,
    allow_list: state.allow_list,
    deny_list: state.deny_list,
    scope: {
      root: state.root,
      cwd,
      ...(state.tmpdir ? { tmpdir: state.tmpdir } : {}),
      paths_allowed: state.paths_allowed,
      paths_prohibited: state.paths_prohibited,
      spec_folder: state.spec_folder ?? null,
    },
  });
  const eligible = (segment: (typeof inspection.segments)[number]): boolean => {
    if (segment.unreadablePrograms.length > 0) return false;
    if (segment.nested.length > 0)
      return segment.accounted && segment.nested.every(eligible);
    return (
      segment.programs.length === 0 ||
      segment.programs.every((program) =>
        [
          "cd",
          "pushd",
          "popd",
          "echo",
          "printf",
          "true",
          "false",
          ":",
        ].includes(program),
      ) ||
      state.allow_list.some((entry) =>
        matchesListEntry(entry, "Bash", segment.text),
      )
    );
  };
  const admitted =
    inspection.segments.length > 0 && inspection.segments.every(eligible);
  return admitted
    ? decision
    : {
        ...decision,
        decision: "denied" as const,
        rule: "command_allow_list" as const,
        reason: "Command is outside the runner's admitted command set.",
        target: command,
      };
}

export function codexFileDecision(path: string, state: PreToolGuardState) {
  const absolute = resolve(state.root, path);
  return judgePreToolCall(
    {
      tool_name: "Write",
      tool_input: { file_path: absolute },
      tool_use_id: "codex-approval",
    },
    state,
    new Date(),
  ).decision;
}

/**
 * What one app-server notification does to the attempt, over the attempt's
 * own state: a tool item resets the stall window and is recorded (D-096), a
 * completed compaction asks for the brief again on the thread it happened on
 * (D-096), a command naming a host outside the allow-list stops the attempt,
 * and a capability the isolated session should not have stops it too. Built
 * apart from the session that delivers the notifications, so the wiring can be
 * driven without an app server.
 */
export function codexNotificationHandler(attempt: {
  ceilings: Pick<AttemptCeilings, "noteToolActivity">;
  items: Map<string, CodexItem>;
  transcript: string[];
  redact: (text: string) => string;
  record: (item: CodexItem, threadId: string | null) => void;
  egress: Pick<EgressLog, "observe">;
  stop: (reason: TerminationReason, detail: string) => void;
  progress: (line: string) => void;
  /**
   * D-096: the thread whose context was just compacted, so the attempt's
   * brief goes back to it. Called once per `contextCompaction` item and for
   * nothing else.
   */
  rebrief: (threadId: string | null) => void;
  /**
   * D-106: a child thread has started. `parentThreadId` is the thread the
   * `subAgentActivity` item itself arrived on — the thread that did the
   * spawning — and `childThreadId` is the new thread it names. Called once
   * per `subAgentActivity` item whose `kind` is `"started"`, and for nothing
   * else: `"interacted"` and `"interrupted"` name no new thread.
   */
  onSubagentStarted: (parentThreadId: string | null, childThreadId: string) => void;
}): (method: string, payload: unknown) => void {
  const { ceilings, items, transcript, redact, record, egress, stop, progress, rebrief, onSubagentStarted } =
    attempt;
  return (method, payload) => {
    const parsed = EventSchema.safeParse(payload);
    if (!parsed.success) return;
    const item = parsed.data.item;
    if (method === "model/rerouted") {
      stop("agent_error", "Codex rerouted away from the selected model");
      return;
    }
    if (!item) return;
    items.set(item.id, item);
    // D-096: a compaction has taken the brief away, and the answer is the
    // brief again on that same thread. On completion rather than on start:
    // the context is what it will be only once the compaction has finished.
    if (method === "item/completed" && item.type === "contextCompaction")
      rebrief(parsed.data.threadId ?? null);
    if (method === "item/completed")
      transcript.push(redact(JSON.stringify({ method, item })).slice(0, 200_000));
    if (item.type === "commandExecution" || item.type === "fileChange") {
      // D-096: a tool call starting and its result arriving are both the
      // executor being alive, and either resets the stall window.
      ceilings.noteToolActivity();
      record(item, parsed.data.threadId ?? null);
      if (item.command && egress.observe(item.command, "command", new Date()).length > 0)
        stop("unlisted_egress_host", "Command requested a host outside the network allow-list");
      if (method === "item/started")
        progress(
          `Codex ${redact(item.command ?? item.changes?.map((change) => change.path).join(", ") ?? item.type).slice(0, 160)}`,
        );
    }
    // D-106: a subagent's own start is reported to its parent, never announced
    // by a `thread/started` notification of its own (ADR-0038's live test).
    if (item.type === "subAgentActivity" && item.kind === "started" && item.agentThreadId)
      onSubagentStarted(parsed.data.threadId ?? null, item.agentThreadId);
    if (["mcpToolCall", "dynamicToolCall", "webSearch"].includes(item.type))
      stop("agent_error", `Unexpected capability in the isolated Codex session: ${item.type}`);
  };
}

/**
 * Attempt-wide usage across every thread Codex reports on, root and child
 * alike (D-106). `thread/tokenUsage/updated` is cumulative per thread
 * (ADR-0038), so the latest figure replaces that thread's own entry; the
 * ceilings and the attempt's final usage are the sum across every thread's
 * current entry, never the last update applied.
 *
 * A thread's figure never goes down: each field is held at the max of what
 * it has ever reported, never overwritten by a smaller one. The wire is
 * cumulative, so a lower figure for a thread already seen is read as a
 * protocol gap, not a real drop; held at the old max rather than passed
 * through, so a thread whose figure genuinely reset would be under-charged —
 * its new usage uncounted — until its own climb passed that old max again,
 * never charged twice for the same tokens.
 */
function codexUsageTracker(): { update: (threadId: string, usage: Usage) => Usage; total: () => Usage } {
  const byThread = new Map<string, Usage>();
  const total = (): Usage =>
    [...byThread.values()].reduce(
      (sum, usage) => ({
        inputTokens: sum.inputTokens + usage.inputTokens,
        cachedInputTokens: sum.cachedInputTokens + usage.cachedInputTokens,
        outputTokens: sum.outputTokens + usage.outputTokens,
      }),
      { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    );
  return {
    update: (threadId, usage) => {
      const previous = byThread.get(threadId);
      byThread.set(
        threadId,
        previous === undefined
          ? usage
          : {
              inputTokens: Math.max(previous.inputTokens, usage.inputTokens),
              cachedInputTokens: Math.max(previous.cachedInputTokens, usage.cachedInputTokens),
              outputTokens: Math.max(previous.outputTokens, usage.outputTokens),
            },
      );
      return total();
    },
    total,
  };
}

/** Native subscription executor with isolated provider configuration and per-request approval. */
export async function runCodexAgent(
  request: AgentRequest,
): Promise<AgentResult> {
  if (request.supervision === "agent_permissions")
    throw new Error(
      "The direct-agent comparison arm is registered for Claude Code only.",
    );
  const redact = request.redact ?? ((text: string) => text);
  const progress = request.onProgress ?? (() => undefined);
  /** D-106: what every thread's guard state starts as — one worktree per attempt, so only `cwd` could ever differ. */
  const guardStateBase: Omit<PreToolGuardState, "cwd"> = {
    root: request.worktree,
    tmpdir: prepareScratchDirectory(request.worktree),
    paths_allowed: [...(request.paths_allowed ?? [])],
    paths_prohibited: [...(request.paths_prohibited ?? [])],
    ...(request.spec_folder ? { spec_folder: request.spec_folder } : {}),
    allow_list: [...request.profile.command_allow_list],
    deny_list: [...request.profile.command_deny_list],
  };
  /** D-106: one guard state per thread, seeded the first time that thread is seen; a thread's judgement reads its own state and no other's. */
  const guardStates = new Map<string, PreToolGuardState>();
  const guardStateFor = (threadId: string): PreToolGuardState => {
    let found = guardStates.get(threadId);
    if (!found) {
      found = { ...guardStateBase, cwd: request.worktree };
      guardStates.set(threadId, found);
    }
    return found;
  };
  const commands: CommandRecord[] = [],
    transcript: string[] = [];
  /** D-096: every thread this attempt gave its brief back to, in order. */
  const reinjections: BriefReinjection[] = [];
  /** The injections still out, awaited before the session goes: a compaction at the end of a turn is briefed too. */
  const injections: Promise<void>[] = [];
  const items = new Map<string, Item>();
  const records = new Map<string, CommandRecord>();
  const egress = new EgressLog(request.profile.network_allow_list);
  /** D-106: every prohibited act the attempt hit, for the pull request and the record. */
  const prohibited: Array<ProhibitedHit & { at: string }> = [];
  const usage = codexUsageTracker();
  /** D-106: a child thread's role, looked up once via `thread/read` on its first `subAgentActivity`. */
  const agentRoles = new Map<string, string | null>();
  /**
   * D-106: every command record made for a thread before its role lookup
   * answered, so the answer can still correct them. `thread/read`'s response
   * and a thread's own first command can arrive in the same read from the
   * process, in which case the record is made before the lookup's promise
   * has a turn to resolve — a lookup a moment behind its thread's first
   * command is ordinary, not a fault to route around.
   */
  const recordsByThread = new Map<string, CommandRecord[]>();
  /** D-106: the attempt's own thread, known once `thread/start` replies — a second-generation spawn is judged against it. */
  let rootThreadId: string | null = null;
  /** D-106: every role lookup made, so one still in flight as the turn ends is waited for before the records are read. */
  const lookups: Array<Promise<void>> = [];
  let countedTokens = 0;
  let finalMessage: string | null = null;
  let termination: { reason: TerminationReason; detail: string } = {
    reason: "agent_error",
    detail: "Codex did not report completion",
  };
  let session: CodexExecutorSession | null = null;
  let stopped = false;
  /** Set once the turn's outcome is known: a ceiling reached while a last re-briefing is still out closes the session, it does not rewrite the outcome. */
  let decided = false;
  const stop = (reason: TerminationReason, detail: string): void => {
    if (stopped) return;
    stopped = true;
    if (!decided) termination = { reason, detail: redact(detail) };
    session?.close(new Error(detail));
  };
  const cancel = (): void => stop("cancelled", "Stopped by the user");
  const detector = new SuspendDetector(
    () => stop("host_suspended", "Host suspended during the Codex attempt"),
    DEFAULT_SUSPEND_INTERVAL_MS,
    DEFAULT_SUSPEND_THRESHOLD_MS,
    request.clock ?? Date.now,
  );
  const timer = setInterval(() => {
    const breach = request.ceilings.tick();
    if (breach) stop(breach.reason, breach.detail);
  }, 250);
  const suspend = setInterval(
    () => detector.tick(),
    DEFAULT_SUSPEND_INTERVAL_MS,
  );
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  let fingerprint = {
    path: request.binary,
    version: "unknown",
    sha256: "0".repeat(64),
  };
  try {
    const path = execFileSync("which", [request.binary], {
      encoding: "utf8",
    }).trim();
    fingerprint = {
      path,
      version: execFileSync(request.binary, ["--version"], {
        encoding: "utf8",
        timeout: 30_000,
      }).trim(),
      sha256: createHash("sha256")
        .update(readFileSync(realpathSync(path)))
        .digest("hex"),
    };
  } catch {
    /* Unavailable fingerprint is recorded, never invented. Session startup will report a missing binary. */
  }
  let credential: AgentResult["invocation"]["credential_class"] = "unknown";
  const record = (item: Item, threadId: string | null): CommandRecord => {
    const existing = records.get(item.id);
    if (existing) return existing;
    const breach =
      request.ceilings.noteCommand() ?? request.ceilings.noteIteration();
    if (breach) stop(breach.reason, breach.detail);
    const entry: CommandRecord = {
      sequence: commands.length,
      tool: item.type,
      detail: redact(
        item.command ??
          item.changes?.map((change) => change.path).join(", ") ??
          item.type,
      ),
      decision: "allowed",
      denial_reason: null,
      denial_rule: null,
      denial_target: null,
      cwd: item.cwd ? relative(request.worktree, item.cwd) || "." : ".",
      decided_by: "agent_permission_layer",
      second_reading: null,
      // D-106: the role looked up for this thread, or null for the root
      // thread and for a role Codex did not report. Corrected in place if the
      // lookup is still in flight when this record is made.
      agent: threadId ? (agentRoles.get(threadId) ?? null) : null,
      at: new Date().toISOString(),
    };
    commands.push(entry);
    records.set(item.id, entry);
    if (threadId) {
      const forThread = recordsByThread.get(threadId);
      if (forThread) forThread.push(entry);
      else recordsByThread.set(threadId, [entry]);
    }
    return entry;
  };
  try {
    session = new CodexExecutorSession({
      binary: request.binary,
      env: request.env,
      worktree: request.worktree,
      timeoutMs: request.ceilings.wallClockLimitMs,
      onUsage: (threadId, reported) => {
        const summed = usage.update(threadId, reported);
        const fresh = Math.max(0, summed.inputTokens - summed.cachedInputTokens) + summed.outputTokens;
        const breach = request.ceilings.noteTokens(
          Math.max(0, fresh - countedTokens),
        );
        countedTokens = fresh;
        if (breach) stop(breach.reason, breach.detail);
      },
      onEvent: codexNotificationHandler({
        ceilings: request.ceilings,
        items,
        transcript,
        redact,
        record,
        egress,
        stop,
        progress,
        /**
         * D-096: Codex routes no session-start hook of the runner's and reads
         * no settings file of it, so this is the whole mechanism — the root
         * thread's compaction and a child's alike. The text is composed here
         * rather than at the start of the round, so its state block says what
         * the records say now; nothing the transport suggested reaches it.
         */
        rebrief: (threadId) => {
          if (threadId === null || request.brief_records === undefined) return;
          // Recorded once the app-server has taken it, so the record counts
          // briefs that went back rather than ones that were asked for.
          if (session === null) return;
          injections.push(
            session
              .injectItems(threadId, reinjectedBrief(request.prompt, request.brief_records))
              .then(() => {
                reinjections.push({
                  target: threadId,
                  mechanism: "thread_inject_items",
                  at: new Date().toISOString(),
                });
              })
              .catch((error: unknown) => {
                progress(
                  `The re-briefing of ${threadId} was not delivered: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
              }),
          );
        },
        /**
         * D-106: a subagent starting one of its own is refused reactively —
         * Codex offers no preventive gate on a spawn, so this is the first
         * point it is even visible (ADR-0038's Q3). A first-generation spawn
         * — `parentThreadId` is the attempt's own root thread — instead looks
         * up the child's role once, for its command records.
         *
         * ADR-0038's live record found every item notification carrying a
         * `threadId`, so `parentThreadId === null` is a protocol gap rather
         * than the ordinary case. Refusing would end an attempt over
         * something this guard never saw, so what runs is closer to
         * admitting it as the root's own spawn — which carries the same gap
         * admitting always would: a real second-generation subagent can pass
         * the check above under it too, this path included. What this path
         * adds over silent admission is only that the gap is said — a
         * transcript line and a progress line naming it — so the attempt
         * runs on seen rather than unseen; the role lookup below still runs,
         * since which thread is asking is a separate question from what the
         * child's role is.
         */
        onSubagentStarted: (parentThreadId, childThreadId) => {
          if (parentThreadId === null) {
            const detail = redact(
              `${childThreadId} started with no threadId on the event that reported it, so nesting could not be checked`,
            );
            transcript.push(detail.slice(0, 200_000));
            progress(`Codex: ${detail}`);
          } else if (rootThreadId !== null && parentThreadId !== rootThreadId) {
            const detail =
              `a subagent (thread ${parentThreadId}) started ${childThreadId}, and a subagent ` +
              "may not start one";
            prohibited.push({
              action: "enable_own_tooling",
              detail: redact(detail),
              at: new Date().toISOString(),
            });
            stop("prohibited_action", detail);
            return;
          }
          if (agentRoles.has(childThreadId) || session === null) return;
          agentRoles.set(childThreadId, null);
          lookups.push(
            session
              .threadRead(childThreadId)
              .then((role) => {
                agentRoles.set(childThreadId, role);
                // The lookup can answer after this thread's own first command
                // was already recorded (both arriving in the same read); fill
                // those in rather than leaving them the placeholder null.
                for (const entry of recordsByThread.get(childThreadId) ?? []) entry.agent = role;
              })
              .catch(() => {
                /* A role that cannot be read is recorded as none, not retried. */
              }),
          );
        },
      }),
      approve: (method, payload) => {
        if (stopped) return false;
        const parsed = ApprovalSchema.safeParse(payload);
        if (!parsed.success) return false;
        const requestApproval = parsed.data;
        const item = items.get(requestApproval.itemId);
        // A file approval without the preceding change list cannot be checked safely.
        if (
          method === "item/fileChange/requestApproval" &&
          (!item?.changes?.length || requestApproval.grantRoot)
        )
          return false;
        const observed: Item = item ?? {
          id: requestApproval.itemId,
          type: "commandExecution",
          ...(requestApproval.command
            ? { command: requestApproval.command }
            : {}),
          ...(requestApproval.cwd ? { cwd: requestApproval.cwd } : {}),
        };
        const threadId = requestApproval.threadId ?? null;
        const entry = record(observed, threadId);
        const guard = guardStateFor(threadId ?? "");
        const decisions =
          method === "item/fileChange/requestApproval"
            ? item!
                .changes!.flatMap((change) => [
                  change.path,
                  ...(change.kind.move_path ? [change.kind.move_path] : []),
                ])
                .map((path) => codexFileDecision(path, guard))
            : [
                codexCommandDecision(
                  requestApproval.command ?? "",
                  requestApproval.cwd ?? "",
                  guard,
                ),
              ];
        const denial = decisions.find(
          (decision) => decision.decision === "denied",
        );
        const accepted =
          !stopped &&
          !denial &&
          !requestApproval.additionalPermissions &&
          !requestApproval.networkApprovalContext;
        entry.decided_by = "runner_admission";
        entry.decision = accepted ? "allowed" : "denied";
        entry.denial_reason = accepted
          ? null
          : redact(
              denial?.reason ??
                "Additional permissions and network escalation are not granted by this runner.",
            );
        entry.denial_rule = accepted
          ? null
          : (denial?.rule ?? "command_allow_list");
        entry.denial_target = denial?.target ? redact(denial.target) : null;
        return accepted;
      },
    });
    const thread = await session.start(
      request.model,
      "You are a coding agent implementing an approved software change. Read the relevant files, implement the approved outcome, and run the required checks. The host handles publication and git history. Do not attempt those actions yourself. State the final result and any remaining blockers.",
    );
    // D-106: a subAgentActivity reported by any other thread is a second
    // generation, judged against this one.
    rootThreadId = thread;
    credential = session.credentialClass;
    // D-096: the cost caps bind, or stop binding, on what Codex authenticated
    // with — read before the turn that would spend anything.
    request.ceilings.useCredential(credential);
    // D-106: the executor's account is the root thread's own turn.
    // `session.turn()` is called once, on `thread`, and a child's
    // `agentMessage` lands in that child's turn state, which nothing here
    // awaits or reads.
    if (!stopped)
      finalMessage = redact(
        await session.turn(thread, request.model, request.prompt),
      );
    if (!stopped) termination = { reason: "completed", detail: "" };
  } catch (error) {
    if (!stopped) {
      const detail = redact(
        error instanceof Error ? error.message : String(error),
      );
      // Only provider protocol failures reach this catch; repository text is never classified here.
      termination = {
        reason:
          /429|5\d\d|rate.limit|usage.limit|connection|timed out|stream disconnected/i.test(
            detail,
          )
            ? "transport_unavailable"
            : "agent_error",
        detail,
      };
    }
  } finally {
    decided = true;
    // A brief asked for as the turn ended is still delivered, and a role
    // asked for as it ended still reaches the records: the session is
    // disposed only once every injection and every lookup has been answered
    // or refused.
    await Promise.allSettled([...injections, ...lookups]);
    await session?.dispose();
    clearInterval(timer);
    clearInterval(suspend);
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
  }
  return {
    invocation: {
      adapter: "codex",
      binary_path: fingerprint.path,
      binary_version: fingerprint.version,
      binary_sha256: fingerprint.sha256,
      model: request.model,
      credential_class: credential,
      argv: [...CODEX_EXECUTOR_ARGV],
      shape_sha256: invocationShapeHash([...CODEX_EXECUTOR_ARGV], []),
      neutralisation: {
        suppressed_at_invocation: [
          "isolated CODEX_HOME with provider-owned auth link only",
          "read-only native sandbox with per-request approval",
          "default local environment; empty dynamic tools and selected capability roots",
          "OpenAI provider pinned; web search disabled, Perbo's own roles the only ones written for agents",
        ],
        withheld_from_worktree: [],
        asserted_empty: ["instructionSources"],
        reported: {
          mcp_servers: [],
          plugins: [],
          skills: [],
          subagents: [],
          memory_paths: [],
        },
      },
    },
    commands,
    egress,
    prohibited,
    usage: {
      input_tokens: usage.total().inputTokens,
      cache_read_input_tokens: usage.total().cachedInputTokens,
      output_tokens: usage.total().outputTokens,
      cost_micros: 0,
      cost_basis: "unavailable",
      cost_partial: true,
      iterations: request.ceilings.counts().iterations,
    },
    termination,
    final_message: finalMessage,
    transcript,
    reinjections,
  };
}
