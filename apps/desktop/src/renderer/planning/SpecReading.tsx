import { cx } from "../ui/index.js";
import { Added } from "./ChangeMarks.js";
import { gatherAdded, markRun, placeRemovals, type RunPiece, type TextMarks } from "./change-marks.js";
import { specBlocks, type SpecItem, type SpecRun } from "./spec-format.js";

/**
 * A spec section as it reads, which is how it is shown until somebody types in
 * it ({@link ./SpecSection.tsx}).
 *
 * A spec is written once and read many times — by the person, in review, and
 * every time the work is picked up again — so the reading is what the pane
 * should be good at. The editor showed the file's own characters: `###` at the
 * head of a heading, a hyphen where a bullet was meant, `R1:` in front of every
 * requirement. All three are how the file says a thing, not how a person reads
 * one.
 *
 * What is coloured here is what the writer marked, never a word this code
 * decided was important: a reference, a piece of code, the emphasis they typed,
 * the id the spec gave a requirement. A highlight a reader cannot trust is
 * worse than no highlight, so there is no rule here that looks for "must" or
 * "never" and paints it.
 *
 * Clicking opens the editor at the character under the pointer. Every run says
 * where it came from, so that is a lookup rather than a guess, and a click in
 * the space beside a line falls back to the start of that line's own words —
 * the nearest thing to the pointer that is text.
 *
 * The last change to the section is marked on it
 * (D-128): what it added is green, and
 * what it took away is put back where it stood, red and struck through. The
 * marks are over the same runs, split where a mark begins or ends, so an
 * added stretch keeps its own source offsets and a click on it lands where
 * it would have; added pieces side by side, across runs, are one mark, so
 * the green is one unbroken highlight; a removal is not in the source, so a
 * click on one lands at the offset it stood at, which is the nearest real
 * character.
 */

/** The marks placed on a section's runs: each run's removals, by the run's index across the section. */
type Placed = { marks: TextMarks; removals: Map<number, { at: number; text: string }[]> } | null;

/** Where a click landed, in the section's own text, or null for nowhere in it. */
function offsetFrom(target: Node, offsetInNode: number): number | null {
  const element = target.nodeType === Node.TEXT_NODE ? target.parentElement : (target as Element);
  const carrier = element?.closest("[data-at]");
  if (!(carrier instanceof HTMLElement)) return null;
  const at = Number(carrier.dataset.at);
  if (!Number.isFinite(at)) return null;
  // A run holds exactly its own text, so an offset inside it is an offset in
  // the source. Anything else — the space around a line, a bullet, an id — is
  // not source text, and the start of the line is what is under the pointer.
  const own = carrier.dataset.run === "" && target.nodeType === Node.TEXT_NODE;
  return own ? at + offsetInNode : at;
}

/** The caret position for a point on the page, where the browser can give one. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const document_ = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = document_.caretPositionFromPoint?.(x, y);
  if (position != null) return { node: position.offsetNode, offset: position.offset };
  const range = document_.caretRangeFromPoint?.(x, y);
  if (range != null) return { node: range.startContainer, offset: range.startOffset };
  return null;
}

/** The class for one run: what the writer marked it, and whether it resolves. */
function classOf(run: SpecRun, known: Set<string> | null): string | undefined {
  const mark =
    run.mark === "code"
      ? "spec-code"
      : run.mark === "strong"
        ? "spec-strong"
        : run.mark === "emphasis"
          ? "spec-em"
          : null;
  if (run.kind !== "symbol") return mark ?? undefined;
  const name = run.text.slice(1);
  const sym = known !== null && !known.has(name) ? "sym sym--unknown" : "sym";
  return mark === null ? sym : `${sym} ${mark}`;
}

function Runs({
  runs,
  known,
  placed,
  from,
}: {
  runs: SpecRun[];
  known: Set<string> | null;
  /** The last change's marks over the section, or null for none. */
  placed: Placed;
  /** Where these runs begin in the section's flat list of runs, which is how the removals are keyed. */
  from: number;
}) {
  // Every run's pieces in reading order, each keeping the run's class, so
  // added pieces from neighbouring runs — a plain word beside an emphasised
  // one, or a piece of code — are gathered into one mark and the highlight
  // runs unbroken across the run boundary.
  const drawn = runs.flatMap((run, index) => {
    const className = classOf(run, known);
    const pieces: RunPiece[] =
      placed === null
        ? [{ kind: "text", text: run.text, at: run.at }]
        : markRun(run, placed.marks.added, placed.removals.get(from + index) ?? []);
    // Positional, as the editor's own runs are: two references to one name
    // are two marks, and the index is what tells them apart.
    return pieces.map((piece, at) => ({ ...piece, className, key: `${index}.${at}` }));
  });
  const text = (piece: (typeof drawn)[number]) => (
    <span key={piece.key} data-at={piece.at} data-run="" className={piece.className}>
      {piece.text}
    </span>
  );
  return (
    <>
      {gatherAdded(drawn).map((stretch) =>
        stretch.added ? (
          <Added key={stretch.pieces[0]!.key}>{stretch.pieces.map(text)}</Added>
        ) : stretch.piece.kind === "removed" ? (
          <Removal key={stretch.piece.key} at={stretch.piece.at} text={stretch.piece.text} />
        ) : (
          text(stretch.piece)
        ),
      )}
    </>
  );
}

/**
 * Words the last change took away, put back where they stood. Not source text,
 * so no `data-run`: a click lands at the offset the words stood at. Whitespace
 * inside is flattened, since a line that went is shown where it stood and not
 * as a line.
 */
