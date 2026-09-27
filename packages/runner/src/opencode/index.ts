import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  admittedCommands,
  invocationShapeHash,
  OPENCODE_ACP_ARGV,
  OPENCODE_API_KEY_ENV,
  OPENCODE_BUILTIN_MODES,
  oneLine,
  spokenLine,
  type CommandRecord,
  type TerminationReason,
} from "@perbo/contracts";
import {
  DEFAULT_SUSPEND_INTERVAL_MS,
  DEFAULT_SUSPEND_THRESHOLD_MS,
  SuspendDetector,
} from "@perbo/workspace";
import type { AgentRequest, AgentResult } from "../adapter.js";
import { ADMISSION_RULES } from "../admission.js";
import { codexCommandDecision, codexFileDecision } from "../codex/index.js";
import { EgressLog, type EgressVerdict } from "../egress.js";
import type { PreToolGuardState } from "../pretool.js";
import type { ProhibitedHit } from "../prohibited.js";
import { prepareScratchDirectory } from "../scratch.js";
import { worktreePath } from "../tally.js";
import {
  OPENCODE_EXECUTOR_INSTRUCTIONS,
  OpenCodeExecutorSession,
  type AcpPromptResult,
  type AcpToolCall,
  type AcpUpdate,
} from "./internal/acp.js";

/**
 * The tools OpenCode offers a session under the executor's permission rules
 * (`opencodePermissions("executor")`), by the name its tool calls carry. A call
 * of any other tool that ran means the session held a capability those rules
 * do not give it, and the attempt ends `agent_configuration_present`.
 */
export const OPENCODE_EXECUTOR_TOOLS = [
  "shell",
  "bash",
  "read",
  "write",
  "edit",
  "patch",
  "apply_patch",
  "glob",
  "grep",
  "list",
] as const;

/**
 * The executor's tools every call of which runs a command or changes a file,
 * and so is asked of the runner before it runs, by name. A completed call of
 * one is judged by its name as well as by the kind OpenCode reported for it,
 * so a kind that names none of those acts cannot let it pass unasked.
 */
export const OPENCODE_ASKED_TOOLS = ["shell", "bash", "write", "edit", "patch", "apply_patch"] as const;

/** A call's kind, as ACP names the kinds the runner judges. */
const WRITE_KINDS = new Set(["edit", "delete", "move"]);
const READ_KINDS = new Set(["read", "search"]);

/** The string at `key` of a call's input, where it is one. */
function text(input: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = input?.[key];
  return typeof value === "string" ? value : null;
}

/**
 * Every path a file change names: the locations OpenCode reports, the file the
 * tool was handed, each file of a multi-file change and where a move lands, and
 * every header of a patch. The call is judged on all of them, so a change is
 * refused on any one path the guard refuses, however the tool spelled it.
 */
