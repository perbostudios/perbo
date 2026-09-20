import {
  inspectCommandWithCwd,
  writeCause,
  type CommandInspection,
} from "./prohibited.js";
import {
  inspectWritePath,
  resolveScope,
  type WorktreeScope,
  type WriteFinding,
} from "./shell/index.js";

/**
 * Whether a command the executor asked for is admitted, and on what grounds
 * (SCP-163).
 *
 * The allow-list answers "is this verb one of the ones we named". That is the
 * right question for a verb that reads — `ls`, `rg`, `git log` — and the wrong
 * one for a verb that writes. Measured on AYO-13: an executor that had built a
 * fixture store inside its own worktree could not remove it, because `rm -r
 * .scratch-judging` is not a name on the list, while `node -e
 * "rmSync('.scratch-judging',{recursive:true})"` is — the same act, admitted
 * because the word in front of it was `node`. The attempt ended with no change
 * at all.
 *
 * So a mutating command is decided by **where its writes land**. The SCP-156
 * resolver already answers that question for the write guard: it walks each
 * target the way the kernel does, through quotes, wrappers, `cd`, `$TMPDIR` and
 * symlinks, and says which of them left the worktree. A command that runs a
 * write verb is admitted when the resolver finds nothing outside, and refused
 * when it finds something — with the rule that refused it and the target it was
 * judged on, so the refusal is legible as a fact about a path rather than as a
 * fact about a word.
 *
 * Everything else is admitted, including a verb the allow-list does not carry.
 * The runner's refusals are the entries of `ADMISSION_RULES` below — the
 * deny-list, the three write rules (outside the worktree, a prohibited path,
 * outside the contract's globs), a write to git's credential wiring, and the
 * two programs the guard cannot read — and absence from a list is not one of
 * them. The allow-list is not the whole of what the agent's
 * permission layer admits: it also admits `cd` inside the worktree, `echo`,
 * `pwd`, `true`, `test`, `command -v` and the other built-ins with no entry of
 * their own. A runner that refused every unlisted name wrote
 * `denied` against commands that had run — the mirror of the AYO-13 defect this
 * ticket exists to remove, and what turned an attempt whose only commands were
 * `cd` and `echo` into `no_changes_after_denials`.
 *
 * Whether the agent's layer ran a command is the agent's own report, so that is
 * what the record follows: a `permission_denials` entry in the result envelope
 * amends the decision to `denied` under `command_allow_list` (`adapter.ts`),
 * keyed by the sequence the decision was made at. In order, then:
 *
 *   1. the runner's deny-list, read against the segment and against every
 *      command the resolver found it runs;
 *   2. the runner's write rule, by resolved target — outside the worktree,
 *      inside it and prohibited by the contract, or inside it and outside the
 *      contract's globs;
 *   3. otherwise admitted — and only the agent's reported refusal turns that
 *      into a denial, on the strength of a refusal that actually happened.
 *
 * On the local provider none of this is enforced — ADR-0004's amendment says so
 * of the whole command surface, and the `--allowedTools` list the agent's own
 * permission layer holds is the thing that actually refuses. The write verbs
 * are absent from that list, so an executor still cannot run them: this
 * judgement reads a `tool_use` block, which is the agent's account of a command
 * it has already run, and a rule that decides after the fact cannot be handed
 * the verbs it exists to refuse. SCP-177 is the ticket that runs it first.
 */

