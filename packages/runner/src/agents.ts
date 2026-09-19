import { ADMISSION_RULES, type AdmissionDecision } from "./admission.js";

/**
 * The roles the executor may start a subagent from (D-106, ADR-0038).
 *
 * D-106 leaves how many subagents, which of these roles and which model to the
 * executor, and keeps the roles themselves Perbo's. The set below is that
 * closed set: the executor is handed it as `--agents` and the write guard
 * refuses a call to the tool that starts one — `Agent`, or `Task` under its
 * former name — whose `subagent_type` is not one of these names, so a
 * definition the repository or the person supplies cannot be started even
 * where Claude Code offers it (ADR-0030).
 *
 * The names carry the `perbo-` prefix because `--agents` and the definitions
 * under `~/.claude/agents` share one namespace. Which of two definitions of
 * one name runs is measured, not assumed: on Claude Code 2.1.247 the roles
 * passed with `--agents` win it, and a personal definition of the same name is
 * the one dropped (ADR-0038, 2026-09-15). The prefix is what keeps that
 * collision from arising at all — a role named `explorer` or `implementer`
 * would be a name a person may well keep an agent under, and Perbo's
 * definition silently replacing theirs inside an attempt is not a thing to
 * arrange on purpose. Above the flag sits one source only, the machine-wide
 * managed settings directory, which a person cannot write without admin
 * rights and which can override far more than a role.
 *
 * No role carries `Agent` or `Task`, and the guard refuses a call under
 * either name a subagent made whatever role it names. Nesting is not counted
 * to a depth; it is refused at one, because a subagent that could start
 * subagents would put a generation of them outside the set a person ever
 * approved. Both halves are here because a role's `tools` list is a request
 * the binary honours and the guard is what Perbo enforces — the same reason
 * the role names are checked at all.
 */
export interface AgentRole {
  /** What the executor reads when it decides whether to start this role. */
  description: string;
  /** The role's own standing instruction. Perbo's text, never the model's. */
  prompt: string;
  /** The built-in tools this role may use. The attempt's guard judges them all. */
  tools: readonly string[];
}

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "Bash"] as const;
const WRITING_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"] as const;

export const PERBO_AGENT_ROLES: Readonly<Record<string, AgentRole>> = Object.freeze({
  "perbo-explorer": {
    description:
      "Reads the worktree and answers one question about it. Asked to write " +
      "nothing; it carries Bash, and the ticket's scope guard is what enforces " +
      "where a write may land.",
    prompt:
      "You are an explorer inside one approved ticket's worktree. Read the code and " +
      "answer the question you were given. Write nothing: your answer is your whole " +
      "output. Quote paths and line numbers so the answer can be checked.",
    tools: READ_ONLY_TOOLS,
  },
  "perbo-implementer": {
    description:
      "Writes one part of the change, and the tests that prove it.",
    prompt:
      "You are implementing one part of an approved ticket in a Git worktree. Make the " +
      "change you were given and the tests that prove it, and nothing beyond it. The " +
      "runner's write guard judges every write you make against the ticket's scope, so " +
      "a refusal is the contract speaking and not a fault to work around. Do not " +
      "commit, push, or open a pull request. End by saying which files you touched and " +
      "what you ran.",
    tools: WRITING_TOOLS,
  },
  "perbo-verifier": {
    description:
      "Runs checks and reports what passed and what failed. Asked to change " +
      "nothing it is judging; it carries Bash, and the ticket's scope guard is " +
      "what enforces where a write may land.",
    prompt:
      "You are verifying work in one approved ticket's worktree. Run the checks you were " +
      "asked to run and report exactly what passed and what failed, quoting the output " +
      "that says so. Write nothing and change nothing: a verifier that edits the code it " +
      "is judging is worth nothing.",
    tools: READ_ONLY_TOOLS,
  },
});

/** The role names, in the order the invocation offers them. */
export const PERBO_AGENT_ROLE_NAMES: readonly string[] = Object.freeze(
  Object.keys(PERBO_AGENT_ROLES),
);

/**
 * The tool that starts a subagent, and every name Claude Code answers to for it.
 *
 * On the pinned binary (2.1.247) the tool is `Agent`: the name its
 * `PreToolUse` hook payload's `tool_name` carries and a stream's `tool_use`
 * block carries. `Task` is the tool's former name, which Claude Code still
 * accepts wherever a name is configured — `--tools`, `--allowedTools`, a
 * hook's matcher — and still prints in the init event's tool list, while
 * normalising it to `Agent` everywhere else. The current name is listed first
 * because it is the one the wire actually carries; both are kept because
 * nothing pins the binary to keep printing one where it prints the other
 * today.
 */
export const SUBAGENT_TOOL_NAMES = ["Agent", "Task"] as const;

