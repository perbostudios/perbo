import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PermissionProfile } from "@perbo/contracts";
import { replaceFile } from "@perbo/workspace";
import {
  ADMISSION_RULES,
  judgeCommand,
  matchesListEntry,
  type AdmissionRule,
} from "./admission.js";
import { PERBO_AGENT_ROLE_NAMES, isSubagentTool, judgeSubagentStart, SUBAGENT_TOOL_NAMES } from "./agents.js";
import { writeBriefRecord, type BriefRecords } from "./brief.js";
import { describeShellCwd } from "./prohibited.js";
import { UNKNOWN_CWD, everySegment, type CommandSegment } from "./shell/index.js";
import { HOST_TEMPORARY_DIRECTORY } from "./scratch.js";

/**
 * The write guard, moved in front of the tool (SCP-177).
 *
 * `judgeCommand` reads a `tool_use` block out of the stream, which the agent
 * emits **after** the tool has run. That makes admitting a mutating verb by
 * where its paths land impossible to enforce: the runner can refuse a command
 * the outer `--allowedTools` list already admitted, but it cannot admit one the
 * outer list refused without the command running first. AYO-29's executor
 * closed that gap the wrong way, by putting `rm`, `cp`, `mv`, `ln`, `chmod`,
 * `mkdir`, `touch` and `tee` on the enforced list.
 *
 * The mechanism that closes it properly is a `PreToolUse` hook. Claude Code
 * runs it before the tool, hands it the tool name and input on stdin, and obeys
 * the `permissionDecision` it prints — `deny` stops the call and `allow` runs
 * one the allow-list does not carry. Measured against the pinned binary
 * (2.1.247) rather than assumed; the measurement and the rejected alternative
 * are in `docs/08`.
 *
 * ## Why a hook and not the permission-prompt tool
 *
 * `--permission-prompt-tool` works too, and was measured working. It needs an
 * MCP server, and ADR-0030's requirement 3 asserts that **no tool server at
 * all** is connected — the one thing that assertion achieves exactly. Buying a
 * pre-execution decision by weakening threat 18 is the wrong trade when a hook
 * buys the same decision and connects nothing.
 *
 * ## Where the state lives, and why outside the worktree
 *
 * The hook is a separate process, so what it knows it reads from disk: the
 * worktree root, the scratch directory, the lists, and the directory each
 * agent's shell stands in (SCP-170, D-106), which the hook advances itself
 * because it is the only reader that sees the calls in the order they execute.
 * The attempt's own state is written once and never rewritten; what moves is
 * one small file per agent, so two agents' hook processes never write the same
 * bytes and nothing has to be locked.
 *
 * That directory is outside the worktree on purpose. Inside it, an executor
 * could rewrite the root and admit itself anywhere; outside it, every write to
 * it is a write outside the worktree, which is the thing this guard refuses.
 * The guard's own state is protected by the guard.
 *
 * The decisions file carries no command text. The runner already holds a
 * redacted `detail` for each call from the stream, and writing a second,
 * unredacted copy of every command to a file outside the worktree would put
 * materialized secrets somewhere the secret index does not reach. Decisions are
 * keyed by `tool_use_id`, which the hook input carries.
 *
 * ## Three answers, not two
 *
 * A hook that answers every call would be the only permission layer, because
 * `allow` bypasses the `--allowedTools` list, the built-in handling and the
 * binary's own write sandbox alike. The runner does not know enough to be that
 * layer: `judgeCommand` authors the refusals `ADMISSION_RULES` names — the
 * deny-list, a write the resolver put outside the worktree, a write to a path
 * the contract prohibits (D-105), a write inside the worktree but outside the
 * globs the contract admits (SCP-195), a write to git's credential wiring, and
 * the two programs it cannot read — and `SCP-163`'s follow-up established why
 * it must not author one more from absence off the allow-list. The agent's own layer
 * admits `pwd`, `test`, `command -v` and the rest of the built-ins with no
 * entry, and a runner that refused them would refuse commands that were always
 * going to run.
 *
 * So the hook answers:
 *
 * - **deny** — the deny-list, a write outside the worktree, a write to a path
 *   the contract prohibits, or a write inside the worktree that the contract's
 *   globs do not admit. This is the refusal, and it stops the call.
 * - **allow** — the line runs a verb that writes to a path it names, or a verb
 *   with no effect beyond one already judged, and every target the resolver
 *   found is inside. This is the admission `SCP-163` needs, and it is what
 *   lets `rm -r .scratch` run without `rm` on the enforced list.
 * - **nothing** — the runner has no grounds either way, so the answer is
 *   silence and the agent's own permission layer decides as it always did.
 *   Measured: a hook that prints nothing and exits 0 leaves `ls -la` admitted
 *   under `Bash(ls:*)` and `mkdir` refused under an empty list. That silence is
 *   what keeps `script -q /dev/null …` out — the runner does not vouch for it,
 *   and the outer list does not carry it.
 */

