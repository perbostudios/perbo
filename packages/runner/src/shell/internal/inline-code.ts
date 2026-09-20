import type { Context } from "./command.js";
import { judgeTarget, landed, ruleOf, type WriteFinding } from "./destination.js";
import {
  INLINE_READ_ONLY,
  INLINE_WRITE_CALLS,
  PLAIN_WRITE_CALLS,
  type InlineStatementForm,
} from "./inline-tables.js";
import type { Word } from "./lexer.js";
import { allowedPathsSentence, prohibitedPathsSentence, type Cwd } from "./scope.js";

/** The receiver `write_text` is read on: a `Path` built from one literal. */
const PATH_RECEIVER = /(?:\bpathlib\s*\.\s*)?\bPath\s*\(\s*(§\d+§)\s*\)\s*\.$/;

/** The streams that are not files, removed before the sentences above are read. */
const INLINE_STREAM_WRITES =
  /\b(?:process\s*\.\s*std(?:out|err)|sys\s*\.\s*std(?:out|err)|console|STDOUT|STDERR|\$stdout|\$stderr)\s*\.\s*write\s*\(/g;

/**
 * A control-flow header, which is syntax rather than vocabulary.
 *
 * SCP-234's round was lost to a scan that read `for` as a name it had never
 * heard of and called the program unclassifiable for it. The keyword names
 * nothing and calls nothing; the expression after it is read like any other,
 * and the names a `for` binds are bound by `assignedNames` below.
 */
const INLINE_CONTROL = /^(for|while|if|elif|else)\b([\s\S]*)$/;

/**
 * The languages this guard tells apart, which is as far as its reading goes.
 *
 * One question turns on it and one only: a backtick. In JavaScript it opens a
 * template literal, which is a string. In Perl, Ruby and PHP it runs a shell
 * command, which is the thing this guard exists to refuse.
 */
type InlineLanguage = "js" | "python" | "shellish" | "other";

function inlineLanguage(verb: string): InlineLanguage {
  if (verb === "node" || verb === "nodejs" || verb === "deno" || verb === "bun") return "js";
  if (verb.startsWith("python") || verb.startsWith("pypy")) return "python";
  if (verb === "perl" || verb === "ruby" || verb === "php") return "shellish";
  return "other";
}

/**
 * The code as the agent typed it, with only the quoting that wrapped it removed.
 *
 * The lexer removes every quote, which is right for a path and wrong for a
 * program: `open('/etc/x','w')` arrives as `open(/etc/x,w)`, and the two string
 * literals that say what it opens and how are gone with them. Inline code is
 * read from the raw word for that reason, unwrapped once so the quoting the
 * shell used to carry it does not count as a literal of its own.
 */
export function unwrapped(raw: string): string {
  let text = raw;
  while (text.length >= 2) {
    const first = text[0]!;
    // Quotes only. A backtick is not shell quoting — it is a command
    // substitution, which the lexer marks and this function never sees — and in
    // Perl, Ruby and PHP a backtick pair around the whole program is the spawn
    // this guard exists to refuse, not wrapping to be taken off.
    if ((first === '"' || first === "'") && text.endsWith(first)) {
      text = text.slice(1, -1);
      continue;
    }
    const second = text[1];
    if (first === "$" && (second === "'" || second === '"') && text.endsWith(second)) {
      text = text.slice(2, -1);
      continue;
    }
    break;
  }
  return text;
}

/** The quoted strings in a piece of source, whatever quote the language uses. */
function stringLiterals(code: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < code.length) {
    const quote = code[i]!;
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      i += 1;
      continue;
    }
    let value = "";
    let j = i + 1;
    while (j < code.length && code[j] !== quote) {
      if (code[j] === "\\") {
        value += code[j + 1] ?? "";
        j += 2;
        continue;
      }
      value += code[j];
      j += 1;
    }
    found.push(value);
    i = j + 1;
  }
  return found;
}

/**
 * The source with every string literal replaced by a token that stands for it.
 *
 * The scan below reads structure, and a literal is the one place where the
 * text is data rather than code: a `>` inside a string is not a redirect, and
 * `rm -rf /` inside one is not a command. Masking them first is what lets the
 * rest of the scan be a plain character-and-name check. The literals are kept
 * so the two places that need to see one — a file mode and a module name — can.
 */
