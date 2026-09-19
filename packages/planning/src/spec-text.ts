import { PlanningError } from "./errors.js";

/**
 * Writing a spec, which is the other half of {@link parseSpec} (D-103): the
 * five sections in, the Markdown the reader reads out — and, beside it, which
 * node each requirement lands in.
 *
 * Nothing here touches the filesystem, so the desktop's browser preview runs
 * the same id assignment and the same slug as the command line does. Putting
 * the file on disk is `spec-write.ts`.
 *
 * The reader is strict, because a spec that is about to be drafted from has to
 * be complete. This side is not: a person writes a spec section by section, and
 * a requirement they have just typed has no id until it is written down. So
 * what goes in is the five sections as text, and what comes back is the file
 * with ids assigned, which is what the person then sees beside each
 * requirement.
 */

/** The five sections a spec has, in the order D-103 writes them. */
export const SPEC_HEADINGS = ["Outcome", "Requirements", "No-Gos", "Rabbit holes", "Notes"] as const;
export type SpecHeading = (typeof SPEC_HEADINGS)[number];

export interface SpecRequirement {
  /** `R1` upward, written into the spec when the requirement is written. */
  id: string;
  text: string;
}

export interface Spec {
  /** The first `#` heading. */
  title: string;
  outcome: string;
  requirements: SpecRequirement[];
  /** Behaviour deliberately excluded from the outcome, one per list item. */
  no_gos: string[];
  rabbit_holes: string[];
  /** Written by hand and kept; prose rather than a list. */
  notes: string;
}

/**
 * The longest slug a spec folder takes. Long enough to read, short enough to
 * type. Named for the spec because `@perbo/workspace` caps a branch name's
 * slug at its own length, and the two are not the same bound.
 */
export const MAX_SPEC_SLUG_LENGTH = 60;

/** The five sections as a person edits them, before any id is assigned. */
export interface SpecText {
  title: string;
  outcome: string;
  /** One requirement per line; `- R1: text` where it already has an id. */
  requirements: string;
  no_gos: string;
  rabbit_holes: string;
  notes: string;
}

/** A requirement on the way in: `id` is null for one written just now. */
export interface SpecRequirementDraft {
  id: string | null;
  text: string;
}

/**
 * The highest requirement id the file has ever held, kept in the file itself.
 *
 * An id is never reused after its requirement is removed (D-103), and nothing
 * else remembers a removed one: a requirement no criterion ever cited leaves no
 * trace in the contract, the draft or the node pages, so deriving the mark from
 * the ids still in use would hand `R3` to a new requirement the moment the old
 * `R3` was deleted. The mark lives where the spec lives, so one file is the
 * whole of it. It is an HTML comment inside the Requirements section, which
 * `parseSpec` already drops — it reads list items there and nothing else — so
 * the reader needs no knowledge of it.
 */
const MARK = /<!--\s*perbo:requirement-ids through R(\d+)\s*-->/;
const markLine = (highWater: number): string =>
  `<!-- perbo:requirement-ids through R${highWater} -->`;

const LIST_ITEM = /^[-*]\s+(.*)$/;
const REQUIREMENT = /^(R[1-9]\d*):\s*(.+)$/;

/**
 * One slug for one title, deterministically: lowercase, ASCII letters and
 * digits kept, every run of anything else one hyphen, trimmed and capped.
 *
 * A title that leaves nothing is refused rather than given a made-up name. A
 * folder nobody can find from the title it came from is worse than a refusal
 * the person can answer by writing a title.
 */
export function specSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SPEC_SLUG_LENGTH)
    .replace(/-+$/, "");
  if (slug.length === 0) {
    throw new PlanningError(
      `'${title}' leaves no folder name: a spec's folder is its title in ASCII letters and ` +
        "digits, so give it a title with at least one of them (D-103)",
    );
  }
  return slug;
}

/**
 * The openings a person writes before they say what the work is. Stripped so
 * the title is the work rather than the asking for it.
 */
