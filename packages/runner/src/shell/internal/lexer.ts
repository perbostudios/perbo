export interface Word {
  /** As written, so a refusal names what the agent typed. */
  raw: string;
  /** Quotes and escapes removed. */
  value: string;
  /**
   * Command bodies found in `$(…)`, backticks or `<(…)` outside single quotes,
   * and inside the arithmetic of a `$((…))`.
   */
  substitutions: string[];
  /** True when an unexpanded `$name` or `${name}` survives in the value. */
  variable: boolean;
  /**
   * True for a word that belongs to a redirect rather than to the command: its
   * target, or the descriptor number written against its operator. Both join
   * the command's words so a write verb's operands are judged with them, and
   * neither can be the command word — a wrapper that lost its own is still
   * option-only with `> log.txt` or `2>&1` after it (SCP-186).
   */
  redirect?: boolean;
  /**
   * True for a word of a `find` body that holds the path the walk finds, where
   * the body spells `{}`: a name the files on disk give, not the line.
   */
  found?: boolean;
}

interface Redirect {
  target: Word | null;
  reason: string | null;
}

/**
 * Where a command's standard input comes from, as the line spells it.
 *
 * It matters for one class of command: an interpreter or a shell given no
 * program on its command line runs whatever arrives on standard input, so the
 * question "what is this process about to run" is answered here or not at all.
 */
export type StdinSource =
  | { kind: "heredoc"; tag: string; expanded: boolean; body: string }
  /** A here-string, `<<< word`, whose text is on the line. */
  | { kind: "word"; word: Word }
  /** A file, `< path`, whose contents this guard does not read. */
  | { kind: "file"; word: Word }
  /** A descriptor or an input this guard cannot name at all. */
  | { kind: "opaque"; raw: string }
  /** The stage before it in a pipeline, as the words that stage was written as. */
  | { kind: "pipe"; producer: Word[] };

export type Item =
  | { kind: "word"; word: Word }
  | { kind: "redirect"; redirect: Redirect }
  | {
      kind: "stdin";
      source: StdinSource;
      /**
       * The command bodies the shell runs to build this input: a `$(…)` in a
       * here-string, in a file name or in an unquoted here-document's body, and
       * the body of a `< <(…)`. They run before the command does, whatever it
       * makes of the input.
       */
      substitutions: string[];
    }
  | { kind: "operator"; text: string };

const WORD_BREAK = new Set([">", "<", "|", ";", "&", "(", ")"]);

/**
 * The operators that end one command and start the next.
 *
 * `&&`, `||` and `;` run the next command in the same shell, so a `cd` before
 * one moves it. `|`, `|&` and `&` run their command in a subshell, so a `cd`
 * inside it moves nothing after it.
 */
export const SEQUENTIAL_OPERATORS = new Set(["&&", "||", ";", "\n", "\r\n", ""]);

/** Read the operator at `from`, longest form first, or null. */
function readOperator(text: string, from: number): string | null {
  const two = text.slice(from, from + 2);
  if (two === "&&" || two === "||" || two === "|&") return two;
  const newline = /^\r?\n/.exec(text.slice(from));
  if (newline !== null) return newline[0];
  const ch = text[from];
  return ch === ";" || ch === "|" || ch === "&" ? ch : null;
}

/** Read the body of a `$(…)` or a backtick pair, tracking nesting and quotes. */
function readSubstitution(text: string, from: number): { body: string; end: number } | null {
  if (text.startsWith("`", from)) return readBackticks(text, from);
  let depth = 1;
  let quote: string | null = null;
  for (let i = from + 2; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === "\\" && quote === '"') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { body: text.slice(from + 2, i), end: i + 1 };
    }
  }
  return null;
}

/**
 * A backtick pair's body, as the shell runs it.
 *
 * Inside backticks a backslash before a backtick, a `$` or another backslash
 * is removed and the character after it kept, so `` \` `` opens a
 * substitution nested in this one rather than closing it: bash runs
 * `` echo `echo \`rm x\`` `` as `echo `rm x``, which runs `rm`. Before any
 * other character the backslash stays.
 */
function readBackticks(text: string, from: number): { body: string; end: number } | null {
  let body = "";
  for (let i = from + 1; i < text.length; i += 1) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === "\\" && (next === "`" || next === "$" || next === "\\")) {
      body += next;
      i += 1;
      continue;
    }
    if (ch === "`") return { body, end: i + 1 };
    body += ch;
  }
  return null;
}

/**
 * A process substitution whose `<` or `>` is at `from`: its body and where it
 * ends, or, where it never closes, the rest of the text as its body.
 */
function readProcess(text: string, from: number): { body: string; end: number; closed: boolean } {
  const read = readSubstitution(text, from);
  return read === null ? { body: text.slice(from + 2), end: text.length, closed: false } : { ...read, closed: true };
}

