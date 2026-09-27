import {
  inspectCommandWithCwd,
  writeCause,
  type CommandInspection,
} from "./prohibited.js";
import {
  everySegment,
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
 * outside the contract's globs), a write to git's credential wiring, a `git
 * branch` that changes a branch, the three git rules that stand behind the
 * allow lists (an alias defined on the line, a repository or config file the
 * line picks, a verb git does not define), and the two programs the guard
 * cannot read — and absence from a list is not one of them. The allow-list is not the whole of what the agent's
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
 * keyed by the sequence the decision was made at. In order, then, each read
 * against the segment and every command the resolver found it runs:
 *
 *   1. a git alias defined on the line (`git_alias_defined`);
 *   2. the runner's deny-list;
 *   3. a write to git's credential wiring (`git_credential_config`);
 *   4. git pointed at a repository or config file the line picks
 *      (`git_repository_redirect`);
 *   5. a `git branch` that changes a branch (`git_branch_write`);
 *   6. a program the resolver could not read (`unreadable_program`);
 *   7. the write rule, by resolved target — outside the worktree, inside it
 *      and prohibited by the contract, or inside it and outside the
 *      contract's globs — and inline code it could not classify;
 *   8. a git verb git does not define (`git_verb_unknown`);
 *   9. otherwise admitted — and only the agent's reported refusal turns that
 *      into a denial, on the strength of a refusal that actually happened.
 *
 * The judgement runs twice: before the tool, in the `PreToolUse` hook
 * (`pretool.ts`, SCP-177), whose `deny` stops the call and which answers
 * `deny` when it cannot read its state or judge the call; and after, over the
 * `tool_use` block, which records. The `--allowedTools` list the agent's own
 * permission layer holds carries no write verb but `git branch`, which is
 * there for its listing forms: its forms that change a branch are refused by
 * `git_branch_write` at the hook, so the entry never admits one.
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
   * A `git branch` that changes a branch — deletes, renames, copies, creates
   * or forces one, or sets its upstream, its tracking or its description —
   * however it is spelled, and one whose words the guard cannot read to tell.
   * Not a deny-list entry: listing branches (`git branch -a -v`, `--list
   * <pattern>`, `--show-current`) is a read the executor and the chat both
   * need, so the refusal is keyed on the words `git branch` is given rather
   * than on its name, as the credential rule is keyed on the key `git config`
   * is given.
   */
  git_branch_write: "git_branch_write",
  /**
   * A `git` line whose verb is not the one it names, because it defines an
   * alias on the way in — `-c alias.<name>=…`, `--config-env
   * alias.<name>=…`, the same key through `GIT_CONFIG_PARAMETERS` or a
   * `GIT_CONFIG_KEY_<n>`, a `GIT_CONFIG_COUNT` that switches on a key the line
   * does not set, or a config file the line chooses (`GIT_CONFIG_GLOBAL`,
   * `GIT_CONFIG_SYSTEM`) — or writes one with `git config` for the lines
   * after it: `git -c alias.x='branch -D' x main` deletes a branch while a
   * rule keyed on the verb reads `x`. Behind the allow lists: Claude Code's own permission layer, Codex's and
   * OpenCode's admitted set and the chat's read-only shapes carry no entry such
   * a line matches, so this is a second line at the hook rather than the one
   * that refuses it.
   * It does not see an alias a program defines when it runs git itself, nor
   * one already in a config file git reads.
   */
  git_alias: "git_alias_defined",
  /**
   * A line that runs `git` — directly or through a wrapper — and points it at
   * a repository or a config file the line picks rather than the worktree's
   * own: `HOME`, `XDG_CONFIG_HOME`, `GIT_DIR`, `GIT_WORK_TREE`,
   * `GIT_COMMON_DIR` or `GIT_CEILING_DIRECTORIES` assigned or handed to
   * `env`, or git's `--git-dir`, `--work-tree` or `--namespace`, since a
   * `.gitconfig` the agent wrote under a redirected `HOME` holds aliases the
   * line does not show. `GIT_CONFIG_NOSYSTEM` and `GIT_TERMINAL_PROMPT` remove
   * configuration rather than add it, and are not among them. Behind the allow lists: Claude Code's own permission layer, Codex's and
   * OpenCode's admitted set and the chat's read-only shapes carry no entry such
   * a line matches, so this is a second line at the hook rather than the one
   * that refuses it.
   * It does not see a program that sets these and runs git itself, nor
   * `-C` or `cd` into a nested repository, whose own config git reads.
   */
  git_repository_redirect: "git_repository_redirect",
  /**
   * A `git` verb git itself does not define, so the verb it runs is not the
   * one it names: an alias — from any config file, a nested repository's own
   * among them — and an external `git-<x>` command on the `PATH` both look
   * like one. `git help <x>` and `git <x> --help` only print, and are
   * admitted. Behind the allow lists: Claude Code's own permission layer, Codex's and
   * OpenCode's admitted set and the chat's read-only shapes carry no entry such
   * a line matches, so this is a second line at the hook rather than the one
   * that refuses it.
   * It does not see a program that runs git itself, nor what a nested
   * repository's own config does through a verb git defines (`core.pager`,
   * `core.fsmonitor`, a filter, a hook).
   */
  git_verb_unknown: "git_verb_unknown",
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
  /**
   * A call naming a host off the network allow-list that a person refused, or
   * that the run refuses without asking (D-137). Not a
   * write rule: what is refused is the destination the call named.
   */
  egress: "unlisted_egress_host",
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
/** These take the scope's own value as a separate word, unless attached with `=` (`-f` is `--file`). */
const GIT_CONFIG_VALUE_FLAGS = new Set(["--file", "-f", "--blob"]);

/** git's global flags that take no value, wherever they stand before the subcommand. */
const GIT_GLOBAL_FLAGS = new Set([
  "--bare", "--no-pager", "-P", "-p", "--paginate", "--literal-pathspecs", "--no-literal-pathspecs",
  "--no-optional-locks", "--no-replace-objects", "--no-lazy-fetch", "--glob-pathspecs",
  "--noglob-pathspecs", "--icase-pathspecs", "--no-advice",
]);
/** These take a value, attached with `=` or as the next word. */
const GIT_GLOBAL_ATTACHABLE_VALUE_FLAGS = new Set([
  "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--attr-source", "--shallow-file",
]);
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
        // The shell hands git the key without its quotes, however they are
        // placed: `-c "alias.x=branch -D"` sets `alias.x`.
        configuredKeys.push(key.replace(/["']/g, ""));
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

/** `git config`'s own subcommands that read: naming a key after one answers a question. */
const GIT_CONFIG_READ_SUBCOMMANDS = new Set(["get", "list"]);
/** Its subcommands that write, each naming the key or section it writes as its first operand. */
const GIT_CONFIG_WRITE_SUBCOMMANDS = new Set(["set", "unset", "edit", "remove-section", "rename-section"]);
/** Renaming a section writes under its second operand too: every key the old section held. */
const GIT_CONFIG_RENAME = new Set(["--rename-section", "rename-section"]);

/**
 * The keys and sections a `git config` invocation writes, past git's global
 * options: its first operand, and the new name a section is renamed to —
 * spelled as flags (`git config user.name x`, `--unset`, `--rename-section`)
 * or as a subcommand (`git config set user.name x`). Empty for a read
 * (`--get`, `--list`, `get`, `list`) and for any other verb.
 */
function gitConfigWrittenKeys(words: readonly string[], verbIndex: number): string[] {
  if (words[verbIndex] !== "config") return [];
  let read = false;
  let renames = false;
  let subcommand: string | null = null;
  const operands: string[] = [];
  for (let i = verbIndex + 1; i < words.length; i += 1) {
    const word = words[i]!;
    if (word.startsWith("-") && word !== "-") {
      const eq = word.indexOf("=");
      const name = eq === -1 ? word : word.slice(0, eq);
      if (GIT_CONFIG_READ_FLAGS.has(name)) read = true;
      if (GIT_CONFIG_RENAME.has(name)) renames = true;
      if (GIT_CONFIG_VALUE_FLAGS.has(name) && eq === -1) i += 1;
      continue;
    }
    const value = unquote(word);
    if (subcommand === null && operands.length === 0 && (GIT_CONFIG_READ_SUBCOMMANDS.has(value) || GIT_CONFIG_WRITE_SUBCOMMANDS.has(value))) {
      subcommand = value;
      if (GIT_CONFIG_READ_SUBCOMMANDS.has(value)) read = true;
      if (GIT_CONFIG_RENAME.has(value)) renames = true;
      continue;
    }
    operands.push(value);
  }
  if (read) return [];
  return operands.slice(0, renames ? 2 : 1);
}

/**
 * The credential-shaped key one `git` invocation writes, however it reaches
 * it: a `-c`/`--config-env` on any subcommand, or `git config <key>` itself
 * — past whatever global options (`-C`, `--git-dir`, `--no-pager`, …) stand
 * between `git` and `config`. Reads stay admitted; null where the line names
 * no credential key at all. A section renamed onto one of these names is
 * read as that section's keys.
 */
function gitConfigCredentialKey(text: string): string | null {
  const words = splitWords(text.trim());
  if (words[0] !== "git") return null;
  const { verbIndex, configuredKeys } = gitGlobalOptions(words);
  for (const key of configuredKeys) {
    if (isCredentialConfigKey(key)) return key;
  }
  return (
    gitConfigWrittenKeys(words, verbIndex).find(
      (key) => isCredentialConfigKey(key) || isCredentialConfigKey(`${key}.x`),
    ) ?? null
  );
}

/** A git alias's key: `alias.<name>` runs another verb, or a shell command where it begins with `!`. */
const isAliasKey = (key: string): boolean => /^alias(\.|$)/i.test(key);

/** A value the line builds when it runs, so what key it names cannot be read off the line. */
const BUILT = /[$`]/;

/** Variables that put a config file the line chooses in front of git. */
const GIT_CONFIG_FILE_ENV_VARS = new Set(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]);

/** The sentence every alias refusal ends with. */
const ALIAS_BECAUSE = "so the verb git runs is not the one the line names";

/**
 * Why one command line defines a git alias on the way in, or null where it
 * defines none. The environment the line gives git — a leading assignment,
 * or one handed to `env`, `export` or `declare -x` — and then, where the
 * command is `git`, every `-c`/`--config-env` before the verb, and the key a
 * `git config` write names. A `-c` that sets no alias (`git -c core.pager=cat
 * branch -a`) is no definition.
 *
 * Where the global-option walk stops at an option it does not know, where
 * the verb stands cannot be told, so every `-c`/`--config-env` on the rest
 * of the line is read as one that could stand before it.
 */
function gitAliasDefinition(text: string): string | null {
  const words = splitWords(text.trim());
  const keysSet = new Set<number>();
  let count: string | null = null;
  for (let i = envAssignmentIntroducerWidth(words); i < words.length; i += 1) {
    const match = ENV_ASSIGNMENT.exec(words[i]!);
    if (match === null) break;
    const name = match[1]!;
    const value = unquote(match[2]!);
    if (name === "GIT_CONFIG_COUNT") count = value;
    if (GIT_CONFIG_KEY_VAR.test(name)) keysSet.add(Number(name.slice("GIT_CONFIG_KEY_".length)));
    if (GIT_CONFIG_FILE_ENV_VARS.has(name)) {
      return `${name} points git at a config file the line chooses, which can define a git alias, ${ALIAS_BECAUSE}`;
    }
    if (name === GIT_CONFIG_PARAMETERS_VAR || GIT_CONFIG_KEY_VAR.test(name)) {
      const keys = name === GIT_CONFIG_PARAMETERS_VAR ? [value] : [value.replace(/["']/g, "")];
      if (BUILT.test(value) || keys.some((key) => /(^|['"\s])alias\./i.test(key))) {
        return `${name} defines a git alias through the environment, ${ALIAS_BECAUSE}`;
      }
    }
  }
  // `GIT_CONFIG_COUNT` switches on `GIT_CONFIG_KEY_0` up to one below it, and
  // a key the line does not set comes from wherever the environment got it.
  if (count !== null) {
    const n = /^\d+$/.test(count) ? Number(count) : Number.NaN;
    const unread = Number.isNaN(n) || Array.from({ length: n }, (_, k) => k).some((k) => !keysSet.has(k));
    if (unread) {
      return `GIT_CONFIG_COUNT switches on config keys the line does not set, which can define a git alias, ${ALIAS_BECAUSE}`;
    }
  }
  if (words.length === 0 || unquote(words[0]!).split("/").pop() !== "git") return null;
  const { verbIndex, configuredKeys } = gitGlobalOptions(words);
  const configured = [...configuredKeys];
  if (words[verbIndex]?.startsWith("-") === true) {
    for (let i = verbIndex; i < words.length; i += 1) {
      const eq = words[i]!.indexOf("=");
      const name = eq === -1 ? words[i]! : words[i]!.slice(0, eq);
      if (!GIT_GLOBAL_CONFIG_FLAGS.has(name)) continue;
      const assignment = eq === -1 ? words[i + 1] : words[i]!.slice(eq + 1);
      if (assignment !== undefined) configured.push(assignment.split("=")[0]!.replace(/["']/g, ""));
    }
  }
  for (const key of configured) {
    if (BUILT.test(key)) {
      return `${key} is a config key built when the line runs, which can define a git alias, ${ALIAS_BECAUSE}`;
    }
    if (isAliasKey(key)) return `${key} defines a git alias on the line, ${ALIAS_BECAUSE}`;
  }
  const written = gitConfigWrittenKeys(words, verbIndex).find((key) => isAliasKey(key) || BUILT.test(key));
  return written === undefined
    ? null
    : `${written} writes a git alias for the lines after this one, so a later git line runs a verb it does not name`;
}

/** `git branch`'s long options that only choose which branches a listing shows, and how. */
const GIT_BRANCH_READ_FLAGS = new Set([
  "--list", "--all", "--remotes", "--verbose", "--show-current", "--ignore-case",
  "--color", "--no-color", "--column", "--no-column", "--abbrev", "--no-abbrev",
]);
/** Of those, the ones that take an optional value, attached with `=` only. */
const GIT_BRANCH_ATTACHED_VALUE_FLAGS = new Set(["--color", "--column", "--abbrev"]);
/** The short read options, alone or clustered — `-a`, `-vv`, `-avl`. */
const GIT_BRANCH_READ_SHORTS = new Set(["l", "a", "r", "v", "i"]);
/**
 * The filters that take a commit: attached with `=`, or the next word where
 * one follows — git takes the next word whatever it is, and a next word that
 * begins with `-` is read here as an option, so a write flag standing there
 * is refused rather than taken for a commit.
 */
const GIT_BRANCH_COMMIT_FILTERS = new Set(["--contains", "--no-contains", "--merged", "--no-merged"]);
/** The options that always take a value, attached with `=` or as the next word. */
const GIT_BRANCH_VALUE_FLAGS = new Set(["--points-at", "--sort", "--format"]);

/**
 * Split into words the way `splitWords` does, with every redirect left out:
 * `>`, `2>/dev/null`, `2>&1`, `&>log`, `<<<`, `<<EOF`, and a target joined to
 * its operator or standing after it, are the shell's business rather than
 * words the program is given. A descriptor is the digits a word holds when an
 * operator follows them; an operator before `(` is a process substitution,
 * which stays in the word for `literalWord` to refuse.
 */
function wordsWithoutRedirects(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: string | null = null;
  /** Inside a redirect: dropping its operator, then the blanks before its target, then the target. */
  let redirect: "operator" | "blank" | "target" | null = null;
  const end = (): void => {
    if (current.length > 0 && redirect === null) words.push(current);
    current = "";
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (redirect === "operator") {
      if ("<>&|-".includes(ch)) continue;
      redirect = "blank";
    }
    if (redirect === "blank") {
      if (/\s/.test(ch)) continue;
      redirect = "target";
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      end();
      redirect = null;
      continue;
    }
    if ((ch === "<" || ch === ">") && redirect === null && text[i + 1] !== "(") {
      if (current.length > 0 && !/^(?:\d+|&)$/.test(current)) words.push(current);
      current = "";
      redirect = "operator";
      continue;
    }
    current += ch;
  }
  end();
  return words;
}

/**
 * One word's value as the shell hands it to the program, or null where the
 * shell can make it something the line does not spell: an expansion, a
 * substitution or an escape outside single quotes, or a glob, a brace, a
 * process substitution or a redirect joined to the word outside any quotes.
 */
function literalWord(word: string): string | null {
  let value = "";
  let quote: "'" | '"' | null = null;
  for (const ch of word) {
    if (quote === "'") {
      if (ch === "'") quote = null;
      else value += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "$" || ch === "`" || ch === "\\") return null;
      else value += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if ("$`\\*?[{(<>".includes(ch)) return null;
    value += ch;
  }
  return quote === null ? value : null;
}

/**
 * Why a `git branch` changes a branch, or is one the guard cannot read, or
 * null where it only lists branches — or where the line is not `git branch`
 * at all.
 *
 * Listing is admitted: the read flags above, and a pattern beside `--list`
 * (`-l`). Everything else is refused, and that is what makes it a list of
 * reads rather than a list of writes: `-d`/`-D`/`--delete`, `-m`/`-M`/
 * `--move`, `-c`/`-C`/`--copy`, `-u`/`--set-upstream-to`,
 * `--unset-upstream`, `--edit-description`, `-f`/`--force`, `--track`/
 * `--no-track` and `--create-reflog` each change a branch, and so does any
 * option this table does not name, git's own unique abbreviations of those
 * (`--del`) included. A word standing where no option takes it is a branch
 * to create, save beside `--list`, where it is a pattern; `--` and
 * `--end-of-options` make every word after them such a word. A word the
 * shell can turn into something else when the line runs (`$X`, `$(…)`, an
 * unquoted `*`) is refused, since what `git branch` is given cannot be read
 * off the line; a pattern is quoted, `--list 'feat/*'`.
 *
 * Past git's global options, as the credential rule reads them
 * (`gitGlobalOptions`): `git -C . branch -D main` is `branch`. Where the walk
 * stops at an option it does not know and `branch` is among the words after
 * it, where the subcommand stands cannot be told, and the line is refused.
 */
function gitBranchWrite(text: string): string | null {
  const words = wordsWithoutRedirects(text.trim());
  if (words.length === 0 || literalWord(words[0]!)?.split("/").pop() !== "git") return null;
  const { verbIndex } = gitGlobalOptions(words);
  const verb = words[verbIndex];
  if (verb === undefined) return null;
  if (literalWord(verb) !== "branch") {
    const unplaced =
      verb.startsWith("-") && words.slice(verbIndex + 1).some((word) => literalWord(word) === "branch");
    return unplaced
      ? `git's option ${verb} stands before branch, and the guard cannot say where git branch's own words start`
      : null;
  }
  /** The next word, taken as an option's value: refused where the shell can make it something else. */
  const unreadableValue = (next: string | undefined): string | null =>
    next !== undefined && literalWord(next) === null
      ? `${next} is expanded when the line runs, so the guard cannot say what git branch is given — a pattern to list by is quoted`
      : null;
  let list = false;
  let created: string | null = null;
  for (let i = verbIndex + 1; i < words.length; i += 1) {
    const raw = words[i]!;
    const value = literalWord(raw);
    if (value === null) {
      return `${raw} is expanded when the line runs, so the guard cannot say what git branch is given — a pattern to list by is quoted`;
    }
    if (value === "--" || value === "--end-of-options") {
      return `${value} makes every word after it a branch for git branch to create`;
    }
    if (value.startsWith("--")) {
      const eq = value.indexOf("=");
      const name = eq === -1 ? value : value.slice(0, eq);
      if (GIT_BRANCH_READ_FLAGS.has(name) && (eq === -1 || GIT_BRANCH_ATTACHED_VALUE_FLAGS.has(name))) {
        if (name === "--list") list = true;
        continue;
      }
      if (GIT_BRANCH_VALUE_FLAGS.has(name)) {
        if (eq === -1) {
          const unreadable = unreadableValue(words[i + 1]);
          if (unreadable !== null) return unreadable;
          i += 1;
        }
        continue;
      }
      if (GIT_BRANCH_COMMIT_FILTERS.has(name)) {
        const next = words[i + 1];
        if (eq === -1 && next !== undefined && !next.startsWith("-")) {
          const unreadable = unreadableValue(next);
          if (unreadable !== null) return unreadable;
          i += 1;
        }
        continue;
      }
      return `${name} changes a branch, and the guard admits git branch only to list branches`;
    }
    if (value.startsWith("-") && value.length > 1) {
      const letters = [...value.slice(1)];
      const writing = letters.find((letter) => !GIT_BRANCH_READ_SHORTS.has(letter));
      if (writing !== undefined) {
        return `-${writing} changes a branch, and the guard admits git branch only to list branches`;
      }
      if (letters.includes("l")) list = true;
      continue;
    }
    created ??= value;
  }
  if (created !== null && !list) {
    return `${created} names a branch for git branch to create — a pattern to list by stands beside --list`;
  }
  return null;
}

/**
 * git's own verbs: `git --list-cmds=builtins` and `git --list-cmds=main` on
 * git 2.39.5 (Apple Git-154), the git this repository's machines run — the
 * builtins, `stage` among them, and the commands git ships as programs of its
 * own (`bisect`, `submodule`, `subtree`, `mergetool`, …). A verb a later git
 * adds is refused until it is added here.
 */
const GIT_VERBS = new Set([
  "add", "am", "annotate", "apply", "archive", "bisect--helper", "blame", "branch", "bugreport",
  "bundle", "cat-file", "check-attr", "check-ignore", "check-mailmap", "check-ref-format",
  "checkout", "checkout--worker", "checkout-index", "cherry", "cherry-pick", "clean", "clone",
  "column", "commit", "commit-graph", "commit-tree", "config", "count-objects", "credential",
  "credential-cache", "credential-cache--daemon", "credential-store", "describe", "diagnose", "diff",
  "diff-files", "diff-index", "diff-tree", "difftool", "env--helper", "fast-export", "fast-import",
  "fetch", "fetch-pack", "fmt-merge-msg", "for-each-ref", "for-each-repo", "format-patch", "fsck",
  "fsck-objects", "fsmonitor--daemon", "gc", "get-tar-commit-id", "grep", "hash-object", "help",
  "hook", "index-pack", "init", "init-db", "interpret-trailers", "log", "ls-files", "ls-remote",
  "ls-tree", "mailinfo", "mailsplit", "maintenance", "merge", "merge-base", "merge-file",
  "merge-index", "merge-ours", "merge-recursive", "merge-recursive-ours", "merge-recursive-theirs",
  "merge-subtree", "merge-tree", "mktag", "mktree", "multi-pack-index", "mv", "name-rev", "notes",
  "pack-objects", "pack-redundant", "pack-refs", "patch-id", "pickaxe", "prune", "prune-packed",
  "pull", "push", "range-diff", "read-tree", "rebase", "receive-pack", "reflog", "remote",
  "remote-ext", "remote-fd", "repack", "replace", "rerere", "reset", "restore", "rev-list",
  "rev-parse", "revert", "rm", "send-pack", "shortlog", "show", "show-branch", "show-index",
  "show-ref", "sparse-checkout", "stage", "stash", "status", "stripspace", "submodule--helper",
  "switch", "symbolic-ref", "tag", "unpack-file", "unpack-objects", "update-index", "update-ref",
  "update-server-info", "upload-archive", "upload-archive--writer", "upload-pack", "var",
  "verify-commit", "verify-pack", "verify-tag", "version", "whatchanged", "worktree", "write-tree",
  // Shipped as programs of git's own rather than built in.
  "add--interactive", "bisect", "credential-osxkeychain", "daemon", "difftool--helper",
  "filter-branch", "gui--askpass", "http-backend", "http-fetch", "http-push", "imap-send",
  "merge-octopus", "merge-one-file", "merge-resolve", "mergetool", "p4", "quiltimport",
  "remote-ftp", "remote-ftps", "remote-http", "remote-https", "request-pull", "send-email",
  "sh-i18n--envsubst", "shell", "submodule", "subtree", "web--browse",
]);

/** git's options that print and run no verb: `git --version`, `git --exec-path`. */
const GIT_VERBLESS_FLAGS = new Set([
  "--version", "-v", "--help", "-h", "--html-path", "--man-path", "--info-path", "--exec-path", "--list-cmds",
]);

/**
 * Why one command line runs a git verb git does not define, or null. Past
 * git's global options: `git -C . x` is `x`. A verb the line builds when it
 * runs, and an option before the verb that the walk does not know, leave
 * the verb unreadable and are refused the same way; a line with no verb
 * (`git`, `git --version`) runs none. `git <x> --help` is `git help <x>`,
 * which prints an alias's expansion rather than running it.
 */
function gitUnknownVerb(text: string): string | null {
  const words = wordsWithoutRedirects(text.trim());
  if (words.length === 0 || literalWord(words[0]!)?.split("/").pop() !== "git") return null;
  const { verbIndex } = gitGlobalOptions(words);
  const raw = words[verbIndex];
  if (raw === undefined) return null;
  const verb = literalWord(raw);
  if (verb !== null && verb.startsWith("-")) {
    return GIT_VERBLESS_FLAGS.has(verb.split("=")[0]!)
      ? null
      : `git's option ${verb} is not one the guard reads, so it cannot say which verb git runs`;
  }
  if (verb !== null && GIT_VERBS.has(verb)) return null;
  if (words[verbIndex + 1] === "--help") return null;
  return verb === null
    ? `${raw} is built when the line runs, so the guard cannot say which verb git runs`
    : `git ${verb} is not a verb git itself defines, so what runs is an alias or an external git-${verb} command the line does not show`;
}

/** Variables that choose which repository, or which home and its config files, git reads. */
const GIT_REPOSITORY_ENV_VARS = new Set([
  "HOME", "XDG_CONFIG_HOME", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_CEILING_DIRECTORIES",
]);
/** git's global options that do the same from its own command line. */
const GIT_REPOSITORY_FLAGS = new Set(["--git-dir", "--work-tree", "--namespace"]);
/** `env`'s options that take the next word as their value. */
const ENV_VALUE_OPTIONS = new Set(["-u", "-C", "-S", "-P", "--unset", "--chdir", "--split-string"]);

/** Whether one command line's own program is `git`. */
function runsGit(text: string): boolean {
  const first = splitWords(text.trim())[0];
  return first !== undefined && unquote(first).split("/").pop() === "git";
}

/**
 * Why one command line points git at a repository or a config file it picks,
 * or null. The environment it sets — an assignment of its own, one in front
 * of its program, or one handed to `env` (past `env`'s options), `export` or
 * `declare -x` — is read here only for a line the caller has found runs git
 * somewhere; git's `--git-dir`, `--work-tree` and `--namespace` are read
 * among its global options, and on the rest of the line where the walk stops
 * at an option it does not know.
 */
function gitRepositoryRedirect(text: string): string | null {
  const words = splitWords(text.trim());
  let i = envAssignmentIntroducerWidth(words);
  while (words[0] === "env" && i < words.length && words[i]!.startsWith("-") && !ENV_ASSIGNMENT.test(words[i]!)) {
    i += ENV_VALUE_OPTIONS.has(words[i]!) ? 2 : 1;
  }
  for (; i < words.length; i += 1) {
    const match = ENV_ASSIGNMENT.exec(words[i]!);
    if (match === null) break;
    if (GIT_REPOSITORY_ENV_VARS.has(match[1]!)) {
      return `${match[1]} points git at a repository or config file the line picks rather than the worktree's own, whose aliases the line does not show`;
    }
  }
  if (!runsGit(text)) return null;
  const { verbIndex } = gitGlobalOptions(words);
  const before = words[verbIndex]?.startsWith("-") === true ? words.length : verbIndex;
  for (let j = 1; j < before; j += 1) {
    const name = words[j]!.split("=")[0]!;
    if (GIT_REPOSITORY_FLAGS.has(name)) {
      return `${name} points git at a repository or config file the line picks rather than the worktree's own, whose aliases the line does not show`;
    }
  }
  return null;
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

  // A git alias defined on the way in, first: the verb a line with one runs
  // is not the verb it names, which is what the deny-list, the credential rule
  // and `git branch`'s rule read. A second line at the hook, behind the allow
  // lists that carry no entry such a line matches.
  //
  // Read in every segment the line holds — a `sh -c` body's and a
  // substitution's as well as its own — because an invocation starts at its
  // program and leaves out the assignments in front of it:
  // `sh -c 'GIT_CONFIG_COUNT=1 git x'` shows them only in the body's segment.
  for (const segment of inspection.segments) {
    for (const inner of everySegment([segment])) {
      for (const text of [inner.text, ...inner.invocations]) {
        const why = gitAliasDefinition(text);
        if (why !== null) return denied(ADMISSION_RULES.git_alias, segment.text, why);
      }
    }
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
          segment.text,
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
  //
  // Read in every segment the line holds, as the alias rule is: an
  // assignment in front of git inside a `sh -c` body or a substitution —
  // `sh -c "GIT_ASKPASS=… git fetch"` — shows only in that body's segment.
  for (const inner of everySegment(inspection.segments)) {
    for (const text of [inner.text, ...inner.invocations]) {
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

  // A git pointed at a repository or a config file the line picks, whose
  // aliases the line does not show; a second line at the hook, as the alias
  // rule is. After the
  // credential rule, so a credential key written into such a repository is
  // named as the credential it is. The environment is
  // judged on any line that runs git anywhere — `export HOME=/tmp/h; git x` —
  // since an assignment in one segment is the environment of the next.
  const lineRunsGit = everySegment(inspection.segments).some((segment) =>
    [segment.text, ...segment.invocations].some(runsGit),
  );
  for (const segment of inspection.segments) {
    for (const inner of everySegment([segment])) {
      for (const text of [inner.text, ...inner.invocations]) {
        const why = lineRunsGit || runsGit(text) ? gitRepositoryRedirect(text) : null;
        if (why !== null) return denied(ADMISSION_RULES.git_repository_redirect, segment.text, why);
      }
    }
  }

  // A `git branch` that changes a branch. Not a deny-list entry: listing
  // branches is a read the executor and the chat both need, so the refusal is
  // keyed on the words `git branch` is given, read against the segment and
  // every command the resolver found it runs — `env git branch -D main`,
  // `sh -c 'git branch -D main'` and `X=-D; git branch $X main` included.
  for (const segment of inspection.segments) {
    for (const text of [segment.text, ...segment.invocations]) {
      const why = gitBranchWrite(text);
      if (why !== null) {
        return denied(ADMISSION_RULES.git_branch_write, segment.text, why);
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
        detail,
        escaped.detail,
      );
    }
    return denied(
      writeRule(escaped),
      escaped.target ?? detail,
      escaped.detail,
    );
  }

  // A verb git does not define runs an alias or an external command the line
  // does not show; a second line at the hook, as the alias rule is. Last,
  // because every rule above either
  // reads no verb or reads one git defines, so a line one of them refuses is
  // named by that rule; this one is what a line all of them admit still has
  // to answer.
  for (const segment of inspection.segments) {
    for (const inner of everySegment([segment])) {
      for (const text of [inner.text, ...inner.invocations]) {
        const why = gitUnknownVerb(text);
        if (why !== null) return denied(ADMISSION_RULES.git_verb_unknown, segment.text, why);
      }
    }
  }

  // And that is every refusal the runner authors. A name the allow-list does
  // not carry is not a third rule: the agent's permission layer admits `cd`,
  // `echo`, `pwd` and the rest of the built-ins with no entry, so refusing
  // here would record `denied` against a command that ran. If the layer did
  // refuse it, its result envelope says so and that report amends this row.
  return ALLOWED;
}
