import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  invocationShapeHash,
  type AgentInvocation,
  type AttemptCostBasis,
  type BriefReinjection,
  type CommandRecord,
  type NeutralisationRecord,
  type PermissionProfile,
  type TerminationReason,
} from "@perbo/contracts";
import { PRICED_MODEL_ID, costMicros as providerListCostMicros } from "@perbo/model";
import {
  DEFAULT_SUSPEND_INTERVAL_MS,
  DEFAULT_SUSPEND_THRESHOLD_MS,
  SuspendDetector,
} from "@perbo/workspace";
import { ADMISSION_RULES, judgeCommand } from "./admission.js";
import {
  agentsFlagValue,
  PERBO_AGENT_ROLE_NAMES,
  PERBO_AGENT_ROLES,
  isSubagentTool,
  judgeSubagentStart,
  subagentRoleOf,
} from "./agents.js";
import { readReinjections, type BriefRecords } from "./brief.js";
import type { AttemptCeilings, CeilingBreach } from "./ceilings.js";
import { EgressLog } from "./egress.js";
import {
  discardPreToolGuard,
  preparePreToolGuard,
  prepareUnguardedSettings,
  readPreToolDecisions,
} from "./pretool.js";
import {
  UNKNOWN_CWD,
  inspectToolWrite,
  type ProhibitedHit,
  type ShellCwd,
} from "./prohibited.js";
import { DEFAULT_AGENT_TOOLS } from "./profile.js";
import { prepareScratchDirectory, scratchEnvironment } from "./scratch.js";
import { describeTransportFailure, transportExhaustion } from "./transport.js";

/**
 * The one coding-agent adapter (D-009, SCP-017, ADR-0030).
 *
 * There is one, and there is no interface above it, because D-009 says the
 * capability-negotiation contract is extracted in M2 **when a second adapter
 * exists to constrain its shape** — not designed speculatively before the first
 * one ships. What is here instead is the thing a second adapter would have to
 * match: an argv that is built rather than assembled ad hoc, recorded on the
 * attempt, and asserted against.
 *
 * ## The invocation shape, and why each flag is in it
 *
 * | flag | what it closes |
 * |---|---|
 * | `--setting-sources user` | project `settings.json` and `.mcp.json` are not read (ADR-0030 req 1), and subscription login survives, which `--bare` does not (D-009) |
 * | `--strict-mcp-config --mcp-config {}` | no tool server from any source, which is threat 18 |
 * | `--settings <the attempt's settings file>` | the runner's own two hooks — the write guard before a tool, the brief again after a compaction — and no hook from any other source, which is threat 17 |
 * | `--disable-slash-commands` | every skill, measured off with this flag alone |
 * | `CLAUDE_CODE_DISABLE_CLAUDE_MDS`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | instruction files and the auto-memory directory |
 * | `--permission-mode manual` + allow/deny lists | the command allow-list, enforced rather than requested |
 * | `--agents <roles>` | the subagent roles Perbo defines, and the only ones the guard admits a call to `Agent` (or `Task`) for (D-106) |
 * | `--no-session-persistence` | no transcript left in the user's session store |
 *
 * `--max-budget-usd` is not among them. The flag is chosen before the executor
 * has said what it authenticated with, and D-096 keeps a cost cap only where
 * it is billed per token, so the runner's own counter is the cap: it reads the
 * charge the transport reports on each event and stops at the first past it.
 *
 * ## Why `--safe-mode` is no longer among them (SCP-177)
 *
 * It turned off hooks, and the runner's write guard is a hook. Measured against
 * the pinned binary: with `--safe-mode` a `PreToolUse` hook delivered through
 * `--settings` never fires and a tool server named in `--mcp-config` is never
 * connected, so **no** mechanism decides a tool call before it runs. Without
 * it, the hook fires, its `deny` stops the call and its `allow` runs a verb the
 * `--allowedTools` list does not carry.
 *
 * What the flag closed is closed by name instead, and what it closed that the
 * named flags do not is user-scoped rather than repository-supplied: plugin
 * subagents on the user's own machine, which the write guard refuses by name
 * when the executor tries to start one (D-106). Measured against a worktree
 * committing a hostile `.claude/settings.json` hook, a `.mcp.json`, a
 * `.claude/agents/` entry and a `CLAUDE.md`: none of the four loaded. The
 * probes are in `docs/08`.
 *
 * And three flags that are **never** passed: `--add-dir` loads skills from an
 * added directory even under `--bare`; `--plugin-dir` and `--plugin-url` are
 * the same channel by another name. Their absence is asserted, not remembered.
 */

export const ADAPTER_NAME = "claude-code";

/**
 * What `--safe-mode` used to close and no flag does (SCP-177).
 *
 * `--setting-sources user` already keeps the repository's `settings.json` and
 * `.mcp.json` out, `--strict-mcp-config` keeps its `.mcp.json` out a second
 * time, and `--disable-slash-commands` turns off every skill. What was left
 * once `--safe-mode` came off was the instruction files a working directory is
 * searched for and the auto-memory directory, and these two names close both.
 *
 * Set on the child rather than allow-listed, alongside the scratch directory
 * and for the same reason: a value the runner's own environment carried must
 * not be able to reopen either.
 */
export const CUSTOMIZATION_CLOSURES: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
});

export const FORBIDDEN_FLAGS = [
  "--add-dir",
  "--plugin-dir",
  "--plugin-url",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
] as const;

