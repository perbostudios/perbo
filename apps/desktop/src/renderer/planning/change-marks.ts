import type { EditingChange, PlanPromise } from "../../shared/protocol.js";

/**
 * How the last change to the spec and the plan is marked on the panes
 * (D-128): what it added is shown
 * green, what it took away is shown red and struck through, where each stood.
 *
 * Pure functions over text, so the same diff serves a criterion on a node
 * card, a criterion in the inspector and a section of
 * the spec as it reads. Nothing here reads a record or a file; the panes hand
 * these the before and the after the session holds.
 */

/** One stretch of a diff: kept, added by the change, or taken away by it. */
export interface DiffPiece {
  kind: "same" | "added" | "removed";
  text: string;
}

/**
 * The tokens a text is diffed in: words, and the whitespace and punctuation
 * between them, each a token of its own. Joined back they are the text
 * exactly, so a diff of tokens is a diff of characters that happens to break
 * only where a reader would — and a mark never starts inside a word.
 */
const TOKEN = /[\p{L}\p{N}_]+|[^\p{L}\p{N}_]+/gu;
function tokens(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/** A text as its lines, each with the newline that ends it, so joined back they are the text exactly. */
function lines(text: string): string[] {
  return text.length === 0 ? [] : text.split(/(?<=\n)/);
}

/**
 * How many cells the longest-common-subsequence table over one pair of
 * lines may hold: six million, which is 24 MB as 32-bit counts. Past it the
 * pair is called wholly replaced, the last resort rather than the rule — the
 * cap is crossed only where both lines of one pair are past about 2,400
 * tokens, which is 7,000 characters of English prose at the 2.9 characters
 * a token measured on it, and a spec section is diffed line by line first,
 * so only a single line that long reaches it. The table over lines is never
 * capped: a section of the largest size the record allows is at most a few
 * thousand lines, and that table is small.
 */
const PAIR_TABLE_CAP = 6_000_000;

/** One run of a diff over items: kept items, or the items removed and the items added between two kept ones. */
type Run<T> = { kind: "same"; items: T[] } | { kind: "changed"; removed: T[]; added: T[] };

/**
 * The longest common subsequence of two lists, by the usual table, then
 * walked from the front so the runs come out in order: what both have is
 * kept, and between two kept stretches what only the first has is removed
 * and what only the second has is added. The shared head and tail come off
 * first, so the table is over the middle alone. Null where the middle would
 * take more cells than `cap`, since the table is the whole of the cost.
 */
function commonRuns<T>(a: readonly T[], b: readonly T[], cap: number): Run<T>[] | null {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const middleA = a.slice(head, a.length - tail);
  const middleB = b.slice(head, b.length - tail);
  const n = middleA.length;
  const m = middleB.length;
  if ((n + 1) * (m + 1) > cap) return null;
  const runs: Run<T>[] = [];
  const same = (items: T[]): void => {
    if (items.length === 0) return;
    const last = runs.at(-1);
    if (last?.kind === "same") last.items.push(...items);
    else runs.push({ kind: "same", items });
  };
  const changed = (removed: T[], added: T[]): void => {
    if (removed.length === 0 && added.length === 0) return;
    const last = runs.at(-1);
    if (last?.kind === "changed") {
      last.removed.push(...removed);
      last.added.push(...added);
    } else runs.push({ kind: "changed", removed, added });
  };
  same(a.slice(0, head));
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i * width + j] =
        middleA[i] === middleB[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (middleA[i] === middleB[j]) {
      same([middleA[i]!]);
      i++;
      j++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      changed([middleA[i]!], []);
      i++;
    } else {
      changed([], [middleB[j]!]);
      j++;
    }
  }
  changed(middleA.slice(i), middleB.slice(j));
  same(a.slice(a.length - tail));
  return runs;
}