/**
 * The command bodies a substitution starting at `from` runs, given what
 * `readSubstitution` read there.
 *
 * `$((…))` is arithmetic, not a command: its text runs nothing, and only a
 * substitution written inside it does. It is arithmetic only where the inner
 * `(` closes at the end, as bash and zsh read it: `$((a) ; (b))` is a command
 * substitution running two subshells, and runs `a` and `b`.
 */
function substitutionBodies(text: string, from: number, read: { body: string; end: number }): string[] {
  const arithmetic = text.startsWith("$((", from) && readSubstitution(text, from + 1)?.end === read.end - 1;
  return arithmetic ? substitutionsIn(read.body.slice(1, -1)) : [read.body];
}

/**
 * The command bodies in text the shell expands without splitting it into
 * words — an unquoted here-document's body, an arithmetic expression — where a
 * quote is a character and only a backslash, a `$(…)` and a backtick pair mean
 * anything.
 */
export function substitutionsIn(text: string): string[] {
  const bodies: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`" || (ch === "$" && text[i + 1] === "(")) {
      const read = readSubstitution(text, i);
      if (read === null) {
        bodies.push(text.slice(i + (ch === "`" ? 1 : 2)));
        break;
      }
      bodies.push(...substitutionBodies(text, i, read));
      i = read.end;
      continue;
    }
    i += 1;
  }
  return bodies;
}

/**
 * How the shell expands a word a `$(…)` or a backtick pair builds, or one of
 * the variables in `built` whose value is built when the line runs: the text
 * the line spells ahead of the first expansion, and whether a substitution or
 * a variable stands outside double quotes, where the shell splits what it
 * expands to into further words. A process substitution is the path the
 * shell replaces it with, `/dev/fd/<n>`. Null for a word neither builds.
 */
export function substitutedShape(
  raw: string,
  built: ReadonlySet<string> = new Set(),
): { prefix: string; splits: boolean } | null {
  const shape = expansionShape(raw, built);
  return shape.builds ? { prefix: shape.prefix, splits: shape.splits } : null;
}

/**
 * The text a word spells ahead of its first expansion — a variable, a
 * positional or special parameter, a `$(…)` or a backtick pair — and whether
 * the shell splits what one expands to into further words, or null for a word
 * with none. `$Y`, `"${Y}"`, `$1` and `$@` begin with one: what the word
 * begins with is not on the line.
 */
export function expandedPrefix(raw: string): { prefix: string; splits: boolean } | null {
  const shape = expansionShape(raw, new Set());
  return shape.expanded ? { prefix: shape.prefix, splits: shape.splits } : null;
}

