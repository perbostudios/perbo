export interface Word {
  /** As written, so a refusal names what the agent typed. */
  raw: string;
  /** Quotes and escapes removed. */
  value: string;
  /** Command bodies found in `$(…)` or backticks outside single quotes. */
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
  | { kind: "stdin"; source: StdinSource }
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
  if (text.startsWith("`", from)) {
    const close = text.indexOf("`", from + 1);
    return close === -1 ? null : { body: text.slice(from + 1, close), end: close + 1 };
  }
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
      substitutions.push(read.body);
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

/**
 * What a `(` the scan stands inside opened: a list of commands (a subshell, a
 * group), a process substitution `<(…)`, or a parenthesis inside a word, as an
 * array assignment's `x=(…)` is. It decides what a `#` straight after the `)`
 * that closes it is: a comment after a list, a character after a process
 * substitution, and after a word's parenthesis a character to bash and a
 * comment to zsh.
 */
type Paren = "list" | "substitution" | "word";

/** Whether the next character starts a word, continues one, or is in dispute. */
type Position = "start" | "inside" | "disputed";

/**
 * The same line with every heredoc body removed.
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
 * With `comments`, a comment comes out too: an unquoted `#` that starts a word
 * runs to the end of its line, and the shell runs none of it — not the words
 * after it, not an operator, and not a `<<` that would otherwise take the lines
 * after it as a body. A `#` inside a word, a quoted one and an escaped one are
 * characters, and so is one inside `${…}`, `$[…]` or `((…))`, or straight after
 * a process substitution's `)`. A backslash at the end of a comment continues
 * nothing, so the newline after it still ends the command.
 *
 * Where bash and zsh disagree whether a `#` opens a comment — straight after an
 * array's `)`, inside `[[ … ]]`, after the `}` bash ends a `${…}` at and zsh
 * does not — or whether a `<<` opens a heredoc, nothing is taken out and
 * `unreadable` says why: the line cannot be read the same way under both.
 */
export function withoutHeredocBodies(
  command: string,
  options: { comments?: boolean } = {},
): { text: string; bodies: HeredocBody[]; unreadable: string | null } {
  const bodies: HeredocBody[] = [];
  const comments = options.comments === true;
  if (!command.includes("<<") && !(comments && command.includes("#"))) {
    return { text: command, bodies, unreadable: null };
  }
  let kept = "";
  let start = 0;
  let opened: Heredoc[] = [];
  let quote: string | null = null;
  let at: Position = "start";
  const parens: Paren[] = [];
  /** True inside `[[ … ]]`. */
  let condition = false;
  /** Where zsh ends the last `${…}` that bash ended sooner. */
  let zshUntil = -1;
  let unreadable: string | null = null;
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
      quote = ch;
      at = "inside";
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }
    if (ch === "`" || (ch === "$" && command[i + 1] === "(")) {
      // A heredoc inside a substitution belongs to the command the substitution
      // runs, which is read on its own.
      const read = readSubstitution(command, i);
      if (read === null) break;
      at = "inside";
      i = read.end;
      continue;
    }
    if (ch === "$" && command[i + 1] === "{") {
      const read = readParameterExpansion(command, i);
      if (read === null) break;
      if (read.zsh > read.bash) zshUntil = Math.max(zshUntil, read.zsh);
      at = "inside";
      i = read.bash;
      continue;
    }
    if (ch === "$" && command[i + 1] === "[") {
      const end = readBalanced(command, i + 1, "[", "]");
      if (end === null) break;
      at = "inside";
      i = end;
      continue;
    }
    if (comments && ch === "#" && at !== "inside") {
      const disputed =
        at === "disputed"
          ? "a # straight after a ) that closes an array, a function's name or a case pattern"
          : condition
            ? "a # that starts a word inside [[ … ]]"
            : i < zshUntil
              ? "a # after the } that bash ends a ${…} at and zsh does not"
              : null;
      if (disputed !== null) {
        unreadable ??= `${disputed} is a comment to one shell and a character to another`;
        at = "inside";
        i += 1;
        continue;
      }
      const newline = command.indexOf("\n", i);
      const end = newline === -1 ? command.length : newline;
      kept += command.slice(start, i);
      start = end;
      i = end;
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
      opened.push(read.heredoc);
      at = "inside";
      i = read.end;
      continue;
    }
    if (ch === "\n" && opened.length > 0) {
      kept += command.slice(start, i + 1);
      i = skipHeredocBodies(command, i + 1, opened, bodies);
      start = i;
      opened = [];
      at = "start";
      continue;
    }
    if (ch === "(") {
      if (at !== "inside" && command[i + 1] === "(") {
        const end = readArithmeticCommand(command, i);
        if (end !== null) {
          at = "start";
          i = end;
          continue;
        }
      }
      const before = command[i - 1];
      parens.push(
        at === "inside" ? "word" : before === "<" || before === ">" ? "substitution" : "list",
      );
      at = "start";
      i += 1;
      continue;
    }
    if (ch === ")") {
      // A `)` that closes nothing this scan opened — a `case` pattern's, or
      // one a misread `case` inside a substitution left over — closes what
      // this cannot name.
      const closed = parens.pop();
      at = closed === "list" ? "start" : closed === "substitution" ? "inside" : "disputed";
      i += 1;
      continue;
    }
    if (at !== "inside" && command.startsWith("[[", i) && /\s/.test(command[i + 2] ?? "")) {
      condition = true;
      at = "inside";
      i += 2;
      continue;
    }
    if (
      condition &&
      at !== "inside" &&
      command.startsWith("]]", i) &&
      /^(?:$|[\s;&|)])/.test(command.slice(i + 2, i + 3))
    ) {
      condition = false;
      at = "inside";
      i += 2;
      continue;
    }
    at = /\s/.test(ch) || WORD_BREAK.has(ch) ? "start" : "inside";
    i += 1;
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
 * than command text (SCP-174), and so do comments where `comments` is set. Line
 * continuations are joined next, because `git branch \<newline> -D main`
 * deletes a branch.
 */
export function scanSegments(
  command: string,
  options: { comments?: boolean } = {},
): {
  texts: string[];
  separators: string[];
  balanced: boolean;
  bodies: HeredocBody[];
  /** Why the shells disagree on what the line runs, where they do. */
  unreadable: string | null;
} {
  const read = withoutHeredocBodies(command, options);
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
        const read = readWord(segment, i);
        if (!read.balanced) balanced = false;
        const raw = `${"<".repeat(opened)}${segment.slice(start, read.end)}`;
        items.push({
          kind: "stdin",
          source: stdinSource(read.word, opened, descriptor, raw, heredocs),
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
      const close = segment.indexOf(")", i);
      const end = close === -1 ? segment.length : close + 1;
      items.push({
        kind: "redirect",
        redirect: {
          target: { raw: segment.slice(i, end), value: "", substitutions: [], variable: false },
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