/**
 * The difference between two texts, as runs of kept, added and removed
 * tokens in reading order, with the removed run ahead of the added one where
 * the two sit together. Runs of one kind are collapsed, so a changed phrase is
 * one mark rather than one per word.
 *
 * The lines are diffed first, which is cheap, and only the lines that changed
 * are diffed by word: between two kept stretches the lines that went are
 * paired in order with the lines that came, each pair diffed on its own, and
 * a line left over on either side is whole removed or whole added. A section
 * with a sentence changed at its top and another at its bottom is two small
 * tables, not one over the whole section.
 */
export function wordDiff(before: string, after: string): DiffPiece[] {
  const pieces: DiffPiece[] = [];
  const push = (kind: DiffPiece["kind"], text: string): void => {
    if (text.length === 0) return;
    const last = pieces.at(-1);
    if (last !== undefined && last.kind === kind) last.text += text;
    else pieces.push({ kind, text });
  };
  for (const run of commonRuns(lines(before), lines(after), Number.POSITIVE_INFINITY)!) {
    if (run.kind === "same") {
      push("same", run.items.join(""));
      continue;
    }
    const pairs = Math.min(run.removed.length, run.added.length);
    for (let at = 0; at < pairs; at++)
      for (const piece of tokenDiff(run.removed[at]!, run.added[at]!)) push(piece.kind, piece.text);
    push("removed", run.removed.slice(pairs).join(""));
    push("added", run.added.slice(pairs).join(""));
  }
  return mergeHunks(pieces);
}

/** One pair of lines diffed by token, or called wholly replaced past the table's cap. */
function tokenDiff(before: string, after: string): DiffPiece[] {
  const runs = commonRuns(tokens(before), tokens(after), PAIR_TABLE_CAP);
  if (runs === null)
    return [
      { kind: "removed", text: before },
      { kind: "added", text: after },
    ];
  return runs.flatMap((run): DiffPiece[] =>
    run.kind === "same"
      ? [{ kind: "same", text: run.items.join("") }]
      : [
          { kind: "removed", text: run.removed.join("") },
          { kind: "added", text: run.added.join("") },
        ],
  );
}

/**
 * A changed phrase as one mark. The table matches a space between two new
 * words to any space in the old text, which leaves "the colour mode" as
 * three green words with plain spaces between, and a struck word in each
 * gap. So a run of changes with nothing but whitespace kept between them is
 * one change: what went, as one removed piece, and what came, as one added
 * piece, each with the whitespace it had, so both texts still come back
 * whole from the pieces. The same holds across lines: two lines paired and
 * each wholly reworded, with only their newlines kept, are one change.
 */
function mergeHunks(pieces: readonly DiffPiece[]): DiffPiece[] {
  const merged: DiffPiece[] = [];
  let index = 0;
  while (index < pieces.length) {
    const piece = pieces[index]!;
    if (piece.kind === "same") {
      merged.push(piece);
      index++;
      continue;
    }
    // The hunk runs to the next kept piece that is more than whitespace, and
    // ends on its last change, so no kept whitespace leads or trails it.
    let last = index;
    for (let at = index; at < pieces.length; at++) {
      const each = pieces[at]!;
      if (each.kind === "same" && each.text.trim().length > 0) break;
      if (each.kind !== "same") last = at;
    }
    const hunk = pieces.slice(index, last + 1);
    // A hunk that is already one removal, one addition, or the one ahead of
    // the other stands; any other shape is collapsed to that.
    const ordered =
      (hunk.length === 1 && hunk[0]!.kind !== "same") ||
      (hunk.length === 2 && hunk[0]!.kind === "removed" && hunk[1]!.kind === "added");
    if (ordered) merged.push(...hunk);
    else {
      const removed = hunk.filter((each) => each.kind !== "added").map((each) => each.text).join("");
      const added = hunk.filter((each) => each.kind !== "removed").map((each) => each.text).join("");
      if (removed.length > 0) merged.push({ kind: "removed", text: removed });
      if (added.length > 0) merged.push({ kind: "added", text: added });
    }
    index = last + 1;
  }
  return merged;
}