/** The rules an admission decision can be made by, named so a record can carry one. */
export const ADMISSION_RULES = {
  /** The command matches an entry on the runner's deny-list. */
  deny_list: "command_deny_list",
  /**
   * The agent's own permission layer refused the command before it ran, as its
   * result envelope reported. The runner never authors this rule itself.
   */
  allow_list: "command_allow_list",
  /** A write the SCP-156 resolver put outside the worktree, or could not place. */
  write: "write_outside_worktree",
  /**
   * A write the resolver put inside the worktree and outside the globs the
   * approved contract admits a write under (SCP-195). Distinct from the rule
   * above because the two ask a person for different things: one is a path that
   * left the tree, the other a path the contract has to be revised to reach.
   */
  scope: "write_outside_scope",
  /**
   * A write to a path the approved contract prohibits, wherever the globs above
   * put it (D-105). Judged before the scope rule, because a path that is both
   * prohibited and unadmitted is not answered by widening the contract: the
   * contract already decided that path is not to be touched.
   */
  prohibited_path: "write_prohibited_path",
  /**
   * A `git config` write to git's own credential wiring — `credential.*`,
   * `core.sshCommand`, a `url.*.insteadOf`/`pushInsteadOf`, or
   * `include.*`/`includeIf.*` — at any scope (SCP-201). Not a write-target
   * rule: there is no path to resolve, only a key to read, and `git config
   * user.name` has to stay admitted while `git config credential.helper` does
   * not.
   */
  git_credential_config: "git_credential_config",
  /**
   * A command whose program position is a substitution, a backtick, or an
   * unexpanded variable — including `eval` or `exec` of one — so the guard
   * cannot say what actually runs (SCP-201). Distinct from the write rule
   * because there is nothing to resolve yet: refusing here is refusing before
   * the question "where does this write" can even be asked.
   */
  unreadable_program: "unreadable_program",
  /**
   * An interpreter's program the guard could not classify (SCP-234). The code
   * is on the line and no reading of it says what it writes, so the command is
   * refused — but nothing about it shows a write, which is why the attempt's
   * second reading records this and lets the attempt run on where it ends the
   * attempt for the write rule above. Ticket 4's round was lost to the two
   * being one rule.
   */
  unreadable_inline_program: "unreadable_inline_program",
  /**
   * A call naming a subagent role Perbo does not define — `Agent`, or `Task`
   * under its former name (D-106). Not a deny-list entry: the tool itself is
   * admitted, and what is refused is which role it names — Claude Code offers
   * the executor its own built-in agents and the ones a plugin or the
   * person's `~/.claude/agents` supplies, and none of those passed through
   * the approved plan.
   */
  subagent_role: "subagent_role_undefined",
  /**
   * A call to that same tool a subagent made (D-106, ADR-0038). Distinct from
   * the rule above because the role it names may well be one Perbo defines:
   * what is refused is who is asking. No role carries `Agent` or `Task`, so
   * the binary's own tool list refuses this first — this rule is the holder
   * that does not depend on the binary honouring that list, and nesting is
   * the one property of the set whose breach is unbounded rather than
   * bounded by the set's size.
   */
  subagent_nesting: "subagent_nesting_refused",
  /**
   * A call refused because the guard cannot keep track of where an agent's
   * shell stands (D-106). Not a write rule: what it refuses is the call, not a
   * target the call names.
   *
   * Two doors reach it, and they are one fact. Reading: the file holding that
   * agent's directory is there and will not read back, and that file is
   * written only by a call that moved the agent, so this agent moved and where
   * it went went with the bytes. Writing: this call moves the agent and its
   * new directory cannot be recorded, so the next call would be judged from a
   * directory the shell has left. A file that is simply absent is neither —
   * that is an agent that has not moved, and the directory the attempt started
   * it at is the right answer for it, for as long as nothing removes a file
   * the guard wrote before the attempt ends.
   */
  agent_directory_unknown: "agent_directory_unknown",
} as const;

export type AdmissionRule = (typeof ADMISSION_RULES)[keyof typeof ADMISSION_RULES];

export interface AdmissionDecision {
  decision: "allowed" | "denied";
  /** The rule that refused it. Null on an admitted command. */
  rule: AdmissionRule | null;
  /**
   * What the rule was judged on: the target path as the command spelled it for
   * a write rule, and the command itself for a rule that judged the name. Null
   * on an admitted command.
   */
  target: string | null;
  /** One sentence a person can read. Null on an admitted command. */
  reason: string | null;
}