function maskLiterals(
  code: string,
  language: InlineLanguage,
): { masked: string; literals: string[]; spawned: boolean } {
  const literals: string[] = [];
  let masked = "";
  let spawned = false;
  let i = 0;
  while (i < code.length) {
    const quote = code[i]!;
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      masked += quote;
      i += 1;
      continue;
    }
    let value = "";
    let j = i + 1;
    while (j < code.length && code[j] !== quote) {
      if (code[j] === "\\") {
        value += code[j + 1] ?? "";
        j += 2;
        continue;
      }
      value += code[j];
      j += 1;
    }
    if (quote === "`" && language !== "js") {
      // Perl, Ruby and PHP run what is between backticks. The backtick is kept
      // so the expression check trips on it, and named so the refusal says why.
      spawned = true;
      masked += "`";
    } else {
      masked += `§${literals.length}§`;
      literals.push(value);
    }
    i = j + 1;
  }
  return { masked, literals, spawned };
}

/** Everything after a comment marker on each line, which runs nothing. */
function withoutComments(masked: string, language: InlineLanguage): string {
  return masked
    .split("\n")
    .map((line) => {
      // `#` opens a comment everywhere but JavaScript; `//` only in JavaScript,
      // because in Python it is floor division.
      const cut = language === "js" ? line.indexOf("//") : line.indexOf("#");
      return cut === -1 ? line : line.slice(0, cut);
    })
    .join("\n");
}