/** The tools whose writes the hook judges: everything that can write. */
export const PRE_TOOL_JUDGED_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
] as const;

/**
 * Every tool the hook is installed for: the writing five, and the one that
 * starts a subagent, under both names Claude Code answers to for it (D-106).
 *
 * The tool that starts a subagent writes nothing itself, and it is here
 * because what it starts does. Both `Agent` and `Task` are listed because the
 * pinned binary sends the call as `Agent` and normalises `Task` only on
 * surfaces it reads as configuration — a hook's matcher is one, and this is
 * what the matcher carries either way (ADR-0038, SCP-326).
 */
export const PRE_TOOL_HOOKED_TOOLS = [...PRE_TOOL_JUDGED_TOOLS, ...SUBAGENT_TOOL_NAMES] as const;

/** The `matcher` a Claude Code hook entry takes: alternation over tool names. */
export const PRE_TOOL_MATCHER = PRE_TOOL_HOOKED_TOOLS.join("|");

/**
 * The `SessionStart` source the brief goes back on (D-096).
 *
 * `SessionStart` fires on `startup`, `resume`, `clear` and `compact`, and the
 * matcher is the source. Only a compaction has taken anything away, so only a
 * compaction gets the brief again — the hook reads the source itself as well,
 * so the answer does not rest on the matcher alone.
 */
export const SESSION_START_MATCHER = "compact";

/** What the hook needs to judge a call, as the runner writes it. */
export interface PreToolGuardState {
  /** The attempt's worktree root. */
  root: string;
  /** The scratch directory `$TMPDIR` points at, or null where there is none. */
  tmpdir: string | null;
  /**
   * Where an agent's shell stands before it has moved: absolute, or
   * `UNKNOWN_CWD`. Every agent starts here, and where each one stands after
   * that is its own file (D-106). This one is never rewritten.
   */
  cwd: string;
  /**
   * The globs the approved contract admits a write under, relative to the root
   * (SCP-195). Empty, or carrying `**`, admits everything inside the root.
   */
  paths_allowed: string[];
  /**
   * The paths the approved contract prohibits a write to, relative to the root
   * (D-105). Judged before the globs above, so a prohibited path inside the
   * admitted ones is refused all the same. Empty prohibits nothing.
   */
  paths_prohibited: string[];
  /**
   * Where this repository keeps its specs, from `.perbo/config.json` (D-103).
   * Prohibited whatever the contract says, beside the default `specs/`.
   */
  spec_folder?: string | null;
  /**
   * Whether the spec folders may be written. Absent for every attempt, which
   * may not; stated by the interview, which writes the spec it is there to
   * write (D-102) and is bounded by `paths_allowed` instead.
   */
  spec_folder_writable?: boolean;
  allow_list: string[];
  deny_list: string[];
  /**
   * The subagent roles Perbo defines, as the invocation offered them (D-106).
   * The hook reads them from here rather than from its own import, so what the
   * executor was handed and what the guard enforces are one list.
   *
   * Absent refuses every subagent-starting call: a guard that cannot say
   * which roles the attempt offered cannot say a named one is among them.
   */
  agent_roles?: string[];
}

/**
 * Where one agent's shell stands (D-106 criterion 2).
 *
 * The executor and each of its subagents get their own Bash session, so a `cd`
 * one of them ran says nothing about where another's next relative path
 * resolves. One shared directory judges one agent's write from another's, in
 * whichever direction the calls happened to arrive.
 *
 * So each agent's directory is its own file, named by the agent and written by
 * that agent's calls alone. Two agents' hook processes therefore never write
 * the same file, which is what makes interleaved calls safe without a lock —
 * there is no read-modify-write of a shared value to lose.
 */
export interface PreToolAgentState {
  /**
   * The role the payload named, or null for the top-level session. Recorded so
   * a file named by a digest still says whose it is; the judgement reads `cwd`
   * alone.
   */
  agent: string | null;
  /** Where that agent's shell stands: absolute, or `UNKNOWN_CWD`. */
  cwd: string;
}

/** What the hook told the agent about one call. */
export type PreToolAnswer = "allow" | "deny" | "defer";