const ALLOWED: AdmissionDecision = { decision: "allowed", rule: null, target: null, reason: null };

const denied = (rule: AdmissionRule, target: string, reason: string): AdmissionDecision => ({
  decision: "denied",
  rule,
  target,
  reason,
});

/** The rule a write finding was refused by, as an admission rule. */
const writeRule = (finding: WriteFinding): AdmissionRule =>
  finding.rule === "write_prohibited_path"
    ? ADMISSION_RULES.prohibited_path
    : finding.rule === "write_outside_scope"
      ? ADMISSION_RULES.scope
      : ADMISSION_RULES.write;

/**
 * git's own credential wiring (SCP-201): the helper it shells out to, the SSH
 * command it runs, a URL rewrite that can silently redirect a push, and a
 * file it sources unconditionally. `gh auth setup-git` writes
 * `credential.helper` itself — this is the same rewrite reached through
 * `git config` directly, so it is refused the same way regardless of scope.
 */
function isCredentialConfigKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.startsWith("credential.") ||
    lower === "core.sshcommand" ||
    lower.startsWith("include.") ||
    lower.startsWith("includeif.") ||
    /^url\..+\.(insteadof|pushinsteadof)$/.test(lower)
  );
}

/** A whole-word quote pair around a token, stripped — `'x'` and `"x"`, never a bare `'`. */
function unquote(word: string): string {
  if (word.length < 2) return word;
  const first = word[0];
  const last = word[word.length - 1];
  return (first === "'" || first === '"') && first === last ? word.slice(1, -1) : word;
}

/**
 * Split into words the way a shell would, quotes kept but respected — a
 * quoted value's own spaces are not word boundaries. `matchesListEntry`'s
 * plain `split(/\s+/)` is good enough for prefix matching, but a `-c
 * key='a b'` value has to survive as one word for the key that precedes its
 * `=` to be read correctly. This does not expand escapes or substitutions
 * the way the shell reader's own lexer (`shell/internal/lexer.ts`) does; it
 * only has to not split a quoted span apart.
 */
function splitWords(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of text) {
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) words.push(current);
  return words;
}

/** `git config`'s read forms: naming the key here answers a question, it does not set one. */
const GIT_CONFIG_READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l"]);
/** These take the scope's own value as a separate word, unless attached with `=`. */
const GIT_CONFIG_VALUE_FLAGS = new Set(["--file", "--blob"]);

/** git's global flags that take no value, wherever they stand before the subcommand. */
const GIT_GLOBAL_FLAGS = new Set([
  "--bare", "--no-pager", "-p", "--paginate", "--literal-pathspecs", "--no-optional-locks",
]);
/** These take a value, attached with `=` or as the next word. */
const GIT_GLOBAL_ATTACHABLE_VALUE_FLAGS = new Set(["--git-dir", "--work-tree", "--namespace"]);
/** Bare `--exec-path` prints the path and runs no subcommand; only the attached form takes one. */
const GIT_GLOBAL_ATTACHED_ONLY_FLAGS = new Set(["--exec-path"]);
/** `-C` always takes its value as the next word — there is no `-C=<dir>` form. */
const GIT_GLOBAL_SEPARATE_VALUE_FLAGS = new Set(["-C"]);
/**
 * Set a config key for the one command — `-c key=value`, `--config-env
 * key=ENV_VAR` — on whatever subcommand follows. `gh auth setup-git` writes
 * `credential.helper` through `git config`; this is the same rewrite for the
 * length of a single `git fetch`/`clone`/`pull`, so it is the credential
 * rule's business regardless of which subcommand carries it (SCP-201 round 2).
 */
const GIT_GLOBAL_CONFIG_FLAGS = new Set(["-c", "--config-env"]);