const OPENING =
  /^(?:i(?:'d| would)? (?:want|like|need)(?: to)?|can you|could you|please|let'?s|we need(?: to)?|help me)\b[\s,:-]*/i;

/**
 * The first sentence of a message, where a full stop after a short token is an
 * abbreviation rather than an ending.
 *
 * "Fix Dr. Smith's login" is one sentence, and splitting it at `Dr.` would
 * name the folder `fix-dr` — a name minted once and never moved. Two letters
 * is the line: it keeps `Dr.`, `e.g.` and `vs.` whole and still ends a
 * sentence on any ordinary word.
 */
function firstSentence(text: string): string {
  for (let at = 0; at < text.length - 1; at++) {
    const mark = text[at]!;
    if (mark !== "." && mark !== "!" && mark !== "?") continue;
    if (!/\s/.test(text[at + 1]!)) continue;
    const word = /(\S+)$/.exec(text.slice(0, at))?.[1] ?? "";
    if (mark === "." && word.replace(/[^A-Za-z]/g, "").length <= 2) continue;
    return text.slice(0, at + 1);
  }
  return text;
}

/**
 * A spec title taken from the first thing a person said about the work.
 *
 * The person's own words, cut down deterministically: the first sentence, its
 * opening dropped, clipped to a whole word. Nothing a model returned reaches
 * this, so the folder it goes on to name stays the person's own parameter
 * ([ADR-0023](../../../docs/adr/0023-untrusted-context-boundary.md) §4).
 *
 * A message that leaves no letters or digits is refused rather than given a
 * made-up name, for {@link specSlug}'s reason: the folder has to be findable
 * from what it was called.
 */
export function specTitleFromMessage(message: string): string {
  const sentence = firstSentence(message.replace(/\s+/g, " ").trim())
    .replace(OPENING, "")
    .replace(/[.!?,;:\s]+$/, "")
    .trim();
  const whole = sentence.slice(0, MAX_SPEC_SLUG_LENGTH + 1).replace(/\s+\S*$/, "");
  const clipped =
    sentence.length <= MAX_SPEC_SLUG_LENGTH
      ? sentence
      : // A first word longer than the cap has no space to cut back to, so it
        // is cut where the cap falls rather than run past it.
        whole.length > 0 && whole.length <= MAX_SPEC_SLUG_LENGTH
        ? whole
        : sentence.slice(0, MAX_SPEC_SLUG_LENGTH);
  const title = clipped.charAt(0).toUpperCase() + clipped.slice(1);
  // specSlug is the judge of what leaves a folder name: asking it here means
  // one rule rather than two that drift.
  specSlug(title);
  return title;
}

/**
 * The requirements a section's text states, each with the id it already
 * carries.
 *
 * A line that is not a list item is a requirement too, and is written back as
 * one. Dropping it would lose a person's sentence silently, which is the one
 * outcome an editor may not have.
 */
function parseRequirementLines(text: string): SpecRequirementDraft[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !MARK.test(line))
    .map((line) => {
      const item = LIST_ITEM.exec(line);
      const body = (item ? item[1]! : line).trim();
      const match = REQUIREMENT.exec(body);
      return match
        ? { id: match[1]!, text: match[2]!.trim() }
        : { id: null, text: body };
    })
    .filter((requirement) => requirement.text.length > 0);
}

/** The list items a section's text states, for No-Gos and Rabbit holes. */
const listOf = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const item = LIST_ITEM.exec(line);
      return (item ? item[1]! : line).trim();
    })
    .filter((line) => line.length > 0);

/**
 * The mark a file carries, or the highest id in it where it carries none. An
 * id counts on a list item, indented or not, and on a plain line alike, which
 * is every line `parseRequirementLines` reads as a requirement.
 */
export function requirementHighWater(markdown: string): number {
  const marked = MARK.exec(markdown);
  const ids = [...markdown.matchAll(/^\s*(?:[-*]\s+)?R([1-9]\d*):/gm)].map((match) => Number(match[1]));
  return Math.max(marked ? Number(marked[1]) : 0, 0, ...ids);
}