export interface AgentRequest {
  binary: string;
  worktree: string;
  /** Built from the plan. No repository content reaches it. */
  prompt: string;
  /**
   * The round's records, from which the state block of a re-injected brief is
   * composed after a compaction (D-096). The recorded brief is `prompt`
   * itself. Omitted, no brief is recorded for the attempt and a compaction
   * gets nothing back.
   */
  brief_records?: BriefRecords;
  model: string;
  profile: PermissionProfile;
  ceilings: AttemptCeilings;
  env: NodeJS.ProcessEnv;
  /**
   * The globs the approved contract admits a write under (SCP-195). They reach
   * both readings from here — the hook's state file and the transcript
   * reading's scope — so the two cannot hold different contracts. Omitted
   * admits everything inside the worktree, which is what a caller with no
   * contract to hand gets.
   */
  paths_allowed?: readonly string[];
  /**
   * The paths the approved contract prohibits a write to (D-105). They reach
   * both readings from here beside the globs above, and are judged before them:
   * a prohibited path inside the admitted ones is refused all the same.
   */
  paths_prohibited?: readonly string[];
  /**
   * Where this repository keeps its specs, from `.perbo/config.json` (D-103).
   * Prohibited whatever the contract says, beside the default `specs/`.
   */
  spec_folder?: string | null;
  tools?: readonly string[];
  onProgress?: (message: string) => void;
  /** Redacts a line against the attempt's materialized secrets before recording it. */
  redact?: (text: string) => string;
  /** Injected by the test that proves a suspend terminates an attempt. */
  clock?: () => number;
  /**
   * The program the `PreToolUse` hook runs, as argv without the guard's
   * directory, which is appended. Only the test that stands a different
   * judgement in the hook's place passes it; nothing a model returned can
   * reach it.
   */
  hookProgram?: readonly string[];
  /**
   * Who decides this agent's tool calls (SCP-228).
   *
   * `runner_guard`, the default, is the executor: the runner's `PreToolUse`
   * hook answers every call before it runs, and a prohibited action read out
   * of the transcript ends the attempt.
   *
   * `agent_permissions` is the registered direct-agent arm, which runs under
   * the permissions a person gives Claude Code for ordinary work. No hook of
   * the runner's is installed and no prohibited-action list is applied — the
   * arm pushes its own branch and opens its own pull request, and both are
   * prohibited actions for the executor. Everything else is unchanged: the
   * environment reaching the process is still the caller's to scrub, the
   * ceilings still terminate, the commands are still recorded, the egress log
   * still observes every host, and repository configuration is still asserted
   * not to have loaded. What is dropped is every runner-side termination that
   * judges the arm's work rather than its budget.
   */
  supervision?: "runner_guard" | "agent_permissions";
}

export interface AgentResult {
  invocation: AgentInvocation;
  commands: CommandRecord[];
  egress: EgressLog;
  prohibited: Array<ProhibitedHit & { at: string }>;
  usage: {
    input_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens: number;
    output_tokens: number;
    cost_micros: number;
    cost_basis: AttemptCostBasis;
    /**
     * The attempt was stopped before the transport wrote its final accounting
     * line, so these are the running sums from the messages already read.
     */
    cost_partial: boolean;
    iterations: number;
  };
  termination: { reason: TerminationReason; detail: string };
  /**
   * The text of the agent's last assistant message, redacted (D-092).
   *
   * The executor's brief asks it to end with an account of its change, and
   * this is where that account is read from; the loop seals it onto the
   * attempt and briefs the ticket's next remediation round with it. Null where
   * the agent produced no assistant text at all — a run a ceiling cut before
   * it spoke, or a transport that never answered.
   */
  final_message: string | null;
  /** Raw stream-json lines, redacted. The bundle decides whether to retain them. */
  transcript: string[];
  /**
   * Every time this attempt's brief went back after a compaction (D-096), as
   * the mechanism that carried it recorded them. Absent where the adapter
   * records none.
   */
  reinjections?: BriefReinjection[];
}

export class AgentConfigurationPresentError extends Error {
  readonly reported: NeutralisationRecord["reported"];

  constructor(message: string, reported: NeutralisationRecord["reported"]) {
    super(message);
    this.name = "AgentConfigurationPresentError";
    this.reported = reported;
  }
}

/** The prompt sits at a known index so the shape hash can exclude it. */
export function buildArgv(request: {
  worktree: string;
  prompt: string;
  model: string;
  profile: PermissionProfile;
  tools?: readonly string[];
  /**
   * The attempt's own settings file: the runner's two hooks and nothing else
   * (SCP-177, D-096). It is the only settings source the invocation names, so
   * it is also what keeps every other hook out.
   */
  settingsPath: string;
}): { argv: string[]; promptIndexes: number[] } {
  const tools = [...(request.tools ?? DEFAULT_AGENT_TOOLS)];
  const argv = [
    "-p",
    request.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    "user",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--settings",
    request.settingsPath,
    "--disable-slash-commands",
    "--permission-mode",
    "manual",
    "--tools",
    tools.join(","),
    "--allowedTools",
    request.profile.command_allow_list.join(","),
    "--disallowedTools",
    request.profile.command_deny_list.join(","),
    "--model",
    request.model,
    // The roles the executor may start a subagent from (D-106). Passing them
    // is half the enforcement: the guard's hook refuses a `subagent_type`
    // outside this set, so a definition from the repository or from the
    // person's own machine cannot be started even where Claude Code offers it.
    "--agents",
    agentsFlagValue(PERBO_AGENT_ROLES),
    "--no-session-persistence",
  ];
  return { argv, promptIndexes: [1] };
}

/**
 * ADR-0030 requirement 3, as strongly as it can honestly be stated.
 *
 * The ADR asks the runner to "assert the set is empty". Measured against Claude
 * Code 2.1.247, no invocation that preserves subscription login produces an
 * empty set: `--safe-mode` clears user skills, subagents and auto-memory, and
 * still reports an installed plugin. Asserting global emptiness would refuse to
 * run on any developer machine with a plugin, and would be asserting something
 * the threat model does not need.
 *
 * So the assertion is **nothing loaded originates in the repository**: no tool
 * server at all, and nothing whose path resolves inside the worktree. The
 * measurement behind that narrowing is in the Stage 2 result, and ADR-0030 is
 * amended to match rather than left saying something the code does not do.
 */
