import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button, InkIcon, Notice, NumberPop, PageHeader, SectionLabel, cx } from "../ui/index.js";
import { bridge, errorMessage, useAction } from "../workspace/index.js";
import { exclusiveJob } from "../../shared/jobs.js";
import { decisionQuestions } from "../../shared/decisions.js";
import { useShortcut } from "../shell/shortcuts.js";
import { displayKey, stageName } from "./ticket-workspace.js";
import { costLabel, taskRecords } from "./task-context.js";
import type { TaskContext } from "./task-context.js";
import type { DecisionQuestion } from "../../shared/protocol.js";

export function TaskHeader(context: TaskContext) {
  const { ticket, title, repo } = taskRecords(context);
  return (
    <PageHeader
      title={
        <>
          <span className="mono muted">{displayKey(ticket.key)}</span>
          <span className="task-header-title" title={title}>
            {title}
          </span>
        </>
      }
    >
      <span className="repo-tag">
        {repo?.name} · {repo?.branch}
      </span>
    </PageHeader>
  );
}
export function LoopScreen(context: TaskContext & { decisions?: boolean }) {
  const { detail, repoId, show } = context;
  const {
    ticket,
    contract,
    criteria,
    active,
    latest,
    review,
    jobs,
    busy,
    recoverable,
    projection,
  } = taskRecords(context);
  const action = useAction();
  const questions: DecisionQuestion[] = decisionQuestions(review);
  const observed = projection.observed;
  const paused = ticket.state === "changes_requested" && !active && questions.length > 0,
    stage = paused
      ? 4
      : projection.stage;
  const title = recoverable
    ? "Ready to recover this task"
    : paused
    ? "Paused for a decision"
    : (observed?.title ??
      (
        {
          provisioning: "Materialising the worktree",
          executing: "Working on the approved outcome",
          verifying: "Running deterministic checks",
          independent_review: "Independent review",
          pr_open: "The review is ready",
          failed: "The loop stopped",
          changes_requested: "Refinement needs attention",
          cancelled: "The loop was stopped",
        } as Record<string, string>
      )[ticket.state] ??
      "Ready to start the loop");
  const steps = ticket.history.map((entry, index) => ({
    text: entry.note || entry.to.replaceAll("_", " "),
    time: index === ticket.history.length - 1 && active ? "now" : "",
    state:
      index === ticket.history.length - 1 && active
        ? ("current" as const)
        : ("complete" as const),
  }));
  const commands = latest?.ceilings.find(
    (ceiling) => ceiling.resource === "attempt_commands",
  );
  useShortcut("output", () => show("output"));
  useShortcut("stop", active && active.state !== "stopping" ? () => action.mutate({ kind: "cancel", jobId: active.id }) : null);
  return (
    <section className="screen" data-screen="s12">
      <TaskHeader {...context} />
      <div className="loop-body">
        <div className="loop-heading">
          <InkIcon name={paused ? "dots" : "dots"} size={32} />
          <div>
            <h1>
              {active ? (
                <span className="t-shimmer" data-text={title}>
                  {title}
                </span>
              ) : (
                title
              )}
            </h1>
            <p>
              {recoverable
                ? "This desktop session has no running command for the task. Review the contract and retained changes before starting another attempt."
                : paused
                ? "The loop stops here until you answer. Nothing is spending while it waits."
                : "The agent owns the approach. You will only be interrupted if it reaches a real choice."}
            </p>
          </div>
        </div>
        <div className="loop-stages">
          <div className="progress-track">
            <span
              style={{
                width: ((stage - 1) / 6) * 100 + "%",
              }}
            />
          </div>
          <div className="stage-labels">
            {[1, 2, 3, 4, 5, 6].map((number) => (
              <span
                key={number}
                className={
                  number === stage
                    ? "current"
                    : number < stage
                      ? "complete"
                      : ""
                }
              >
                {number < stage ? <InkIcon name="approve" size={14} /> : <i />}
                {stageName(number)}
              </span>
            ))}
          </div>
        </div>
        <div>
          <SectionLabel>Task description</SectionLabel>
          <div className="loop-description">
            {contract.outcome}{" "}
            <span className="muted">
              {criteria.length} criteria, {contract.scope.paths_allowed.length}{" "}
              paths in scope, base pinned at{" "}
              {contract.base.base_commit.slice(0, 7)}.
            </span>
          </div>
        </div>
        <div>
          <div className="column-heading">
            <SectionLabel>Description of steps</SectionLabel>
            <span className="small muted">
              newest last · recorded progress, not steps for you to approve
            </span>
          </div>
          <div className="step-history">
            {steps.length ? (
              steps.map((step, index) => (
                <div className={step.state} key={index}>
                  {step.state === "complete" ? (
                    <InkIcon name="approve" size={16} />
                  ) : (
                    <span className="step-dot" />
                  )}
                  <span>{step.text}</span>
                  <time>{step.time}</time>
                </div>
              ))
            ) : (
              <div>
                <InkIcon name="dots" size={16} />
                <span>
                  {active
                    ? "Waiting for the CLI’s first progress event…"
                    : "No execution steps have been recorded yet."}
                </span>
                <time />
              </div>
            )}
          </div>
        </div>
        <dl className="metric-strip">
          <div>
            <dt>Commands</dt>
            <dd>
              {/* No denominator: nothing bounds a run by commands (D-096). */}
              <NumberPop value={commands?.used ?? "—"} />
            </dd>
          </div>
          <div>
            <dt>Spent</dt>
            <dd>
              <NumberPop value={active ? "Pending" : costLabel(detail)} />{" "}
              <small>stops after {detail.effective.stallMinutes} min idle</small>
            </dd>
          </div>
          <div>
            <dt>Files touched</dt>
            <dd>
              <NumberPop value={latest?.changes.length ?? "—"} />
            </dd>
          </div>
          <div>
            <dt>Est. time remaining</dt>
            <dd>
              <small>Not estimated</small>
            </dd>
          </div>
          <div>
            <dt>Tickets awaiting action</dt>
            <dd>
              {
                context.workspace.tasks.filter((row) =>
                  ["pr_open", "changes_requested"].includes(row.ticket.state),
                ).length
              }
            </dd>
          </div>
        </dl>
        <div className="loop-actions">
          <Button
            onClick={() =>
              action.mutate({ kind: "openWorktree", repoId, key: ticket.key })
            }
          >
            Open worktree
          </Button>
          <Button
            disabled={!active || active.state === "stopping"}
            onClick={() => {
              if (active) action.mutate({ kind: "cancel", jobId: active.id });
            }}
          >
            Stop the loop
          </Button>
          <Button variant="primary" onClick={() => show("output")}>
            <InkIcon name="dots" size={15} />
            Watch what the agents are doing
          </Button>
          <span className="spacer" />
          {recoverable && (
            <Button disabled={busy} onClick={() => show("contract")}>
              Review and recover
            </Button>
          )}
          {!active &&
            !recoverable &&
            !questions.length &&
            !["executing", "verifying", "provisioning"].includes(
              ticket.state,
            ) && (
              <Button disabled={busy} onClick={() => show("review")}>
                Review the result
              </Button>
            )}
          <span className="small muted">
            Stopping is only possible while the loop is still running.
          </span>
        </div>
        {jobs.at(-1)?.error && (
          <Notice tone="danger">{jobs.at(-1)?.error}</Notice>
        )}
        {action.error && (
          <Notice tone="danger">{errorMessage(action.error)}</Notice>
        )}
      </div>
      {paused && questions.length > 0 && (
        <DecisionOverlay {...context} questions={questions} />
      )}
    </section>
  );
}
const AnswersSchema = z.record(
  z.string(),
  z.object({ text: z.string(), custom: z.boolean() }),
);
function DecisionOverlay(
  context: TaskContext & { questions: DecisionQuestion[] },
) {
  const { questions, detail, repoId, show, navigate, workspace } = context;
  const storageKey = "perbo:decisions:" + repoId + ":" + detail.ticket.key;
  const [answers, setAnswers] = useState<z.infer<typeof AnswersSchema>>(() => {
    try {
      const parsed = AnswersSchema.safeParse(
        JSON.parse(sessionStorage.getItem(storageKey) ?? "{}"),
      );
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  });
  const [index, setIndex] = useState(0),
    [confirm, setConfirm] = useState(false),
    [custom, setCustom] = useState(""),
    [customSelected, setCustomSelected] = useState(false),
    [error, setError] = useState<string | null>(null),
    [pending, setPending] = useState<string | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const action = useAction(),
    question = questions[index]!,
    selected = answers[question.id];
  const busy = Boolean(exclusiveJob(workspace.jobs));
  useEffect(() => {
    sessionStorage.setItem(storageKey, JSON.stringify(answers));
  }, [answers, storageKey]);
  useEffect(() => {
    card.current?.focus();
  }, []);
  const [shaking, setShaking] = useState(false);
  useEffect(() => {
    if (!error) return;
    setShaking(false);
    const frame = requestAnimationFrame(() => setShaking(true));
    const timer = setTimeout(() => setShaking(false), 320);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [error]);
  const questionId = question.id;
  useEffect(() => {
    const answer = answers[questionId];
    setCustom(answer?.custom ? answer.text : "");
    setCustomSelected(answer?.custom ?? question.options.length === 0);
  }, [questionId]);
  const choose = (text: string, isCustom: boolean): void => {
    setAnswers({ ...answers, [question.id]: { text, custom: isCustom } });
    setCustomSelected(isCustom);
    setError(null);
  };
  const advance = (): void => {
    if (customSelected) {
      if (!custom.trim()) {
        setError("Write your approach before continuing.");
        return;
      }
      choose(custom.trim(), true);
    } else if (!selected?.text.trim()) {
      setError("Choose an approach before continuing.");
      return;
    }
    if (index + 1 === questions.length) setConfirm(true);
    else setIndex(index + 1);
  };
  const submit = (): void => {
    if (questions.some((question) => !answers[question.id]?.text.trim())) {
      setError("Answer every question before confirming.");
      return;
    }
    const text =
      "For task " +
      detail.ticket.key +
      ":\n" +
      questions
        .map(
          (question, index) =>
            index +
            1 +
            ". " +
            question.title +
            "\n" +
            answers[question.id]!.text,
        )
        .join("\n\n");
    void bridge
      .request({
        kind: "decide",
        repoId,
        key: detail.ticket.key,
        answer: text,
        digest: detail.digest,
      })
      .then((job) => {
        setPending(job.id);
        show("loop");
      })
      .catch((error) => setError(errorMessage(error)));
  };
  useShortcut("decisionNext", confirm ? submit : advance);
  useShortcut("decisionBack", confirm ? () => setConfirm(false) : index > 0 ? () => setIndex(index - 1) : null);
  useShortcut("decisionSend", () => {
    if (questions.every((entry) => answers[entry.id]?.text.trim())) submit();
    else advance();
  });
  return (
    <div className="decision-overlay" data-screen={confirm ? "s14" : "s13"}>
      <div
        ref={card}
        tabIndex={-1}
        className={cx("decision-card", "t-modal", "is-open", confirm && "decision-card--confirm")}
        role="dialog"
        aria-label={confirm ? "Confirm your decisions" : "Decisions required"}
        aria-modal="false"
        onKeyDown={(event) => {
          if (event.key === "Escape") navigate({ page: "home" });
        }}
      >
        <div className="decision-titlebar">
          {!confirm && <InkIcon name="alert" size={15} />}
          <h2>{confirm ? "Confirm your decisions" : "Decisions required"}</h2>
          <span className="mono muted">
            {confirm
              ? questions.length + " answered"
              : index + 1 + " of " + questions.length}
          </span>
        </div>
        <div className="decision-body">
          {confirm ? (
            <>
              <p>
                These go to the executor as one message and become part of the
                ticket record. Change any of them now — after this they are
                history, not settings.
              </p>
              <div className="decision-confirmations">
                {questions.map((question, position) => (
                  <div
                    className={
                      "decision-confirm" +
                      (answers[question.id]?.custom
                        ? " decision-confirm--custom"
                        : "")
                    }
                    key={question.id}
                  >
                    <span className="mono muted">{position + 1}.</span>
                    <div>
                      <p className="confirmation-question">{question.title}</p>
                      <strong>
                        {answers[question.id]?.custom
                          ? "Your answer — “" + answers[question.id]?.text + "”"
                          : answers[question.id]?.text}
                      </strong>
                      {answers[question.id]?.custom && (
                        <p className="confirmation-authorship">
                          written by you, not offered
                        </p>
                      )}
                    </div>
                    <button
                      className="text-button"
                      title="Reopen this decision"
                      onClick={() => {
                        setIndex(position);
                        setConfirm(false);
                      }}
                    >
                      <InkIcon name="locked" size={17} />
                      edit
                    </button>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="decision-intro">
                <SectionLabel>Decision {index + 1}</SectionLabel>
                <h3 className="decision-question">{question.title}</h3>
                <p>{question.context}</p>
              </div>
              <div className={cx("decision-choices", "t-input", error && "is-error", shaking && "is-shaking")}>
                {question.options.map((option, position) => (
                  <label
                    className={
                      "choice" +
                      (!customSelected && selected?.text === option.title
                        ? " selected"
                        : "")
                    }
                    key={option.title}
                  >
                    <span className="choice-heading">
                      <input
                        type="radio"
                        name="decision-choice"
                        checked={
                          !customSelected && selected?.text === option.title
                        }
                        onChange={() => choose(option.title, false)}
                      />
                      <span className="choice-number">
                        Choice {position + 1}
                      </span>
                      <strong>{option.title}</strong>
                      {option.recommended && (
                        <span className="choice-recommended">recommended</span>
                      )}
                    </span>
                    <p>{option.detail}</p>
                    {option.metadata && (
                      <span className="choice-metadata">
                        {option.metadata.map((item) => (
                          <span key={item}>{item}</span>
                        ))}
                      </span>
                    )}
                  </label>
                ))}
                <label
                  className={
                    "choice choice--custom" +
                    (customSelected ? " selected" : "")
                  }
                >
                  <span className="choice-heading">
                    <input
                      type="radio"
                      name="decision-choice"
                      checked={customSelected}
                      onChange={() => setCustomSelected(true)}
                    />
                    <strong>
                      {question.options.length
                        ? "Something else — tell it what to do"
                        : "Tell it what the product should do"}
                    </strong>
                  </span>
                  <textarea
                    aria-label="Your approach"
                    placeholder="Type the approach in a sentence…"
                    value={custom}
                    onFocus={() => setCustomSelected(true)}
                    onChange={(event) => {
                      setCustom(event.target.value);
                      choose(event.target.value, true);
                    }}
                  />
                </label>
              </div>
            </>
          )}
          {error && <Notice tone="danger">{error}</Notice>}
          {action.error && (
            <Notice tone="danger">{errorMessage(action.error)}</Notice>
          )}
          <div className="decision-actions">
            {confirm ? (
              <Button
                variant="primary"
                disabled={busy || pending !== null}
                onClick={submit}
              >
                {pending ? "Recording your decisions…" : "Confirm and resume"}
              </Button>
            ) : (
              <>
                <Button variant="primary" onClick={advance}>
                  Save and continue
                </Button>
                <Button
                  onClick={() => {
                    choose(
                      question.options.find((option) => option.recommended)
                        ?.title ??
                        "Choose an approach within the approved contract and scope; keep the choice in the task record.",
                      false,
                    );
                    if (index + 1 === questions.length) setConfirm(true);
                    else setIndex(index + 1);
                  }}
                >
                  Let it decide
                </Button>
                <span className="spacer" />
                <span className="small muted">
                  Can always change it before confirmation
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