/**
 * The spec as Markdown, with an id on every requirement.
 *
 * A requirement that arrives with an id keeps it, however its text was edited.
 * One that arrives without keeps the id of the requirement in `existing` whose
 * text is the same, unless a line names that id itself; otherwise it gets the
 * next past the mark. So an editor that sends a section again before it has
 * read the file back does not renumber it. An id that arrives twice is
 * refused, because a criterion cites one and two requirements under one id
 * would make the citation ambiguous.
 */
export function renderSpec(
  text: SpecText,
  options: { highWater?: number; existing?: readonly SpecRequirementDraft[] } = {},
): { markdown: string; requirements: SpecRequirement[]; highWater: number } {
  const title = text.title.trim();
  if (title.length === 0) {
    throw new PlanningError("a spec's first heading is the title of the work it states");
  }
  const drafts = parseRequirementLines(text.requirements);
  let highWater = Math.max(
    options.highWater ?? 0,
    0,
    ...drafts.map((draft) => (draft.id === null ? 0 : Number(draft.id.slice(1)))),
  );
  const named = new Set(drafts.flatMap((draft) => (draft.id === null ? [] : [draft.id])));
  const kept = new Map<string, string>();
  const heldIds = new Set<string>();
  for (const each of options.existing ?? []) {
    if (each.id === null) continue;
    heldIds.add(each.id);
    if (!named.has(each.id) && !kept.has(each.text)) kept.set(each.text, each.id);
  }
  // Keyed on id, holding the text it was seen with: a "Keep both" join carries
  // the file's text and the person's whole, so a requirement neither side
  // touched is whole in both halves and its line arrives twice. That is one
  // requirement said twice, not two requirements sharing an id, and only the
  // second reading tells them apart.
  const seen = new Map<string, string>();
  const requirements: SpecRequirement[] = drafts.flatMap((draft) => {
    if (draft.id !== null) {
      const already = seen.get(draft.id);
      if (already !== undefined) {
        if (already === draft.text) return [];
        throw new PlanningError(
          `the spec uses the requirement id ${draft.id} twice. An id is written once and never ` +
            "reused, because a criterion cites it",
        );
      }
      seen.set(draft.id, draft.text);
      return [{ id: draft.id, text: draft.text }];
    }
    const held = kept.get(draft.text);
    if (held !== undefined && !seen.has(held)) {
      seen.set(held, draft.text);
      return [{ id: held, text: draft.text }];
    }
    // Past the mark and past every id a line names or `existing` holds, so
    // the file never carries one id twice whatever the mark said.
    do highWater += 1;
    while (named.has(`R${highWater}`) || heldIds.has(`R${highWater}`));
    const id = `R${highWater}`;
    seen.set(id, draft.text);
    return [{ id, text: draft.text }];
  });

  const body: Record<(typeof SPEC_HEADINGS)[number], string> = {
    Outcome: text.outcome.trim(),
    Requirements: [
      ...requirements.map((requirement) => `- ${requirement.id}: ${requirement.text}`),
      // No mark until an id has been given: a file that numbered nothing carries nothing.
      ...(highWater === 0 ? [] : ["", markLine(highWater)]),
    ].join("\n"),
    "No-Gos": listOf(text.no_gos)
      .map((each) => `- ${each}`)
      .join("\n"),
    "Rabbit holes": listOf(text.rabbit_holes)
      .map((each) => `- ${each}`)
      .join("\n"),
    Notes: text.notes.trim(),
  };
  const markdown =
    `# ${title}\n\n` +
    SPEC_HEADINGS.map((heading) => `## ${heading}\n\n${body[heading]}\n`).join("\n");
  return { markdown, requirements, highWater };
}


/**
 * Read a spec back as the five sections a person edits, with the ids it
 * carries and the mark behind them.
 *
 * Deliberately more forgiving than {@link parseSpec}: a spec half written has
 * no Outcome yet and its requirements have no ids, and a reader that refused
 * one could not open the file the person is in the middle of writing. What is
 * strict is the drafting path, which reads the same bytes with `parseSpec`.
 */