/** Whether `name` is the tool that starts a subagent, under either name it answers to. */
export function isSubagentTool(name: string): boolean {
  return (SUBAGENT_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * The `--agents` value: the roles, as the binary parses them.
 *
 * A JSON object keyed by role name, each `{ description, prompt, tools }`.
 * Measured against Claude Code 2.1.247 by `scripts/live-subagents/claude-subagents.mjs`,
 * which passed exactly this shape and had both roles started (ADR-0038,
 * 2026-09-12); the flag is not in a contract anyone owes us.
 */
export function agentsFlagValue(
  roles: Readonly<Record<string, AgentRole>> = PERBO_AGENT_ROLES,
): string {
  return JSON.stringify(roles);
}

/**
 * The role a subagent-starting call names, exactly as it was written.
 *
 * `subagent_type` is the field the `tool_use` block (named `Agent`, or `Task`
 * under its former name) and the hook payload both carry, read off the live
 * stream in ADR-0038's test.
 *
 * Nothing is trimmed, lowercased or otherwise repaired first. The value is a
 * name in a closed set, so every spelling that is not a member is a different
 * name — and a guard that normalised before comparing would be admitting one
 * spelling of a role in place of another, which is the whole question here.
 */
export function subagentRoleOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as Record<string, unknown>).subagent_type;
  return typeof value === "string" ? value : null;
}

/**
 * Whether the executor may start this subagent (D-106 criterion 1).
 *
 * The roles are Perbo's, and Claude Code offers the executor more than them:
 * its own built-in agents, the ones a plugin supplies and the ones the person
 * keeps in `~/.claude/agents` were all measured as startable once the tool is
 * allowed (ADR-0038, 2026-09-12). None of those passed through the plan a
 * person approved, so none of them may run inside an attempt, and this is the
 * rule that says so — before the call, in the guard's hook, because a subagent
 * refused after it started has already read the repository.
 *
 * `toolName` is the name the call itself carried — `Agent` on the pinned
 * binary, or `Task` under its former name — and is what a refusal's `target`
 * and wording quote when the call named no role, rather than a constant that
 * might name the spelling the binary did not send.
 *
 * `startedBy` is the agent making the call: null for the top-level session and
 * the role for a subagent's own call. A subagent's call is refused whatever
 * role it names, which is the rule below it.
 *
 * No parameter has a default, and `roles` in particular must not get one.
 * What makes this fail closed is the caller passing the set the attempt itself
 * declared — the hook passes `state.agent_roles ?? []`, and an empty set
 * refuses every role. A default of the roles Perbo compiles in would hand a
 * caller that omitted the argument the widest answer instead of the safest:
 * `interviewGuardState` deliberately declares no roles, because ADR-0030 says
 * the interview starts no subagent, and a one-argument call there would admit
 * all three.
 */
export function judgeSubagentStart(
  toolName: string,
  input: unknown,
  roles: readonly string[],
  startedBy: string | null,
): AdmissionDecision {
  const named = subagentRoleOf(input);
  // A record's target is a name a person reads, and a call that named nothing
  // — or named an empty string — has none to quote back, so the tool stands in
  // its place. An empty one would also fail `CommandRecord`'s own minimum.
  const quoted = named !== null && named.length > 0 ? named : null;

  /**
   * A subagent may not start a subagent, whatever role it names.
   *
   * Judged before membership, because a nested `perbo-implementer` is a role
   * Perbo defines and is refused all the same: what is wrong with it is who
   * asked, not which name it carries. No role carries `Agent` or `Task`, so
   * the binary refuses this first — but that list is a request the binary
   * honours, and a nested generation is the one breach of the closed set that
   * is unbounded, so it is worth the second holder.
   */
  if (startedBy !== null) {
    return {
      decision: "denied",
      rule: ADMISSION_RULES.subagent_nesting,
      target: quoted ?? toolName,
      reason:
        `a ${toolName} from ${startedBy} is a subagent starting a subagent, which Perbo ` +
        "does not offer: a nested generation would sit outside the set of roles a person " +
        "approved. Report what you found to the agent that started you, and let it delegate",
    };
  }

  if (named !== null && roles.includes(named)) {
    return { decision: "allowed", rule: null, target: null, reason: null };
  }
  const which =
    roles.length === 0 ? "and this attempt declares none" : `which are ${roles.join(", ")}`;
  return {
    decision: "denied",
    rule: ADMISSION_RULES.subagent_role,
    target: quoted ?? toolName,
    reason:
      quoted === null
        ? `a ${toolName} call naming no subagent_type cannot be a role Perbo defines, ${which}`
        : `${quoted} is not a role Perbo defines, ${which}; a subagent definition from the ` +
          "repository or from your own machine cannot be started inside an attempt",
  };
}