/** One decision the hook made, as the runner reads it back. */
export interface PreToolDecision {
  /** The call this answers. The runner joins on it; there is no other key. */
  tool_use_id: string;
  tool: string;
  /**
   * What the hook said. `defer` means it said nothing and the agent's own
   * permission layer decided, so the attempt's record must not claim this
   * decision as the runner's.
   */
  answer: PreToolAnswer;
  decision: "allowed" | "denied";
  rule: AdmissionRule | null;
  /** Unredacted: a path or a command fragment. The runner redacts before recording. */
  target: string | null;
  reason: string | null;
  /** The directory the call was judged from, relative to the root, or `unknown`. */
  cwd: string | null;
  /**
   * The agent that made the call: the role a subagent was started from, and
   * null for the executor's own top-level session (D-106). The role rather
   * than the agent's id, because it is the name a person reads and the one the
   * transcript reading can produce as well — the stream carries the
   * subagent-starting call's `subagent_type`, not the id the hook is handed.
   */
  agent: string | null;
  at: string;
}

/** The files the guard keeps for one attempt. */
/**
 * What an invocation needs from whichever settings the runner wrote for it.
 *
 * Two shapes answer to this: the guard below, and the hookless settings
 * SCP-228 gives an agent the runner does not police. The invocation names a
 * settings file either way, because that argument is also what keeps every
 * other hook out (SCP-177).
 */
export interface AgentSettings {
  /** Outside the worktree, so the executor cannot write to it. */
  directory: string;
  /** Passed to the binary as `--settings`. */
  settingsPath: string;
  /** The hook's own decisions; empty and never appended to where none runs. */
  decisionsPath: string;
}

export interface PreToolGuard extends AgentSettings {
  statePath: string;
}

const STATE_FILE = "state.json";
const DECISIONS_FILE = "decisions.jsonl";
const SETTINGS_FILE = "settings.json";
/** One file per agent, holding where that agent's shell stands (D-106). */
const AGENTS_DIRECTORY = "agents";
/** The top-level session's own file: it is the one agent with no id of its own. */
const SESSION_AGENT_KEY = "session";

/**
 * The file name one agent's state is kept under.
 *
 * The agent id arrives on the hook's standard input, so it is a value the
 * guard is handed rather than one it chose, and making a filename out of it
 * would make it a path (ADR-0023). The digest is the whole answer: no
 * separator, no `..` and no absolute form survives it, and one id always names
 * one file.
 */
function agentStateFile(directory: string, agentId: string | undefined): string {
  const key =
    agentId === undefined
      ? SESSION_AGENT_KEY
      : createHash("sha256").update(agentId).digest("hex").slice(0, 32);
  return join(directory, AGENTS_DIRECTORY, `${key}.json`);
}

/**
 * Where one agent's shell stands, or that the guard cannot say (D-106).
 *
 * A file that is not there and a file that will not read back are not one
 * case. The file is written only by a call that moved this agent, so its
 * absence says the agent has not moved and stands where the attempt started
 * it: the root, which is inside the worktree and inside the contract. That
 * holds while every move is recorded, which is why a move that cannot be is
 * refused, and while nothing removes a file the guard wrote: the runner
 * removes the directory only once the attempt is over, and something else
 * deleting an agent's file after a move would stand it back at the root. A file
 * that is there and cannot be read back says the opposite — this agent did
 * move, that is why the bytes exist, and where it went is gone with them.
 *
 * Standing that agent at the root would judge its next relative target from a
 * directory its shell has left: with the shell in `/tmp`, `echo x > out.txt`
 * resolves to `<root>/out.txt`, is admitted as a path inside the worktree, and
 * writes `/tmp/out.txt` — the boundary D-022 and D-105 rest on, crossed with
 * an admission rather than a refusal. So the second case is refused instead.
 */
type AgentStanding =
  | { readonly placed: true; readonly state: PreToolAgentState }
  | { readonly placed: false; readonly cause: string };

/**
 * The read door's clause: the file is there, it will not say where the agent
 * went, and the bytes exist because a call moved it.
 */
const holdsNothing = (why: string): string =>
  `the file holding that agent's directory is there and did not read back (${why}), and that ` +
  "file is written only by a call that moved the agent, so this agent moved";

/** Whether a read failed because there is no such file, rather than for any other reason. */
function isAbsent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

const causeOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Where this agent's shell stands, where the attempt started it, or neither. */
function readAgentState(
  directory: string,
  call: PreToolCall,
  attempt: PreToolGuardState,
): AgentStanding {
  // Never the file's own `agent`: the role arrives on the payload in front of
  // the guard, and the file is what a torn write could leave a stale name in.
  const agent = call.agent_type ?? null;
  let written: string;
  try {
    written = readFileSync(agentStateFile(directory, call.agent_id), "utf8");
  } catch (error) {
    if (isAbsent(error)) return { placed: true, state: { agent, cwd: attempt.cwd } };
    return { placed: false, cause: holdsNothing(causeOf(error)) };
  }
  let held: PreToolAgentState;
  try {
    held = JSON.parse(written) as PreToolAgentState;
  } catch (error) {
    return { placed: false, cause: holdsNothing(`it did not parse: ${causeOf(error)}`) };
  }
  // The file is put in place by a rename, so no reader sees half of one: a
  // file with no directory in it is a file that says nothing about where this
  // agent went, which is the standing of one that would not parse at all.
  if (typeof held.cwd !== "string" || held.cwd.length === 0) {
    return { placed: false, cause: holdsNothing("it holds no directory") };
  }
  return { placed: true, state: { agent, cwd: held.cwd } };
}

/**
 * The refusal under `agent_directory_unknown` (D-106 criterion 2), recorded
 * like any other so the attempt's record carries it rather than a silent stop.
 *
 * Two doors reach it, and the caller says what is true at its own. At the read
 * door the file holding an agent's directory will not read back, so every call
 * from that agent is refused, and not only the ones that name a path: where
 * its shell stands is what every relative target resolves against, and a
 * guard that cannot say where an agent is has no grounds for picking which of
 * its calls to let through. At the write door a call would move the agent and
 * its new directory cannot be recorded, so that call is refused and the agent
 * stays where the guard last saw it.
 */
function refuseAgentDirectoryUnknown(
  directory: string,
  call: PreToolCall,
  said: { reason: string; cwd: string },
  at: Date,
): PreToolResponse {
  const tool = call.tool_name ?? "unknown";
  const reason = said.reason;
  const decision: PreToolDecision = {
    tool_use_id: call.tool_use_id ?? "",
    tool,
    answer: "deny",
    decision: "denied",
    rule: ADMISSION_RULES.agent_directory_unknown,
    target: tool,
    reason,
    cwd: said.cwd,
    agent: call.agent_type ?? null,
    at: at.toISOString(),
  };
  try {
    appendFileSync(join(directory, DECISIONS_FILE), `${JSON.stringify(decision)}\n`, "utf8");
  } catch {
    // The refusal stands whether or not the runner can read it back.
  }
  return failClosed(reason);
}

/**
 * The hook entry point, as an absolute path.
 *
 * Compiled beside this module in `dist`; running from `src` under the test
 * runner there is no `.js` beside it, and the built copy one directory over is
 * what a spawned `node` can actually load. Which is why `test` depends on this
 * package's own `build` in `turbo.json` and not only on its dependencies'.
 *
 * A missing entry is refused here rather than left to the hook: an unreadable
 * hook command fails every tool call with a loader stack trace, and the
 * sentence a person needs is that the package was not built.
 */
export function guardHookEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "guard-hook.js"), join(here, "..", "dist", "guard-hook.js")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "the runner's write-guard hook is not compiled: no guard-hook.js beside " +
      `${here} or under its dist. Run \`pnpm exec turbo run build\` before running an attempt.`,
  );
}

/**
 * The attempt's settings, as the binary reads them: two hooks and no others.
 *
 * Both run the same program, which is the runner's own and built from a path
 * this package computed — the write guard before every tool that can write
 * (SCP-177), and the brief again after every compaction (D-096). The file is
 * the only settings source the invocation names, so it is also what keeps
 * every other hook out.
 */
export function attemptSettings(command: string): Record<string, unknown> {
  const hook = [{ type: "command", command }];
  return {
    hooks: {
      PreToolUse: [{ matcher: PRE_TOOL_MATCHER, hooks: hook }],
      SessionStart: [{ matcher: SESSION_START_MATCHER, hooks: hook }],
    },
  };
}

/**
 * Create the attempt's guard directory and write its state and settings.
 *
 * The hook command is the runner's own, built from `process.execPath` and a
 * path this package computed. Nothing a model returned reaches it.
 */
