import type { Context } from "./command.js";
import { judgeTarget, landed, ruleOf, type WriteFinding } from "./destination.js";
import {
  INLINE_READ_ONLY,
  INLINE_WRITE_CALLS,
  PLAIN_WRITE_CALLS,
  type InlineStatementForm,
} from "./inline-tables.js";
import type { Word } from "./lexer.js";
import { inspectSegments } from "./line.js";
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
 * The question that turns on it most is a backtick. In JavaScript it opens a
 * template literal, which is a string. In Perl, Ruby and PHP it runs a shell
 * command, which is the thing this guard exists to refuse. The others are
 * where a program writes without a call: `awk`'s own `>` redirect, and the
 * `exec` that runs a command in Perl, Ruby and PHP and Python code in Python.
 */
type InlineLanguage = "js" | "python" | "shellish" | "awk" | "other";

function inlineLanguage(verb: string): InlineLanguage {
  if (verb === "node" || verb === "nodejs" || verb === "deno" || verb === "bun") return "js";
  if (verb.startsWith("python") || verb.startsWith("pypy")) return "python";
  if (verb === "perl" || verb === "ruby" || verb === "php") return "shellish";
  if (verb.endsWith("awk")) return "awk";
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

/**
 * The source with every string literal replaced by a token that stands for it.
 *
 * The scan below reads structure, and a literal is the one place where the
 * text is data rather than code: a `>` inside a string is not a redirect, and
 * `rm -rf /` inside one is not a command. Masking them first is what lets the
 * rest of the scan be a plain character-and-name check. The literals are kept
 * for the places that read one: a file mode, a module name, the destination of
 * a write and the command a spawn runs. So is the body of every Perl, Ruby or
 * PHP backtick, which is a shell command whose writes are read like any other.
 */
function maskLiterals(
  code: string,
  language: InlineLanguage,
): { masked: string; literals: string[]; spawned: boolean; commands: string[] } {
  const literals: string[] = [];
  const commands: string[] = [];
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
      commands.push(value);
      masked += "`";
    } else {
      masked += `§${literals.length}§`;
      literals.push(value);
    }
    i = j + 1;
  }
  return { masked, literals, spawned, commands };
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

/**
 * The names this code binds itself. An assigned name — a binding, a loop
 * variable — carries the answer of an expression the scan already read, so a
 * method on it is judged by the method's name. An imported name is a module,
 * and a module's attributes are judged by their full dotted name only: that is
 * the line that keeps `import os` from meaning `os.remove`.
 */