export function readSpecSections(markdown: string): {
  text: SpecText;
  requirements: SpecRequirementDraft[];
  highWater: number;
} {
  const lines = markdown.replace(/^\uFEFF/, "").split(/\r?\n/);
  let title = "";
  const found = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of lines) {
    const heading = /^(#{1,2})\s+(.*)$/.exec(line.trim());
    if (heading === null) {
      current?.push(line);
      continue;
    }
    if (heading[1] === "#") {
      if (title.length === 0) title = heading[2]!.trim();
      current = null;
      continue;
    }
    current = [];
    found.set(heading[2]!.trim(), current);
  }
  const section = (name: string): string =>
    (found.get(name) ?? [])
      .filter((line) => !MARK.test(line))
      .join("\n")
      .trim();
  return {
    highWater: requirementHighWater(markdown),
    requirements: parseRequirementLines(section("Requirements")),
    text: {
      title,
      outcome: section("Outcome"),
      requirements: section("Requirements"),
      no_gos: section("No-Gos"),
      rabbit_holes: section("Rabbit holes"),
      notes: section("Notes"),
    },
  };
}

/**
 * What a contract has to say about where a requirement landed, read
 * structurally: a `PlanContract` satisfies it, and nothing here imports the
 * schema, so this module stays free of the filesystem and of node's crypto and
 * runs in the desktop's renderer as it does on the command line. P0 carries
 * neither field and reaches every requirement's answer as `[]`, which is right.
 */
export interface PlanWithRequirements {
  acceptance_criteria?: readonly { id: string; requirement_id?: string | undefined }[] | undefined;
  nodes?: readonly { id: string; criteria: readonly string[] }[] | undefined;
}

export interface RequirementNode {
  id: string;
  text: string;
  /** The nodes holding the criteria that cite it, in the plan's node order. */
  nodes: string[];
}

/**
 * Which node each requirement lands in, derived rather than written down.
 *
 * A requirement lands in the node holding the criteria drafted from it, so one
 * whose criteria were split across nodes appears in each of them and one no
 * criterion cites yet appears in none (D-103). A plan with no graph puts every
 * criterion in the one implicit whole, so it names no node for anything.
 */
export function requirementNodes(
  spec: Pick<Spec, "requirements">,
  contract: PlanWithRequirements | null,
): RequirementNode[] {
  const nodes = contract?.nodes ?? [];
  const criteria = contract?.acceptance_criteria ?? [];
  const citedBy = new Map<string, Set<string>>();
  for (const criterion of criteria) {
    if (criterion.requirement_id === undefined) continue;
    const holder = nodes.find((node) => node.criteria.includes(criterion.id));
    if (holder === undefined) continue;
    const already = citedBy.get(criterion.requirement_id);
    if (already === undefined) citedBy.set(criterion.requirement_id, new Set([holder.id]));
    else already.add(holder.id);
  }
  return spec.requirements.map((requirement) => ({
    id: requirement.id,
    text: requirement.text,
    nodes: nodes.map((node) => node.id).filter((id) => citedBy.get(requirement.id)?.has(id)),
  }));
}

/**
 * How a spec names code: `@Symbol`, on the left of a word boundary that is not
 * an address, a property access or another `@` (D-103).
 *
 * `$` is an identifier character here because it is one in TypeScript and
 * JavaScript, and the index holds names that use it. A narrower reading would
 * mark `@retry$Queue` as a name the index cannot find while the index holds it,
 * and the pane would be telling a person to fix something that is already
 * right. This is the pattern the impact warnings read a spec with, so the names
 * the Spec pane marks and the names the impact analysis looks up are one list.
 *
 * The boundary is consumed by the match, so it is `match[1].length` characters
 * wide and the reference itself starts after it.
 */
const SPEC_SYMBOL = /(^|[^\w$@.])@([A-Za-z_$][A-Za-z0-9_$]*)/g;

/** One stretch of a spec's text: a whole `@Symbol`, or the prose between them. */
export interface SpecTextRun {
  text: string;
  /** The name, without its `@`; null for prose. */
  name: string | null;
}