function expansionShape(
  raw: string,
  built: ReadonlySet<string>,
): { prefix: string; splits: boolean; builds: boolean; expanded: boolean } {
  if (raw.startsWith("<(") || raw.startsWith(">(")) {
    return { prefix: "/dev/fd/", splits: false, builds: true, expanded: true };
  }
  let prefix = "";
  let expanded = false;
  let splits = false;
  let builds = false;
  let quote: string | null = null;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else if (!expanded) prefix += ch;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      if (!expanded) prefix += raw[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (quote === null && (ch === '"' || ch === "'")) {
      quote = ch;
      i += 1;
      continue;
    }
    if (quote === '"' && ch === '"') {
      quote = null;
      i += 1;
      continue;
    }
    if (ch === "`" || (ch === "$" && raw[i + 1] === "(")) {
      builds = true;
      expanded = true;
      if (quote === null) splits = true;
      const read = readSubstitution(raw, i);
      if (read === null) break;
      i = read.end;
      continue;
    }
    if (ch === "$" && /[A-Za-z0-9_{@*#?$!-]/.test(raw[i + 1] ?? "")) {
      expanded = true;
      if (quote === null) splits = true;
      const name = /^\{?[#!]?([A-Za-z_][A-Za-z0-9_]*)/.exec(raw.slice(i + 1))?.[1];
      if (name !== undefined && built.has(name)) builds = true;
    }
    if (!expanded) prefix += ch;
    i += 1;
  }
  return { prefix, splits, builds, expanded };
}

/**
 * The command a word begins with the `$(…)` of — bare or inside double
 * quotes, and not arithmetic — and the text the word goes on with after it,
 * as written. Null where the word begins with anything else.
 */
export function leadingSubstitution(raw: string): { body: string; after: string } | null {
  const at = raw.startsWith('"$(') ? 1 : raw.startsWith("$(") ? 0 : -1;
  if (at === -1 || raw.startsWith("$((", at)) return null;
  const read = readSubstitution(raw, at);
  return read === null ? null : { body: read.body, after: raw.slice(read.end) };
}

/**
 * A word with each `$((…))` whose arithmetic spells only numbers and
 * operators written as `digit`, or null where it has none. Such an expansion
 * prints a number and runs nothing; one that names a variable is left as it
 * is, since bash evaluates a variable's value as arithmetic in turn, and a
 * subscript in it can run a command.
 */
export function literalArithmetic(raw: string, digit: string): string | null {
  let out = "";
  let quote: string | null = null;
  let changed = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      out += raw.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "'" && quote === null) quote = "'";
    else if (ch === '"') quote = quote === '"' ? null : '"';
    else if (raw.startsWith("$((", i)) {
      const read = readSubstitution(raw, i);
      const arithmetic = read !== null && readSubstitution(raw, i + 1)?.end === read.end - 1;
      if (arithmetic && /^[\d\s+\-*/%()]*$/.test(read.body.slice(1, -1))) {
        out += digit;
        changed = true;
        i = read.end;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return changed ? out : null;
}

/** What a backslash inside double quotes escapes, as bash reads it. */
const DOUBLE_QUOTED_ESCAPES = new Set(["$", "`", '"', "\\", "\n"]);

function readWord(text: string, from: number): { word: Word; end: number; balanced: boolean } {
  let value = "";
  const substitutions: string[] = [];
  let variable = false;
  let balanced = true;
  let quote: string | null = null;
  let i = from;
  while (i < text.length) {
    const ch = text[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else value += ch;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      // Inside double quotes a backslash escapes only `$`, a backtick, `"`, `\`
      // and a newline, as bash reads it; before any other character it stays in
      // the word, which on Windows makes it a separator.
      const next = text[i + 1] ?? "";
      if (quote === '"' && !DOUBLE_QUOTED_ESCAPES.has(next)) value += ch;
      value += next;
      i += 2;
      continue;
    }
    if (quote === null && (ch === '"' || ch === "'")) {
      quote = ch;
      i += 1;
      continue;
    }
    if (quote === '"' && ch === '"') {
      quote = null;
      i += 1;
      continue;
    }
    if (ch === "`" || (ch === "$" && text[i + 1] === "(")) {
      const read = readSubstitution(text, i);
      if (read === null) {
        balanced = false;
        value += text.slice(i);
        i = text.length;
        continue;
      }
      substitutions.push(...substitutionBodies(text, i, read));
      value += text.slice(i, read.end);
      i = read.end;
      continue;
    }
    if (ch === "$") variable = true;
    if (quote === null && (/\s/.test(ch) || WORD_BREAK.has(ch))) break;
    value += ch;
    i += 1;
  }
  if (quote !== null) balanced = false;
  return { word: { raw: text.slice(from, i), value, substitutions, variable }, end: i, balanced };
}

/** A heredoc a line opened: the terminator to look for, and how to match it. */
interface Heredoc {
  tag: string;
  /** `<<-`, which strips leading tabs from the body lines and the terminator. */
  stripTabs: boolean;
  /**
   * True for `<<'EOF'` and `<<"EOF"`, whose body the shell hands over verbatim.
   * An unquoted tag lets the shell expand `$name` and `$(…)` inside the body,
   * so what the command receives is not what the line says.
   */
  quoted: boolean;
}

/** A heredoc's tag and the lines the shell feeds to the command's input. */
export interface HeredocBody extends Heredoc {
  body: string;
}

/** Read the tag of a `<<`, `from` being the character after the operator. */
function readHeredocTag(text: string, from: number): { heredoc: Heredoc; end: number } | null {
  let i = from;
  const stripTabs = text[i] === "-";
  if (stripTabs) i += 1;
  while (text[i] === " " || text[i] === "\t") i += 1;
  const read = readWord(text, i);
  if (read.word.value.length === 0) return null;
  const quoted = read.word.raw !== read.word.value;
  return { heredoc: { tag: read.word.value, stripTabs, quoted }, end: read.end };
}

/**
 * Where the text after the bodies of `opened` starts, `from` being line one,
 * and the body each of them consumed.
 */
function skipHeredocBodies(
  text: string,
  from: number,
  opened: readonly Heredoc[],
  bodies: HeredocBody[],
): number {
  let at = from;
  for (const heredoc of opened) {
    const { tag, stripTabs } = heredoc;
    const lines: string[] = [];
    while (at < text.length) {
      const newline = text.indexOf("\n", at);
      const end = newline === -1 ? text.length : newline;
      const line = text.slice(at, end).replace(/\r$/, "");
      at = newline === -1 ? end : newline + 1;
      const stripped = stripTabs ? line.replace(/^\t+/, "") : line;
      if (stripped === tag) break;
      lines.push(stripped);
    }
    bodies.push({ ...heredoc, body: lines.join("\n") });
  }
  return at;
}

/** Skip the quoted text that starts at `from`, returning where it ends, or null. */
function skipQuoted(text: string, from: number): number | null {
  const quote = text[from]!;
  for (let i = from + 1; i < text.length; i += 1) {
    if (quote === '"' && text[i] === "\\") i += 1;
    else if (text[i] === quote) return i + 1;
  }
  return null;
}

/**
 * Where a `${…}` starting at `from` ends, as bash reads it and as zsh does.
 *
 * Both skip quoted text and substitutions inside one, and both read a `#` in
 * one as a character. They disagree on a bare `{` inside: bash ends the
 * expansion at the first `}` that no nested `${` claims, and zsh counts the
 * `{`, so `${x:-{a} #}` ends after `{a}` under bash — the ` #}` then opening a
 * comment — and at the last `}` under zsh. Null where bash finds no end; where
 * zsh finds none, its end is the end of the text.
 */
function readParameterExpansion(text: string, from: number): { bash: number; zsh: number } | null {
  let bashDepth = 1;
  let zshDepth = 1;
  let bash: number | null = null;
  let i = from + 2;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = skipQuoted(text, i);
      if (end === null) break;
      i = end;
      continue;
    }
    if (ch === "`" || (ch === "$" && text[i + 1] === "(")) {
      const read = readSubstitution(text, i);
      if (read === null) break;
      i = read.end;
      continue;
    }
    if (ch === "$" && text[i + 1] === "{") {
      if (bash === null) bashDepth += 1;
      zshDepth += 1;
      i += 2;
      continue;
    }
    if (ch === "{") zshDepth += 1;
    if (ch === "}") {
      if (bash === null) {
        bashDepth -= 1;
        if (bashDepth === 0) bash = i + 1;
      }
      zshDepth -= 1;
      if (zshDepth === 0) return { bash: bash ?? i + 1, zsh: i + 1 };
    }
    i += 1;
  }
  return bash === null ? null : { bash, zsh: text.length };
}

/**
 * Where the balanced text that a `(` or `[` at `from` opens ends, just past the
 * character that closes it, or null. Quoted text and substitutions inside are
 * skipped.
 */
function readBalanced(text: string, from: number, open: string, close: string): number | null {
  let depth = 1;
  let i = from + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = skipQuoted(text, i);
      if (end === null) return null;
      i = end;
      continue;
    }
    if (ch === "`" || (ch === "$" && text[i + 1] === "(")) {
      const read = readSubstitution(text, i);
      if (read === null) return null;
      i = read.end;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return null;
}

/**
 * Where an arithmetic command `(( … ))` starting at `from` ends, or null where
 * the `((` opens two subshells. Both shells take it as arithmetic only where
 * the `)` balancing the second `(` is followed at once by another.
 */
function readArithmeticCommand(text: string, from: number): number | null {
  const inner = readBalanced(text, from + 1, "(", ")");
  return inner !== null && text[inner] === ")" ? inner + 1 : null;
}

/** The reason a line with a `#` this guard cannot read as a character is refused. */
const COMMENT = "a comment cannot be told from an argument here";

/**
 * A character that, straight before a `#`, joins the `#` to the word it
 * stands in, whatever surrounds them: a letter, a quote, a backslash, a `$`, a
 * brace. A `#` after one is a character to bash and to zsh — part of a word,
 * the parameter `$#`, a quoted or an escaped `#` — because a comment starts
 * only where a `#` begins a word. After a blank, an operator, a parenthesis or
 * a backtick, or at the start of the text, a `#` may begin one.
 */
const JOINS_A_WORD = /[^\s;&|()<>`]/;

/** The first `#` from `from` to `end` that no character joins to a word, or -1. */
function looseHash(text: string, from: number, end = text.length): number {
  for (let i = text.indexOf("#", from); i !== -1 && i < end; i = text.indexOf("#", i + 1)) {
    if (i === 0 || !JOINS_A_WORD.test(text[i - 1]!)) return i;
  }
  return -1;
}

/**
 * What can make bash or zsh end an expansion somewhere other than where the
 * readers above end it: a double quote, which the shells read as nested and
 * this may not, an escape or a newline inside it, a nested expansion, a
 * heredoc, a `case` pattern's lone `)`. A single quote is read the same way by
 * all three.
 */
const UNSURE_INSIDE = /["`\\\n]|\$[({['"]|<<|\bcase\b/;

/**
 * Whether the inside of an expansion, `from` to `end`, is one whose end the
 * readers above find where bash and zsh do: nothing in it is `UNSURE_INSIDE`,
 * no bracket in it that `nested` names, and no `#` in it may start a comment.
 */
function certain(text: string, from: number, end: number, nested: RegExp | null): boolean {
  const inside = text.slice(from, end);
  return (
    !UNSURE_INSIDE.test(inside) &&
    (nested === null || !nested.test(inside)) &&
    looseHash(text, from, end) === -1
  );
}

/**
 * Read the `$(…)`, `$((…))`, backtick pair, `${…}` or `$[…]` at `from`: where
 * bash ends it, where zsh does, and whether that end is `certain`. Null where
 * it has no end.
 */
function readExpansion(
  text: string,
  from: number,
): { end: number; zsh: number; certain: boolean } | null {
  if (text[from] === "`" || text.startsWith("$(", from)) {
    const read = readSubstitution(text, from);
    if (read === null) return null;
    // The reader counts parentheses, and the only lone `)` a command holds is
    // a `case` pattern's.
    const backtick = text[from] === "`";
    const sure = certain(text, from + (backtick ? 1 : 2), read.end - 1, null);
    return { end: read.end, zsh: read.end, certain: sure };
  }
  if (text.startsWith("${", from)) {
    const read = readParameterExpansion(text, from);
    if (read === null) return null;
    const sure = read.zsh === read.bash && certain(text, from + 2, read.bash - 1, /[{}()]/);
    return { end: read.bash, zsh: read.zsh, certain: sure };
  }
  const end = readBalanced(text, from + 1, "[", "]");
  if (end === null) return null;
  return { end, zsh: end, certain: certain(text, from + 2, end - 1, /[[\]]/) };
}

/** Whether an expansion `readExpansion` reads starts at `at`. */
const opensExpansion = (text: string, at: number): boolean =>
  text[at] === "`" || (text[at] === "$" && "([{".includes(text[at + 1] ?? "\0"));

/**
 * Whether the `$'…'` at `from` ends where a plain single quote does. In one, a
 * backslash escapes the next character, a `'` among them; read as a single
 * quote it ends at an escaped `'`, and what follows is quoted differently.
 */
function ansiQuoteReadsPlain(text: string, from: number): boolean {
  const close = text.indexOf("'", from + 2);
  if (close === -1) return true;
  let escapes = 0;
  while (text[close - 1 - escapes] === "\\") escapes += 1;
  return escapes % 2 === 0;
}

/**
 * The first `$'…'` anywhere in the text — inside a substitution or a quote too
 * — that does not end where a plain single quote does, or -1. Every reader
 * here takes a `'` as a plain single quote, so after one the whole line is
 * read quoted the other way round.
 */
function misreadAnsiQuote(text: string): number {
  for (let at = text.indexOf("$'"); at !== -1; at = text.indexOf("$'", at + 2)) {
    if (!ansiQuoteReadsPlain(text, at)) return at;
  }
  return -1;
}

/**
 * The same line with every heredoc body removed, and why the line cannot be
 * read, where it cannot.
 *
 * `cat >> file <<'EOF'` feeds the lines that follow to the command's standard
 * input. They are its data: a `>` or a `cd` written inside one redirects and
 * moves nothing, and a quote inside one opens nothing. The operator and its tag
 * stay, so the redirect standing before them is judged exactly as it was.
 *
 * A body starts after the newline that ends the line its operator stands on —
 * two operators on one line take their bodies in that order — and ends at the
 * first line equal to the tag. An unterminated body runs to the end of the
 * text. `<<<` is a here-string, whose word is on the line itself, and is left
 * alone, as is a `<<` inside `${…}`, `$[…]`, `$((…))` or `((…))`, where it is
 * text or a shift.
 *
 * What the command does with the data is the command's own — with one
 * exception, and it is the reason the bodies are returned rather than dropped:
 * where the command is an interpreter or a shell, that data **is** its program,
 * and the guard reads it as such (SCP-177).
 *
 * A comment is not taken out. Its words, read as a command's, can hide a write
 * (`cp a /etc/x # -t out`), and where one starts is not something this can
 * read with certainty: bash and zsh disagree on some, and an expansion misread
 * before a `#` moves it. So a `#` that may start a comment makes the line
 * `unreadable`, and a `#` is read as a character only where this proves it one:
 * inside a quote, or continuing a word, as this reads them. That reading holds
 * up to the first expansion or `$'…'` this cannot prove ends where the shells
 * end it (`certain`); after one, a `#` is a character only where the character
 * before it joins it to a word (`JOINS_A_WORD`).
 *
 * A `$'…'` holding an escaped `'` makes the line `unreadable` wherever it
 * stands (`misreadAnsiQuote`).
 *
 * Where bash and zsh disagree whether a `<<` opens a heredoc — after the `}`
 * bash ends a `${…}` at and zsh does not — the line is `unreadable` too, and so
 * it is where a `<<` this reads as opening one stands after an expansion or a
 * `$'…'` whose end is uncertain: it may be text inside a quote the shells read
 * as still open, and taken as a heredoc it would hide the lines after it.
 *
 * A heredoc's body starts after the newline that ends the line its `<<` stands
 * on, and a newline inside an expansion or a `((…))` ends no line. So where a
 * `<<` waits for its body behind an expansion, a `$'…'` or a `((…))` whose end
 * is uncertain — one holding a newline included — which newline starts the
 * body is uncertain too, and the line is `unreadable`.
 */
export function withoutHeredocBodies(command: string): {
  text: string;
  bodies: HeredocBody[];
  unreadable: string | null;
} {
  const bodies: HeredocBody[] = [];
  const ansi = misreadAnsiQuote(command);
  if (!command.includes("<<") && !command.includes("#") && ansi === -1) {
    return { text: command, bodies, unreadable: null };
  }
  let kept = "";
  let start = 0;
  let opened: Heredoc[] = [];
  let quote: string | null = null;
  /** Whether the next character starts a word or continues one. */
  let at: "start" | "inside" = "start";
  /** Where what is quoted stopped being certain, or -1. */
  let unsure = -1;
  /** Where zsh ends the last `${…}` that bash ended sooner. */
  let zshUntil = -1;
  /** The first `<<` whose body has not started, as written, or null. */
  let waiting: string | null = null;
  let unreadable: string | null = null;
  /** The expansion or `$'` after which what is quoted is uncertain, as written. */
  const opener = () =>
    JSON.stringify(command.slice(unsure, command[unsure] === "`" ? unsure + 1 : unsure + 2));
  const comment = (hash: number): string => {
    const excerpt = JSON.stringify(command.slice(hash, hash + 24).split("\n")[0]);
    if (unsure === -1) {
      return `the # in ${excerpt} starts a word, so it may open a comment, and ${COMMENT}`;
    }
    return (
      `the # in ${excerpt} may open a comment — what is quoted after the ${opener()} before ` +
      `it cannot be read with certainty — and ${COMMENT}`
    );
  };
  /** From `from` on, only the character before a `#` proves it a character. */
  const lose = (from: number) => {
    if (unsure !== -1) return;
    unsure = from;
    if (waiting !== null) {
      unreadable ??=
        `the << in ${waiting} takes its body from the lines after the one it stands on, and ` +
        `after the ${opener()} that follows it where that line ends cannot be read with ` +
        "certainty, so which lines are data and which the shell runs cannot be told";
    }
    const hash = looseHash(command, from);
    if (hash !== -1) unreadable ??= comment(hash);
  };
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      // An escaped newline continues the line, so the body it opens still
      // begins after the next newline that ends one, and the word it stood in
      // goes on after it.
      if (command[i + 1] !== "\n") at = "inside";
      i += 2;
      continue;
    }
    if (quote === null && (ch === '"' || ch === "'")) {
      if (ch === "'" && command[i - 1] === "$" && !ansiQuoteReadsPlain(command, i - 1)) {
        lose(i - 1);
      }
      quote = ch;
      at = "inside";
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (unsure === -1 && opensExpansion(command, i)) {
        // The shells read an expansion inside double quotes whole, a `"` in it
        // included, and this reads on to the next `"`: the same place only
        // where the expansion's end is certain.
        const read = readExpansion(command, i);
        if (read === null || !read.certain) lose(i);
      }
      i += 1;
      continue;
    }
    if (opensExpansion(command, i)) {
      // A heredoc inside a substitution belongs to the command the substitution
      // runs, which is read on its own.
      const read = readExpansion(command, i);
      if (read === null) {
        lose(i);
        break;
      }
      if (read.zsh > read.end) zshUntil = Math.max(zshUntil, read.zsh);
      if (!read.certain) lose(i);
      at = "inside";
      i = read.end;
      continue;
    }
    if (ch === "#" && at === "start") {
      if (unsure === -1) unreadable ??= comment(i);
      at = "inside";
      i += 1;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      if (command[i + 2] === "<") {
        // A here-string. Its word is on this line, and the two characters it
        // ends with are not an operator of their own.
        at = "start";
        i += 3;
        continue;
      }
      const read = readHeredocTag(command, i + 2);
      if (read === null) {
        at = "start";
        i += 2;
        continue;
      }
      if (i < zshUntil) {
        unreadable ??=
          "a << after the } that bash ends a ${…} at and zsh does not opens a heredoc " +
          "to one shell and is text to another";
      }
      if (unsure !== -1) {
        unreadable ??=
          `the << in ${JSON.stringify(command.slice(i, read.end))} may stand inside a quote — ` +
          `what is quoted after the ${opener()} before it cannot be read with certainty — and ` +
          "a heredoc it opened would take the lines the shell runs after it as data";
      }
      opened.push(read.heredoc);
      waiting ??= JSON.stringify(command.slice(i, read.end));
      at = "inside";
      i = read.end;
      continue;
    }
    if (ch === "\n" && opened.length > 0) {
      kept += command.slice(start, i + 1);
      i = skipHeredocBodies(command, i + 1, opened, bodies);
      start = i;
      opened = [];
      waiting = null;
      at = "start";
      continue;
    }
    if (ch === "(" && at !== "inside" && command[i + 1] === "(") {
      const end = readArithmeticCommand(command, i);
      if (end !== null) {
        if (!certain(command, i + 2, end - 2, null)) lose(i);
        at = "start";
        i = end;
        continue;
      }
    }
    at = /\s/.test(ch) || WORD_BREAK.has(ch) ? "start" : "inside";
    i += 1;
  }
  if (ansi !== -1) {
    unreadable ??=
      `the $'…' in ${JSON.stringify(command.slice(ansi, ansi + 16).split("\n")[0])} holds an ` +
      "escaped quote, which ends it for this guard and not for the shell";
  }
  return { text: kept + command.slice(start), bodies, unreadable };
}

/**
 * The bodies a line opened, taken by tag as each `<<` is read.
 *
 * By tag rather than by position, because the collector walks the line and the
 * lexer walks the segments it was split into: a tag names its own body under
 * either walk, and a `<<` whose body is missing is left unreadable rather than
 * handed the next one along.
 */
export function heredocQueue(bodies: readonly HeredocBody[]): Map<string, HeredocBody[]> {
  const queue = new Map<string, HeredocBody[]>();
  for (const body of bodies) {
    const held = queue.get(body.tag);
    if (held === undefined) queue.set(body.tag, [body]);
    else held.push(body);
  }
  return queue;
}

/**
 * One shell line, as the commands it runs and the separators between them.
 *
 * Splitting is quote-aware: a separator inside `"…"`, `'…'`, a `$(…)`, a
 * backtick pair or a subshell is part of a command, not a boundary. Heredoc
 * bodies come out before anything else is read, because they are input rather
 * than command text (SCP-174). Line continuations are joined next, because
 * `git branch \<newline> -D main` deletes a branch.
 */
export function scanSegments(command: string): {
  texts: string[];
  separators: string[];
  balanced: boolean;
  bodies: HeredocBody[];
  /** Why the line cannot be read, where it cannot (`withoutHeredocBodies`). */
  unreadable: string | null;
} {
  const read = withoutHeredocBodies(command);
  const bodies = read.bodies;
  const text = read.text.replace(/\\\r?\n/g, " ");
  const texts: string[] = [];
  const separators: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let depth = 0;
  let balanced = true;
  let i = 0;
  const push = (end: number, separator: string) => {
    texts.push(text.slice(start, end));
    separators.push(separator);
    start = end + separator.length;
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (quote === null && (ch === '"' || ch === "'")) {
      quote = ch;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }
    if (ch === "`" || (ch === "$" && text[i + 1] === "(")) {
      const read = readSubstitution(text, i);
      if (read === null) {
        balanced = false;
        break;
      }
      i = read.end;
      continue;
    }
    if (ch === "&" && text[i + 1] === ">") {
      // `&>` redirects both streams; the `&` is part of the operator.
      i += 1;
      continue;
    }
    if (ch === ">") {
      // `>|` is one operator, and the `&` of `2>&1` is part of this one: in
      // neither is the second character a separator.
      i += 1;
      if (text[i] === ">" || text[i] === "|") i += 1;
      if (text[i] === "&") i += 1;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }
    if (depth === 0) {
      const operator = readOperator(text, i);
      if (operator !== null) {
        push(i, operator);
        i += operator.length;
        continue;
      }
    }
    i += 1;
  }
  if (quote !== null || depth !== 0) balanced = false;
  texts.push(text.slice(start));
  separators.push("");
  return { texts, separators, balanced, bodies, unreadable: read.unreadable };
}

/** The list `inspectCommand` evaluates its pattern rules against. */
export function splitCommandSegments(command: string): string[] {
  return scanSegments(command)
    .texts.map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** Classify one input redirect, `opened` being how many `<` it was written with. */
function stdinSource(
  word: Word,
  opened: number,
  descriptor: boolean,
  raw: string,
  heredocs: Map<string, HeredocBody[]>,
): StdinSource {
  if (descriptor || word.value.length === 0) return { kind: "opaque", raw };
  if (opened === 3) return { kind: "word", word };
  if (opened === 2) {
    const held = heredocs.get(word.value);
    const body = held?.shift();
    if (body === undefined) return { kind: "opaque", raw };
    return { kind: "heredoc", tag: body.tag, expanded: !body.quoted, body: body.body };
  }
  return { kind: "file", word };
}

export function tokenize(
  segment: string,
  heredocs: Map<string, HeredocBody[]> = new Map(),
): { items: Item[]; balanced: boolean } {
  const items: Item[] = [];
  let balanced = true;
  let i = 0;
  while (i < segment.length) {
    const ch = segment[i]!;
    if (ch === "\n" || ch === "\r") {
      // A newline ends a command inside `( … )` as it does at the top level,
      // where splitting has already consumed it.
      const operator = readOperator(segment, i);
      items.push({ kind: "operator", text: operator ?? "\n" });
      i += operator?.length ?? 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "&" && segment[i + 1] === ">") {
      // `&>` redirects both streams; the redirect is read from the `>`.
      i += 1;
      continue;
    }
    if (ch === "<") {
      let opened = 1;
      i += 1;
      while (segment[i] === "<" && opened < 3) {
        opened += 1;
        i += 1;
      }
      if (opened === 1 && segment[i] === ">") {
        // `<>` opens the named file for writing as well as for reading.
        i += 1;
      } else if (opened === 1 && segment[i] === "(") {
        // `<(…)` is a process substitution: the shell runs its body and hands
        // the command a path to read the output from, so it is an operand of
        // the command whose body is a command in its own right, as a `$(…)` is.
        const { body, end, closed } = readProcess(segment, i - 1);
        if (!closed) balanced = false;
        const raw = segment.slice(i - 1, end);
        items.push({ kind: "word", word: { raw, value: raw, substitutions: [body], variable: false } });
        i = end;
        continue;
      } else {
        // An input redirect names where the command's standard input comes
        // from. Nothing is written through one — and for a command whose
        // program **is** its standard input, it is the only place the line
        // says what that program is.
        const start = i;
        if (opened === 2 && segment[i] === "-") i += 1;
        const descriptor = segment[i] === "&";
        if (descriptor) i += 1;
        while (segment[i] === " " || segment[i] === "\t") i += 1;
        if (opened === 1 && !descriptor && segment.startsWith("<(", i)) {
          // `< <(…)`: the input is a process substitution's output, which the
          // line does not spell, and its body is a command the shell runs.
          const { body, end, closed } = readProcess(segment, i);
          if (!closed) balanced = false;
          items.push({ kind: "stdin", source: { kind: "opaque", raw: `<${segment.slice(start, end)}` }, substitutions: [body] });
          i = end;
          continue;
        }
        const read = readWord(segment, i);
        if (!read.balanced) balanced = false;
        const raw = `${"<".repeat(opened)}${segment.slice(start, read.end)}`;
        const source = stdinSource(read.word, opened, descriptor, raw, heredocs);
        items.push({
          kind: "stdin",
          source,
          substitutions:
            source.kind !== "heredoc" ? read.word.substitutions : source.expanded ? substitutionsIn(source.body) : [],
        });
        i = read.end === i ? i + 1 : read.end;
        continue;
      }
    } else if (ch === ">") {
      i += 1;
      if (segment[i] === ">" || segment[i] === "|") i += 1;
      // `2>&1` and `>&-` duplicate a descriptor; they open no file.
      const duplication = /^&\s*(?:\d+|-)(?![\w./-])/.exec(segment.slice(i));
      if (duplication !== null) {
        i += duplication[0].length;
        continue;
      }
      if (segment[i] === "&") i += 1;
    } else if (ch === "(" || ch === ")") {
      items.push({ kind: "word", word: { raw: ch, value: ch, substitutions: [], variable: false } });
      i += 1;
      continue;
    } else if (WORD_BREAK.has(ch)) {
      const operator = readOperator(segment, i);
      if (operator === null) {
        i += 1;
        continue;
      }
      items.push({ kind: "operator", text: operator });
      i += operator.length;
      continue;
    } else {
      const read = readWord(segment, i);
      if (!read.balanced) balanced = false;
      // A bare number written against a redirect operator is the descriptor
      // being redirected — the `2` of `2>&1` — not an operand of the command.
      const descriptor =
        /^\d+$/.test(read.word.value) && (segment[read.end] === ">" || segment[read.end] === "<");
      items.push({
        kind: "word",
        word: descriptor ? { ...read.word, redirect: true } : read.word,
      });
      i = read.end === i ? i + 1 : read.end;
      continue;
    }

    // A redirect operator; its target is the word that follows it.
    while (segment[i] === " " || segment[i] === "\t") i += 1;
    const substitution = /^>?\(/.exec(segment.slice(i));
    if (substitution !== null) {
      // `>(…)`: the command writes into a process whose body is a command of
      // its own. Where the output goes cannot be placed, and the body is read
      // as a `$(…)`'s is.
      const { body, end, closed } = readProcess(segment, i + substitution[0].length - 2);
      if (!closed) balanced = false;
      items.push({
        kind: "redirect",
        redirect: {
          target: { raw: segment.slice(i, end), value: "", substitutions: [body], variable: false },
          reason: "a process substitution",
        },
      });
      i = end;
      continue;
    }
    const read = readWord(segment, i);
    if (!read.balanced) balanced = false;
    items.push({
      kind: "redirect",
      redirect:
        read.word.value.length > 0
          ? { target: read.word, reason: null }
          : { target: null, reason: "the operator has no target" },
    });
    i = read.end === i ? i + 1 : read.end;
  }
  return { items, balanced };
}