/**
 * Everything between `git` and the subcommand: where the subcommand starts,
 * and the key of every `-c`/`--config-env` assignment along the way. git's
 * grammar always puts its global options before the subcommand, so this
 * reads a prefix rather than the whole line; an option this table does not
 * know stops the walk rather than guessing past it, the same conservative
 * reading the rest of the guard gives an option it cannot place.
 *
 * Exported for the interview's own guard (SCP-355), which bans a flag by
 * `git`'s subcommand and needs the same walk past `-C`, `-c` and the rest to
 * find it — `git -C . log --output=<path>` is `log` past its global option,
 * not `words[1]`.
 */
export function gitGlobalOptions(words: readonly string[]): { verbIndex: number; configuredKeys: string[] } {
  const configuredKeys: string[] = [];
  let i = 1;
  while (i < words.length) {
    const word = words[i]!;
    if (!word.startsWith("-") || word === "-") break;
    const eq = word.indexOf("=");
    const name = eq === -1 ? word : word.slice(0, eq);
    const attached = eq === -1 ? null : word.slice(eq + 1);
    if (GIT_GLOBAL_CONFIG_FLAGS.has(name)) {
      const assignment = attached ?? words[i + 1];
      if (assignment !== undefined) {
        const assignEq = assignment.indexOf("=");
        const key = assignEq === -1 ? assignment : assignment.slice(0, assignEq);
        configuredKeys.push(unquote(key));
      }
      i += attached === null ? 2 : 1;
      continue;
    }
    if (GIT_GLOBAL_SEPARATE_VALUE_FLAGS.has(name)) {
      i += attached === null ? 2 : 1;
      continue;
    }
    if (GIT_GLOBAL_ATTACHABLE_VALUE_FLAGS.has(name)) {
      i += attached === null ? 2 : 1;
      continue;
    }
    if (GIT_GLOBAL_ATTACHED_ONLY_FLAGS.has(name)) {
      i += 1;
      continue;
    }
    if (GIT_GLOBAL_FLAGS.has(name)) {
      i += 1;
      continue;
    }
    break;
  }
  return { verbIndex: i, configuredKeys };
}

/**
 * The credential-shaped key one `git` invocation writes, however it reaches
 * it: a `-c`/`--config-env` on any subcommand, or `git config <key>` itself
 * — past whatever global options (`-C`, `--git-dir`, `--no-pager`, …) stand
 * between `git` and `config`, which the key parser used to require as the
 * literal second word. Reads via `--get`/`--get-all`/`--list`/`-l` stay
 * admitted; null where the line names no credential key at all.
 */
function gitConfigCredentialKey(text: string): string | null {
  const words = splitWords(text.trim());
  if (words[0] !== "git") return null;
  const { verbIndex, configuredKeys } = gitGlobalOptions(words);
  for (const key of configuredKeys) {
    if (isCredentialConfigKey(key)) return key;
  }
  if (words[verbIndex] !== "config") return null;
  let i = verbIndex + 1;
  let read = false;
  while (i < words.length && words[i]!.startsWith("-") && words[i] !== "-") {
    const flag = words[i]!;
    const eq = flag.indexOf("=");
    const name = eq === -1 ? flag : flag.slice(0, eq);
    if (GIT_CONFIG_READ_FLAGS.has(name)) read = true;
    if (GIT_CONFIG_VALUE_FLAGS.has(name) && eq === -1) i += 1;
    i += 1;
  }
  if (read) return null;
  const key = words[i];
  if (key === undefined) return null;
  const unquoted = unquote(key);
  return isCredentialConfigKey(unquoted) ? unquoted : null;
}

/**
 * The single-quoted `'key=value'` pairs `GIT_CONFIG_PARAMETERS` carries —
 * git's own format for passing config through the environment — read for
 * their keys alone.
 */
function keysInGitConfigParameters(value: string): string[] {
  const keys: string[] = [];
  const re = /'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    const pair = match[1]!;
    const eq = pair.indexOf("=");
    if (eq !== -1) keys.push(pair.slice(0, eq));
  }
  return keys;
}