interface BoundNames {
  assigned: Set<string>;
  imported: Set<string>;
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

/** Each call in `code`: where its name starts, its width as written, the name without spaces, and the code before it. */
function* callsIn(code: string) {
  for (const match of code.matchAll(INLINE_CALL)) {
    const at = match.index;
    yield { at, width: match[1]!.length, name: match[1]!.replace(/\s+/g, ""), before: code.slice(0, at).trimEnd() };
  }
}

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

/** The literal an argument is, where there is one and it is one. */
function literalArgument(argument: string | undefined, literals: string[]): string | null {
  const match = /^§(\d+)§$/.exec(argument ?? "");
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
  method: boolean,
  literals: string[],
  vocabulary: InlineVocabulary,
): string | null {
  const last = name.split(".").pop()!;
  if (last === "open") {
    // The function `open(path, mode)` takes its mode second; a method —
    // `Path(…).open(mode)`, whatever `.open` is called on — takes it first.
    // Either may spell it `mode=`, and a keyword argument is not a position.
    const args = callArguments(masked, at);
    const keyword = args
      .map((argument) => /^mode\s*=(?!=)\s*([\s\S]*)$/.exec(argument)?.[1])
      .find((value) => value !== undefined);
    const positional = args.filter((argument) => argument !== "" && !/^[A-Za-z_]\w*\s*=(?!=)/.test(argument));
    const mode = keyword ?? positional[method ? 0 : 1];
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
  method: boolean,
  literals: string[],
): { target: string } | { reason: string } | null {
  const last = name.split(".").pop()!;
  const rule = PLAIN_WRITE_CALLS.find((entry) => entry.name === last);
  if (rule === undefined) return null;
  // `open(path, mode)` is the function. A method `.open` names its file on the
  // receiver, which is `guardedCall`'s to refuse in a write mode.
  if (rule.name === "open" && method) return null;
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
  bound: BoundNames,
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
  // A call on something other than a name — `f[0](…)`, `(f)(…)`, `g()(…)` —
  // calls a value this scan never read as a callee: `[os.remove][0]('/x')`
  // runs `os.remove` without a name in call position anywhere.
  if (/[\])]\s*\(/.test(text)) {
    return "a call on a subscript or a parenthesised value is not a callee this table can name";
  }
  // A dunder reaches the machinery behind a name: `os.__dict__['system']` is
  // `os.system` spelled so no table sees it.
  const dunder = /\.\s*(__[A-Za-z0-9_]*__)(?![\w$])/.exec(text);
  if (dunder !== null) return `\`${dunder[1]}\` is not a name the read-only table knows`;
  // The calls first, then the same text with each call's name blanked, so a
  // callee is never read a second time as a bare value.
  let remaining = text;
  for (const { at, width, name, before } of callsIn(text)) {
    remaining = remaining.slice(0, at) + " ".repeat(width) + remaining.slice(at + width);
    if (INLINE_OPERATOR_KEYWORDS.has(name)) continue;
    const segments = name.split(".");
    // A plain write to a literal path is a shape this guard reads, whatever the
    // table makes of the name: the destination is what decides it, and the pass
    // that resolves paths answers that.
    const method = segments.length > 1 || before.endsWith(".");
    const plain = plainWrite(name, text, at, method, literals);
    if (plain !== null) {
      if ("reason" in plain) return plain.reason;
      destinations.push(plain.target);
      continue;
    }
    // A method on a receiver this scan cannot name — a literal, a subscript,
    // the result of another call — is judged by its method name alone.
    const onUnnamedReceiver = segments.length === 1 && before.endsWith(".");
    const onBoundName = segments.length > 1 && bound.assigned.has(segments[0]!);
    const known = vocabulary.calls.has(name)
      ? true
      : (onUnnamedReceiver || onBoundName) && vocabulary.methods.has(segments[segments.length - 1]!);
    if (!known) return `\`${name}\` is not a call the read-only table names`;
    const guard = guardedCall(name, text, at, method, literals, vocabulary);
    if (guard !== null) return guard;
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
      bound.assigned.has(segments[0]!) ||
      // A module as a value is the module; an attribute of one is a value only
      // where the table names it, in `names` below or as a call. `os.remove`
      // passed around as a value is `os.remove` called later.
      (bound.imported.has(segments[0]!) &&
        (segments.length === 1 || vocabulary.calls.has(dotted))) ||
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
  bound: BoundNames,
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
  bound: BoundNames,
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
  const bound: BoundNames = { assigned: assignedNames(statements), imported: new Set() };
  for (const statement of statements) {
    for (const name of importedNames(statement)) {
      if (name !== "") bound.imported.add(name);
    }
  }
  for (const statement of statements) {
    const found = unreadableStatement(statement, vocabulary, bound, literals, destinations);
    if (found !== null) return { construct: found, destinations };
  }
  return { construct: null, destinations };
}

/**
 * Which operands of a call name a file it writes. A list is those operands by
 * position; `each` is every operand (`File.delete(a, b)`); `mode` is an `open`,
 * which writes only where its mode is a literal that writes.
 */
type WriteOperands = readonly number[] | "each" | "mode";

/** How a spawn call is handed its command: one shell string, or an argv. */
type SpawnForm = "shell" | "argv";

const byModule = <T>(entries: Record<string, Record<string, T>>) =>
  new Map(Object.entries(entries).map(([module, calls]) => [module, new Map(Object.entries(calls))]));

/**
 * The calls that write a file, by the module that owns them, and which of
 * their operands is the file.
 *
 * A call is placed by its module, so `os.remove` is a write and `list.remove`
 * is not. The module is the one the code bound that name to — an `import … as`,
 * a `require`, a destructured binding, a plain alias — or the name itself where
 * the runtime supplies it unloaded: `fs` in `node -e`, `Deno`, `Bun`, `File`.
 * `builtins` is a bare call nothing bound. A copy or a link writes its
 * destination and reads its source; a rename or a move writes both, because
 * the source is gone afterwards.
 */
const WRITE_CALLS = byModule<WriteOperands>({
  fs: {
    writeFile: [0], writeFileSync: [0], appendFile: [0], appendFileSync: [0],
    createWriteStream: [0], open: "mode", openSync: "mode",
    rename: [0, 1], renameSync: [0, 1], unlink: [0], unlinkSync: [0], rm: [0], rmSync: [0],
    rmdir: [0], rmdirSync: [0], mkdir: [0], mkdirSync: [0], mkdtemp: [0], mkdtempSync: [0],
    copyFile: [1], copyFileSync: [1], cp: [1], cpSync: [1],
    symlink: [1], symlinkSync: [1], link: [1], linkSync: [1],
    truncate: [0], truncateSync: [0], chmod: [0], chmodSync: [0], chown: [0], chownSync: [0],
    utimes: [0], utimesSync: [0],
    // `fs-extra`, which is read as `fs`.
    outputFile: [0], outputFileSync: [0], outputJson: [0], outputJsonSync: [0],
    writeJson: [0], writeJsonSync: [0], remove: [0], removeSync: [0],
    copy: [1], copySync: [1], move: [0, 1], moveSync: [0, 1],
    ensureDir: [0], ensureDirSync: [0], ensureFile: [0], ensureFileSync: [0],
    emptyDir: [0], emptyDirSync: [0], mkdirp: [0], mkdirs: [0],
  },
  os: {
    remove: [0], unlink: [0], rmdir: [0], removedirs: [0], mkdir: [0], makedirs: [0],
    rename: [0, 1], renames: [0, 1], replace: [0, 1], symlink: [1], link: [1],
    truncate: [0], chmod: [0], chown: [0], lchown: [0], utime: [0], mkfifo: [0],
  },
  shutil: {
    rmtree: [0], copy: [1], copy2: [1], copyfile: [1], copytree: [1], copymode: [1],
    copystat: [1], move: [0, 1], make_archive: [0], unpack_archive: [1],
  },
  io: { open: "mode" },
  codecs: { open: "mode" },
  builtins: {
    open: "mode", fopen: "mode",
    // Perl's and PHP's own names for the same acts.
    unlink: "each", mkdir: [0], rmdir: [0], rename: [0, 1], file_put_contents: [0],
    copy: [1], touch: [0], symlink: [1], link: [1],
  },
  Deno: {
    writeFile: [0], writeFileSync: [0], writeTextFile: [0], writeTextFileSync: [0],
    remove: [0], removeSync: [0], mkdir: [0], mkdirSync: [0], rename: [0, 1],
    renameSync: [0, 1], copyFile: [1], copyFileSync: [1], create: [0], createSync: [0],
    truncate: [0], truncateSync: [0], symlink: [1], symlinkSync: [1],
    link: [1], linkSync: [1], chmod: [0], chmodSync: [0],
  },
  Bun: { write: [0] },
  File: {
    write: [0], binwrite: [0], delete: "each", unlink: "each", rename: [0, 1], open: "mode",
    new: "mode", symlink: [1], link: [1], truncate: [0],
  },
  IO: { write: [0], binwrite: [0] },
  FileUtils: {
    rm: [0], rm_r: [0], rm_rf: [0], rm_f: [0], remove: [0], rmdir: [0], rmtree: [0],
    remove_dir: [0], remove_file: [0], mkdir: [0], mkdir_p: [0], makedirs: [0], touch: [0],
    cp: [1], cp_r: [1], copy: [1], copy_file: [1], mv: [0, 1], move: [0, 1],
    ln: [1], ln_s: [1], ln_sf: [1], install: [1],
  },
});

/**
 * The methods a `Path` built from a literal writes that path with, and which
 * other operands it writes besides: `Path('a').rename('b')` removes `a` and
 * creates `b`. `open` writes it only in a write mode.
 */
const PATH_WRITES = new Map<string, readonly number[]>([
  ["write_text", []], ["write_bytes", []], ["touch", []], ["mkdir", []], ["rmdir", []],
  ["unlink", []], ["chmod", []], ["symlink_to", []], ["hardlink_to", []],
  ["rename", [0]], ["replace", [0]], ["open", []],
]);

/**
 * The calls that run a shell command or a program, by module. Their command is
 * read by this guard's own shell reading, so `execSync('rm -rf /tmp/x')` is the
 * write `rm -rf /tmp/x` is, and `execSync('command -v node')` is the read it is.
 */
const SPAWN_CALLS = byModule<SpawnForm>({
  child_process: {
    exec: "shell", execSync: "shell", spawn: "argv", spawnSync: "argv",
    execFile: "argv", execFileSync: "argv",
  },
  os: { system: "shell", popen: "shell" },
  subprocess: {
    run: "argv", call: "argv", check_call: "argv", check_output: "argv", Popen: "argv",
    getoutput: "shell", getstatusoutput: "shell",
  },
  Bun: { spawn: "argv", spawnSync: "argv" },
  Open3: { capture2: "argv", capture2e: "argv", capture3: "argv", popen3: "argv" },
  IO: { popen: "argv" },
  builtins: { system: "argv", popen: "shell", shell_exec: "shell", passthru: "shell" },
});

/**
 * Method names no library uses for anything but a write or a spawn, placed
 * whatever they are called on: `require('fs').writeFileSync`, a path module
 * someone named `p`, a receiver this scan cannot name at all. Every other name
 * needs its module, which is what keeps `list.remove('x')` from being a write.
 */
const UNMISTAKABLE = new Set([
  "writeFile", "writeFileSync", "appendFile", "appendFileSync", "createWriteStream",
  "outputFile", "outputFileSync", "rmSync", "rmdirSync", "unlinkSync", "mkdirSync",
  "renameSync", "copyFileSync", "cpSync", "symlinkSync", "truncateSync",
  "writeTextFile", "writeTextFileSync", "rmtree", "makedirs", "removedirs", "copyfile",
  "copytree", "execSync", "execFileSync", "spawnSync", "check_call", "check_output",
  "Popen", "getoutput",
]);

/**
 * What a table files a call under: by its module, or, for an unmistakable
 * method, under the first module that has it.
 */
function placed<T>(table: Map<string, Map<string, T>>, call: Callee): T | undefined {
  const found = call.module === null ? undefined : table.get(call.module)?.get(call.method);
  if (found !== undefined || !UNMISTAKABLE.has(call.method)) return found;
  return [...table.values()].map((calls) => calls.get(call.method)).find((value) => value !== undefined);
}

/** The module a load names, with the spellings that load the same one folded. */
function moduleOf(spelled: string): string {
  const name = spelled.replace(/^node:/, "").split(".")[0] ?? "";
  if (name === "fs/promises" || name === "fs-extra" || name === "graceful-fs") return "fs";
  if (name === "posix" || name === "nt") return "os";
  return name;
}

const knownModule = (module: string) => WRITE_CALLS.has(module) || SPAWN_CALLS.has(module);

/** What a name in the code is bound to: a module, or one member of it. */
interface Binding {
  module: string;
  member: string | null;
}

interface Bindings {
  modules: Map<string, Binding>;
  /** Names bound to a `Path` built from a literal, and that literal. */
  paths: Map<string, string>;
}

const NAME = String.raw`[A-Za-z_$][\w$]*`;
const MEMBERS = String.raw`((?:\s*\.\s*[A-Za-z_$][\w$]*)*)`;
const LOAD = String.raw`(?:await\s+)?(?:require|import|__import__)\s*\(\s*§(\d+)§\s*\)`;
const BOUND_LOAD = new RegExp(String.raw`\b(${NAME})\s*=\s*${LOAD}${MEMBERS}`, "g");
const DESTRUCTURED_LOAD = new RegExp(String.raw`\{([^{}]*)\}\s*=\s*${LOAD}${MEMBERS}`, "g");
const ES_DEFAULT = new RegExp(
  String.raw`\bimport\s+(?:\*\s*as\s+)?(${NAME})\s*(?:,\s*\{[^{}]*\}\s*)?from\s*§(\d+)§`,
  "g",
);
const ES_NAMED = new RegExp(
  String.raw`\bimport\s*(?:${NAME}\s*,\s*)?\{([^{}]*)\}\s*from\s*§(\d+)§`,
  "g",
);
const ALIAS = new RegExp(
  String.raw`\b(${NAME})\s*=(?![=>])\s*(${NAME})${MEMBERS}\s*(?=[;\n,)}]|$)`,
  "g",
);
const PATH_BINDING = new RegExp(
  String.raw`\b(${NAME})\s*=\s*(?:pathlib\s*\.\s*)?Path\s*\(\s*§(\d+)§\s*\)\s*(?=[;\n,)}]|$)`,
  "g",
);

/** The last name of a `.a.b` member chain, where there is one. */
const lastMember = (members: string | undefined) =>
  members?.split(".").map((part) => part.trim()).filter((part) => part !== "").pop() ?? null;

/**
 * The names this code binds to a module or to a `Path`, in either language's
 * spelling. A name the scan cannot trace is simply not here, and a call on it
 * is placed only by an unmistakable method name.
 */
function bindingsOf(code: string, statements: readonly string[], literals: string[]): Bindings {
  const modules = new Map<string, Binding>();
  const paths = new Map<string, string>();
  const loaded = (index: string) => moduleOf(literals[Number(index)] ?? "");
  /** Bind each `name` or `name <separator> local` of a list to that member of `module`. */
  const bindEach = (list: string, separator: RegExp, module: string) => {
    for (const part of list.split(",")) {
      const [name, local] = part.split(separator).map((word) => word.trim().replace(/\s*=[\s\S]*$/, ""));
      if (name !== undefined && /^[A-Za-z_$][\w$]*$/.test(name)) modules.set(local || name, { module, member: name });
    }
  };
  for (const match of code.matchAll(BOUND_LOAD)) {
    modules.set(match[1]!, { module: loaded(match[2]!), member: lastMember(match[3]) });
  }
  for (const match of code.matchAll(DESTRUCTURED_LOAD)) bindEach(match[1]!, /\s*:\s*/, loaded(match[2]!));
  for (const match of code.matchAll(ES_DEFAULT)) modules.set(match[1]!, { module: loaded(match[2]!), member: null });
  for (const match of code.matchAll(ES_NAMED)) bindEach(match[1]!, /\s+as\s+/, loaded(match[2]!));
  for (const statement of statements) {
    const python = /^import\s+([\w.\s,]+)$/.exec(statement);
    if (python !== null) {
      for (const part of python[1]!.split(",")) {
        const [module, local] = part.trim().split(/\s+as\s+/);
        if (module === undefined || module === "") continue;
        const name = local ?? module.split(".")[0]!;
        modules.set(name.trim(), { module: moduleOf(module), member: null });
      }
    }
    const from = /^from\s+([\w.]+)\s+import\s+\(?([^()]*)\)?$/.exec(statement);
    if (from !== null) bindEach(from[2]!, /\s+as\s+/, moduleOf(from[1]!));
  }
  for (const match of code.matchAll(PATH_BINDING)) {
    const path = literals[Number(match[2])];
    if (path !== undefined) paths.set(match[1]!, path);
  }
  // Twice, so an alias of an alias is traced too.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const match of code.matchAll(ALIAS)) {
      const [, local, head, members] = match;
      const bound = modules.get(head!);
      const module = bound?.module ?? (knownModule(moduleOf(head!)) ? moduleOf(head!) : null);
      if (module === null || local === head) continue;
      modules.set(local!, { module, member: lastMember(members) ?? bound?.member ?? null });
    }
  }
  return { modules, paths };
}