/** The statements in a masked source: a `;` or a newline at nesting depth zero. */
function splitStatements(masked: string): string[] {
  const statements: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of masked) {
    if (character === "(" || character === "[" || character === "{") depth += 1;
    if (character === ")" || character === "]" || character === "}") depth -= 1;
    if (depth <= 0 && (character === ";" || character === "\n")) {
      statements.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  statements.push(current);
  return statements.map((statement) => statement.trim()).filter((statement) => statement !== "");
}

/** The vocabulary the table adds up to, read once per piece of code. */
interface InlineVocabulary {
  calls: Set<string>;
  methods: Set<string>;
  names: string[];
  modules: Set<string>;
  forms: Set<InlineStatementForm>;
}

function inlineVocabulary(): InlineVocabulary {
  const vocabulary: InlineVocabulary = {
    calls: new Set(),
    methods: new Set(),
    names: [],
    modules: new Set(),
    forms: new Set(),
  };
  for (const rule of INLINE_READ_ONLY) {
    for (const name of rule.calls ?? []) vocabulary.calls.add(name);
    for (const name of rule.methods ?? []) vocabulary.methods.add(name);
    for (const name of rule.names ?? []) vocabulary.names.push(name);
    for (const name of rule.modules ?? []) vocabulary.modules.add(name);
    for (const form of rule.forms ?? []) vocabulary.forms.add(form);
  }
  return vocabulary;
}

/**
 * Syntax rather than vocabulary: words that are part of how an expression is
 * written and name nothing the code can call.
 */
const INLINE_KEYWORDS = new Set([
  "in", "not", "and", "or", "is", "if", "else", "of", "as", "from",
  // Declaration syntax: it introduces a name rather than reading one, and a
  // JavaScript `for (const x of y)` header carries it.
  "const", "let", "var",
  "true", "false", "null", "undefined", "True", "False", "None", "nil",
  "NaN", "Infinity", "self", "this",
]);

/**
 * The keywords that can stand immediately before a parenthesis, where the
 * parenthesis groups an expression rather than making the word a callee:
 * `i['id'] in ('a', 'b')`, `not (a or b)`. Nothing on this list can be called,
 * so a match in call position is syntax and is read as one.
 */
const INLINE_OPERATOR_KEYWORDS = new Set([
  "in", "not", "and", "or", "is", "if", "else", "of", "as", "from",
]);

/** What a read-only expression may be spelled with, once literals are masked. */
const INLINE_EXPRESSION_CHARACTERS = /^[A-Za-z0-9_$§.,()[\]{}+\-*/%:!=?\s]*$/;

/** A dotted name in call position, and a dotted name in value position. */
const INLINE_CALL = /([A-Za-z_$][A-Za-z0-9_$]*(?:\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\(/g;
const INLINE_NAME = /[A-Za-z_$][A-Za-z0-9_$]*(?:\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*)*/g;

/** The top-level arguments of the call whose name starts at `from`. */
function callArguments(masked: string, from: number): string[] {
  const start = masked.indexOf("(", from);
  if (start === -1) return [];
  let depth = 0;
  const args: string[] = [];
  let current = "";
  for (let i = start; i < masked.length; i += 1) {
    const character = masked[i]!;
    if (character === "(" || character === "[" || character === "{") {
      depth += 1;
      if (depth === 1) continue;
    }
    if (character === ")" || character === "]" || character === "}") {
      depth -= 1;
      if (depth === 0) {
        args.push(current);
        return args.map((argument) => argument.trim());
      }
    }
    if (depth === 1 && character === ",") {
      args.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  return args.map((argument) => argument.trim());
}

/** The literal an argument is, where it is one. */
function literalArgument(argument: string, literals: string[]): string | null {
  const match = /^§(\d+)§$/.exec(argument);
  if (match === null) return null;
  return literals[Number(match[1])] ?? null;
}

/** A read mode, which is every mode that is not a write: `r`, `rb`, `rt`, none. */
const READ_MODE = /^[rbtU]*$/;

/**
 * Whether a call the table admitted names something the table cannot admit
 * after all: an `open` in a write mode, a `require` of a module off the list.
 */
function guardedCall(
  name: string,
  masked: string,
  at: number,
  literals: string[],
  vocabulary: InlineVocabulary,
): string | null {
  const last = name.split(".").pop()!;
  if (last === "open") {
    const args = callArguments(masked, at);
    const mode = args[1];
    if (mode === undefined) return null;
    const literal = literalArgument(mode, literals);
    if (literal !== null && READ_MODE.test(literal)) return null;
    return `\`${name}\` is given a mode this guard cannot read as a read mode`;
  }
  if (last === "require") {
    const args = callArguments(masked, at);
    const module = args[0] === undefined ? null : literalArgument(args[0], literals);
    if (module !== null && vocabulary.modules.has(module)) return null;
    return "`require` names a module that is not on the read-only list";
  }
  return null;
}

/**
 * The destination a plain write call names, where the call is one (SCP-234).
 *
 * Three answers. `null` is "not a write this table reads", which is every call
 * the scan judges the way it always did — an `open` in a read mode included. A
 * `reason` is a write whose destination this guard cannot read as a literal
 * path, and that refuses. A `target` is a write to a literal, and where that
 * literal lands is the path pass's question rather than this one's.
 */
function plainWrite(
  name: string,
  masked: string,
  at: number,
  literals: string[],
): { target: string } | { reason: string } | null {
  const last = name.split(".").pop()!;
  const rule = PLAIN_WRITE_CALLS.find((entry) => entry.name === last);
  if (rule === undefined) return null;
  const args = callArguments(masked, at);
  if (rule.name === "open") {
    // A read mode, or a mode this scan cannot read at all, is not a write it
    // can place: `guardedCall` answers for both, in the sentence it always used.
    const mode = args[1];
    if (mode === undefined) return null;
    const literal = literalArgument(mode, literals);
    if (literal === null || READ_MODE.test(literal)) return null;
  }
  const spelled =
    rule.argument === null
      ? PATH_RECEIVER.exec(masked.slice(0, at).trimEnd())?.[1]
      : args[rule.argument];
  const target = spelled === undefined ? null : literalArgument(spelled, literals);
  if (target === null) {
    return {
      reason: `\`${name}\` writes to a destination this guard cannot read as a literal path`,
    };
  }
  return { target };
}

/**
 * Whether an expression stays inside the table's vocabulary, and what it was
 * that did not.
 *
 * `destinations` collects the literal path every plain write call names, for
 * the pass that resolves them. It is filled as the scan walks, so a scan that
 * stops at a construct it cannot read leaves behind only what it had read by
 * then — which is all the caller needs, the line being refused either way.
 */
function unreadableExpression(
  expression: string,
  vocabulary: InlineVocabulary,
  bound: Set<string>,
  literals: string[],
  destinations: string[],
): string | null {
  const text = expression.trim();
  if (text === "") return null;
  if (!INLINE_EXPRESSION_CHARACTERS.test(text)) {
    const offending = [...text].find(
      (character) => !INLINE_EXPRESSION_CHARACTERS.test(character),
    );
    return offending === "`"
      ? "a backtick runs a shell command"
      : `\`${offending}\` is not a character a read-only expression may contain`;
  }
  // The calls first, then the same text with each call's name blanked, so a
  // callee is never read a second time as a bare value.
  let remaining = text;
  const blank = (from: number, width: number) => {
    remaining = remaining.slice(0, from) + " ".repeat(width) + remaining.slice(from + width);
  };
  INLINE_CALL.lastIndex = 0;
  let match = INLINE_CALL.exec(text);
  while (match !== null) {
    const name = match[1]!.replace(/\s+/g, "");
    const segments = name.split(".");
    const before = text.slice(0, match.index).trimEnd();
    if (INLINE_OPERATOR_KEYWORDS.has(name)) {
      blank(match.index, match[1]!.length);
      match = INLINE_CALL.exec(text);
      continue;
    }
    // A plain write to a literal path is a shape this guard reads, whatever the
    // table makes of the name: the destination is what decides it, and the pass
    // that resolves paths answers that.
    const plain = plainWrite(name, text, match.index, literals);
    if (plain !== null) {
      if ("reason" in plain) return plain.reason;
      destinations.push(plain.target);
      blank(match.index, match[1]!.length);
      match = INLINE_CALL.exec(text);
      continue;
    }
    // A method on a receiver this scan cannot name — a literal, a subscript,
    // the result of another call — is judged by its method name alone.
    const onUnnamedReceiver = segments.length === 1 && before.endsWith(".");
    const onBoundName = segments.length > 1 && bound.has(segments[0]!);
    const known = vocabulary.calls.has(name)
      ? true
      : (onUnnamedReceiver || onBoundName) && vocabulary.methods.has(segments[segments.length - 1]!);
    if (!known) return `\`${name}\` is not a call the read-only table names`;
    const guard = guardedCall(name, text, match.index, literals, vocabulary);
    if (guard !== null) return guard;
    blank(match.index, match[1]!.length);
    match = INLINE_CALL.exec(text);
  }
  INLINE_NAME.lastIndex = 0;
  let name = INLINE_NAME.exec(remaining);
  while (name !== null) {
    const dotted = name[0].replace(/\s+/g, "");
    const segments = dotted.split(".");
    const allowed =
      INLINE_KEYWORDS.has(dotted) ||
      // A key in an object literal, or a label: a word in the position where a
      // value's name is written, naming nothing the code can reach.
      /^\s*:/.test(remaining.slice(name.index + name[0].length)) ||
      // A keyword argument's label — `json.dumps(x, indent=2)`. It names a
      // parameter of the call it sits in, not a value this code can reach; a
      // statement that is itself an assignment was read as a binding before it
      // reached here.
      /^\s*=(?![=>])/.test(remaining.slice(name.index + name[0].length)) ||
      bound.has(segments[0]!) ||
      // A field reference (`$1`) or a variable read (`$path`) is a value, and
      // reading a value writes nothing.
      dotted.startsWith("$") ||
      vocabulary.names.some(
        (known) => dotted === known || dotted.startsWith(`${known}.`),
      );
    if (!allowed) return `\`${dotted}\` is not a name the read-only table knows`;
    name = INLINE_NAME.exec(remaining);
  }
  return null;
}

/**
 * The names a `for` header introduces, in either language's spelling — `for i
 * in xs:` and `for (const x of xs) {`. A loop variable is a name this code
 * binds, so the scan reads it as its own rather than as a word off the table.
 */
function loopTargets(statement: string): string[] {
  const header = /^for\s*\(?\s*(?:const\s+|let\s+|var\s+)?([^()]*?)\s+(?:in|of)\s/.exec(
    statement.trim(),
  );
  if (header === null) return [];
  return header[1]!
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part));
}

/** The names this code binds by assignment or by a loop, read as its own. */
function assignedNames(statements: readonly string[]): Set<string> {
  const bound = new Set<string>();
  for (const statement of statements) {
    for (const target of loopTargets(statement)) bound.add(target);
    const declared = /^(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/.exec(statement);
    if (declared !== null) {
      bound.add(declared[1]!);
      continue;
    }
    const assigned = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*=(?![=>])/.exec(statement);
    if (assigned !== null) bound.add(assigned[1]!);
  }
  return bound;
}

/** The names an `import` statement introduces, whatever language wrote it. */
function importedNames(statement: string): string[] {
  const python = /^import\s+(.+)$/.exec(statement);
  if (python !== null) {
    return python[1]!.split(",").map((part) => {
      const words = part.trim().split(/\s+as\s+/);
      return (words[1] ?? words[0] ?? "").trim().split(".")[0] ?? "";
    });
  }
  const from = /^from\s+[\w.]+\s+import\s+(.+)$/.exec(statement);
  if (from !== null) {
    return from[1]!.split(",").map((part) => {
      const words = part.trim().split(/\s+as\s+/);
      return (words[1] ?? words[0] ?? "").trim();
    });
  }
  return [];
}

/**
 * Whether an `import`, a `from … import` or a `require` names only modules the
 * table calls read-only, and which one did not.
 */
function unreadableImport(
  statement: string,
  literals: string[],
  vocabulary: InlineVocabulary,
): string | null {
  const off = (module: string) => `\`${module}\` is not a module on the read-only list`;
  const python = /^import\s+(.+)$/.exec(statement);
  if (python !== null) {
    for (const part of python[1]!.split(",")) {
      const module = part.trim().split(/\s+as\s+/)[0]!.trim();
      // A masked literal here is a JavaScript `import '…'`, whose module is the
      // literal rather than the word.
      const literal = literalArgument(module, literals);
      const named = literal ?? module.split(".")[0]!;
      if (!vocabulary.modules.has(named)) return off(named);
    }
    return null;
  }
  const from = /^from\s+([\w.§]+)\s+import\s+/.exec(statement);
  if (from !== null) {
    const literal = literalArgument(from[1]!, literals);
    const named = literal ?? from[1]!.split(".")[0]!;
    return vocabulary.modules.has(named) ? null : off(named);
  }
  const required = /^(?:require|use)\s+(§\d+§|[\w:.]+)\s*$/.exec(statement);
  if (required !== null) {
    const named = literalArgument(required[1]!, literals) ?? required[1]!;
    return vocabulary.modules.has(named) ? null : off(named);
  }
  return `\`${statement.split(/\s+/)[0] ?? statement}\` is not an import shape this guard reads`;
}

/**
 * Whether one statement is a shape the table admits, and what it was that the
 * table did not know.
 *
 * An `awk` program arrives as `<pattern> { <statements> }`, so a statement that
 * is a braced block is unwrapped and its contents read the same way.
 */
function unreadableStatement(
  statement: string,
  vocabulary: InlineVocabulary,
  bound: Set<string>,
  literals: string[],
  destinations: string[],
  depth = 0,
): string | null {
  const text = statement.trim();
  if (text === "") return null;
  const block = /^([^{}]*)\{([\s\S]*)\}$/.exec(text);
  if (block !== null && depth < 4) {
    const pattern = unreadableHeader(block[1]!, vocabulary, bound, literals, destinations);
    if (pattern !== null) return pattern;
    for (const inner of splitStatements(block[2]!)) {
      const found = unreadableStatement(
        inner,
        vocabulary,
        bound,
        literals,
        destinations,
        depth + 1,
      );
      if (found !== null) return found;
    }
    return null;
  }
  if (INLINE_CONTROL.test(text)) {
    return unreadableHeader(text, vocabulary, bound, literals, destinations);
  }
  if (/^(?:import|from|require|use)\b/.test(text)) {
    if (!vocabulary.forms.has("import")) {
      return "an import is not a shape the read-only table admits";
    }
    return unreadableImport(text, literals, vocabulary);
  }
  const binding =
    /^(?:(?:const|let|var)\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*=(?![=>])([\s\S]*)$/.exec(text);
  if (binding !== null) {
    if (!vocabulary.forms.has("binding")) {
      return "a binding is not a shape the read-only table admits";
    }
    return unreadableExpression(binding[2]!, vocabulary, bound, literals, destinations);
  }
  // `print $1`, `puts 1 + 1`, `print 1`: the languages that print without
  // parentheses. The rest of the line is an expression like any other.
  const printed = /^(print|printf|puts|say|echo|p|pp)\b([\s\S]*)$/.exec(text);
  if (printed !== null && !text.startsWith(`${printed[1]!}(`)) {
    if (!vocabulary.forms.has("bare-print")) {
      return `\`${printed[1]!}\` without parentheses is not a shape the read-only table admits`;
    }
    return unreadableExpression(printed[2]!, vocabulary, bound, literals, destinations);
  }
  return unreadableExpression(text, vocabulary, bound, literals, destinations);
}

/**
 * A control-flow header, or an `awk` pattern, read as the expression it decides
 * on. The keyword in front of it is syntax: it calls nothing and names nothing,
 * and the names a `for` binds were bound before the scan reached here.
 */
function unreadableHeader(
  header: string,
  vocabulary: InlineVocabulary,
  bound: Set<string>,
  literals: string[],
  destinations: string[],
): string | null {
  let text = header.trim();
  const control = INLINE_CONTROL.exec(text);
  if (control !== null) {
    if (!vocabulary.forms.has("control")) {
      return `\`${control[1]!}\` is not a shape the read-only table admits`;
    }
    text = control[2]!.trim();
  }
  if (text.endsWith(":")) text = text.slice(0, -1);
  return unreadableExpression(text, vocabulary, bound, literals, destinations);
}

/**
 * Read a piece of inline code: whether it is a shape this guard can account
 * for, and the literal destinations of the plain writes it makes.
 *
 * `construct` is what stopped the scan, or `null` where every statement was a
 * shape the table names. `destinations` are the paths the plain write calls
 * spelled; where each of them lands is the path pass's question.
 */
function readInlineCode(
  source: string,
  language: InlineLanguage,
): { construct: string | null; destinations: string[] } {
  const destinations: string[] = [];
  const { masked, literals, spawned } = maskLiterals(source, language);
  if (spawned) return { construct: "a backtick runs a shell command", destinations };
  const vocabulary = inlineVocabulary();
  const statements = splitStatements(withoutComments(masked, language));
  const bound = assignedNames(statements);
  for (const statement of statements) {
    for (const name of importedNames(statement)) {
      if (name !== "") bound.add(name);
    }
  }
  for (const statement of statements) {
    const found = unreadableStatement(statement, vocabulary, bound, literals, destinations);
    if (found !== null) return { construct: found, destinations };
  }
  return { construct: null, destinations };
}

/**
 * Judge one piece of inline code, given the interpreter and option that took it.
 *
 * Two passes, in this order. The first reads the paths written in the code and
 * refuses one that resolves outside the root, which is the same question a
 * redirect target is asked. The second asks whether the code is a shape the
 * table above can show writes nothing, and refuses it when it is not — which is
 * every shape the table does not name, that being the point. Only the sentence
 * a refusal carries is still drawn from the write-call list.
 */
export function inlineCodeFindings(
  verb: string,
  how: string,
  code: Word,
  context: Context,
  cwd: Cwd,
): WriteFinding[] {
  const tail = `: ${context.segment.slice(0, 200)}`;
  if (code.variable || code.substitutions.length > 0) {
    return [
      {
        detail:
          `the code passed to ${how} cannot be read — it is built at run time${tail}`,
        target: null,
        resolved: null,
        cause: "unreadable_program",
      },
    ];
  }
  const findings: WriteFinding[] = [];
  const source = unwrapped(code.raw.length > 0 ? code.raw : code.value);
  const read = readInlineCode(source, inlineLanguage(verb));
  // Every path the code spells: the ones written like paths, and the
  // destination of every plain write call — which is a path however short it
  // looks, `notes.md` as much as `/etc/hosts` (SCP-234).
  const paths = stringLiterals(source).filter(
    (literal) => literal.includes("/") || literal.startsWith("~"),
  );
  const judged = new Set<string>();
  // A path in the code is a path on disk, not shell text: a `~` or a `$` in it
  // is a character the interpreter reads literally.
  for (const literal of [...paths, ...read.destinations]) {
    if (judged.has(literal)) continue;
    judged.add(literal);
    const destination = judgeTarget(literal, context.scope, cwd, false);
    if (destination.kind === "inside") continue;
    findings.push({
      detail:
        destination.kind === "outside"
          ? `the path ${literal} in the code passed to ${how} resolves to ` +
            `${destination.resolved}, outside the worktree${tail}`
          : destination.kind === "outside_scope"
            ? `the path ${literal} in the code passed to ${how} resolves to ${destination.at}, ` +
              `which this ticket's contract does not admit — ` +
              `${allowedPathsSentence(destination.allowed)}${tail}`
            : destination.kind === "prohibited_path"
              ? `the path ${literal} in the code passed to ${how} resolves to ${destination.at}, ` +
                `which this ticket's contract prohibits — ` +
                `${prohibitedPathsSentence(destination.prohibited)}${tail}`
              : `the path ${literal} in the code passed to ${how} cannot be resolved — ` +
                `${destination.reason}${tail}`,
      target: literal,
      resolved: landed(destination),
      rule: ruleOf(destination),
      cause: "outside_target",
    });
  }
  if (read.construct === null) return findings;
  const text = source.replace(INLINE_STREAM_WRITES, "");
  const named = INLINE_WRITE_CALLS.find((rule) => rule.pattern.test(text));
  findings.push({
    detail:
      named !== undefined
        ? `the code passed to ${how} ${named.detail}, which this guard cannot resolve ` +
          `to a destination${tail}`
        : `the code passed to ${how} is not a shape this guard can show writes nothing — ` +
          `${read.construct}${tail}`,
    target: null,
    resolved: null,
    cause: "unreadable_program",
  });
  return findings;
}
