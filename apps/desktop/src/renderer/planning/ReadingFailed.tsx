import { useEffect, useRef } from "react";
import { Button, InfoHint, InkIcon } from "../ui/index.js";
import { firstSentence } from "./InterviewDock.js";

/** What the pop-up over a confirm whose reading did not run says first, before why. */
export const READING_FAILED = "The plan could not be checked against the spec";
/** What it says after why: nothing moved on, and the way to check again. */
export const CONFIRM_TO_CHECK = "Nothing was confirmed. Confirm again to check once more.";
/** What it says after why instead, where the model provider refused the request: no way to check again is offered. */
export const REFUSED_NOT_AGAIN =
  "Nothing was confirmed. The model provider refused the request Perbo sent, so checking again will not help.";

/**
 * The pop-up over a confirm whose reading of the plan against its spec did
 * not run, once the host has tried it until it ran and every try failed
 * (D-138): in the decision card's frame, as the simple
 * task's notice is, in the centre of the pane. It says why in one sentence,
 * with the whole error behind the `i` (D-133), and has
 * one button, which puts it away and leaves the person on the screen they
 * confirmed from, where confirming again reads the plan again. There is no
 * way on without the reading. Where the reading's model provider refused the
 * request (`refused`, from the job the host ran), it does not offer to check
 * again, because the same request is refused the same way.
 */
export function ReadingFailedNotice({
  error,
  refused = false,
  onAcknowledge,
}: {
  error: string;
  refused?: boolean;
  onAcknowledge: () => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    card.current?.focus();
  }, []);
  return (
    <div className="decision-overlay" data-screen="reading-failed">
      <div
        ref={card}
        tabIndex={-1}
        className="decision-card decision-card--ended t-modal is-open"
        role="dialog"
        aria-label="The plan could not be checked"
        aria-modal="false"
      >
        <div className="decision-titlebar">
          <InkIcon name="alert" size={15} />
          <h2>The plan could not be checked</h2>
        </div>
        <div className="decision-body">
          <p className="ended-sentence">
            {`${READING_FAILED}: ${firstSentence(error)}`} <InfoHint text={error} label="The whole error" />
          </p>
          <p>{refused ? REFUSED_NOT_AGAIN : CONFIRM_TO_CHECK}</p>
          <div className="decision-actions">
            <span className="spacer" />
            <Button variant="primary" onClick={onAcknowledge}>
              Got it
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
