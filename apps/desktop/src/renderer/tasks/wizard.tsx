/** The three-step Create a task wizard: its header, and the screen a step waits on. */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Button,
  InkIcon,
  PageFooter,
  PageHeader,
  ProgressDots,
  ThinkingStatus,
  cx,
} from "../ui/index.js";
export function WizardHeader({
  step,
  children,
}: {
  step: number;
  children?: ReactNode;
}) {
  return (
    <PageHeader
      title="Create a task"
      subtitle={
        <>
          · <span>step {step} of 3</span>
        </>
      }
      wizard
    >
      <ProgressDots step={step} />
      {children}
    </PageHeader>
  );
}
export function WaitScreen({
  step,
  title,
  description,
  status,
  onCancel,
}: {
  step: number;
  title: string;
  description: string;
  status: string;
  onCancel: () => void;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <section
      className="screen wait-screen"
      data-screen={step === 1 ? "s8" : "s10"}
    >
      <WizardHeader step={step} />
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
      <PageFooter>
        <span className="small muted">
          You can leave this page. Your work stays on this machine.
        </span>
        <span className="spacer" />
        <Button onClick={onCancel}>Cancel</Button>
      </PageFooter>
    </section>
  );
}
