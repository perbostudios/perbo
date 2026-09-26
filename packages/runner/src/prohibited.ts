import { relative } from "node:path";
import {
  AGENT_CONFIG_PATTERNS,
  POLICY_PATTERNS,
  isAgentConfigPath,
  matchesAny,
  type ProhibitedAction,
} from "@perbo/contracts";
import {
  UNKNOWN_CWD,
  inspectWritePath,
  readCommandLine,
  resolveScope,
  everySegment,
  splitCommandSegments,
  type CommandSegment,
  type Cwd,
  type ResolvedScope,
  type WorktreeScope,
  type WriteCause,
  type WriteFinding,
} from "./shell/index.js";
import { describePushDestination, readPush, resolvePushDestination } from "./push-remote.js";

/**
 * The refusal a write finding carries, as a prohibited action. A finding about
 * a path names its rule; one about a command the guard could not read carries
 * none, and the worktree rule stands in for it.
 */
const writeAction = (finding: WriteFinding): ProhibitedAction =>
  finding.rule ?? "write_outside_worktree";

/** What a finding shows, with the default spelled once. */
export const writeCause = (finding: WriteFinding): WriteCause =>
  finding.cause ?? "outside_target";

/**
 * The prohibited-action list, detected rather than requested (docs/08, SCP-078).
 *
 * Two surfaces, because the two failure modes are different. A **command** is
 * caught before or as it runs, from the tool call the agent made. A **path** is
 * caught when the change set is sealed, which catches the same act performed by
 * a file write the command allow-list never saw.
 *
 * On the local provider the command surface is judged twice: the runner's
 * pre-execution hook decides a call before the tool runs and a refusal stops
 * it, and this module's reading of the `tool_use` block is the second opinion
 * behind it, which can only terminate the attempt after the act — what
 * ADR-0004's amendment says of the surface, and what still holds for every call
 * the hook did not answer. What is genuinely prevented is that refusal, what
 * the tool allow-list refuses, and what the runner simply never delegates — the
 * credential, the push and the pull request.
 */

export interface ProhibitedHit {
  action: ProhibitedAction;
  detail: string;
  /**
   * What a write hit shows (SCP-234). `outside_target` is a write this reading
   * placed outside the worktree; `unreadable_program` is an interpreter's
   * program the guard could not classify, which refuses the command and shows
   * no write at all — so it is not something to end an attempt over. Absent on
   * every hit a command or program rule decided: those name an act, not a destination.
   */
  cause?: WriteCause;
}

interface CommandRule {
  action: ProhibitedAction;
  pattern: RegExp;
  detail: string;
}

/**
 * `git`, with any number of global flags before the verb.
 *
 * `git -C /path push --force` is the same act as `git push --force` and a
 * verb-anchored pattern misses it entirely. Found by dogfooding this repository,
 * where the agent reached for `git -C <worktree> show` naturally — which is
 * harmless, and told us that the mutating forms were equally invisible.
 *
 * A flag may carry its value as a separate token (`-C /path`, `-c user.name=x`),
 * which is why the group swallows an optional non-flag token after each flag.
 * The cost is a false positive on a contrived form like `git log --grep=x push`;
 * that terminates an attempt with a recorded reason, which is the safe
 * direction for a rule whose whole job is refusing.
 */
const GIT_GLOBAL_FLAG = String.raw`-{1,2}[A-Za-z][\w-]*(?:=\S+)?(?:\s+[^\s-]\S*)?\s+`;
/**
 * The verb may be quoted. `git "push" --force` is the same push, and a rule
 * that reads the quote as part of the word refuses nothing.
 *
 * Every rule built with `git` below is also case-insensitive, because this
 * targets a case-insensitive filesystem where `Git push --force` runs.
 */
const QUOTE = String.raw`["']?`;
/**
 * Where a verb ends (SCP-243).
 *
 * `\b` is a boundary between `merge` and `-`, so the `merge` rule matched the
 * front of `git merge-base --is-ancestor HEAD origin/main` — a read-only
 * ancestry check — and terminated AYO-66's attempt as `self_merge`. A `-`
 * continues a verb rather than ending one: `merge-base`, `merge-tree` and
 * `merge-file` are three verbs of their own, and so is every other `<verb>-…`
 * spelling this helper is given.
 */