/** A call, placed: the module that owns it, its method, and a literal `Path` it is made on. */
interface Callee {
  module: string | null;
  method: string;
  path: string | null;
}

/** A module loaded in place, or a `Path` built from a literal, standing before a `.`. */
const LOADED_RECEIVER = /\b(?:require|import|__import__)\s*\(\s*(§\d+§)\s*\)\s*\.$/;

function calleeOf(name: string, before: string, literals: string[], bound: Bindings): Callee {
  const segments = name.split(".");
  const method = segments.pop()!;
  if (before.endsWith(".")) {
    // A receiver this scan did not name: a module loaded in place, a `Path`
    // built from a literal, or something else it cannot place.
    const loaded = LOADED_RECEIVER.exec(before)?.[1];
    const path = PATH_RECEIVER.exec(before)?.[1];
    return {
      module: loaded === undefined ? null : moduleOf(literalArgument(loaded, literals) ?? ""),
      method,
      path: literalArgument(path, literals),
    };
  }
  const head = segments[0];
  if (head === undefined) {
    const member = bound.modules.get(method);
    return { module: member?.module ?? "builtins", method: member?.member ?? method, path: null };
  }
  if (segments.length === 1 && bound.paths.has(head)) {
    return { module: null, method, path: bound.paths.get(head)! };
  }
  return { module: bound.modules.get(head)?.module ?? moduleOf(head), method, path: null };
}