/** How one criterion the plan now has stands after the last change. */
export type CriterionChange =
  | { kind: "unchanged" }
  /** Reworded: the diff, and the words it now has, which a view marks only while it shows those. */
  | { kind: "changed"; diff: DiffPiece[]; text: string }
  | { kind: "added"; text: string };

/** The last change to the plan's criteria, as the panes mark it. */
export interface CriteriaChange {
  /** Each criterion the plan now has, by its id, as the change left it. */
  of: Map<string, CriterionChange>;
  /** The words of each criterion the change took away, in the order they had, for the end of the list. */
  removed: string[];
}

/**
 * Each criterion's standing after the change: the ones it left as they were,
 * the ones it reworded, with their diff, the ones it added, and the ones it
 * took away, kept with the words they had so a pane can show them struck
 * through where the list ends.
 *
 * Paired by words and never by id, because an edit through `perbo edit`
 * numbers the criteria afresh: deleting the second of three leaves the third
 * with the second's id, and by id it would read as the second reworded into
 * the third and the third gone. A criterion with the same words on both
 * sides is unchanged, wherever it moved; the rest are paired in the order
 * they stand, each pair a rewording, and what is left over on either side
 * was taken away or added. The id kept is the after-side's, which is what
 * the pane draws by.
 */
export function criteriaChange(
  before: PlanPromise["criteria"],
  after: PlanPromise["criteria"],
): CriteriaChange {
  const of = new Map<string, CriterionChange>();
  const unpaired = before.map((criterion) => criterion.text);
  const reworded: PlanPromise["criteria"] = [];
  for (const criterion of after) {
    const at = unpaired.findIndex((text) => text.trim() === criterion.text.trim());
    if (at >= 0) {
      unpaired.splice(at, 1);
      of.set(criterion.id, { kind: "unchanged" });
    } else reworded.push(criterion);
  }
  const pairs = Math.min(unpaired.length, reworded.length);
  reworded.forEach((criterion, index) =>
    of.set(
      criterion.id,
      index < pairs
        ? { kind: "changed", diff: wordDiff(unpaired[index]!, criterion.text), text: criterion.text }
        : { kind: "added", text: criterion.text },
    ),
  );
  return { of, removed: unpaired.slice(pairs) };
}

/**
 * What tells one recorded change from the next, for a memo over it: when it
 * was recorded and the words on each side. A session read again holds a
 * fresh object for the same change, and a diff of a long section is not
 * something to do again for that.
 */
export function changeKey(change: EditingChange | null): string | null {
  if (change === null) return null;
  const spec =
    change.spec === null
      ? ""
      : [change.spec.before, change.spec.after].flatMap((sections) => Object.values(sections)).join("\u0000");
  const plan =
    change.plan === null
      ? ""
      : [change.plan.before, change.plan.after]
          .flatMap((promise) => [promise.outcome, ...promise.criteria.map((criterion) => criterion.text)])
          .join("\u0000");
  return `${change.at}\u0001${spec}\u0001${plan}`;
}

/**
 * A change to one text, placed in the after-text: the stretches that are new,
 * as offsets in it, and what was taken away, at the offset where it stood.
 * This is the shape a view that draws the after-text from its own source
 * offsets can apply — the spec as it reads, whose runs each know where in the
 * section they begin.
 */
export interface TextMarks {
  added: { from: number; to: number }[];
  removed: { at: number; text: string }[];
}

export function textMarks(before: string, after: string): TextMarks {
  const marks: TextMarks = { added: [], removed: [] };
  let cursor = 0;
  for (const piece of wordDiff(before, after)) {
    if (piece.kind === "removed") {
      // Whitespace alone that went is nothing a reader can see struck
      // through, and a bare struck space beside a word is noise.
      if (piece.text.trim().length > 0) marks.removed.push({ at: cursor, text: piece.text });
      continue;
    }
    // And whitespace alone that came — the space a merged hunk gives back to
    // the after-text — is not a mark either.
    if (piece.kind === "added" && piece.text.trim().length > 0)
      marks.added.push({ from: cursor, to: cursor + piece.text.length });
    cursor += piece.text.length;
  }
  return marks;
}