/** Variables that choose the program git runs for it — credential-shaping however they are set. */
const GIT_PROGRAM_ENV_VARS = new Set(["GIT_SSH_COMMAND", "GIT_SSH", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_EXEC_PATH"]);
/** git reads its own config out of this variable too, one `'key=value'` pair at a time. */
const GIT_CONFIG_PARAMETERS_VAR = "GIT_CONFIG_PARAMETERS";
/** Pairs with `GIT_CONFIG_VALUE_<n>`; this one's own value is a config key name. */
const GIT_CONFIG_KEY_VAR = /^GIT_CONFIG_KEY_\d+$/;
/** One `NAME=value` word, whether it is a leading shell assignment or an operand of `env`. */
const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

/**
 * The word or words that introduce an environment assignment without being
 * one themselves — `env`, `export`, and the `-x` (export) form of
 * `declare`/`typeset` — consumed the same way, so the assignment behind them
 * is still read. A plain `declare NAME=value` with no `-x` never reaches the
 * environment a child process sees, so it is deliberately not one of these
 * (SCP-201 round 3: the assignment can stand in its own segment — `export
 * GIT_SSH_COMMAND=…; git fetch` — ahead of the git command's own).
 */
function envAssignmentIntroducerWidth(words: readonly string[]): number {
  if (words[0] === "env" || words[0] === "export") return 1;
  if ((words[0] === "declare" || words[0] === "typeset") && words[1] === "-x") return 2;
  return 0;
}

/**
 * The credential-shaping environment variable one command line sets, however
 * it sets it — a leading `NAME=value` before the program, the same shape
 * handed to `env`, or one `export`/`declare -x`/`typeset -x` away from it —
 * and the reason, or null where the leading run of assignments names none of
 * them (SCP-201 round 2: `git` reads `GIT_CONFIG_PARAMETERS`/
 * `GIT_CONFIG_KEY_<n>` and the SSH/askpass/exec-path variables from the
 * environment as readily as from the command line).
 */
function gitCredentialEnvAssignment(text: string): { name: string; key: string | null } | null {
  const words = splitWords(text.trim());
  let i = envAssignmentIntroducerWidth(words);
  while (i < words.length) {
    const match = ENV_ASSIGNMENT.exec(words[i]!);
    if (match === null) break;
    const name = match[1]!;
    const value = unquote(match[2]!);
    if (GIT_PROGRAM_ENV_VARS.has(name)) return { name, key: null };
    if (name === GIT_CONFIG_PARAMETERS_VAR) {
      for (const key of keysInGitConfigParameters(value)) {
        if (isCredentialConfigKey(key)) return { name, key };
      }
    }
    if (GIT_CONFIG_KEY_VAR.test(name) && isCredentialConfigKey(value)) {
      return { name, key: value };
    }
    i += 1;
  }
  return null;
}

/** An entry as Claude Code writes them: `Read`, `Bash(git status:*)`, `Bash(ls)`. */
const ENTRY = /^([A-Za-z_][\w-]*)(?:\((.*)\))?$/s;

/**
 * Whether `text` starts with `prefix` at a word boundary.
 *
 * A bare `startsWith` makes `Bash(rm:*)` match `rmdir -p x`, which is a
 * different verb; requiring a following space makes `Bash(./node_modules/.bin/:*)`
 * match nothing, because the prefix ends mid-word on purpose. Both are answered
 * by asking whether the join between the two is inside a word.
 */
function startsAtBoundary(text: string, prefix: string): boolean {
  if (!text.startsWith(prefix)) return false;
  const next = text[prefix.length];
  if (next === undefined) return true;
  const word = /[\w-]/;
  return !word.test(next) || !word.test(prefix[prefix.length - 1] ?? "");
}

/**
 * One allow-list or deny-list entry against one command.
 *
 * `Tool` matches every use of that tool. `Tool(spec)` matches uses of that tool
 * whose text is `spec`, and `Tool(prefix:*)` uses whose text begins with
 * `prefix` — the prefix rule Claude Code applies to the same list, so what the
 * runner decides and what the agent's permission layer decides are read from
 * the entry the same way.
 */
export function matchesListEntry(entry: string, tool: string, text: string): boolean {
  const parsed = ENTRY.exec(entry.trim());
  if (parsed === null) return false;
  const [, name, spec] = parsed;
  if (name !== tool) return false;
  if (spec === undefined || spec === "*") return true;
  if (spec.endsWith(":*")) return startsAtBoundary(text, spec.slice(0, -2).trim());
  return text === spec.trim();
}

const onList = (list: readonly string[], tool: string, text: string): boolean =>
  list.some((entry) => matchesListEntry(entry, tool, text));

export interface AdmissionInput {
  /** The tool the agent asked for: `Bash`, `Read`, `Edit`, … */
  tool: string;
  /** The command line for `Bash`, and the tool's own description otherwise. */
  detail: string;
  /**
   * The list the runner hands the agent as `--allowedTools`. No decision below
   * is made from it: a verb it does not carry is admitted here, and the agent's
   * own report is what records a refusal. SCP-177 is where it decides.
   */
  allow_list: readonly string[];
  deny_list: readonly string[];
  /** The worktree, the shell's directory and the scratch directory (SCP-156, SCP-166). */
  scope?: WorktreeScope;
  /**
   * The path a file tool writes to, for `Write`, `Edit`, `MultiEdit` and
   * `NotebookEdit` (SCP-161 criterion 2, reachable now that SCP-177 runs this
   * before the tool). Given, it goes through the same resolver a redirect
   * target goes through and a path outside the root is refused with the same
   * rule. Absent — which is what the reading after the fact passes, since by
   * then the bytes are the seal's business — only the deny-list is asked.
   */
  path?: string;
}

/**
 * The decision, and the reading it was made from.
 *
 * The reading is returned rather than discarded because the caller needs the
 * directory the line left the shell in for the next line, and the prohibited
 * hits for the attempt's record; reading the line twice would be reading it
 * twice as slowly and, where a symlink changed under it, twice differently.
 */
export function judgeCommand(input: AdmissionInput): {
  admission: AdmissionDecision;
  inspection: CommandInspection;
} {
  const detail = input.detail.trim();
  const inspection = inspectCommandWithCwd(input.detail, input.scope);
  return { admission: decide(input, detail, inspection), inspection };
}

function decide(
  input: AdmissionInput,
  detail: string,
  inspection: CommandInspection,
): AdmissionDecision {
  /**
   * A file tool is not a shell line: it has no verb, no redirect and no
   * working directory. So the questions the runner asks of it are the
   * deny-list and — where the caller supplied the path, which only the
   * pre-execution hook can — where that path lands. A tool merely absent from
   * the allow-list is admitted here, and the agent's report is what records a
   * refusal of it.
   */
  if (input.tool !== "Bash") {
    if (onList(input.deny_list, input.tool, detail)) {
      return denied(
        ADMISSION_RULES.deny_list,
        input.tool,
        `${input.tool} is on the runner's command deny-list`,
      );
    }
    // Except where the caller can name the path and act on the answer, which is
    // the pre-execution hook: there the same resolver decides a `Write` the way
    // it decides a redirect, before the bytes exist for the seal to read.
    if (input.path !== undefined) {
      const outside = inspectWritePath(input.path, resolveScope(input.scope));
      if (outside !== null) {
        return denied(writeRule(outside), outside.target ?? input.path, outside.detail);
      }
    }
    return ALLOWED;
  }

  // Named refusals come first: a deny-list entry is an explicit decision about
  // a command, and it holds whether or not the command writes anywhere legal.
  //
  // The entry is matched against the segment as written *and* against each
  // command the resolver found the segment runs. A list entry matches by
  // prefix, so `Bash(sudo:*)` reads only the front of the line and misses `env
  // sudo rm -r .scratch` and `sh -c 'sudo rm -r .scratch'`; before SCP-163 the
  // allow-list caught those on the way past, and deciding a mutating command
  // by where its writes land took that second line away. What the parser found
  // the line runs is the thing the deny-list was always about.
  for (const segment of inspection.segments) {
    for (const text of [segment.text, ...segment.invocations]) {
      const hit = input.deny_list.find((entry) => matchesListEntry(entry, "Bash", text));
      if (hit !== undefined) {
        return denied(
          ADMISSION_RULES.deny_list,
          segment.text.slice(0, 200),
          `${hit} on the runner's command deny-list refuses this command`,
        );
      }
    }
  }

  // git's own credential wiring, reached through `git config` rather than
  // through `gh` (SCP-201) — or through `-c`/`--config-env` on any
  // subcommand, or through the environment `git` itself reads
  // (`GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_KEY_<n>`, and the variables that
  // choose the SSH/askpass/exec-path program it runs). Not a deny-list entry:
  // `git config user.name` and `git -c color.ui=false status` have to stay
  // admitted, so the refusal is keyed on the config key named rather than on
  // the command's spelling.
  for (const segment of inspection.segments) {
    for (const text of [segment.text, ...segment.invocations]) {
      const key = gitConfigCredentialKey(text);
      if (key !== null) {
        return denied(
          ADMISSION_RULES.git_credential_config,
          key,
          `${key} rewrites the machine's git credential wiring, which the credential rule refuses at any scope`,
        );
      }
      const env = gitCredentialEnvAssignment(text);
      if (env !== null) {
        const what = env.key ?? env.name;
        return denied(
          ADMISSION_RULES.git_credential_config,
          what,
          env.key !== null
            ? `${env.name} names the credential key ${env.key} through the environment, which the credential rule refuses at any scope`
            : `${env.name} chooses the program git runs, which the credential rule refuses regardless of how it is set`,
        );
      }
    }
  }

  // A program the resolver could not read at all: a substitution, a
  // backtick, or an unexpanded variable stood where the verb should be, so
  // there is no verb to check against the deny-list and no path to judge yet
  // (SCP-201). Refused ahead of the write rule below for that reason — the
  // question the write rule asks does not have an answer here.
  for (const segment of inspection.segments) {
    const unreadable = segment.unreadablePrograms[0];
    if (unreadable !== undefined) {
      return denied(
        ADMISSION_RULES.unreadable_program,
        unreadable,
        `the program ${unreadable} cannot be read — it is built at run time, so the guard cannot say what it runs`,
      );
    }
  }

  // Then where the writes land. One target outside the worktree refuses the
  // line, and the first one found is the one the record names — a refusal that
  // named five paths would still be one decision, and the reader needs the
  // path they have to change rather than the list.
  //
  // A finding that placed a destination is named ahead of one that placed
  // nothing: where a line both writes out and carries a program this guard
  // cannot read, the escape is the fact the reader has to act on (SCP-234).
  const placed = inspection.writes.find((finding) => writeCause(finding) === "outside_target");
  const escaped = placed ?? inspection.writes[0];
  if (escaped !== undefined) {
    if (writeCause(escaped) === "unreadable_program") {
      return denied(
        ADMISSION_RULES.unreadable_inline_program,
        detail.slice(0, 200),
        escaped.detail,
      );
    }
    return denied(
      writeRule(escaped),
      escaped.target ?? detail.slice(0, 200),
      escaped.detail,
    );
  }

  // And that is every refusal the runner authors. A name the allow-list does
  // not carry is not a third rule: the agent's permission layer admits `cd`,
  // `echo`, `pwd` and the rest of the built-ins with no entry, so refusing
  // here would record `denied` against a command that ran. If the layer did
  // refuse it, its result envelope says so and that report amends this row.
  return ALLOWED;
}