/** The literals an array literal holds, where it is one made only of literals. */
function literalArray(argument: string | undefined, literals: string[]): string[] | null {
  const array = /^\[([\s\S]*)\]$/.exec(argument?.trim() ?? "");
  if (array === null) return null;
  const items = array[1]!.split(",").map((item) => item.trim()).filter((item) => item !== "");
  const values = items.map((item) => literalArgument(item, literals));
  return values.every((value): value is string => value !== null) ? values : null;
}

/** The literal an argument or an option spelled `name=` or `name:` holds, if any. */
function namedLiteral(args: readonly string[], names: string, literals: string[]): string | null | undefined {
  const text = args.join(",");
  if (!new RegExp(String.raw`\b(?:${names})\b`).test(text)) return undefined;
  const spelled = new RegExp(String.raw`\b(?:${names})\s*[:=]\s*(§\d+§)`).exec(text);
  return literalArgument(spelled?.[1], literals);
}

/** A mode that writes, in any of the languages' spellings: `w`, `a+`, `r+`, `x`, Perl's `>`. */
const WRITE_MODE = /[wax+>]/;
/** Perl's mode, which comes before the path and may carry it: `'>'`, `'>>out.txt'`. */
const PERL_MODE = /^\s*(\+?>>?|\+<)\s*([\s\S]*)$/;