/** One stretch of a run as it is drawn: its own text, at its source offset, or a removal put there. */
export type RunPiece = { kind: "text" | "added" | "removed"; text: string; at: number };

/**
 * Which run each removal is drawn in, by the run's index: the first run that
 * reaches the offset where it stood, and the last run for one that stood
 * after every run. A removal at the boundary between two runs goes with the
 * first, so it is drawn once. Runs are the view's, in reading order, each
 * knowing where in the source it begins.
 */
export function placeRemovals(
  runs: readonly { at: number; text: string }[],
  removed: readonly { at: number; text: string }[],
): Map<number, { at: number; text: string }[]> {
  const placed = new Map<number, { at: number; text: string }[]>();
  if (runs.length === 0) return placed;
  for (const removal of removed) {
    let index = runs.findIndex((run) => run.at + run.text.length >= removal.at);
    if (index < 0) index = runs.length - 1;
    const run = runs[index]!;
    const at = Math.min(Math.max(removal.at, run.at), run.at + run.text.length);
    const list = placed.get(index) ?? [];
    list.push({ at, text: removal.text });
    placed.set(index, list);
  }
  return placed;
}

/**
 * One run split where the marks fall: its text in pieces, the added stretches
 * marked as such, and each removal placed in it inserted at its offset. A run
 * with nothing in it comes back as itself.
 */
export function markRun(
  run: { at: number; text: string },
  added: readonly { from: number; to: number }[],
  removed: readonly { at: number; text: string }[],
): RunPiece[] {
  const end = run.at + run.text.length;
  const cuts = new Set<number>([run.at, end]);
  for (const range of added) {
    if (range.from > run.at && range.from < end) cuts.add(range.from);
    if (range.to > run.at && range.to < end) cuts.add(range.to);
  }
  for (const removal of removed) cuts.add(removal.at);
  const points = [...cuts].sort((left, right) => left - right);
  const pieces: RunPiece[] = [];
  for (let index = 0; index < points.length; index++) {
    const at = points[index]!;
    for (const removal of removed) if (removal.at === at) pieces.push({ kind: "removed", text: removal.text, at });
    const to = points[index + 1];
    if (to === undefined || to === at) continue;
    const text = run.text.slice(at - run.at, to - run.at);
    const isAdded = added.some((range) => range.from <= at && range.to >= to);
    pieces.push({ kind: isAdded ? "added" : "text", text, at });
  }
  return pieces;
}

/** What a view draws in order: one piece on its own, or pieces added together, drawn as one mark. */
type Stretch<T> = { added: false; piece: T } | { added: true; pieces: T[] };

/**
 * Pieces in reading order, with every stretch of added pieces gathered into
 * one, so a view draws it as one mark and the highlight runs unbroken across
 * it. Added pieces sit side by side wherever the view splits its text for a
 * reason of its own — the spec's runs split at emphasis and code, and a diff
 * keeps a space apart — and each drawn as a mark of its own leaves a gap at
 * every split. Whitespace between two added pieces goes into the stretch
 * with them, since the words either side of it came together; whitespace
 * after the last one does not, and a removal ends the stretch, since what
 * went is drawn where it stood and never inside what came.
 */
export function gatherAdded<T extends { kind: string; text: string }>(pieces: readonly T[]): Stretch<T>[] {
  const stretches: Stretch<T>[] = [];
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index]!;
    if (piece.kind !== "added") {
      stretches.push({ added: false, piece });
      continue;
    }
    const gathered = [piece];
    for (let next = index + 1; next < pieces.length; next++) {
      const ahead = pieces[next]!;
      if (ahead.kind === "removed" || (ahead.kind !== "added" && ahead.text.trim().length > 0)) break;
      if (ahead.kind === "added") {
        gathered.push(...pieces.slice(index + 1, next + 1));
        index = next;
      }
    }
    stretches.push({ added: true, pieces: gathered });
  }
  return stretches;
}
