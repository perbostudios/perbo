/** The head of a task's own pages, and the screen a task waits on. */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Button,
  InkIcon,
  PageFooter,
  PageHeader,
  ThinkingStatus,
  cx,
} from "../ui/index.js";
/**
 * The head of a task's own pages, which counts no steps: the work is described
 * to the interview, the plan is read on its own pane, and the contract is where
 * approving freezes it — three different places, not three steps of one form,
 * and a number counting to three over any of them says a person is partway
 * through something they are not.
 */
export function WizardHeader({ children }: { children?: ReactNode }) {
  return (
    <PageHeader title="Create a task" wizard>
      {children}
    </PageHeader>
  );
}
export function WaitScreen({
  title,
  description,
  status,
  onCancel,
  bare = false,
}: {
  title: string;
  description: string;
  status: string;
  onCancel?: () => void;
  /**
   * Whether this is a pane working rather than the window.
   *
   * A pane keeps the head of the page it is part of: retitling the window
   * "Create a task" because a pane inside a planning is busy says a person is
   * somewhere they are not. A page that is the whole of what is happening
   * takes the head, because there is nothing else on screen to own it.
   */
  bare?: boolean;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <section className="screen wait-screen" data-screen="s10">
      {!bare && <WizardHeader />}
      <div className="wait-body">
        <InkIcon name="dots" size={52} className="waiting-dots" />
        <div className={cx("t-stagger", shown && "is-shown")}>
          <h1 className="t-stagger-line t-stagger-line--1">{title}</h1>
          <p className="t-stagger-line t-stagger-line--2">{description}</p>
        </div>
        <div className="wait-progress">
          <div className="progress-track indeterminate">
            <span />
          </div>
          <div className="wait-status">
            <ThinkingStatus text={status} />
          </div>
        </div>
      </div>
      {onCancel !== undefined && (
        <PageFooter>
          <span className="small muted">
            You can leave this page. Your work stays on this machine.
          </span>
          <span className="spacer" />
          <Button onClick={onCancel}>Cancel</Button>
        </PageFooter>
      )}
    </section>
  );
}