export function assertNeutralised(
  init: Record<string, unknown>,
  worktree: string,
): NeutralisationRecord["reported"] {
  // Both forms, because on macOS `/var` is a symlink to `/private/var`: an
  // agent reports the path it was given and the runner knows the resolved one,
  // and comparing only one of them lets configuration inside the worktree pass.
  const roots = new Set<string>([resolve(worktree)]);
  try {
    roots.add(realpathSync(resolve(worktree)));
  } catch {
    // The worktree is gone; the unresolved form is all there is to compare.
  }

  const names = (value: unknown, key: string): string[] => {
    if (!Array.isArray(value)) return [];
    return value.map((entry) => {
      if (typeof entry === "string") return entry;
      const record = entry as Record<string, unknown>;
      return String(record[key] ?? record.name ?? JSON.stringify(record));
    });
  };
  const paths = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => (typeof entry === "object" && entry ? String((entry as Record<string, unknown>).path ?? "") : ""))
      .filter((path) => path.length > 0);
  };

  const memoryPaths = Object.values(
    (init.memory_paths as Record<string, string> | null | undefined) ?? {},
  ).filter((path): path is string => typeof path === "string");

  const reported: NeutralisationRecord["reported"] = {
    mcp_servers: names(init.mcp_servers, "name"),
    plugins: names(init.plugins, "name"),
    skills: names(init.skills, "name"),
    subagents: names(init.agents, "name"),
    memory_paths: memoryPaths,
  };

  const inside = (path: string) => {
    const resolved = resolve(path);
    return [...roots].some((root) => resolved === root || resolved.startsWith(root + sep));
  };

  const violations: string[] = [];
  if (reported.mcp_servers.length > 0) {
    violations.push(`tool servers were connected: ${reported.mcp_servers.join(", ")}`);
  }
  const errors = init.mcp_server_errors;
  if (Array.isArray(errors) && errors.length > 0) {
    violations.push(`tool servers were attempted and failed: ${JSON.stringify(errors).slice(0, 200)}`);
  }
  for (const path of [...paths(init.plugins), ...memoryPaths]) {
    if (inside(path)) violations.push(`configuration loaded from inside the worktree: ${path}`);
  }

  if (violations.length > 0) {
    throw new AgentConfigurationPresentError(
      `repository-supplied agent configuration reached the agent process: ${violations.join("; ")}`,
      reported,
    );
  }
  return reported;
}

function binaryFingerprint(binary: string): { path: string; version: string; sha256: string } {
  const path = (() => {
    try {
      return execFileSync("which", [binary], { encoding: "utf8" }).trim() || binary;
    } catch {
      return binary;
    }
  })();
  const version = (() => {
    try {
      return execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 30_000 }).trim();
    } catch {
      return "unknown";
    }
  })();
  const sha256 = (() => {
    try {
      return createHash("sha256").update(readFileSync(realpathSync(path))).digest("hex");
    } catch {
      // A launcher script that resolves to a directory, or a binary this
      // process cannot read. Recorded as absent rather than as a wrong hash.
      return "0".repeat(64);
    }
  })();
  return { path, version, sha256 };
}

interface StreamUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface CountedStreamUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

interface StreamAssistantMessage {
  id?: string;
  content?: Array<{ type?: string; id?: string; name?: string; input?: unknown; text?: string }>;
  usage?: StreamUsage;
}

const ZERO_STREAM_USAGE: CountedStreamUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/** Token counts cross a process boundary, so malformed values count as absent. */
function countedStreamUsage(value: unknown): CountedStreamUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const valid = (candidate: unknown): candidate is number =>
    typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0;
  if (
    !Object.keys(ZERO_STREAM_USAGE).some((field) =>
      valid(record[field as keyof CountedStreamUsage]),
    )
  ) {
    return null;
  }
  const count = (field: keyof CountedStreamUsage): number => {
    const candidate = record[field];
    return valid(candidate) ? candidate : 0;
  };
  return {
    input_tokens: count("input_tokens"),
    output_tokens: count("output_tokens"),
    cache_read_input_tokens: count("cache_read_input_tokens"),
    cache_creation_input_tokens: count("cache_creation_input_tokens"),
  };
}

function addStreamUsage(a: CountedStreamUsage, b: CountedStreamUsage): CountedStreamUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens:
      a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  };
}

/** `Bash` carries a command; everything else is described by its input. */
function describeTool(name: string, input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>;
  if (name === "Bash" && typeof record.command === "string") return record.command;
  if (typeof record.file_path === "string") return `${name} ${record.file_path}`;
  return `${name} ${JSON.stringify(record).slice(0, 300)}`;
}