/**
 * A spec section split into its `@Symbol` references and the prose around them.
 *
 * The runs put the text back together exactly — `runs.map(r => r.text).join("")`
 * is the input — because they are rendered behind a textarea the person types
 * in, and a dropped character would slide every mark after it off its word.
 */
export function markSpecSymbols(text: string): SpecTextRun[] {
  const runs: SpecTextRun[] = [];
  let cursor = 0;
  SPEC_SYMBOL.lastIndex = 0;
  for (let match = SPEC_SYMBOL.exec(text); match !== null; match = SPEC_SYMBOL.exec(text)) {
    const at = match.index + match[1]!.length;
    if (at > cursor) runs.push({ text: text.slice(cursor, at), name: null });
    runs.push({ text: text.slice(at, at + match[2]!.length + 1), name: match[2]! });
    cursor = at + match[2]!.length + 1;
  }
  if (cursor < text.length) runs.push({ text: text.slice(cursor), name: null });
  return runs;
}

/** Every name a spec's text refers to, once each, in the order they appear. */
export function specSymbolNames(text: string): string[] {
  const seen: string[] = [];
  for (const run of markSpecSymbols(text))
    if (run.name !== null && !seen.includes(run.name)) seen.push(run.name);
  return seen;
}

/**
 * The `@Symbol` being typed immediately before the caret, or null.
 *
 * `before` is the section's text up to the caret, so the reference has to run
 * to its end: a name already left behind is finished, and offering to complete
 * it would rewrite a word the person has moved on from. `from` is where the `@`
 * is, which is where the popup opens and where an insertion starts.
 */
export function symbolBeingTyped(before: string): { from: number; query: string } | null {
  const match = /(^|[^\w$@.])@([A-Za-z_$][A-Za-z0-9_$]*)?$/.exec(before);
  if (match === null) return null;
  return { from: match.index + match[1]!.length, query: match[2] ?? "" };
}

/**
 * The names offered for what is being typed: every one holding the query
 * anywhere, the ones that start with it first, at most `limit` of them.
 *
 * A substring match rather than a prefix because a person naming code
 * remembers the noun and not the qualifier — `@Queue` has to reach
 * `signupQueue` — and the prefix matches lead because where the person did
 * type the start, that is what they meant. Ordering is otherwise the index's
 * own, and the filters run in one pass each rather than through a comparator,
 * so two names matching equally keep the order the index gave them.
 */
export function symbolOptions<T extends { name: string }>(
  query: string,
  symbols: readonly T[],
  limit: number,
): T[] {
  const wanted = query.toLowerCase();
  const matched = symbols.filter((symbol) => symbol.name.toLowerCase().includes(wanted));
  const starts = (symbol: T): boolean => symbol.name.toLowerCase().startsWith(wanted);
  return [...matched.filter(starts), ...matched.filter((symbol) => !starts(symbol))].slice(0, limit);
}

/**
 * Write a chosen name over the reference being typed, and say where the caret
 * lands (SCP-321).
 *
 * `@Name ` and not `@Name`: the space ends the reference, so what is typed
 * next is the next word rather than more of the name, and the caret goes past
 * it. A space already after the caret is not doubled.
 */
export function completeSymbol(args: {
  text: string;
  /** Where the `@` is, from {@link symbolBeingTyped}. */
  from: number;
  /** The caret, which is the end of what is being replaced. */
  to: number;
  name: string;
}): { text: string; caret: number } {
  const written = `@${args.name} `;
  return {
    text: args.text.slice(0, args.from) + written + args.text.slice(args.to).replace(/^ /, ""),
    caret: args.from + written.length,
  };
}

/**
 * Write one name in place of another everywhere this section refers to it.
 *
 * Done over {@link markSpecSymbols}'s runs rather than by a pattern built from
 * the name, because the name is not a pattern: `$` is an identifier character
 * here and a repetition in a regular expression, and an address or a property
 * access that happens to carry the same letters is not a reference and is left
 * alone. What is replaced is exactly what the pane marked.
 */