/** The files an `open` writes: its path, where its mode is a literal that writes. */
function openedForWriting(args: readonly string[], literals: string[]): string[] {
  const literal = (at: number) => literalArgument(args[at], literals);
  // A mode this scan cannot read is not a write it can place, and the
  // read-only table refuses the call for it; no mode at all is a read.
  const mode = namedLiteral(args, "mode|flags?", literals) ?? literal(1);
  if (mode === null || !WRITE_MODE.test(mode)) return [];
  const perl = PERL_MODE.exec(mode);
  const path = perl !== null ? perl[2]!.trim() || literal(2) : (literal(0) ?? namedLiteral(args, "file", literals) ?? null);
  return path === null ? [] : [path];
}

/** The literal files one call writes, where it is a write this table places. */
function writtenBy(call: Callee, args: readonly string[], literals: string[]): string[] {
  const literal = (at: number) => literalArgument(args[at], literals);
  const pick = (positions: readonly number[]) =>
    positions.map(literal).filter((value): value is string => value !== null);
  if (call.path !== null) {
    const others = PATH_WRITES.get(call.method);
    if (others === undefined) return [];
    if (call.method === "open") {
      const mode = namedLiteral(args, "mode", literals) ?? literal(0);
      return mode !== null && WRITE_MODE.test(mode) ? [call.path] : [];
    }
    return [call.path, ...pick(others)];
  }
  const operands = placed(WRITE_CALLS, call);
  if (operands === undefined) return [];
  if (operands === "mode") return openedForWriting(args, literals);
  if (operands === "each") return pick(args.map((_, at) => at));
  return pick(operands);
}