export async function runAgent(request: AgentRequest): Promise<AgentResult> {
  const progress = request.onProgress ?? (() => undefined);
  const redact = request.redact ?? ((text: string) => text);

  // SCP-166: the executor gets a temporary directory before it starts, inside
  // the worktree and out of the seal. The path is the runner's, from the
  // worktree it provisioned; the guard below is told about it so `$TMPDIR`
  // resolves rather than being refused as an unreadable variable.
  const scratch = prepareScratchDirectory(request.worktree);

  /**
   * The write guard, installed before the process starts (SCP-177), and the
   * brief a compaction gets back beside it (D-096).
   *
   * Their settings file is the only one the invocation names, so the same
   * argument that installs the runner's two hooks is what keeps every other
   * hook out. Its state directory is outside the worktree, which is what makes it
   * unwritable by the executor: a write to it is a write outside the root, and
   * refusing those is what the guard does.
   */
  const supervision = request.supervision ?? "runner_guard";
  const guard =
    supervision === "runner_guard"
      ? preparePreToolGuard({
          worktree: request.worktree,
          tmpdir: scratch,
          profile: request.profile,
          paths_allowed: request.paths_allowed ?? [],
          paths_prohibited: request.paths_prohibited ?? [],
          ...(request.spec_folder ? { spec_folder: request.spec_folder } : {}),
          ...(request.hookProgram ? { hookProgram: request.hookProgram } : {}),
          // D-096: the round's brief, where the settings file installs the
          // hook that gives it back. The direct-agent arm below installs no
          // hook of the runner's, so it records none either.
          ...(request.brief_records
            ? { brief: { text: request.prompt, records: request.brief_records } }
            : {}),
        })
      : prepareUnguardedSettings();

  const { argv, promptIndexes } = buildArgv({
    worktree: request.worktree,
    prompt: request.prompt,
    model: request.model,
    profile: request.profile,
    settingsPath: guard.settingsPath,
    ...(request.tools ? { tools: request.tools } : {}),
  });

  for (const flag of FORBIDDEN_FLAGS) {
    if (argv.includes(flag)) {
      discardPreToolGuard(guard);
      throw new Error(`invocation contains ${flag}, which reopens the channel ADR-0030 closes`);
    }
  }

  /**
   * Where the executor's shell stands (SCP-170).
   *
   * The Bash tool keeps one shell whose working directory persists between tool
   * calls, so a `cd` in one call is what the next call's relative paths resolve
   * against. The runner reads the move out of the command text with its own
   * resolver — nothing a model returned becomes the directory — and judges the
   * next Bash line from there. Only a move the calling shell keeps counts: not
   * one made in a subshell, a pipeline stage, a backgrounded command, or a
   * shell `sh -c` spawned and let die.
   *
   * The runner does not see exit codes here, so a `cd` the real shell rejected
   * is applied anyway: the tracked directory is where the line said it was
   * going. A `cd` to a directory that does not exist walks cleanly and is
   * tracked; the resolver refuses only a path it cannot walk at all — a
   * component under a plain file, or one under a directory this process may not
   * read — and refusing marks the directory unknown.
   */
  const START: ShellCwd = { path: request.worktree, unknown: false, relative: "." };
  /**
   * One per agent, because each of them has its own Bash session (D-106).
   * Keyed by the id of the subagent-starting call, which is unique per
   * subagent where its role is not, and by the empty string for the
   * executor's own session. A shared entry would judge one agent's relative
   * path from another's directory and raise a prohibited-action hit against a
   * write that never left the worktree.
   */
  const shells = new Map<string, ShellCwd>();
  const shellKeyOf = (event: Record<string, unknown>): string =>
    typeof event.parent_tool_use_id === "string" ? event.parent_tool_use_id : "";

  const fingerprint = binaryFingerprint(request.binary);
  const egress = new EgressLog(request.profile.network_allow_list);
  const commands: CommandRecord[] = [];
  /**
   * The decisions already made for each command the agent asked for, by
   * sequence number and in the order it asked.
   *
   * A tool call is decided once. The runner judges every one it reads, and the
   * agent's own permission layer reports its refusals again in the result
   * envelope at the end of the run — the same act arriving from two hooks.
   * AYO-13 recorded both, so every command of the attempt appeared twice, once
   * `allowed` and once `denied`, and a reader counting rows counted a refusal
   * as two decisions and an admission that never happened (SCP-163). The second
   * report amends the entry the first one made rather than adding a row.
   *
   * The queue is per command text and holds one entry per call, because an
   * agent that ran the same line twice made two calls and earned two decisions:
   * each reported refusal amends the oldest of them not yet amended, so a
   * command refused twice is two `denied` rows rather than one.
   */
  const decidedAt = new Map<string, number[]>();
  const decisionKey = (tool: string, detail: string) => `${tool}\u0000${detail}`;
  const decided = (tool: string, detail: string, sequence: number) => {
    const key = decisionKey(tool, detail);
    const queue = decidedAt.get(key);
    if (queue === undefined) decidedAt.set(key, [sequence]);
    else queue.push(sequence);
  };
  /** The oldest decision for this command that no reported refusal has claimed. */
  const claimDecision = (tool: string, detail: string): number | undefined =>
    decidedAt.get(decisionKey(tool, detail))?.shift();
  /**
   * The record each `tool_use` block made, by the id the hook also sees.
   *
   * The two readings of one call meet here. The hook's runs first and is the
   * one the agent obeyed; the block arrives in the stream before the hook has
   * written anything, so the join happens once the run is over rather than as
   * each block is read.
   */
  const recordOfToolUse = new Map<string, number>();
  const reconciled = new Set<string>();
  /**
   * The role each subagent was started from, by the id of the subagent-starting
   * call that started it — named `Agent`, or `Task` under its former name (D-106).
   *
   * A subagent's `assistant` and `user` events carry `parent_tool_use_id`, the
   * id of that call (ADR-0038) — so the stream says which agent made a tool
   * call, but only by way of the call that started it. The role comes from the
   * block's own `subagent_type`, which the runner reads as it goes past.
   */
  const roleOfTask = new Map<string, string>();
  /**
   * Which agent an event belongs to: the role for a subagent's, and null for
   * the top-level session's. A `parent_tool_use_id` the runner never saw the
   * starting block for is still not the session — the id itself says a
   * subagent made it, so it is named by that id rather than recorded as the
   * executor's.
   */
  const agentOf = (event: Record<string, unknown>): string | null => {
    const parent = event.parent_tool_use_id;
    if (typeof parent !== "string" || parent.length === 0) return null;
    return roleOfTask.get(parent) ?? parent;
  };
  /**
   * Prohibited actions read out of a `tool_use` block, held until the guard's
   * answer for that call is known (SCP-177).
   *
   * A hit used to end the attempt the moment it was read, and that was right
   * when the only reading was after the fact: the act had happened. Now the
   * guard may have refused the same call before it ran, and terminating an
   * attempt for a write that never occurred is the false positive SCP-156
   * exists to have stopped — it cost a $15.25 run once already.
   *
   * The block arrives before the hook runs, and the hook has written by the
   * time the next event arrives, so the answer is one event away and this
   * waits for it rather than polling. A call with no recorded decision — the
   * hook did not fire, or the block carried no id — is treated as not
   * prevented and still ends the attempt.
   */
  const pendingHits: Array<{ hit: ProhibitedHit; at: string; toolUseId: string | undefined }> = [];
  const prohibited: Array<ProhibitedHit & { at: string }> = [];
  const transcript: string[] = [];
  /** D-096: filled from the hook's own file as the guard directory is retired. */
  const reinjections: BriefReinjection[] = [];

  let reported: NeutralisationRecord["reported"] = {
    mcp_servers: [],
    plugins: [],
    skills: [],
    subagents: [],
    memory_paths: [],
  };
  let credentialClass: AgentInvocation["credential_class"] = "unknown";
  let freshInputTokens = 0;
  let inputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let costMicros = 0;
  let costBasis: AttemptCostBasis = "unavailable";
  /**
   * The pinned transport can emit several content blocks for one model
   * request, each repeating that request's usage. The latest reading for each
   * request contributes once; an event with no stable identity is necessarily
   * its own reading.
   */
  const assistantUsage = new Map<string, CountedStreamUsage>();
  let unkeyedAssistantUsage = 0;
  const useAccounting = (usage: CountedStreamUsage): void => {
    freshInputTokens = usage.input_tokens;
    cacheCreationTokens = usage.cache_creation_input_tokens;
    cacheReadTokens = usage.cache_read_input_tokens;
    inputTokens = freshInputTokens + cacheCreationTokens + cacheReadTokens;
    outputTokens = usage.output_tokens;
  };
  const assistantUsageKey = (
    event: Record<string, unknown>,
    message: StreamAssistantMessage,
  ): string => {
    const requestId = typeof event.request_id === "string" ? event.request_id : null;
    const messageId = typeof message.id === "string" ? message.id : null;
    if (requestId !== null) return `request:${requestId}`;
    if (messageId !== null) return `message:${messageId}`;
    unkeyedAssistantUsage += 1;
    return `event:${unkeyedAssistantUsage}`;
  };
  const useAssistantAccounting = (
    event: Record<string, unknown>,
    message: StreamAssistantMessage,
    usage: CountedStreamUsage,
  ): void => {
    assistantUsage.set(assistantUsageKey(event, message), usage);
    useAccounting([...assistantUsage.values()].reduce(addStreamUsage, ZERO_STREAM_USAGE));
  };
  /** Set by the transport's final accounting line, which a stop preempts. */
  let finalAccounting = false;
  /** The last assistant message that carried any text, redacted (D-092). */
  let finalMessage: string | null = null;
  let termination: { reason: TerminationReason; detail: string } = {
    reason: "completed",
    detail: "",
  };
  let terminated = false;

  const child = spawn(request.binary, argv, {
    cwd: request.worktree,
    // The three temporary-directory names are the runner's last, so a value the
    // caller inherited from the host cannot reach the agent.
    env: { ...request.env, ...CUSTOMIZATION_CLOSURES, ...scratchEnvironment(scratch) },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    // Its own process group, so terminating the attempt terminates what the
    // agent spawned as well. Signalling only the agent leaves a long-running
    // child holding the output pipes, and the attempt never finishes closing —
    // which turns every ceiling into a hang rather than a stop.
    detached: true,
  });

  /** Signal the whole group, falling back to the child if the group is gone. */
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      // ESRCH: already gone, which is the outcome we wanted.
      try {
        child.kill(sig);
      } catch {
        // Nothing left to signal.
      }
    }
  };

  const stop = (reason: TerminationReason, detail: string) => {
    if (terminated) return;
    terminated = true;
    termination = { reason, detail };
    progress(`terminating: ${reason} — ${detail}`);
    signal("SIGTERM");
    setTimeout(() => signal("SIGKILL"), 2_000).unref();
  };

  // The desktop signals the runner's process group; the detached executor has
  // its own. Keep the runner alive long enough to stop it and seal cancellation.
  const cancel = (): void => stop("cancelled", "Stopped by the user");
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);

  const breach = (found: CeilingBreach | null) => {
    if (found) stop(found.reason, found.detail);
  };

  /** Price the accounting read so far only where this exact model has a card. */
  const noteProviderListEstimate = (): void => {
    if (costBasis === "transport_reported" || request.model !== PRICED_MODEL_ID) return;
    costMicros = providerListCostMicros({
      input_tokens: freshInputTokens,
      cache_creation_input_tokens: cacheCreationTokens,
      cache_read_input_tokens: cacheReadTokens,
      output_tokens: outputTokens,
    });
    costBasis = "provider_list_estimate";
    breach(request.ceilings.noteCostMicros(costMicros));
  };

  const ticker = setInterval(() => breach(request.ceilings.tick()), 1_000);
  ticker.unref();

  /**
   * A closed laptop is a disconnect, not a pause (SCP-079 criterion 9). The
   * model connection, any local service the attempt started and the agent's own
   * assumptions are all stale on resume, and an attempt that carries on
   * produces a transcript with a hole in it. Materialisation has watched for
   * this since Stage 2; the **attempt** did not, which made the criterion a
   * claim about the wrong window.
   */
  const suspend = new SuspendDetector(
    (event) =>
      stop(
        "host_suspended",
        `the host was suspended for ${Math.round(event.gap_ms / 1000)}s mid-attempt`,
      ),
    DEFAULT_SUSPEND_INTERVAL_MS,
    DEFAULT_SUSPEND_THRESHOLD_MS,
    request.clock ?? Date.now,
  );
  suspend.start();

  /**
   * Fold the hook's decisions into the records the stream produced (SCP-177).
   *
   * The hook's answer is the one that happened: a call it refused never ran,
   * and one it admitted ran whatever the outer list said. So its decision
   * replaces the transcript reading's, and where the two differ the record
   * keeps the other one in a sentence — the readings share a resolver, so a
   * difference is a fact about the directory each was judged from, or about the
   * tree changing between them, and a person should see it either way.
   *
   * Idempotent by `tool_use_id`: it runs on the result envelope and again after
   * the process closes, because a terminated attempt has no result envelope.
   */
  const reconcile = () => {
    for (const decision of readPreToolDecisions(guard.decisionsPath)) {
      if (decision.tool_use_id.length === 0 || reconciled.has(decision.tool_use_id)) continue;
      reconciled.add(decision.tool_use_id);
      // The guard said nothing about this call, so the agent's own permission
      // layer decided it and the record must not claim otherwise. What the
      // transcript reading made of it stands, and a refusal by that layer
      // amends it below through the path it always did.
      if (decision.answer === "defer") continue;
      const index = recordOfToolUse.get(decision.tool_use_id);
      if (index === undefined) {
        // The hook judged a call whose block the runner never read: a stream
        // the stop cut short, or a torn line. Recorded rather than dropped.
        commands.push({
          sequence: commands.length,
          tool: decision.tool,
          detail: redact(decision.target ?? decision.tool).slice(0, 2_000),
          decision: decision.decision,
          denial_reason: decision.reason === null ? null : redact(decision.reason),
          denial_rule: decision.rule,
          denial_target: decision.target === null ? null : redact(decision.target).slice(0, 200),
          cwd: decision.cwd,
          decided_by: "pre_execution_hook",
          second_reading: "the runner never read this call's tool_use block",
          // The hook is handed the role directly, so a call whose block the
          // stream never carried is still named.
          agent: decision.agent,
          at: decision.at,
        });
        continue;
      }
      const entry = commands[index]!;
      const disagreed =
        entry.decision !== decision.decision
          ? entry.decision === "denied"
            ? `the transcript reading refused it: ${entry.denial_rule ?? "unknown"} on ` +
              `${entry.denial_target ?? entry.detail.slice(0, 80)}`
            : "the transcript reading admitted it"
          : null;
      commands[index] = {
        ...entry,
        decision: decision.decision,
        denial_reason: decision.reason === null ? null : redact(decision.reason),
        denial_rule: decision.rule,
        denial_target: decision.target === null ? null : redact(decision.target).slice(0, 200),
        // The directory the enforced judgement stood in, which after a refusal
        // is not where the transcript reading thinks the shell went: a refused
        // `cd` never happened.
        cwd: decision.cwd ?? entry.cwd,
        decided_by: "pre_execution_hook",
        second_reading: disagreed,
      };
    }
  };

  /** Whether the guard refused this call, from the decisions it has written. */
  const guardRefused = (toolUseId: string | undefined): boolean => {
    if (toolUseId === undefined) return false;
    const index = recordOfToolUse.get(toolUseId);
    if (index === undefined) return false;
    const entry = commands[index]!;
    return entry.decided_by === "pre_execution_hook" && entry.decision === "denied";
  };

  /**
   * Decide the held hits: keep the ones the guard did not prevent, and of
   * those, end the attempt only for one that shows a write.
   *
   * A `write_outside_worktree` finding has two causes (SCP-234). One placed a
   * destination outside the worktree — a resolved path, a redirect, a writer
   * verb's target — and the attempt ends on it, because those bytes are
   * somewhere they should not be. The other could not classify the program an
   * interpreter was handed: the command is refused and recorded, and nothing
   * about it says a write happened. Ticket 4 read one file inside its own
   * worktree, printed it, and lost the round to the second being treated as
   * the first.
   */
  const settlePendingHits = (): void => {
    if (pendingHits.length === 0) return;
    reconcile();
    for (const held of pendingHits.splice(0)) {
      if (guardRefused(held.toolUseId)) continue;
      if (held.hit.cause === "unreadable_program") continue;
      prohibited.push({ ...held.hit, at: held.at });
      stop("prohibited_action", `${held.hit.action}: ${held.hit.detail}`);
    }
  };

  const handleEvent = (event: Record<string, unknown>, at: Date) => {
    const type = event.type;

    /**
     * Only an event that can only follow the tool is late enough.
     *
     * The tool's result comes back as a `user` message and the next turn as an
     * `assistant` one, and the hook has finished writing before either. The
     * `system` events in between have not: measured on the pinned binary with
     * `--include-hook-events`, a `system` summary is emitted between the hook
     * starting and the hook answering, so settling on one would read the
     * decisions file before the decision was in it and terminate the attempt
     * for a write the guard had just refused.
     */
    if (type === "user" || type === "assistant") settlePendingHits();
    /**
     * A tool result, which is the second half of the tool activity the stall
     * detector watches for (D-096). The executor's prompt arrives as argv, so
     * every `user` event on this stream is a tool answering.
     */
    if (type === "user") request.ceilings.noteToolActivity();
    // A child can flush several stream lines in one stdout chunk before the
    // stop signal lands. Continue reading their audit evidence, as before, but
    // freeze accounting at the event that tripped the stop.
    const withinAccountingPrefix = !terminated;

    /**
     * The charge the transport reports, from whichever event carries it
     * (SCP-159). `total_cost_usd` is cumulative, so the last one read is what
     * the attempt had spent; reading it on every event rather than only on the
     * final line is what lets a terminated attempt record a figure at all, and
     * what makes the cost ceiling a running check rather than one that can
     * only fire once the run is over.
     *
     * Nothing is read after the stop: what is recorded is what the transport
     * had reported up to and including the message the runner stopped on.
     */
    if (!terminated && typeof event.total_cost_usd === "number") {
      costMicros = Math.round(event.total_cost_usd * 1_000_000);
      costBasis = "transport_reported";
      breach(request.ceilings.noteCostMicros(costMicros));
    }

    if (type === "system" && event.subtype === "init") {
      try {
        reported = assertNeutralised(event, request.worktree);
      } catch (error) {
        if (error instanceof AgentConfigurationPresentError) {
          reported = error.reported;
          stop("agent_configuration_present", error.message);
          return;
        }
        throw error;
      }
      credentialClass =
        event.apiKeySource === "none"
          ? "subscription"
          : typeof event.apiKeySource === "string"
            ? "user_api_key"
            : "unknown";
      // D-096: the cost caps bind from here, or stop binding, according to what
      // the executor authenticated with.
      request.ceilings.useCredential(credentialClass);
      progress(
        `agent ready: ${reported.mcp_servers.length} tool servers, ` +
          `${reported.skills.length} skills, credential ${credentialClass}`,
      );
      return;
    }

    if (type === "assistant") {
      breach(request.ceilings.noteIteration());
      const message = (event.message ?? {}) as StreamAssistantMessage;
      const reportedUsage = countedStreamUsage(message.usage);
      const usage = reportedUsage ?? ZERO_STREAM_USAGE;
      if (withinAccountingPrefix && !finalAccounting && reportedUsage !== null) {
        useAssistantAccounting(event, message, reportedUsage);
      }
      /**
       * The ceiling counts **fresh** tokens; the record counts all of them.
       *
       * A cached read is the same prompt arriving again, and an agent that
       * takes thirty turns re-reads it thirty times: counting those against a
       * runaway ceiling terminates ordinary work on a real repository long
       * before anything has run away. Found by dogfooding this repository,
       * where a first attempt died at 2.05M tokens of which almost all were
       * cache reads. Cost is the honest guard on that axis, and it has its own
       * ceiling.
       */
      breach(
        request.ceilings.noteTokens(
          usage.input_tokens + usage.cache_creation_input_tokens + usage.output_tokens,
        ),
      );
      // Until a transport total arrives, the same usage feeds the dollar
      // ceiling at this model's list rates.
      if (withinAccountingPrefix && !finalAccounting && reportedUsage !== null) {
        noteProviderListEstimate();
      }

      // Which agent this turn belongs to (D-106): it names the turn's tool
      // calls, decides whether the turn's words are the executor's own, and
      // keys the shell that agent's `cd` chain moves.
      const agent = agentOf(event);
      const shellKey = shellKeyOf(event);

      /**
       * The model's own words on this turn, kept so the last of them survives
       * the run (D-092). Only `text` blocks: a tool result echoing repository
       * content is not the executor speaking, and the account is read from
       * what the executor said.
       *
       * And only the top-level session's (D-106): a subagent's closing summary
       * is not the executor's account, and taking it would brief the ticket's
       * next round with a child's words as its predecessor's. A child's turn
       * is the last text on the stream whenever the executor ends on a tool
       * call rather than on words, so this is not only the cut attempt's case.
       */
      const spoken = (message.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("\n")
        .trim();
      if (agent === null && spoken.length > 0) finalMessage = redact(spoken);

      for (const block of message.content ?? []) {
        if (block.type !== "tool_use" || typeof block.name !== "string") continue;
        const detail = redact(describeTool(block.name, block.input));
        // The role this call starts a subagent from, so the child's own calls
        // can be named by it when they arrive carrying this call's id.
        if (isSubagentTool(block.name) && typeof block.id === "string") {
          const role = subagentRoleOf(block.input);
          if (role !== null) roleOfTask.set(block.id, role);
        }
        request.ceilings.noteToolActivity();
        breach(request.ceilings.noteCommand());
        // Only `Bash` runs in the shell the `cd` chain moved. A file tool takes
        // an absolute path and is judged from the root, as it always was. Read
        // per block rather than per turn: two Bash calls in one message move
        // the same shell one after the other.
        const shellCommand = block.name === "Bash";
        const shell = shells.get(shellKey) ?? START;
        const { admission, inspection } = judgeCommand({
          tool: block.name,
          detail,
          allow_list: request.profile.command_allow_list,
          deny_list: request.profile.command_deny_list,
          scope: {
            root: request.worktree,
            tmpdir: scratch,
            paths_allowed: request.paths_allowed ?? [],
            paths_prohibited: request.paths_prohibited ?? [],
            spec_folder: request.spec_folder ?? null,
            ...(shellCommand
              ? { cwd: shell.unknown ? UNKNOWN_CWD : (shell.path ?? request.worktree) }
              : {}),
          },
        });
        /**
         * A file tool's destination, resolved as a path rather than read as
         * shell text (SCP-161 criterion 2). It is taken from the tool's own
         * input, not from the description above: what is judged is the path the
         * tool was given. The hook reads the same path before the tool runs;
         * this is the second reading, for a call the hook did not answer.
         */
        const targets = inspectToolWrite(block.name, block.input, {
          root: request.worktree,
          tmpdir: scratch,
          paths_allowed: request.paths_allowed ?? [],
          paths_prohibited: request.paths_prohibited ?? [],
          spec_folder: request.spec_folder ?? null,
        }).map((hit) => ({ ...hit, detail: redact(hit.detail) }));
        /**
         * The second reading of a subagent-starting call (D-106 criterion 1).
         *
         * The hook refuses a role outside Perbo's set, and a call a subagent
         * made whatever role it names, before either one starts; and
         * `settlePendingHits` drops this hit for every call it answered. What
         * is left is a call nothing judged before it ran: a subagent from a
         * definition the approved plan never saw, or a generation below the
         * one it approved — either way the executor widening its own
         * permissions.
         *
         * A hit rather than a `denied` record, because the call is not one the
         * runner refused — it happened. Saying otherwise would write `denied`
         * against a subagent that read the repository, which is the AYO-13
         * mistake in the other direction.
         */
        const startedOutside = isSubagentTool(block.name)
          ? judgeSubagentStart(block.name, block.input, PERBO_AGENT_ROLE_NAMES, agent)
          : null;
        const startedOutsideRoles: ProhibitedHit[] =
          startedOutside === null || startedOutside.decision === "allowed"
            ? []
            : [
                {
                  action: "enable_own_tooling",
                  detail: redact(
                    startedOutside.rule === ADMISSION_RULES.subagent_nesting
                      ? `${agent ?? "a subagent"} started ` +
                        `${subagentRoleOf(block.input) ?? "a subagent"}, and a subagent may not ` +
                        "start one"
                      : `the executor started ${subagentRoleOf(block.input) ?? "a subagent"}, ` +
                        "which is not a role Perbo defines",
                  ),
                },
              ];
        decided(block.name, detail, commands.length);
        if (typeof block.id === "string") recordOfToolUse.set(block.id, commands.length);
        commands.push({
          sequence: commands.length,
          tool: block.name,
          detail: detail.slice(0, 2_000),
          decision: admission.decision,
          denial_reason: admission.reason,
          denial_rule: admission.rule,
          denial_target: admission.target,
          cwd: shellCommand ? shell.relative : null,
          decided_by: "transcript_reading",
          second_reading: null,
          agent,
          at: at.toISOString(),
        });
        if (shellCommand) shells.set(shellKey, inspection.cwd);
        // SCP-228: under the agent's own permissions the runner keeps no
        // prohibited-action list — the arm's `git push` and `gh pr create` are
        // its work, not an escape from an attempt's scope. The command is still
        // recorded above; what is dropped is the runner's veto over it.
        for (const hit of supervision === "runner_guard"
          ? [...targets, ...inspection.hits, ...startedOutsideRoles]
          : []) {
          pendingHits.push({
            hit,
            at: at.toISOString(),
            ...(typeof block.id === "string" ? { toolUseId: block.id } : { toolUseId: undefined }),
          });
        }
        // SCP-228: observed under both supervisions, fatal under one. The log
        // is detection rather than interception on the local provider, and for
        // the executor a host off the list ends the attempt. The direct arm
        // runs as a person's ordinary Claude Code — nothing of the runner's
        // decides its calls — so a kill here would void its run for a reason
        // the arm never saw, while the record still says what it reached for.
        for (const denied of egress.observe(detail, `tool:${block.name}`, at)) {
          if (supervision !== "runner_guard") continue;
          stop("unlisted_egress_host", `${denied.host} is not on the resolved allow-list`);
        }
      }
      return;
    }

    if (type === "result") {
      // The final accounting line arrived; its usage, where present, is the
      // whole attempt rather than another per-request contribution.
      if (withinAccountingPrefix) {
        finalAccounting = true;
        const finalUsage = countedStreamUsage(event.usage);
        if (finalUsage !== null) {
          // The assistant stream's output count is provisional; this is the
          // transport's attempt-wide accounting and replaces every token sum.
          useAccounting(finalUsage);
          noteProviderListEstimate();
        }
      }
      // The hook has judged every call by now, and its answers are the enforced
      // ones, so they are folded in before the agent's own refusals are read.
      reconcile();
      settlePendingHits();
      // Denied actions are audited, not only executed ones.
      const denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
      for (const denial of denials) {
        const record = denial as Record<string, unknown>;
        const name = String(record.tool_name ?? "unknown");
        const detail = redact(describeTool(name, record.tool_input));
        const already = claimDecision(name, detail);
        if (already !== undefined) {
          // The runner already decided this call. If it admitted it and the
          // agent's layer refused it, the refusal is what happened, and it
          // amends that entry rather than making a second.
          const entry = commands[already]!;
          // A call the hook refused is already in `permission_denials`, with
          // the hook's rule and target on it. Rewriting it as a bare allow-list
          // refusal would lose exactly the fact SCP-163 asked the record for.
          if (entry.decided_by === "pre_execution_hook") continue;
          if (entry.decision === "allowed") {
            commands[already] = {
              ...entry,
              decision: "denied",
              denial_reason: "the agent's permission layer refused it before it ran",
              denial_rule: ADMISSION_RULES.allow_list,
              denial_target: entry.detail.slice(0, 200),
              decided_by: "agent_permission_layer",
            };
          }
          continue;
        }
        commands.push({
          sequence: commands.length,
          tool: name,
          detail: detail.slice(0, 2_000),
          decision: "denied",
          denial_reason: "outside the runner's command allow-list",
          denial_rule: ADMISSION_RULES.allow_list,
          denial_target: detail.slice(0, 200),
          // Denied before it reached the shell or the guard: there is no
          // directory it was judged from.
          cwd: null,
          decided_by: "agent_permission_layer",
          second_reading: null,
          // The result envelope names the tool and its input and no agent, so
          // a refusal the runner learns of only from it cannot be named.
          agent: null,
          at: at.toISOString(),
        });
      }
      if (event.is_error === true && !terminated) {
        termination = {
          reason: "agent_error",
          detail: String(event.result ?? event.subtype ?? "the agent reported an error"),
        };
      }
    }
  };

  try {
    await new Promise<void>((resolveDone, rejectDone) => {
    let partial = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      partial += chunk;
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        transcript.push(redact(line));
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        handleEvent(event, new Date());
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      transcript.push(redact(`stderr: ${chunk.trimEnd()}`));
    });
    child.on("error", (error) => {
      clearInterval(ticker);
      suspend.stop();
      rejectDone(error);
    });
    child.on("close", (code, signal) => {
      clearInterval(ticker);
      suspend.stop();
      // Again after the close, because a terminated attempt never reaches a
      // result envelope and its refusals are the ones a reader most needs.
      reconcile();
      settlePendingHits();
      /**
       * An exit the runner did not ask for. Two of them, and they mean
       * opposite things (SCP-172): an agent that ran and failed is evidence
       * about the attempt, while an agent whose model transport was overloaded
       * until its retries ran out is evidence about the provider. The
       * transcript is read for the second before the first is assumed.
       *
       * Only ever for an attempt that ended badly — a non-zero exit, or a
       * result envelope that already said it was an error. An attempt that
       * exited 0 completed, whatever weather it recovered from on the way.
       */
      if (!terminated && (code !== 0 || termination.reason === "agent_error")) {
        const failure = transportExhaustion(transcript);
        termination = failure
          ? {
              reason: "transport_unavailable",
              detail: describeTransportFailure(failure, { code, signal }),
            }
          : code !== 0
            ? {
                reason: "agent_error",
                detail: `the agent exited ${code ?? signal ?? "unknown"}`,
              }
            : termination;
      }
      resolveDone();
    });
    });
  } finally {
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
    // D-096: what the hook recorded, read while the directory is still there.
    reinjections.push(...readReinjections(guard.directory));
    // The decisions carry unredacted targets, and the directory is outside the
    // worktree, so nothing else will ever collect it — including on the throw
    // that a binary which could not be spawned raises.
    discardPreToolGuard(guard);
  }

  const invocation: AgentInvocation = {
    adapter: ADAPTER_NAME,
    binary_path: fingerprint.path,
    binary_version: fingerprint.version,
    binary_sha256: fingerprint.sha256,
    model: request.model,
    credential_class: credentialClass,
    // The prompt is replaced rather than removed, so the recorded argv has the
    // same arity as the one that ran and nothing reconstructs it wrongly.
    argv: argv.map((value, index) => (promptIndexes.includes(index) ? "<prompt>" : value)),
    shape_sha256: invocationShapeHash(argv, promptIndexes),
    neutralisation: {
      suppressed_at_invocation: [
        "--setting-sources user",
        "--strict-mcp-config --mcp-config {}",
        "--settings <the attempt's own two hooks, and no hook from anywhere else>",
        "--disable-slash-commands",
        `env: ${Object.keys(CUSTOMIZATION_CLOSURES).join(", ")}`,
        `never passed: ${FORBIDDEN_FLAGS.join(", ")}`,
      ],
      withheld_from_worktree: [],
      asserted_empty: ["mcp_servers", "mcp_server_errors", "plugins.path", "memory_paths"],
      reported,
    },
  };

  return {
    invocation,
    commands,
    egress,
    prohibited,
    usage: {
      input_tokens: inputTokens,
      cache_creation_input_tokens: cacheCreationTokens,
      cache_read_input_tokens: cacheReadTokens,
      output_tokens: outputTokens,
      cost_micros: costMicros,
      cost_basis: costBasis,
      // Stopped before the transport's final accounting line: tokens are the
      // per-request sums read so far, and cost is reported or estimated over
      // that same prefix.
      cost_partial: termination.reason !== "completed" && !finalAccounting,
      iterations: request.ceilings.counts().iterations,
    },
    termination,
    final_message: finalMessage,
    transcript,
    reinjections,
  };
}