export function preparePreToolGuard(args: {
  worktree: string;
  tmpdir: string | null;
  profile: PermissionProfile;
  /** The contract's write globs. Omitted admits everything inside the worktree. */
  paths_allowed?: readonly string[];
  /** The contract's prohibited paths (D-105). Omitted prohibits nothing. */
  paths_prohibited?: readonly string[];
  /** The repository's spec folder, prohibited whatever the contract says (D-103). */
  spec_folder?: string | null;
  /**
   * The subagent roles the executor may start (D-106). Omitted, the attempt
   * offers the roles Perbo defines, which is what the invocation passes.
   */
  agent_roles?: readonly string[];
  /**
   * The program the hook runs, as argv without the guard's directory, which is
   * always appended as its last argument. Overridden only by the test that
   * stands a different judgement in the hook's place to make the runner's two
   * readings disagree.
   */
  hookProgram?: readonly string[];
  /**
   * Whether this runner runs on Electron's Node, as it does under the desktop.
   * Read from `process.versions` where not given.
   */
  electron?: boolean;
  /**
   * The round's brief and the records its state block is composed from
   * (D-096). Written here, once, because this is the directory the
   * `SessionStart` hook reads them back from. Omitted, no brief is recorded
   * and a compaction gets nothing rather than something invented.
   */
  brief?: { text: string; records: BriefRecords };
}): PreToolGuard {
  const host = HOST_TEMPORARY_DIRECTORY.TMPDIR ?? tmpdir();
  const directory = mkdtempSync(join(host, "perbo-guard-"));
  const guard: PreToolGuard = {
    directory,
    settingsPath: join(directory, SETTINGS_FILE),
    statePath: join(directory, STATE_FILE),
    decisionsPath: join(directory, DECISIONS_FILE),
  };
  // Where each agent's directory is kept (D-106). Made here rather than by the
  // hook, because the hook's own writes are the ones that must not fail.
  mkdirSync(join(directory, AGENTS_DIRECTORY), { recursive: true });
  const state: PreToolGuardState = {
    root: resolve(args.worktree),
    tmpdir: args.tmpdir === null ? null : resolve(args.tmpdir),
    cwd: resolve(args.worktree),
    paths_allowed: [...(args.paths_allowed ?? [])],
    paths_prohibited: [...(args.paths_prohibited ?? [])],
    ...(args.spec_folder ? { spec_folder: args.spec_folder } : {}),
    allow_list: [...args.profile.command_allow_list],
    deny_list: [...args.profile.command_deny_list],
    agent_roles: [...(args.agent_roles ?? PERBO_AGENT_ROLE_NAMES)],
  };
  writeFileSync(guard.statePath, JSON.stringify(state), "utf8");
  writeFileSync(guard.decisionsPath, "", "utf8");
  if (args.brief) writeBriefRecord(directory, args.brief);
  const program = args.hookProgram ?? [process.execPath, guardHookEntry()];
  // Under Electron's Node `process.execPath` is the app, which runs as Node only
  // while `ELECTRON_RUN_AS_NODE` is set, and the executor's environment, which
  // the hook inherits, does not carry it. Without it the hook would start the
  // app, which exits with nothing printed, and a hook that prints nothing lets
  // the call run. So the command sets it for the hook alone.
  const electron = args.electron ?? process.versions.electron !== undefined;
  const command = (electron ? "ELECTRON_RUN_AS_NODE=1 " : "") + [...program, directory].map(quote).join(" ");
  writeFileSync(guard.settingsPath, JSON.stringify(attemptSettings(command)), "utf8");
  return guard;
}

/** A shell word the hook command can carry, since the binary runs it in a shell. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Settings that install no hook at all (SCP-228).
 *
 * The direct-agent arm of the loop-versus-direct-agent registration runs under
 * the permissions a person gives Claude Code for ordinary work, not the
 * runner's — so nothing of the runner's decides its tool calls before they run.
 * The file is still written and still named on the invocation, because
 * `--settings` is the only settings source the invocation has and dropping it
 * would let a user-scoped hook back in.
 *
 * There is no state file: nothing reads one, and writing an allow-list no hook
 * consults would describe a judgement that does not happen.
 */
export function prepareUnguardedSettings(): AgentSettings {
  const host = HOST_TEMPORARY_DIRECTORY.TMPDIR ?? tmpdir();
  const directory = mkdtempSync(join(host, "perbo-unguarded-"));
  const settings: AgentSettings = {
    directory,
    settingsPath: join(directory, SETTINGS_FILE),
    decisionsPath: join(directory, DECISIONS_FILE),
  };
  writeFileSync(settings.settingsPath, JSON.stringify({ hooks: {} }), "utf8");
  writeFileSync(settings.decisionsPath, "", "utf8");
  return settings;
}

/** Remove the settings directory. A guard's decisions carry unredacted targets. */
export function discardPreToolGuard(guard: AgentSettings): void {
  rmSync(guard.directory, { recursive: true, force: true });
}

/** Every decision the hook has written so far, oldest first. */
export function readPreToolDecisions(path: string): PreToolDecision[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // The hook never ran, or the directory is already gone.
    return [];
  }
  const decisions: PreToolDecision[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      decisions.push(JSON.parse(line) as PreToolDecision);
    } catch {
      // A torn append. The call it described falls back to the second reading.
    }
  }
  return decisions;
}