/** Quote one argv word for the shell reading, so it stays the one word it was. */
const shellWord = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

/** The shell command one call runs, where it is a spawn this table places and its command is literal. */
function spawnedBy(call: Callee, args: readonly string[], literals: string[], language: InlineLanguage): string | null {
  const literal = (at: number) => literalArgument(args[at], literals);
  // Perl's, Ruby's and PHP's `exec` runs a command; Python's runs Python.
  const shellExec = language === "shellish" && call.module === "builtins" && call.method === "exec";
  const form = placed(SPAWN_CALLS, call) ?? (shellExec ? "argv" : undefined);
  if (form === undefined) return null;
  if (form === "shell") return literal(0);
  const listed = literalArray(args[0], literals);
  if (listed !== null) return listed.map(shellWord).join(" ");
  const program = literal(0);
  if (program === null) return null;
  const rest = literalArray(args[1], literals);
  if (rest !== null) return [program, ...rest].map(shellWord).join(" ");
  // `system('rm', '-rf', 'x')` is an argv; `system('rm -rf x')`,
  // `subprocess.run('…', shell=True)` and `spawn('…', {shell: true})` are
  // shell text. Read as shell text, a lone program name is the same word.
  const words: string[] = [];
  for (let at = 0; literal(at) !== null; at += 1) words.push(literal(at)!);
  return words.length > 1 ? words.map(shellWord).join(" ") : program;
}