function Removal({ at, text }: { at: number; text: string }) {
  return (
    <del data-at={at} className="change change--removed" aria-label="Removed by the last change">
      {text.replace(/\s+/g, " ")}
    </del>
  );
}

function Item({
  item,
  known,
  nodes,
  placed,
  from,
}: {
  item: SpecItem;
  known: Set<string> | null;
  nodes?: Map<string, string[]> | undefined;
  placed: Placed;
  from: number;
}) {
  // Where this requirement's criteria landed, beside the id that cites them.
  // Only once there is a plan: before one, every line would carry the same
  // empty mark, which says nothing about any of them (D-103).
  const landed = item.id === null ? undefined : nodes?.get(item.id);
  return (
    <li className="spec-read-item" data-at={item.at}>
      {item.id !== null ? (
        // The id is what a criterion cites, so it is kept and shown — but as a
        // mark beside the line rather than as four characters of its sentence.
        <span className="spec-req-id">
          {item.id}
          {landed !== undefined && landed.length > 0 && (
            // The node's number alone, against the requirement's own id: the
            // two are read together, and `node_` on every line is a word
            // repeated as often as there are requirements.
            <span className="spec-req-node" title={`Derived to ${landed.join(", ")}`}>
              {landed.map((node) => node.replace(/^node_/, "")).join(", ")}
            </span>
          )}
        </span>
      ) : (
        <span className="spec-bullet" aria-hidden="true">
          &bull;
        </span>
      )}
      <span className="spec-read-text">
        <Runs runs={item.runs} known={known} placed={placed} from={from} />
      </span>
    </li>
  );
}

export function SpecReading({
  value,
  label,
  placeholder,
  known,
  nodes,
  marks = null,
  onOpen,
}: {
  value: string;
  /** What this section is called, so focus lands somewhere named. */
  label: string;
  /** What an empty section offers, which is the only thing there is to click. */
  placeholder: string;
  /** The repository's exported names, or null where there are none to check against. */
  known: Set<string> | null;
  /** Which nodes each requirement landed in, by id, for the Requirements section. */
  nodes?: Map<string, string[]> | undefined;
  /** The last change to this section, placed in `value`, or null where there is none to mark. */
  marks?: TextMarks | null;
  /** Open the editor, with the caret at this offset in the section's text. */
  onOpen: (at: number) => void;
}) {
  const blocks = specBlocks(value);
  // Every run of the section in reading order, so each removal is placed in
  // one run across the whole section rather than once per block; each block
  // is told where its runs begin in that order.
  const flat: SpecRun[] = [];
  const starts: number[][] = blocks.map((block) => {
    if (block.kind === "list")
      return block.items.map((item) => {
        const from = flat.length;
        flat.push(...item.runs);
        return from;
      });
    const from = flat.length;
    flat.push(...block.runs);
    return [from];
  });
  const placed: Placed =
    marks === null || (marks.added.length === 0 && marks.removed.length === 0)
      ? null
      : { marks, removals: placeRemovals(flat, marks.removed) };
  // A section the change emptied has no run to put its removals in: they are
  // shown as a line of their own, since what went is the whole of what there
  // is to say about it.
  const orphaned = flat.length === 0 && marks !== null ? marks.removed : [];
  return (
    <div
      className={cx("spec-read", blocks.length === 0 && "spec-read--empty")}
      tabIndex={0}
      // No role: the text keeps its headings and its list for a reader moving
      // through the page, and Tab goes on into the editor, which is named and
      // is where typing was always going to happen.
      aria-label={label}
      onFocus={() => onOpen(value.length)}
      onMouseDown={(event) => {
        // Before the browser puts the selection anywhere: what is wanted is a
        // caret in the editor at this point, not a selection in a view that is
        // about to be replaced.
        event.preventDefault();
        const point = caretAt(event.clientX, event.clientY);
        const at = point === null ? null : offsetFrom(point.node, point.offset);
        onOpen(at ?? value.length);
      }}
    >
      {blocks.length === 0 ? (
        <>
          <p className="spec-read-placeholder">{placeholder}</p>
          {orphaned.length > 0 && (
            <p className="spec-read-p" data-at={0}>
              {orphaned.map((removal, at) => (
                <Removal key={at} at={0} text={removal.text} />
              ))}
            </p>
          )}
        </>
      ) : (
        blocks.map((block, index) => {
          if (block.kind === "heading") {
            const Tag = (["h4", "h5", "h6"] as const)[block.level - 2] ?? "h6";
            return (
              <Tag key={index} className={`spec-read-h spec-read-h${block.level}`} data-at={block.at}>
                {/* One flex item, because the rule line beside it is another:
                    runs laid out as flex items lose the spaces between them. */}
                <span className="spec-read-h-text">
                  <Runs runs={block.runs} known={known} placed={placed} from={starts[index]![0]!} />
                </span>
              </Tag>
            );
          }
          if (block.kind === "list") {
            return (
              <ul key={index} className="spec-read-list" data-at={block.at}>
                {block.items.map((item, at) => (
                  <Item
                    key={at}
                    item={item}
                    known={known}
                    nodes={nodes}
                    placed={placed}
                    from={starts[index]![at]!}
                  />
                ))}
              </ul>
            );
          }
          return (
            <p key={index} className="spec-read-p" data-at={block.at}>
              <Runs runs={block.runs} known={known} placed={placed} from={starts[index]![0]!} />
            </p>
          );
        })
      )}
    </div>
  );
}