const VERB_END = String.raw`(?![\w-])`;
const git = (verb: string) =>
  new RegExp(String.raw`\bgit\s+(?:${GIT_GLOBAL_FLAG})*${QUOTE}${verb}${QUOTE}${VERB_END}`, "i");

/**
 * The rules a pattern can decide. `write_outside_worktree` is not one of them:
 * it asks where a path lands, which `writeHits` below answers by resolving the
 * target rather than by matching how it was written.
 */
/**
 * The bare `git push` rule's sentence. The rule matches the word; whether the
 * push is the runner's is decided by where its remote goes (`push-remote.ts`):
 * a remote inside the attempt's worktree or its temporary directory publishes
 * nothing and is permitted, and every other destination is refused with the
 * place it resolved to beside this sentence.
 */
const PUSH_IS_THE_RUNNERS = "the runner performs the push, not the agent";

const COMMAND_RULES: CommandRule[] = [
  {
    action: "destructive_git",
    pattern: new RegExp(`${git("push").source}[^\\n]*\\s(--force\\b|-f\\b|--force-with-lease\\b)`, "i"),
    detail: "force-push",
  },
  {
    action: "destructive_git",
    pattern: new RegExp(`${git("push").source}[^\\n]*\\s--delete\\b`, "i"),
    detail: "branch deletion by push",
  },
  {
    action: "destructive_git",
    pattern: new RegExp(`${git("branch").source}[^\\n]*\\s-[dD]\\b`, "i"),
    detail: "branch deletion",
  },
  {
    action: "destructive_git",
    pattern: new RegExp(`${git("reset").source}[^\\n]*\\s--hard\\b`, "i"),
    detail: "hard reset",
  },
  {
    action: "destructive_git",
    pattern: git("(?:rebase|filter-branch|filter-repo)"),
    detail: "history rewrite",
  },
  { action: "destructive_git", pattern: git("push"), detail: PUSH_IS_THE_RUNNERS },
  { action: "self_merge", pattern: /\bgh\s+pr\s+merge\b/, detail: "merging a pull request" },
  {
    action: "self_merge",
    pattern: new RegExp(`${git("merge").source}[^\\n]*\\borigin/(?:main|master)\\b`, "i"),
    detail: "merging into the default branch",
  },
  { action: "registry_publication", pattern: /\b(npm|pnpm|yarn)\s+publish\b/, detail: "package publication" },
  { action: "registry_publication", pattern: /\b(cargo|gem|poetry|uv)\s+publish\b/, detail: "package publication" },
  { action: "registry_publication", pattern: /\btwine\s+upload\b/, detail: "package publication" },
  {
    action: "registry_publication",
    pattern: new RegExp(`${git("tag").source}[^\\n]*\\bv?\\d+\\.\\d+\\.\\d+`, "i"),
    detail: "release-pattern tag",
  },
  {
    action: "non_local_migration",
    pattern: /(DATABASE_URL|POSTGRES_URL|DB_URL)\s*=\s*["']?[a-z+]+:\/\/(?!(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]))/i,
    detail: "a migration or command against a non-local connection string",
  },
  { action: "external_communication", pattern: /\bgh\s+issue\s+comment\b/, detail: "commenting on an issue" },
  {
    action: "external_communication",
    pattern: /\b(curl|wget)\b[^\n]*\b(hooks\.slack\.com|discord\.com\/api\/webhooks|api\.telegram\.org)/,
    detail: "posting to a chat webhook",
  },
  { action: "new_registry_dependency", pattern: /\b(npm|pnpm|yarn|bun)\s+(add|install)\s+[a-z@][^\s-][^\n]*/, detail: "adding a dependency" },
  { action: "new_registry_dependency", pattern: /\b(pip|uv)\s+(install|add)\s+[a-z][^\n]*/, detail: "adding a dependency" },
  { action: "enable_own_tooling", pattern: /\bclaude\s+mcp\b/, detail: "connecting a tool server" },
  { action: "enable_own_tooling", pattern: /\bclaude\s+plugin/, detail: "installing a plugin" },
];

/**
 * A rule whose act is running a program, whatever its arguments: the program is
 * one the segment runs, not a word that appears on its line.
 *
 * The shell reader says what each segment runs — the basename behind `sudo`,
 * `env VAR=x`, `command`, `exec`, `nohup`, `xargs`, `time` and the rest of its
 * wrapper table, the body of a `sh -c`, an `eval` or a `bash <<EOF`, the body of
 * every `$(…)`, backtick pair and `<(…)`/`>(…)` as a segment of its own, the
 * program behind `find -exec` and `rg --pre`, the program a path spells — so
 * these rules ask it rather than a pattern. `grep -iE 'e-?mail' letter.md`
 * searches for the word and runs `grep`; `echo x | sudo sendmail -t` runs
 * `sendmail`.
 *
 * Where the reader has no reliable answer the name is a hit on a spelling,
 * which is the safe direction for a rule whose whole job is refusing:
 *
 * - anywhere in a segment it could not account for, such as `sh notify.sh`;
 * - anywhere in a segment running one of `LAUNCHERS`, programs that run an
 *   argument as a program in a way the reader does not model —
 *   `make --eval='t:;@mail …'`, `watch mail …`;
 * - as a word in a segment running one of `STAGERS`, because a program staged
 *   under another name is still that program: `ln -s /usr/sbin/sendmail t &&
 *   ./t -t` runs `sendmail` as `t`. A directory named `mail` is not a word
 *   whose last component is the name, so `ls src/mail` and `cat
 *   /var/mail/x` are not hits;
 * - as an absolute or home-relative path in a segment running one of
 *   `COPIERS`, which stage a program by copying its bytes: `cat
 *   /usr/sbin/sendmail > t && chmod +x t && ./t`. Only a path from `/` or `~`
 *   counts, because these read files all day and `cat templates/mail` in a
 *   repository is a file called `mail`, not the program. A glob that expands
 *   to the program (`cat /usr/sbin/sendm* > t`) is not seen.
 *
 * Names compare case-insensitively, because a case-insensitive filesystem runs
 * `MAIL` as `mail`.
 *
 * What neither reading sees, and nothing else stops: a script the attempt
 * writes and then runs (`echo 'mail …' > n.sh && sh n.sh`, a Makefile it
 * wrote), a program run through configuration rather than the line (`git -c
 * alias.x='!mail …' x`, `tar --to-command=mail`), and a `case` pattern's `)`
 * inside a substitution, which the reader takes for the substitution's end and
 * zsh does not (`$(case x in x) mail …;; esac)`). The write guard does not
 * read `make --eval` recipes either.
 */
interface ProgramRule {
  action: ProhibitedAction;
  programs: readonly string[];
  detail: string;
}

const PROGRAM_RULES: ProgramRule[] = [
  { action: "external_communication", programs: ["mail", "sendmail", "mailx"], detail: "sending mail" },
];

/**
 * Programs that run another program named in their arguments, where the shell
 * reader does not find that program: `make`'s `--eval` and `-E` take makefile
 * text whose recipes run, and the rest take the program as an operand after
 * options this reader has no table for.
 */
const LAUNCHERS = new Set([
  "make",
  "gmake",
  "watch",
  "parallel",
  "script",
  "setsid",
  "flock",
  "caffeinate",
  "arch",
  "chroot",
  "unbuffer",
]);

/** Programs that put a program at a path under a name of the caller's choosing. */
const STAGERS = new Set(["ln", "cp", "mv", "install", "chmod"]);

/** Programs that copy a file's bytes wherever the caller says, a program's included. */
const COPIERS = new Set(["cat", "dd", "tee"]);

function runsProgram(segment: CommandSegment, rule: ProgramRule): boolean {
  const names = rule.programs.join("|");
  const anywhere = new RegExp(String.raw`\b(?:${names})\b`, "i");
  // A word whose last component is the name — `sendmail`, `/usr/sbin/sendmail`,
  // `./mail`, not `mailbox`, `mail.txt` or `src/mail/x` — and, as `path`, one
  // spelled from the root or from home: `if=/usr/bin/mail`, `~/bin/mail`, not
  // `templates/mail`.
  const spelled = (from: string) =>
    new RegExp(String.raw`(?:^|[\s"'=(\`])${from}(?:[^\s"'\`;&|<>()]*/)?(?:${names})(?=$|[\s"'\`;&|<>()])`, "i");
  const word = spelled("");
  const path = spelled("[/~]");
  return everySegment([segment]).some((inner) => {
    const runs = inner.programs.map((program) => program.toLowerCase());
    const running = (programs: ReadonlySet<string>) => runs.some((program) => programs.has(program));
    if (!inner.accounted) return anywhere.test(inner.text);
    if (running(LAUNCHERS) && anywhere.test(inner.text)) return true;
    if (running(STAGERS) && word.test(inner.text)) return true;
    if (running(COPIERS) && path.test(inner.text)) return true;
    return runs.some((program) => rule.programs.includes(program));
  });
}

/**
 * `pnpm install` with no package argument restores the lockfile and is how a
 * worktree becomes runnable; `pnpm add left-pad` is prohibited action 10. The
 * rule above cannot tell them apart on its own, so bare installs are exempted
 * here rather than by weakening the pattern.
 */
const DEPENDENCY_EXEMPT = /\b(npm|pnpm|yarn|bun)\s+(install|ci)\s*(--[a-z-]+(=\S+)?\s*)*$/;

/**
 * One shell line, as a list of the commands it actually runs.
 *
 * Two reasons this is not the whole string.
 *
 * **A line continuation is not a boundary.** `git branch \<newline> -D main`
 * deletes a branch, and rules written as `verb[^\n]*flag` cannot see across the
 * newline. Continuations are joined first.
 *
 * **A rule is about a command, not about the line.** Evaluating a rule against
 * the whole text let one command exempt another: `pnpm add left-pad && pnpm
 * install` matched the dependency rule and also matched the bare-install
 * exemption, so nothing was reported — seven characters disabled prohibited
 * action 10. `pip install evil-pkg && npm install` did the same across two
 * different package managers. Per segment, each command answers for itself.
 *
 * The split is quote-aware: a separator inside a quoted argument, a
 * substitution or a subshell belongs to the command, not between two of them.
 */
export function commandSegments(command: string): string[] {
  return splitCommandSegments(command);
}

/** Where the shell that runs a command line stands, before and after it. */
export interface ShellCwd {
  /** Absolute. Null only where the caller named no worktree root. */
  path: string | null;
  /** True after a move the resolver could not read. */
  unknown: boolean;
  /**
   * The same directory relative to the worktree root, or `UNKNOWN_CWD` — the
   * spelling a record carries, so a refusal can be read against it.
   */
  relative: string;
}

export interface CommandInspection {
  hits: ProhibitedHit[];
  /**
   * Where this line leaves the shell. A caller that runs its command lines in
   * one shell hands this back as the next line's `scope.cwd`.
   */
  cwd: ShellCwd;
  /**
   * The commands the line runs, each with the programs behind its wrappers and
   * whether it writes to a path it names. What an admission decision is made
   * from, beside the write findings below.
   */
  segments: CommandSegment[];
  /**
   * Every write the line makes that does not land inside the worktree, with the
   * target as written. The same facts the `write_outside_worktree` hits carry,
   * kept structured so a refusal can name the path rather than quote a sentence.
   */
  writes: WriteFinding[];
}

function describeCwd(cwd: Cwd, scope: ResolvedScope): ShellCwd {
  if (cwd.unknown) return { path: cwd.path, unknown: true, relative: UNKNOWN_CWD };
  if (scope.root === null || cwd.path === null) {
    return { path: cwd.path, unknown: false, relative: "." };
  }
  const at = relative(scope.root, cwd.path);
  return { path: cwd.path, unknown: false, relative: at.length === 0 ? "." : at };
}

/**
 * Where a shell stands before any line moves it, spelled the way a record
 * carries it.
 *
 * The same resolution and the same spelling `inspectCommandWithCwd` gives the
 * directory a line leaves the shell in, so a decision made without reading a
 * line names its directory the way every other decision does.
 */
export function describeShellCwd(scope: WorktreeScope): ShellCwd {
  const resolved = resolveScope(scope);
  return describeCwd({ path: resolved.base, unknown: resolved.baseUnknown }, resolved);
}

/**
 * `scope` names the attempt's worktree, which is what `write_outside_worktree`
 * is judged against, and the directory the shell stands in, which is what a
 * relative target resolves against. Without a root the guard reads
 * conservatively: a relative target that never climbs above its start is
 * inside, everything else is out.
 */
/**
 * What may stand before a push on its line, read as text: a move of the
 * shell to a literal path, or a bare `pwd`, `ls`, `true` or `:`. Nothing else
 * — no argument that is not a plain path, no substitution, no redirect, no
 * program spelled by a path, no read with arguments. Where a push goes is read
 * from the repository as it stands when the line is judged, and anything
 * else earlier on the line may change the remote, its URL or the
 * configuration before the push runs; seven readings of what "writes" means
 * each left a spelling, so the rule is the shape that is permitted and
 * everything else refuses. A change made on an earlier line is read live, so
 * the executor runs a push as its own command. What the rule rests on is
 * that a line's shell does not outlive it: the executor's transport runs each
 * command in a shell of its own, so a function or alias defined on an
 * earlier line — `ls` made to write — is gone by the next.
 */
const BEFORE_A_PUSH = /^(?:(?:cd|pushd)\s+[A-Za-z0-9_.~+/-]+|pwd|ls|true|:)$/;

/** What, if anything, before the push on its line keeps it from being judged. */
function somethingBeforeThePush(earlier: readonly string[]): string | null {
  for (const text of earlier) {
    if (!BEFORE_A_PUSH.test(text.trim())) {
      return `the line runs more than a move of the shell before the push (${text.trim()})`;
    }
  }
  return null;
}

export function inspectCommandWithCwd(
  command: string,
  scope?: WorktreeScope,
): CommandInspection {
  const resolved = resolveScope(scope);
  const text = command.trim();
  const hits: ProhibitedHit[] = [];
  const seen = new Set<string>();
  // The write surface reads the line as a whole, because a `cd` in one command
  // is the working directory of the next.
  const read = readCommandLine(text, resolved);
  // Continuations joined the way the segment reader joins them, so a segment
  // is found in the line it was read from.
  const line = text.replace(/\\\r?\n/g, " ");
  const segments = commandSegments(line);
  // Where the shell stands when a segment runs: the line read up to that
  // segment, so a `cd` earlier on the line counts and nothing after it does.
  let consumed = 0;
  const cwdBefore = (segment: string): string | null => {
    const at = line.indexOf(segment, consumed);
    if (at < 0) return null;
    consumed = at + segment.length;
    if (resolved.baseUnknown) return null;
    if (at === 0) return resolved.base;
    const before = readCommandLine(line.slice(0, at), resolved).cwd;
    return before.unknown ? null : (before.path ?? resolved.base);
  };
  for (const [index, segment] of segments.entries()) {
    const cwd = cwdBefore(segment);
    for (const rule of COMMAND_RULES) {
      if (!rule.pattern.test(segment)) continue;
      // The exemption answers for the segment that matched, never for a
      // different command elsewhere on the line.
      if (rule.action === "new_registry_dependency" && DEPENDENCY_EXEMPT.test(segment)) continue;
      let sentence = rule.detail;
      if (rule.detail === PUSH_IS_THE_RUNNERS) {
        const reading = readPush(segment) ?? {
          remote: null,
          globals: [],
          recursesSubmodules: null,
          unreproducible: "the push could not be read",
        };
        if (reading.unreproducible === null) {
          const before = somethingBeforeThePush(segments.slice(0, index));
          if (before !== null) {
            reading.unreproducible = `${before}, so the push is run as its own command to be read`;
          }
        }
        const destination = resolvePushDestination(reading, {
          root: resolved.root,
          tmpdir: resolved.tmpdir,
          cwd,
        });
        if (destination.kind === "local") continue;
        sentence = `${rule.detail} — ${describePushDestination(destination)}`;
      }
      const key = `${rule.action}|${rule.detail ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ action: rule.action, detail: `${sentence}: ${segment}` });
    }
  }
  for (const segment of read.segments) {
    for (const rule of PROGRAM_RULES) {
      if (!runsProgram(segment, rule)) continue;
      const key = `${rule.action}|${rule.detail}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ action: rule.action, detail: `${rule.detail}: ${segment.text}` });
    }
  }
  const writes: WriteFinding[] = [];
  for (const finding of read.findings) {
    const action = writeAction(finding);
    const key = `${action}|${finding.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    writes.push(finding);
    hits.push({ action, detail: finding.detail, cause: writeCause(finding) });
  }
  return { hits, cwd: describeCwd(read.cwd, resolved), segments: read.segments, writes };
}

/** The same reading, for a caller that has no shell to carry forward. */
export function inspectCommand(command: string, scope?: WorktreeScope): ProhibitedHit[] {
  return inspectCommandWithCwd(command, scope).hits;
}

/**
 * The tools that write a file, and the inputs that name where (SCP-177).
 *
 * A file tool takes a path, not a command line, and reading that path as shell
 * text answers a different question: `Write /etc/hosts` parses as a command
 * named `Write` with an argument, and nothing about it is a redirect. So the
 * path is judged as a path — by the shell guard's own resolver, against the same
 * worktree root, following the same symlinks — before the tool runs, and a
 * destination outside the root is the same `write_outside_worktree` refusal a
 * `> /etc/hosts` would earn.
 */
export const FILE_WRITE_TOOL_PATHS: Record<string, readonly string[]> = {
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path", "file_path"],
};

/** The destinations one tool call names, in the order the tool would write them. */
export function toolWritePaths(tool: string, input: unknown): string[] {
  const keys = FILE_WRITE_TOOL_PATHS[tool];
  if (keys === undefined) return [];
  const record = (input ?? {}) as Record<string, unknown>;
  const paths: string[] = [];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0 && !paths.includes(value)) {
      paths.push(value);
    }
  }
  return paths;
}

/**
 * Judge a file tool's destination before the tool runs. A tool this does not
 * know writes nothing and returns nothing, so a `Read` or a `Grep` is unaffected.
 */
export function inspectToolWrite(
  tool: string,
  input: unknown,
  scope?: WorktreeScope,
): ProhibitedHit[] {
  const resolved = resolveScope(scope);
  const hits: ProhibitedHit[] = [];
  for (const path of toolWritePaths(tool, input)) {
    const outside = inspectWritePath(path, resolved);
    if (outside === null) continue;
    hits.push({
      action: writeAction(outside),
      detail: `the ${tool} destination ${outside.detail}`,
      cause: writeCause(outside),
    });
  }
  return hits;
}

/**
 * Paths that judge the attempt or govern the system judging it (D-045).
 *
 * The list is deliberately short. "Do not modify the tests" is too broad to
 * ship — writing tests is most of what implementing a ticket is — so what is
 * immutable is the pinned check set, the review policy, the corpus, and
 * anything the repository explicitly marked protected. Everything else is the
 * agent's to write.
 */
export interface JudgingArtifacts {
  /** Repository-relative paths pinned at plan approval. */
  pinned_checks: readonly string[];
  /** Paths a repository marked `protected` or `contract`. */
  protected_tests: readonly string[];
  /**
   * Globs the run configuration names as judging this attempt — a review
   * policy, a corpus, a fixture tree. They come from `<repo>/.perbo/config.json`
   * (`protected_paths`), because what judges an attempt is a property of the
   * repository being worked on, not of the runner.
   */
  protected_paths: readonly string[];
}

/**
 * The one judging path every repository has: the ticket store, the recorded
 * principles and the run configuration itself live under `.perbo/`. Anything
 * repository-specific is declared in that configuration rather than here.
 */
export const REVIEW_POLICY_PATTERNS = [".perbo/**", "**/.perbo/**"] as const;

export function inspectPaths(
  paths: readonly string[],
  judging: JudgingArtifacts = { pinned_checks: [], protected_tests: [], protected_paths: [] },
  scope?: WorktreeScope,
): ProhibitedHit[] {
  const resolved = resolveScope(scope);
  const hits: ProhibitedHit[] = [];
  for (const path of paths) {
    if (matchesAny(path, POLICY_PATTERNS)) {
      hits.push({
        action: "write_policy_path",
        detail: `${path} governs the policy the system runs under`,
      });
    }
    if (isAgentConfigPath(path)) {
      hits.push({
        action: "enable_own_tooling",
        detail: `${path} is repository-supplied agent configuration, which is attempt-immutable (ADR-0030)`,
      });
    }
    if (
      matchesAny(path, REVIEW_POLICY_PATTERNS) ||
      matchesAny(path, judging.protected_paths) ||
      judging.pinned_checks.includes(path) ||
      judging.protected_tests.includes(path)
    ) {
      hits.push({
        action: "modify_judging_artifact",
        detail: `${path} is part of what judges this attempt (D-045)`,
      });
    }
    // A path is judged by where it lands: an absolute path inside the worktree
    // and a `..` that comes back are both writes to the same tree, and a
    // symlink is where it points.
    const outside = inspectWritePath(path, resolved);
    if (outside !== null) {
      hits.push({
        action: writeAction(outside),
        detail: outside.detail,
        cause: writeCause(outside),
      });
    }
  }
  return hits;
}

/** For a message the human will read, not for a policy decision. */
export const AGENT_CONFIG_PATTERN_LIST: readonly string[] = AGENT_CONFIG_PATTERNS;