/** A shell command the code runs, and the directory its call names for it. */
interface SpawnedCommand {
  text: string;
  /** The `cwd` option: absent, a literal, or null where it is not a literal. */
  cwd?: string | null | undefined;
}

/**
 * Where a piece of inline code writes, as far as the code says.
 *
 * `targets` are the literal files its write calls name. `commands` are the shell
 * commands it hands a spawn, which this guard's shell reading judges. `chdir`
 * is a directory the code moves to, which every relative target is then judged
 * from.
 */
interface WriteSites {
  targets: string[];
  commands: SpawnedCommand[];
  chdir?: string | null | undefined;
}

/**
 * Read the places a piece of inline code writes: the target of a write call,
 * a redirect or a writer inside a command it spawns, and nothing else.
 *
 * A string the code carries anywhere else is not a write. `{shell: '/bin/zsh'}`
 * names the program a spawn runs its command with, `{cwd: '/tmp'}` where it runs
 * it, `readFileSync('/etc/hosts')` a file it reads; the runner judges writes,
 * not reads (docs/08). And a string in a position this reading does not
 * recognise is not a write either: this reader refuses what it cannot read, and
 * that refusal is the `unreadable_program` finding below, which the read-only
 * table gives every program it cannot show writes nothing. Called a write, the
 * same string would turn "the guard could not read this" into "the guard saw a
 * write outside the worktree" and end the attempt for it, which is the
 * difference `WriteCause` exists to keep (SCP-234).
 */
