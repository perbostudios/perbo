import { cx } from "../ui/index.js";
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
 */

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

function Runs({ runs, known }: { runs: SpecRun[]; known: Set<string> | null }) {
  return (
    <>
      {runs.map((run, index) => (
        <span
          // Positional, as the editor's own runs are: two references to one
          // name are two marks, and the index is what tells them apart.
          key={index}
          data-at={run.at}
          data-run=""
          className={classOf(run, known)}
        >
          {run.text}
        </span>
      ))}
    </>
  );
}

function Item({ item, known }: { item: SpecItem; known: Set<string> | null }) {
  return (
    <li className="spec-read-item" data-at={item.at}>
      {item.id !== null ? (
        // The id is what a criterion cites, so it is kept and shown — but as a
        // mark beside the line rather than as four characters of its sentence.
        <span className="spec-req-id">{item.id}</span>
      ) : (
        <span className="spec-bullet" aria-hidden="true">
          &bull;
        </span>
      )}
      <span className="spec-read-text">
        <Runs runs={item.runs} known={known} />
      </span>
    </li>
  );
}

export function SpecReading({
  value,
  label,
  placeholder,
  known,
  onOpen,
}: {
  value: string;
  /** What this section is called, so focus lands somewhere named. */
  label: string;
  /** What an empty section offers, which is the only thing there is to click. */
  placeholder: string;
  /** The repository's exported names, or null where there are none to check against. */
  known: Set<string> | null;
  /** Open the editor, with the caret at this offset in the section's text. */
  onOpen: (at: number) => void;
}) {
  const blocks = specBlocks(value);
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
        <p className="spec-read-placeholder">{placeholder}</p>
      ) : (
        blocks.map((block, index) => {
          if (block.kind === "heading") {
            const Tag = (["h4", "h5", "h6"] as const)[block.level - 2] ?? "h6";
            return (
              <Tag key={index} className={`spec-read-h spec-read-h${block.level}`} data-at={block.at}>
                {/* One flex item, because the rule line beside it is another:
                    runs laid out as flex items lose the spaces between them. */}
                <span className="spec-read-h-text">
                  <Runs runs={block.runs} known={known} />
                </span>
              </Tag>
            );
          }
          if (block.kind === "list") {
            return (
              <ul key={index} className="spec-read-list" data-at={block.at}>
                {block.items.map((item, at) => (
                  <Item key={at} item={item} known={known} />
                ))}
              </ul>
            );
          }
          return (
            <p key={index} className="spec-read-p" data-at={block.at}>
              <Runs runs={block.runs} known={known} />
            </p>
          );
        })
      )}
    </div>
  );
}
