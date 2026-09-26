import { scanSegments, tokenize, type Word } from "./lexer.js";

/**
 * The variables a line assigns with `NAME=value`, and the value each holds
 * where the line spells it: null where the shell builds it when the line runs
 * — a substitution, another variable, a `+=`, an array — or where the line
 * gives it two different values.
 *
 * `X=--output=/tmp/x; git diff $X` hands `git diff` the option the assignment
 * spells, and `X=$(printf -- --output=/tmp/x); git diff $X` one the guard
 * cannot read, so a word built from one of these variables is read as the
 * value it holds, or as a word built at run time. Every such word on the line
 * counts, wherever it stands — a bare assignment, one in front of a command,
 * `export X=…`, `env X=…` — since the command it prefixes can be a shell that
 * reads it. A variable the line does not assign this way (`$HOME`, a `for`
 * loop's) is read as it always was.
 */
export type Assigned = ReadonlyMap<string, string | null>;

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/;

/** The assignments `command` spells, added to those an enclosing line made. */
export function assignmentsIn(command: string, inherited?: Assigned): Assigned {
  const found = new Map<string, string | null>(inherited ?? []);
  const give = (name: string, value: string | null) => {
    if (!found.has(name)) found.set(name, value);
    else if (found.get(name) !== value) found.set(name, null);
  };
  for (const text of scanSegments(command).texts) {
    const items = tokenize(text).items;
    items.forEach((item, at) => {
      if (item.kind !== "word") return;
      const word = item.word;
      const spelled = ASSIGNMENT.exec(word.raw);
      if (spelled === null) return;
      const name = spelled[1]!;
      const value = word.value.slice(spelled[0].length);
      const next = items[at + 1];
      const array = value.length === 0 && next?.kind === "word" && next.word.raw === "(";
      const literal =
        spelled[2] === "" &&
        !array &&
        !word.variable &&
        word.substitutions.length === 0 &&
        !word.raw.slice(spelled[0].length).startsWith("~");
      give(name, literal ? value : null);
    });
  }
  return found;
}

/**
 * A word as the shell builds it from the variables in `assigned`: the words it
 * becomes where each it names holds a value the line spells, or unreadable
 * where one holds a value built at run time or is expanded through an
 * operator (`${X:-…}`, `${#X}`). Null where it names none of them.
 *
 * Outside double quotes the value is split into words and its globs stay
 * globs; inside them it is one word, as the shell expands it.
 */
export function expandAssigned(word: Word, assigned: Assigned): Word[] | "unreadable" | null {
  const raw = word.raw;
  let out = "";
  let quote: "'" | '"' | null = null;
  let named = false;
  let i = 0;
  const unquoted = (value: string) =>
    value
      .split(/\s+/)
      .map((part) => part.replace(/[^A-Za-z0-9_/.,:@%+=\-*?[\]]/g, (char) => `\\${char}`))
      .join(" ");
  const quoted = (value: string) => value.replace(/[\\"$`]/g, (char) => `\\${char}`);
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
    if (ch === "'" && quote === null) {
      quote = "'";
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quote = quote === '"' ? null : '"';
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "$") {
      const braced = raw[i + 1] === "{";
      const close = braced ? raw.indexOf("}", i + 2) : -1;
      const body = braced ? (close === -1 ? raw.slice(i + 2) : raw.slice(i + 2, close)) : "";
      const plain = braced ? /^[A-Za-z_][A-Za-z0-9_]*$/.exec(body)?.[0] : /^[A-Za-z_][A-Za-z0-9_]*/.exec(raw.slice(i + 1))?.[0];
      const name = plain ?? (braced ? /^[#!]?([A-Za-z_][A-Za-z0-9_]*)/.exec(body)?.[1] : undefined);
      if (name !== undefined && assigned.has(name)) {
        named = true;
        const value = assigned.get(name);
        if (plain === undefined || value === null || value === undefined || (braced && close === -1)) {
          return "unreadable";
        }
        out += quote === '"' ? quoted(value) : unquoted(value);
        i = braced ? close + 1 : i + 1 + name.length;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  if (!named) return null;
  const words: Word[] = [];
  for (const item of tokenize(out).items) {
    if (item.kind !== "word") return "unreadable";
    words.push(item.word);
  }
  return words;
}
