import type { ReactNode } from "react";
import { cx } from "../ui/index.js";
import { gatherAdded, type CriterionChange, type DiffPiece } from "./change-marks.js";

/**
 * The last change, drawn (D-NEW-the-plan-answers-the-spec-and-says-so): what
 * it added highlighted green, what it took away red and struck through, over
 * the words as they now read. The same two elements wherever a criterion is
 * shown — a node card, the inspector, a row of the Plan pane — so a person
 * reads one thing on every pane, and the spec's reading view draws the same
 * two over its own runs ({@link ./SpecReading.tsx}). Words added together
 * are one {@link Added}, so the highlight runs unbroken across them.
 */

/** A stretch the last change added, as one mark however many pieces it is drawn in. */
export function Added({ children }: { children: ReactNode }) {
  return (
    <mark className="change change--added" aria-label="Added by the last change">
      {children}
    </mark>
  );
}

/** A diff as marked text: kept words plain, added words marked, removed words struck where they stood. */
function Diff({ pieces }: { pieces: readonly DiffPiece[] }) {
  return (
    <>
      {gatherAdded(pieces).map((stretch, index) => {
        const text = stretch.added ? stretch.pieces.map((piece) => piece.text).join("") : stretch.piece.text;
        // Whitespace alone is nothing a reader can see marked: a space that
        // came reads plain, and one that went is not put back.
        const blank = text.trim().length === 0;
        if (!stretch.added && stretch.piece.kind === "removed")
          return blank ? null : (
            <del key={index} className="change change--removed" aria-label="Removed by the last change">
              {text}
            </del>
          );
        return stretch.added && !blank ? <Added key={index}>{text}</Added> : <span key={index}>{text}</span>;
      })}
    </>
  );
}

/**
 * A criterion's words, marked as the last change left them: a rewording is
 * a diff, one the change added is wholly new, and the rest read plain. Marked
 * only while the words shown are the words the change left — a view still
 * drawing the plan as it stood before the change is not marked against it.
 */
export function MarkedCriterion({
  text,
  change,
}: {
  text: string;
  change: CriterionChange | undefined;
}) {
  if (change === undefined || change.kind === "unchanged" || change.text !== text) return <>{text}</>;
  if (change.kind === "added") return <Added>{text}</Added>;
  return <Diff pieces={change.diff} />;
}

/**
 * The criteria the last change took away, struck through where a list of
 * criteria ends: they are no longer in the plan, so they have no row and no
 * id of their own, and the end of the list is where they were last. Keyed
 * by position, which is what a criterion that has gone still has.
 */
export function RemovedCriteria({
  removed,
  className,
}: {
  removed: readonly string[];
  className?: string;
}) {
  return (
    <>
      {removed.map((text, index) => (
        <div
          key={index}
          className={cx("crit-removed", className)}
          aria-label="A criterion removed by the last change"
        >
          <del className="change change--removed">{text}</del>
        </div>
      ))}
    </>
  );
}