export function replaceSymbolName(text: string, from: string, to: string): string {
  return markSpecSymbols(text)
    .map((run) => (run.name === from ? `@${to}` : run.text))
    .join("");
}

/** Levenshtein distance, case-folded: a typo and a case slip both read as near. */
function editDistance(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= right.length; j += 1) {
      next.push(
        Math.min(
          row[j]! + 1,
          next[j - 1]! + 1,
          row[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
        ),
      );
    }
    row = next;
  }
  return row[right.length]!;
}

/**
 * The names nearest one the index does not hold, for the offer to fix it.
 *
 * Ties break on the name so that a spec offers the same two every time it is
 * opened; without that the answer would depend on the order the index happened
 * to list its files in, and a person would see the suggestion move.
 */
export function nearestSymbolNames(
  name: string,
  names: readonly string[],
  count: number,
): string[] {
  return names
    .map((each) => ({ name: each, distance: editDistance(name, each) }))
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, count)
    .map((each) => each.name);
}

/** The title and the five sections, in the order they are written and shown. */
export const SPEC_FIELDS = [
  "title",
  "outcome",
  "requirements",
  "no_gos",
  "rabbit_holes",
  "notes",
] as const satisfies readonly (keyof SpecText)[];
export type SpecField = (typeof SPEC_FIELDS)[number];

/** A spec nobody has written yet: what a first write is against. */
export const EMPTY_SPEC_TEXT: SpecText = {
  title: "",
  outcome: "",
  requirements: "",
  no_gos: "",
  rabbit_holes: "",
  notes: "",
};

/**
 * A write refused because the spec moved under the writer (SCP-321).
 *
 * `current` is the file as it is now, so whoever is refused can show both
 * sides rather than losing one of them, and `conflicting` names the fields
 * where the two disagree.
 */
export class SpecConflict extends PlanningError {
  readonly conflicting: readonly SpecField[];
  readonly current: SpecText;

  constructor(conflicting: readonly SpecField[], current: SpecText) {
    super(
      `the spec has changed since it was read: ${conflicting.join(", ")} ` +
        `${conflicting.length === 1 ? "was" : "were"} written by somebody else. ` +
        "Nothing was saved",
    );
    this.name = "SpecConflict";
    this.conflicting = conflicting;
    this.current = current;
  }
}

/**
 * Three texts into one: what the writer read, what it wants, and what the file
 * holds now (SCP-321).
 *
 * The Spec pane and the Impact pane's No-Go action call this before every
 * save; the interview writes the same file through its own tools and never
 * calls it, so this only ever holds one of those two panes' own change against
 * whatever the file now says — including a line the interview, or the other
 * pane, put there since this call's writer last read it. Comparing the whole
 * file would make every unrelated field collide, so the comparison is per
 * field: a field the writer did not change takes whatever the file says, a
 * field only the writer changed takes the writer's, and a field both changed
 * is a conflict, which is the only case a person has to answer.
 *
 * Nothing here consults a clock or a revision the app kept. Two processes write
 * this file and neither tells the other, so the only honest question is what
 * the bytes say at the moment of the write.
 */
export function mergeSpecText(args: {
  /** The file as the writer last read it. */
  base: SpecText;
  /** The text the writer wants the file to hold. */
  next: SpecText;
  /** The file as it is now. */
  current: SpecText;
}): { text: SpecText; conflicting: SpecField[] } {
  const conflicting: SpecField[] = [];
  const text = { ...args.current };
  for (const field of SPEC_FIELDS) {
    if (args.next[field] === args.base[field]) continue;
    // Both moved it to the same words, so there is nothing to settle and the
    // file already says what this writer wanted. A refusal asks a person to
    // choose between two texts and there is only one; the No-Go action makes
    // this ordinary, because adding a line that is already there is what it
    // does when asked twice.
    if (args.current[field] === args.next[field]) continue;
    if (args.current[field] !== args.base[field]) {
      conflicting.push(field);
      continue;
    }
    text[field] = args.next[field];
  }
  return { text, conflicting };
}