/**
 * What the hook prints, in the shape the binary parses.
 *
 * `null` is the third answer: printing nothing and exiting 0 is how a hook says
 * it has no opinion, and the agent's own permission layer then decides.
 */
export interface PreToolResponse {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason: string;
  };
}

/** The tool call as the hook receives it on stdin. */
export interface PreToolCall {
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  /**
   * Present on a subagent's call and absent on the top-level session's: the
   * agent's own id, and the role it was started from (ADR-0038). The id keys
   * the agent's state and the role is what the record names.
   */
  agent_id?: string;
  agent_type?: string;
}

/** A subagent whose payload carried an id but no role name to quote back. */
const UNNAMED_SUBAGENT = "a subagent";

/**
 * Which agent made this call: the role for a subagent's, null for the session's.
 *
 * A subagent's payload carries `agent_id` and `agent_type`, and the top-level
 * session's carries neither (ADR-0038, 2026-09-12). Either one present is read
 * as a subagent, so a payload carrying only the id is not taken for the
 * session's — the id is what says whose call it is and the role is only the
 * name a person reads.
 */
function callerOf(call: PreToolCall): string | null {
  if (typeof call.agent_type === "string" && call.agent_type.length > 0) return call.agent_type;
  return call.agent_id === undefined ? null : UNNAMED_SUBAGENT;
}

/**
 * Verbs with no effect the guard has not already judged.
 *
 * `cd` and its family move the shell, which is SCP-170's tracking and decides
 * the *next* line's relative targets rather than this one. `echo` and `printf`
 * write only where a redirect points, and the redirect's target has already
 * been resolved by the time this is read. `pwd` prints where the shell stands.
 * `true`, `false` and `:` do nothing at all.
 *
 * They are not on the `--allowedTools` list and must not be: that list is
 * matched by prefix, so `Bash(cd:*)` on it would admit `cd x && rm -rf /`
 * whole. Here each segment is judged as itself.
 *
 * `echo` and `printf` earn their place because their only write is the
 * redirect. A program that acts on its own does not — `curl -o` writes without
 * one, and is on the deny-list.
 */
export const EFFECT_FREE_VERBS = new Set(["cd", "pushd", "popd", "pwd", "echo", "printf", "true", "false", ":"]);

/**
 * Whether the runner has positive grounds to admit this line, or nothing to say.
 *
 * Grounds means at least one command on the line is one the guard judged — a
 * verb that writes to a path it names, or one whose effects are already
 * accounted for — and no command on it is one the guard has not judged and the
 * allow-list does not carry. `mkdir -p a && script -q /dev/null node x.js`
 * therefore has nothing to say: the `mkdir` is vouched for and the `script` is
 * not, and vouching for the line would admit both.
 */
function vouchesFor(
  segments: readonly CommandSegment[],
  allow_list: readonly string[],
): boolean {
  let grounds = false;
  for (const segment of everySegment(segments)) {
    // A segment the reader could not account for runs something it could not
    // name, which is no ground to vouch for anything.
    if (!segment.accounted) return false;
    if (segment.mutating) {
      grounds = true;
      continue;
    }
    // A segment that runs no program — `done`, `fi`, a bare assignment, a
    // redirect the resolver already placed — decides nothing on its own.
    if (segment.programs.length === 0) continue;
    if (segment.programs.every((program) => EFFECT_FREE_VERBS.has(program))) {
      grounds = true;
      continue;
    }
    if (allow_list.some((entry) => matchesListEntry(entry, "Bash", segment.text))) continue;
    return false;
  }
  return grounds;
}

/**
 * The judgement, and where it leaves the shell.
 *
 * `next_cwd` is only ever the answer for an **admitted** call: a refused call
 * does not run, so the `cd` on it never happened and the shell is where it was.
 * That is the one thing the pre-execution reading knows and the transcript
 * reading cannot, because before this hook existed a refused command had
 * already executed by the time the runner read it.
 */
