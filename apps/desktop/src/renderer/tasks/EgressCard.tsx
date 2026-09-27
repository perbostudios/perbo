import { useEffect, useRef, useState } from "react";
import { Button, InkIcon, Notice, SectionLabel } from "../ui/index.js";
import { bridge, errorMessage } from "../workspace/index.js";
import type { AskedEgress } from "../../shared/egress-question.js";

/**
 * The question a live run is waiting on: whether the executor may reach a
 * host off the repository's allow-list (D-137).
 *
 * In the decision card's frame and under its title, since it is a decision
 * required of the person. It shows the host and the whole command that named
 * it, as the run printed them, and takes one of two answers: Refuse, the
 * default and the highlighted one, focused so Enter takes it, and Allow
 * beside it. The press sends the question's key and the answer and nothing
 * the run printed; the card goes once the run says the question is settled.
 */
export function EgressCard({
  repoId,
  ticketKey,
  question,
  stallMinutes,
}: {
  repoId: string;
  ticketKey: string;
  question: AskedEgress;
  /** How long the run waits before it stops, in the words the loop page already uses. */
  stallMinutes: number;
}) {
  const refuse = useRef<HTMLButtonElement>(null);
  const [sent, setSent] = useState<"allow" | "refuse" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSent(null);
    setError(null);
    refuse.current?.focus();
  }, [question.key]);
  const answer = (allow: boolean): void => {
    setSent(allow ? "allow" : "refuse");
    setError(null);
    void bridge
      .request({ kind: "egressAnswer", repoId, key: ticketKey, question: question.key, allow })
      .catch((failure: unknown) => {
        setSent(null);
        setError(errorMessage(failure));
      });
  };
  return (
    <div className="decision-overlay" data-screen="egress">
      <div
        className="decision-card t-modal is-open"
        role="dialog"
        aria-label="Decisions required"
        aria-modal="false"
      >
        <div className="decision-titlebar">
          <InkIcon name="alert" size={15} />
          <h2>Decisions required</h2>
        </div>
        <div className="decision-body">
          <div className="decision-intro">
            <SectionLabel>Network</SectionLabel>
            <h3 className="decision-question">Allow {question.host}?</h3>
            <p>
              The executor’s command names a host that is not on this repository’s allow-list. The command waits
              until you answer; unanswered for {stallMinutes} minutes, the run stops.
            </p>
          </div>
          <pre className="ended-log" aria-label="The whole command">
            {question.command}
          </pre>
          <p className="small muted">
            Allow lets this command run and adds {question.host} alone to network_allow_list in
            .perbo/config.json. Refuse closes the network for the rest of this run, and {question.host} is not
            asked about again on this ticket.
          </p>
          {error && <Notice tone="danger">{error}</Notice>}
          <div className="decision-actions">
            <span className="small muted">{sent === null ? "The run waits on this." : "Sending your answer…"}</span>
            <span className="spacer" />
            <Button disabled={sent !== null} onClick={() => answer(true)}>
              Allow
            </Button>
            <Button ref={refuse} variant="primary" disabled={sent !== null} onClick={() => answer(false)}>
              Refuse
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