function writeSites(source: string, language: InlineLanguage): WriteSites {
  const { masked, literals, commands } = maskLiterals(source, language);
  const code = withoutComments(masked, language);
  const bound = bindingsOf(code, splitStatements(code), literals);
  const sites: WriteSites = { targets: [], commands: commands.map((text) => ({ text })) };
  for (const { at, name, before } of callsIn(code)) {
    const call = calleeOf(name, before, literals, bound);
    const args = callArguments(code, at);
    if (call.method === "chdir") {
      sites.chdir = literalArgument(args[0], literals);
      continue;
    }
    sites.targets.push(...writtenBy(call, args, literals));
    const command = spawnedBy(call, args, literals, language);
    if (command !== null) sites.commands.push({ text: command, cwd: namedLiteral(args.slice(1), "cwd", literals) });
  }
  /** The literals the matches of `pattern` capture, in their first capturing group that took part. */
  const captured = (pattern: RegExp) =>
    [...code.matchAll(pattern)]
      .map((match) => literalArgument(match[1] ?? match[2], literals))
      .filter((literal) => literal !== null);
  if (language === "awk") {
    // `awk` writes with a redirect in its own program text, and runs a command
    // by piping into or out of one.
    sites.targets.push(...captured(/>>?\s*(§\d+§)/g));
    sites.commands.push(...captured(/\|\s*&?\s*(§\d+§)|(§\d+§)\s*\|\s*getline/g).map((text) => ({ text })));
  }
  if (language === "other") {
    // AppleScript's `do shell script`.
    sites.commands.push(...captured(/\bdo\s+shell\s+script\s+(§\d+§)/g).map((text) => ({ text })));
  }
  return sites;
}

/** The directory a `cwd` option or a `chdir` names, judged from where the code starts. */
function directoryAt(option: string | null | undefined, context: Context, cwd: Cwd): Cwd {
  if (option === undefined) return cwd;
  const destination = option === null ? null : judgeTarget(option, context.scope, cwd, false);
  if (destination === null || destination.kind === "unresolvable" || destination.resolved === null) {
    return { path: cwd.path, unknown: true };
  }
  return { path: destination.resolved, unknown: false };
}

/**
 * The writes a command the code spawns makes, read as the shell line it is.
 *
 * Only the findings that place a destination are kept. Anything else the shell
 * reading says about the command — a program it cannot read, a line it cannot
 * account for — is already said about the code that runs it: no spawn is on the
 * read-only table, so that code is refused as `unreadable_program` whatever the
 * command is.
 */
function spawnedFindings(command: SpawnedCommand, how: string, context: Context, cwd: Cwd): WriteFinding[] {
  const start = directoryAt(command.cwd, context, cwd);
  return inspectSegments(command.text, context.scope, start, context.depth + 1).findings
    .filter((finding) => finding.target !== null && (finding.cause ?? "outside_target") === "outside_target")
    .map((finding) => ({
      ...finding,
      detail: `the code passed to ${how} runs \`${command.text}\`, and in it ${finding.detail}`,
    }));
}

/**
 * Judge one piece of inline code, given the interpreter and option that took it.
 *
 * Two passes, in this order. The first reads where the code writes — the
 * target of each write call, and each redirect or writer in a command it
 * spawns — and refuses a destination that resolves outside the root or the
 * contract, which is the same question a redirect target is asked. The second
 * asks whether the code is a shape the table above can show writes nothing,
 * and refuses it when it is not — which is every shape the table does not name,
 * that being the point. Only the sentence a refusal carries is still drawn from
 * the write-call list.
 */
export function inlineCodeFindings(
  verb: string,
  how: string,
  code: Word,
  context: Context,
  cwd: Cwd,
): WriteFinding[] {
  const tail = `: ${context.segment}`;
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
  const language = inlineLanguage(verb);
  const read = readInlineCode(source, language);
  const sites = writeSites(source, language);
  const here = directoryAt(sites.chdir, context, cwd);
  const judged = new Set<string>();
  // Every destination the code writes, which is a path however short it looks,
  // `notes.md` as much as `/etc/hosts` (SCP-234). A path in the code is a path
  // on disk, not shell text: a `~` or a `$` in it is a character the
  // interpreter reads literally.
  for (const literal of [...sites.targets, ...read.destinations]) {
    if (judged.has(literal)) continue;
    judged.add(literal);
    const destination = judgeTarget(literal, context.scope, here, false);
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
  for (const command of sites.commands) {
    findings.push(...spawnedFindings(command, how, context, here));
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