export function judgePreToolCall(
  call: PreToolCall,
  state: PreToolGuardState,
  at: Date,
): { decision: PreToolDecision; next_cwd: string } {
  const tool = call.tool_name ?? "unknown";
  const input = call.tool_input ?? {};
  const scope = {
    root: state.root,
    ...(state.tmpdir === null ? {} : { tmpdir: state.tmpdir }),
    // The same globs the transcript reading is handed, from the one state the
    // adapter wrote: two readings of one contract cannot disagree about it.
    paths_allowed: state.paths_allowed ?? [],
    paths_prohibited: state.paths_prohibited ?? [],
    spec_folder: state.spec_folder ?? null,
    spec_folder_writable: state.spec_folder_writable === true,
  };

  /**
   * A tool this guard was not built for gets no answer at all.
   *
   * The matcher installs it for the five that write and for the one that
   * starts a subagent, so in an attempt nothing else reaches here. But the
   * function is called directly by tests and by anything that later reuses it,
   * and its file-tool branch reads `file_path` — which `Read` also carries, so
   * a `Read` outside the worktree came back `write_outside_worktree`, refusing
   * a read on a rule about writes. The runner has no rule for a tool it does
   * not judge, and `--disallowedTools` still refuses the ones the profile
   * names.
   */
  if (!(PRE_TOOL_HOOKED_TOOLS as readonly string[]).includes(tool)) {
    return {
      decision: {
        tool_use_id: call.tool_use_id ?? "",
        tool,
        answer: "defer",
        decision: "allowed",
        rule: null,
        target: null,
        reason: null,
        cwd: null,
        agent: call.agent_type ?? null,
        at: at.toISOString(),
      },
      next_cwd: state.cwd,
    };
  }

  /**
   * The call that starts a subagent (D-106 criterion 1).
   *
   * Judged on the role it names and on who is asking, and on nothing else:
   * there is no path to resolve and no command to read, only a name that is a
   * member of the attempt's closed set or is not, and a payload that came from
   * a subagent or from the session. The refusal has to happen here rather than
   * at the seal, because a subagent refused after it started has already read
   * the repository under a definition nobody approved.
   */
  if (isSubagentTool(tool)) {
    const admission = judgeSubagentStart(tool, input, state.agent_roles ?? [], callerOf(call));
    return {
      decision: {
        tool_use_id: call.tool_use_id ?? "",
        tool,
        // Admitted is not vouched for: the tool is on the invocation's own
        // allow-list under both names, and the guard's business is which
        // role it names.
        answer: admission.decision === "denied" ? "deny" : "defer",
        decision: admission.decision,
        rule: admission.rule,
        target: admission.target,
        reason: admission.reason,
        cwd: null,
        agent: call.agent_type ?? null,
        at: at.toISOString(),
      },
      next_cwd: state.cwd,
    };
  }

  if (tool === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    const { admission, inspection } = judgeCommand({
      tool,
      detail: command,
      allow_list: state.allow_list,
      deny_list: state.deny_list,
      scope: { ...scope, cwd: state.cwd },
    });
    const refused = admission.decision === "denied";
    const answer: PreToolAnswer = refused
      ? "deny"
      : vouchesFor(inspection.segments, state.allow_list)
        ? "allow"
        : "defer";
    return {
      decision: {
        tool_use_id: call.tool_use_id ?? "",
        tool,
        answer,
        decision: admission.decision,
        rule: admission.rule,
        target: admission.target,
        reason: admission.reason,
        cwd: inspection.cwd.relative,
        agent: call.agent_type ?? null,
        at: at.toISOString(),
      },
      // Only a call that runs moves the shell. A refused `cd` never happened,
      // and a deferred one may or may not have — the agent's layer decides
      // that, and the runner does not learn the answer until the result
      // envelope, so it follows the line rather than pretending to know.
      next_cwd: refused
        ? state.cwd
        : inspection.cwd.unknown
          ? UNKNOWN_CWD
          : (inspection.cwd.path ?? state.root),
    };
  }

  // A file tool is not a shell line: it names one absolute path and runs
  // wherever the agent process is. What SCP-161's third criterion asks for is
  // that path put through the same resolver a redirect target goes through,
  // before the write rather than at the seal.
  const path = filePath(input);
  const { admission } = judgeCommand({
    tool,
    detail: path === null ? tool : `${tool} ${path}`,
    allow_list: state.allow_list,
    deny_list: state.deny_list,
    scope,
    ...(path === null ? {} : { path }),
  });
  return {
    decision: {
      tool_use_id: call.tool_use_id ?? "",
      tool,
      // A path inside the worktree is not something to vouch for: the agent's
      // own layer carries `Write` and `Edit` and decides them as it always has.
      // The guard is here for the path that leaves the worktree.
      answer: admission.decision === "denied" ? "deny" : "defer",
      decision: admission.decision,
      rule: admission.rule,
      target: admission.target,
      reason: admission.reason,
      cwd: null,
      agent: call.agent_type ?? null,
      at: at.toISOString(),
    },
    next_cwd: state.cwd,
  };
}