export function opencodeWritePaths(call: AcpToolCall): string[] {
  const input = call.rawInput ?? {};
  const files = Array.isArray(input["files"]) ? (input["files"] as unknown[]) : [];
  const patch = text(input, "patchText") ?? "";
  return [
    ...new Set([
      ...(call.locations ?? []).map((location) => location.path),
      ...["path", "filePath", "filepath", "movePath"].flatMap((key) => text(input, key) ?? []),
      ...files.flatMap((file) =>
        file !== null && typeof file === "object"
          ? ["file", "path", "movePath"].flatMap((key) => text(file as Record<string, unknown>, key) ?? [])
          : [],
      ),
      ...[...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map(
        (found) => (found[1] ?? found[2]!).trim(),
      ),
    ]),
  ].filter((path) => path.length > 0);
}

/** Whether `path`, resolved against the worktree, stays inside the worktree or the scratch directory. */
function inside(state: Pick<PreToolGuardState, "root" | "tmpdir">, path: string): boolean {
  const absolute = resolve(state.root, path);
  return [state.root, ...(state.tmpdir === null ? [] : [state.tmpdir])].some((root) => {
    const rest = relative(root, absolute);
    return rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
  });
}

/** The runner's answer to one OpenCode permission request, before any host is asked about. */
export type OpenCodeDecision =
  | { decision: "allowed" }
  | { decision: "denied"; rule: string; reason: string; target: string | null };

/**
 * What the runner's guard says to one call OpenCode asks about, by its kind: a
 * command is judged as Codex's approvals judge one (`codexCommandDecision`), a
 * file change on every path it names as Codex's file approvals are
 * (`codexFileDecision`), a read or a search only inside the worktree and the
 * scratch directory, and anything else is refused. Inspection only: OpenCode
 * runs the call it already holds, and nothing here becomes an argument.
 */
export function opencodeDecision(call: AcpToolCall, state: PreToolGuardState): OpenCodeDecision {
  const kind = call.kind ?? "other";
  const input = call.rawInput ?? {};
  if (kind === "execute") {
    const command = text(input, "command");
    if (command === null || command.trim() === "")
      return {
        decision: "denied",
        rule: ADMISSION_RULES.allow_list,
        reason: "OpenCode asked about a command without naming it.",
        target: null,
      };
    const decided = codexCommandDecision(command, text(input, "cwd") ?? state.root, state);
    return decided.decision === "denied"
      ? {
          decision: "denied",
          rule: decided.rule ?? ADMISSION_RULES.allow_list,
          reason: decided.reason ?? "Command is outside the runner's admitted command set.",
          target: decided.target ?? null,
        }
      : { decision: "allowed" };
  }
  if (WRITE_KINDS.has(kind)) {
    const paths = opencodeWritePaths(call);
    if (paths.length === 0)
      return {
        decision: "denied",
        rule: ADMISSION_RULES.write,
        reason: "OpenCode asked about a file change without naming the file.",
        target: null,
      };
    for (const path of paths) {
      const decided = codexFileDecision(path, state);
      if (decided.decision === "denied")
        return {
          decision: "denied",
          rule: decided.rule ?? ADMISSION_RULES.write,
          reason: decided.reason ?? "The write guard refused the path.",
          target: decided.target ?? path,
        };
    }
    return { decision: "allowed" };
  }
  if (READ_KINDS.has(kind)) {
    const paths = [
      ...(call.locations ?? []).map((location) => location.path),
      ...["path", "filePath", "filepath"].flatMap((key) => text(input, key) ?? []),
    ];
    const outside = paths.find((path) => !inside(state, path));
    if (paths.length > 0 && outside === undefined) return { decision: "allowed" };
    return {
      decision: "denied",
      rule: "read_outside_worktree",
      reason: "The executor reads inside its worktree only.",
      target: outside ?? null,
    };
  }
  return {
    decision: "denied",
    rule: ADMISSION_RULES.allow_list,
    reason: `OpenCode asked about a ${kind} call, which this runner does not admit.`,
    target: call.title ?? null,
  };
}

/**
 * The executor on OpenCode, through `opencode acp` (D-NEW-opencode-is-a-provider).
 *
 * OpenCode runs its own tools under the executor's permission rules, which ask
 * about every command, every file change and every call reaching outside the
 * worktree and deny every other tool; each question comes here and is
 * answered by the runner's guard. A refusal ends OpenCode's turn, so the
 * attempt starts the next one itself, naming what was refused and why, until
 * a turn ends of its own accord. The brief rides in the session's
 * instructions, which OpenCode sends on every request and a compaction does
 * not remove, so there is nothing to re-inject after one. Subagents are not
 * offered: `task` is among the denied tools.
 */
export async function runOpenCodeAgent(request: AgentRequest): Promise<AgentResult> {
  if (request.supervision === "agent_permissions")
    throw new Error("The direct-agent comparison arm is registered for Claude Code only.");
  const redact = request.redact ?? ((line: string) => line);
  const progress = request.onProgress ?? (() => undefined);
  const guard: PreToolGuardState = {
    root: request.worktree,
    tmpdir: prepareScratchDirectory(request.worktree),
    cwd: request.worktree,
    paths_allowed: [...(request.paths_allowed ?? [])],
    paths_prohibited: [...(request.paths_prohibited ?? [])],
    ...(request.spec_folder ? { spec_folder: request.spec_folder } : {}),
    allow_list: [...request.profile.command_allow_list],
    deny_list: [...request.profile.command_deny_list],
  };
  const commands: CommandRecord[] = [];
  const transcript: string[] = [];
  const records = new Map<string, CommandRecord>();
  /** Each tool call's name and kind, from the update that announced it. */
  const tools = new Map<string, { name: string; kind: string | null }>();
  const egress = new EgressLog(request.profile.network_allow_list);
  const prohibited: Array<ProhibitedHit & { at: string }> = [];
  /** The worktree paths each admitted file change names, by the record it made. */
  const writtenBy = new Map<CommandRecord, string[]>();
  /** What the runner refused in the turn in flight, told to the executor as the next turn starts. */
  let refusals: string[] = [];
  /**
   * The executor's own message in flight, by its id. OpenCode gives each step
   * of a turn a message of its own and streams its words around the step's
   * tool calls, so a message is said once the next one starts or the turn
   * ends, and a tool call in the middle of it does not cut it in two.
   */
  let speaking: { id: string | null; text: string } | null = null;
  let lastMessage: string | null = null;
  const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costMicros: 0 };
  let countedTokens = 0;
  const tell = (): void => {
    if (request.onTally === undefined) return;
    const written = new Set<string>();
    for (const [entry, paths] of writtenBy)
      if (entry.decision === "allowed") for (const path of paths) written.add(path);
    request.onTally({
      commands: admittedCommands(commands),
      input_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
      output_tokens: usage.output,
      cost_micros: usage.costMicros,
      cost_basis: "transport_reported",
      written: [...written],
    });
  };
  let termination: { reason: TerminationReason; detail: string } = {
    reason: "agent_error",
    detail: "OpenCode did not report completion",
  };
  let session: OpenCodeExecutorSession | null = null;
  let stopped = false;
  const gate = request.egress ?? null;
  const waiting = new AbortController();
  const stop = (reason: TerminationReason, detail: string): void => {
    if (stopped) return;
    stopped = true;
    waiting.abort();
    termination = { reason, detail: redact(detail) };
    session?.close(new Error(detail));
  };
  const cancel = (): void => stop("cancelled", "Stopped by the user");
  const detector = new SuspendDetector(
    () => stop("host_suspended", "Host suspended during the OpenCode attempt"),
    DEFAULT_SUSPEND_INTERVAL_MS,
    DEFAULT_SUSPEND_THRESHOLD_MS,
    request.clock ?? Date.now,
  );
  const timer = setInterval(() => {
    const breach = request.ceilings.tick();
    if (breach) stop(breach.reason, breach.detail);
  }, 250);
  const suspend = setInterval(() => detector.tick(), DEFAULT_SUSPEND_INTERVAL_MS);
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);

  let fingerprint = { path: request.binary, version: "unknown", sha256: "0".repeat(64) };
  try {
    const path = execFileSync("which", [request.binary], { encoding: "utf8" }).trim();
    fingerprint = {
      path,
      version: execFileSync(request.binary, ["--version"], { encoding: "utf8", timeout: 30_000 }).trim(),
      sha256: createHash("sha256").update(readFileSync(realpathSync(path))).digest("hex"),
    };
  } catch {
    /* Unavailable fingerprint is recorded, never invented. Session startup will report a missing binary. */
  }
  // OpenCode Zen's key is the one credential the session is passed; without it
  // OpenCode runs only its free models, and what they are billed on is not known.
  const credential: AgentResult["invocation"]["credential_class"] = request.env[OPENCODE_API_KEY_ENV]
    ? "user_api_key"
    : "unknown";
  request.ceilings.useCredential(credential);

  /** The executor finished a message: its words, as it said them, for whoever watches the run. */
  const finishSpeaking = (): void => {
    if (speaking === null) return;
    const words = speaking.text;
    speaking = null;
    if (words.trim() === "") return;
    lastMessage = words;
    transcript.push(redact(JSON.stringify({ sessionUpdate: "agent_message", text: words })).slice(0, 200_000));
    const said = spokenLine("executor", redact(words));
    if (said !== null) progress(said);
  };

  const record = (call: AcpToolCall): CommandRecord => {
    const existing = records.get(call.toolCallId);
    if (existing) return existing;
    const breach = request.ceilings.noteCommand() ?? request.ceilings.noteIteration();
    if (breach) stop(breach.reason, breach.detail);
    const input = call.rawInput ?? {};
    // A file change names its paths several ways — absolute, relative, the
    // tool's own and OpenCode's locations — so its record names each once, as
    // the worktree reads it.
    const detail =
      text(input, "command") ??
      [...new Set(opencodeWritePaths(call).map((path) => relative(request.worktree, resolve(request.worktree, path)) || "."))].join(", ");
    const cwd = text(input, "cwd");
    const entry: CommandRecord = {
      sequence: commands.length,
      tool: tools.get(call.toolCallId)?.name ?? call.kind ?? "tool",
      detail: redact(detail === "" ? (call.title ?? call.kind ?? "tool") : detail),
      decision: "denied",
      denial_reason: null,
      denial_rule: null,
      denial_target: null,
      cwd: call.kind === "execute" ? (cwd ? relative(request.worktree, cwd) || "." : ".") : null,
      decided_by: "runner_admission",
      second_reading: null,
      agent: null,
      at: new Date().toISOString(),
    };
    commands.push(entry);
    records.set(call.toolCallId, entry);
    if (WRITE_KINDS.has(call.kind ?? "")) {
      const writes = opencodeWritePaths(call).flatMap((path) => worktreePath(request.worktree, guard.tmpdir, path) ?? []);
      if (writes.length > 0) writtenBy.set(entry, writes);
    }
    // On one line, whole: a command's own newline would otherwise print a line
    // that reads as one of the run's stages (D-NEW-nothing-shown-is-cut).
    progress(`OpenCode ${oneLine(entry.detail)}`);
    return entry;
  };

  const settle = (entry: CommandRecord, refusal: { rule: string; reason: string; target: string | null } | null): boolean => {
    entry.decided_by = "runner_admission";
    entry.decision = refusal === null ? "allowed" : "denied";
    entry.denial_reason = refusal === null ? null : redact(refusal.reason);
    entry.denial_rule = refusal === null ? null : refusal.rule;
    entry.denial_target = refusal?.target ? redact(refusal.target) : null;
    if (refusal !== null) refusals.push(`${entry.detail}: ${entry.denial_reason}`);
    tell();
    return refusal === null;
  };

  /**
   * An admitted command naming hosts off the list, held while each is settled
   * through the gate (D-NEW-an-unlisted-host-asks). Without a gate the host is
   * refused and the attempt ends `unlisted_egress_host`, as on every adapter.
   */
  const settleEgress = async (entry: CommandRecord, command: string, hosts: readonly string[]): Promise<boolean> => {
    egress.observe(command, "command", new Date());
    if (gate === null) {
      settle(entry, { rule: ADMISSION_RULES.egress, reason: "Command requested a host outside the network allow-list", target: hosts[0] ?? null });
      stop("unlisted_egress_host", "Command requested a host outside the network allow-list");
      return false;
    }
    for (const host of hosts) {
      if (egress.isAllowed(host)) continue;
      const release = request.ceilings.holdForPerson();
      let verdict: EgressVerdict;
      try {
        verdict = await gate.ask({ host, command: redact(command), wait_ms: request.ceilings.stallLimitMs, signal: waiting.signal });
      } catch (error) {
        verdict = {
          answer: "refuse",
          tell:
            `${host} is not on this run's network allow-list, and whether to allow it could not be asked ` +
            `(${error instanceof Error ? error.message : String(error)}). Finish the work without it.`,
        };
      } finally {
        release();
      }
      if (stopped) return settle(entry, { rule: ADMISSION_RULES.egress, reason: "the attempt stopped while the host was asked about", target: host });
      if (verdict.answer === "allow") {
        egress.allow(host);
        continue;
      }
      if (verdict.answer === "refuse") return settle(entry, { rule: ADMISSION_RULES.egress, reason: verdict.tell, target: host });
      settle(entry, { rule: ADMISSION_RULES.egress, reason: verdict.detail, target: host });
      stop("unlisted_egress_host", verdict.detail);
      return false;
    }
    return settle(entry, null);
  };

  const permit = async (call: AcpToolCall): Promise<boolean> => {
    if (stopped) return false;
    request.ceilings.noteToolActivity();
    const entry = record(call);
    if (stopped) return settle(entry, { rule: ADMISSION_RULES.allow_list, reason: "The attempt has stopped.", target: null });
    const decided = opencodeDecision(call, guard);
    if (decided.decision === "denied") return settle(entry, decided);
    const command = call.kind === "execute" ? (text(call.rawInput, "command") ?? "") : null;
    if (command !== null) {
      const hosts = egress.unlisted(command);
      if (hosts.length > 0) return settleEgress(entry, command, hosts);
      egress.observe(command, "command", new Date());
    }
    return settle(entry, null);
  };

  const onUpdate = (update: AcpUpdate): void => {
    if (update.sessionUpdate === "agent_message_chunk") {
      const id = update.messageId ?? null;
      if (speaking !== null && speaking.id !== id) finishSpeaking();
      speaking ??= { id, text: "" };
      speaking.text += update.content?.text ?? "";
      return;
    }
    if (update.sessionUpdate === "usage_update") {
      if (update.cost && update.cost.currency === "USD") {
        usage.costMicros = Math.max(usage.costMicros, Math.round(update.cost.amount * 1_000_000));
        const breach = request.ceilings.noteCostMicros(usage.costMicros);
        if (breach) stop(breach.reason, breach.detail);
        tell();
      }
      return;
    }
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
    if (update.toolCallId === undefined) return;
    // D-096: a tool call starting and its result arriving are both the
    // executor being alive, and either resets the stall window.
    request.ceilings.noteToolActivity();
    if (update.sessionUpdate === "tool_call" && update.title)
      tools.set(update.toolCallId, { name: update.title, kind: update.kind ?? null });
    if (update.status !== "completed" && update.status !== "failed") return;
    transcript.push(redact(JSON.stringify(update)).slice(0, 200_000));
    if (update.status !== "completed") return;
    const announced = tools.get(update.toolCallId);
    const name = announced?.name ?? "unknown";
    const kind = update.kind ?? announced?.kind ?? null;
    if (!(OPENCODE_EXECUTOR_TOOLS as readonly string[]).includes(name)) {
      stop("agent_configuration_present", `OpenCode ran ${name}, a tool the executor's session is not given`);
      return;
    }
    // Every command and every file change is asked about before it runs and
    // runs only on the runner's `once`, so one that ran with no question
    // behind it, or over the runner's refusal, ran on a rule the runner did
    // not write. Which calls those are is read from the tool's name as well
    // as from the kind OpenCode reported, whichever says so.
    const asked =
      kind === "execute" || WRITE_KINDS.has(kind ?? "") || (OPENCODE_ASKED_TOOLS as readonly string[]).includes(name);
    if (asked && records.get(update.toolCallId)?.decision !== "allowed") {
      const detail = records.has(update.toolCallId)
        ? `OpenCode ran ${name} after the runner refused it`
        : `OpenCode ran ${name} without asking the runner`;
      prohibited.push({ action: "enable_own_tooling", detail: redact(detail), at: new Date().toISOString() });
      stop("agent_configuration_present", detail);
    }
  };

  const addUsage = (result: AcpPromptResult): void => {
    const reported = result.usage;
    if (!reported) return;
    usage.input += reported.inputTokens ?? 0;
    usage.cacheRead += reported.cachedReadTokens ?? 0;
    usage.cacheWrite += reported.cachedWriteTokens ?? 0;
    usage.output += reported.outputTokens ?? 0;
    const fresh = usage.input + usage.output;
    const breach = request.ceilings.noteTokens(Math.max(0, fresh - countedTokens));
    countedTokens = fresh;
    if (breach) stop(breach.reason, breach.detail);
    tell();
  };

  let modes: string[] = [];
  try {
    session = new OpenCodeExecutorSession({
      binary: request.binary,
      env: request.env,
      instructions: `${OPENCODE_EXECUTOR_INSTRUCTIONS}\n\n${request.prompt}`,
      timeoutMs: request.ceilings.wallClockLimitMs,
      onUpdate,
      permit,
    });
    const opened = await session.open(request.worktree, request.model);
    modes = opened.modes;
    const loaded = modes.filter((mode) => !(OPENCODE_BUILTIN_MODES as readonly string[]).includes(mode));
    if (loaded.length > 0) stop("agent_configuration_present", `OpenCode loaded agent definitions: ${loaded.join(", ")}`);
    let text: string =
      "Carry out the approved brief in your instructions. State the final result and any remaining blockers when you are done.";
    while (!stopped) {
      refusals = [];
      lastMessage = null;
      const result = await session.prompt(opened.sessionId, text);
      finishSpeaking();
      addUsage(result);
      if (stopped) break;
      if (result.stopReason === "end_turn") {
        termination = { reason: "completed", detail: "" };
        break;
      }
      if (result.stopReason === "cancelled" && refusals.length > 0) {
        // A refusal ends OpenCode's turn. What was refused, and why, is the
        // runner's own account of its own answers, and the next turn starts
        // with it.
        text =
          "The runner refused these calls in your last turn:\n" +
          refusals.map((refusal) => `- ${refusal}`).join("\n") +
          "\nContinue the approved work within those limits, or state what blocks it.";
        continue;
      }
      termination = { reason: "agent_error", detail: redact(`OpenCode ended the turn: ${result.stopReason}`) };
      break;
    }
  } catch (error) {
    if (!stopped) {
      const detail = redact(error instanceof Error ? error.message : String(error));
      termination = {
        reason: /429|5\d\d|rate.limit|usage.limit|connection|timed out|No models are available|Internal service failure/i.test(detail)
          ? "transport_unavailable"
          : "agent_error",
        detail,
      };
    }
  } finally {
    await session?.dispose();
    clearInterval(timer);
    clearInterval(suspend);
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
  }
  tell();
  return {
    invocation: {
      adapter: "opencode",
      binary_path: fingerprint.path,
      binary_version: fingerprint.version,
      binary_sha256: fingerprint.sha256,
      model: request.model,
      credential_class: credential,
      argv: [...OPENCODE_ACP_ARGV],
      shape_sha256: invocationShapeHash([...OPENCODE_ACP_ARGV], []),
      neutralisation: {
        suppressed_at_invocation: [
          "fresh OpenCode config, data, state and cache directories; project configuration off",
          "configuration from OPENCODE_CONFIG_CONTENT only: no tool server, plugin, formatter, language server, sharing or update",
          "every command, file change and call outside the worktree asked of the runner; every other tool denied, subagents and skills included",
          "the brief in the session's instructions, which a compaction does not remove",
        ],
        withheld_from_worktree: [],
        asserted_empty: ["primary agents beyond OpenCode's own", "tool calls that ran without the runner's answer"],
        reported: {
          mcp_servers: [],
          plugins: [],
          skills: [],
          subagents: modes.filter((mode) => !(OPENCODE_BUILTIN_MODES as readonly string[]).includes(mode)),
          memory_paths: [],
        },
      },
    },
    commands,
    egress,
    prohibited,
    usage: {
      input_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
      cache_creation_input_tokens: usage.cacheWrite,
      cache_read_input_tokens: usage.cacheRead,
      output_tokens: usage.output,
      cost_micros: usage.costMicros,
      cost_basis: "transport_reported",
      cost_partial: termination.reason !== "completed",
      iterations: request.ceilings.counts().iterations,
    },
    termination,
    final_message: lastMessage === null ? null : redact(lastMessage),
    transcript,
    reinjections: [],
  };
}