/** The path a file tool writes to, under whichever name that tool uses. */
function filePath(input: Record<string, unknown>): string | null {
  for (const name of ["file_path", "notebook_path"]) {
    const value = input[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** The refusal the hook prints when it cannot judge at all. */
export function failClosed(reason: string): PreToolResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/**
 * One hook invocation: read the state, judge, record, answer.
 *
 * Every failure answers `deny`. A hook that throws exits non-zero, and Claude
 * Code treats a non-zero exit other than 2 as a non-blocking error and runs the
 * tool anyway — so an exception here would be a guard that fails open.
 */
export function runPreToolHook(
  directory: string,
  stdin: string,
  at = new Date(),
): PreToolResponse | null {
  let attempt: PreToolGuardState;
  let call: PreToolCall;
  try {
    attempt = JSON.parse(readFileSync(join(directory, STATE_FILE), "utf8")) as PreToolGuardState;
    call = JSON.parse(stdin) as PreToolCall;
  } catch (error) {
    return failClosed(
      `the runner's write guard could not read its own state, so nothing is admitted: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // The attempt's contract, with this agent's own directory standing in for
  // the one the attempt started every agent at (D-106 criterion 2). An agent
  // the guard cannot place gets no judgement at all.
  const standing = readAgentState(directory, call, attempt);
  if (!standing.placed) {
    // The read door: the guard does not know where this agent is, so no
    // relative target can be judged and `cwd` is unknown rather than a guess.
    const who = call.agent_type ?? "the executor's session";
    return refuseAgentDirectoryUnknown(
      directory,
      call,
      {
        reason:
          `the runner's write guard cannot say where ${who} stands: ${standing.cause}. Judging a ` +
          "relative target from the directory the attempt started it at would admit a write " +
          "against a directory its shell has left",
        cwd: UNKNOWN_CWD,
      },
      at,
    );
  }
  const agent = standing.state;
  const state: PreToolGuardState = { ...attempt, cwd: agent.cwd };

  let judged: ReturnType<typeof judgePreToolCall>;
  try {
    judged = judgePreToolCall(call, state, at);
  } catch (error) {
    return failClosed(
      `the runner's write guard could not judge this call: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (judged.next_cwd !== agent.cwd) {
    // This agent's file and no other's, so two agents' hook processes never
    // write the same bytes and an interleaved pair cannot lose one another's
    // move. Replaced rather than rewritten in place, so a reader never sees
    // half of it.
    //
    // A failure here is refused rather than swallowed, and it is the same fact
    // as a file that will not read back: this call moves the agent, and if the
    // move cannot be recorded then the next call reads the directory recorded
    // before it — or no file, which is the root — and judges its relative
    // target from there while the shell stands somewhere else. Refusing means
    // the agent does not move at all, so what its file says stays true.
    try {
      const path = agentStateFile(directory, call.agent_id);
      const next: PreToolAgentState = { agent: agent.agent, cwd: judged.next_cwd };
      replaceFile(path, JSON.stringify(next));
    } catch (error) {
      // The write door says the other true thing, and neither sentence is the
      // other's: here the guard knows exactly where this agent stands — it is
      // still at `agent.cwd`, because refusing the call is what keeps it there
      // — and what it cannot do is record where the call would take it. The
      // reason reaches the executor's own model as `permissionDecisionReason`,
      // so telling it the shell has left a directory it has not would be a
      // false account of why its call was refused.
      const who = call.agent_type ?? "the executor's session";
      return refuseAgentDirectoryUnknown(
        directory,
        call,
        {
          reason:
            `the runner's write guard could not record where this call moves ${who} ` +
            `(${causeOf(error)}), so the move is refused and that agent stays where it is. ` +
            "Allowing it would leave the guard judging that agent's next relative target from " +
            "a directory its shell had left",
          // Relative to the worktree root, as every decision's directory is and
          // as the attempt's command record, which this becomes, defines it.
          cwd: describeShellCwd({ root: state.root, cwd: agent.cwd }).relative,
        },
        at,
      );
    }
  }
  try {
    appendFileSync(join(directory, DECISIONS_FILE), `${JSON.stringify(judged.decision)}\n`, "utf8");
  } catch {
    // The decision stands whether or not the runner can read it back. Losing
    // the record must not turn a refusal into an admission.
  }

  if (judged.decision.answer === "defer") return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: judged.decision.answer === "allow" ? "allow" : "deny",
      permissionDecisionReason:
        judged.decision.reason ??
        "every target the runner's guard found is inside the attempt's worktree",
    },
  };
}

/** The rules a decision can name, re-exported so a reader of a record has one import. */
export { ADMISSION_RULES };
