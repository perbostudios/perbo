import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { DECISION_CHOICES, DECISION_WORDS, type DecisionChoice } from "@perbo/contracts/browser";
import { Button, InfoHint, InkIcon, Notice, NumberPop, PageHeader, SectionLabel, cx } from "../ui/index.js";
import { bridge, errorMessage, useAction } from "../workspace/index.js";
import { exclusiveJob, isRun } from "../../shared/jobs.js";
import { decisionQuestions, settledFindings } from "../../shared/decisions.js";
import { WaitScreen } from "./wizard.js";
import { useShortcut } from "../shell/shortcuts.js";
import { displayKey, stageName } from "./ticket-workspace.js";
import { costLabel, runEnding, taskRecords } from "./task-context.js";
import type { RunEnding, TaskContext } from "./task-context.js";
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
  // What ended the last command, where it failed: said once in a card that is
  // confirmed, then kept at the top of the steps in the same words. Not while
  // the records it is read from are still being read after the command ended.
  const ending = active || projection.refreshing ? null : runEnding(jobs, latest, ticket.state);
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(() => new Set());
  const acknowledged = ending !== null && (confirmed.has(ending.job.id) || endingConfirmed(ending.job.id));
  const whyLabel = ending?.title === "The run ended" ? "Why the run ended" : "Why it failed";
  const questions: DecisionQuestion[] = decisionQuestions(review, settledFindings(detail));
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
  // Newest first: the step the loop is on, or what ended it, heads the list.
  const steps = [
    ...(ending !== null && acknowledged
      ? [{ text: ending.sentence, reason: ending.reason, time: "", state: "ended" as const }]
      : []),
    ...ticket.history
      .map((entry, index) => ({
        text: entry.note || entry.to.replaceAll("_", " "),
        reason: null,
        time: index === ticket.history.length - 1 && active ? "now" : "",
        state: index === ticket.history.length - 1 && active ? ("current" as const) : ("complete" as const),
      }))
      .reverse(),
  ];
  const commands = latest?.ceilings.find(
    (ceiling) => ceiling.resource === "attempt_commands",
  );
  // A stop lands on the stopped page at once, without waiting for the record
  // the stop leaves: the page holds while the host finishes it. Only the run
  // is what that page is about, so stopping any other command stays here.
  const stop = (): void => {
    if (!active) return;
    action.mutate({ kind: "cancel", jobId: active.id });
    if (isRun(active)) show("stopped");
  };
  // Between pressing Approve and the loop having anything to show.
  //
  // Approving runs a command: the request returns as soon as the job is
  // scheduled, so this page opens while `perbo approve` is still reading the
  // contract and settling its checks. Underneath, it says "Ready to start the
  // loop" over an empty progress bar — which reads as nothing having happened
  // to a person who just pressed the one button that freezes their work.
  const approving =
    active !== undefined && !recoverable && ["plan_review", "ready"].includes(ticket.state);
  useShortcut("output", () => show("output"));
  // The wait offers no stop, so the shortcut offers none either: there is no
  // run yet to call off, and the stopped page is not about a ticket still
  // being approved.
  useShortcut("stop", active && active.state !== "stopping" && !approving ? stop : null);
  if (approving)
    return (
      <WaitScreen
        title="Approving the contract"
        description="Freezing the outcome, the criteria, the scope and the base, and settling the checks that hold the plan to its spec. The loop starts once they pass."
        status={active.label}
      />
    );
  return (
    <section className="screen screen--loop" data-screen="s12">
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
                ? "This desktop session has no running command for the task. The run was stopped, and its work and evidence have been retained."
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
        <div className="loop-steps">
          <div className="column-heading">
            <SectionLabel>Description of steps</SectionLabel>
            <span className="small muted">
              newest first · recorded progress, not steps for you to approve
            </span>
          </div>
          {/* The one part of this page that scrolls: the steps grow for as
              long as the loop runs, and the actions below stay where they are. */}
          <div className="step-history" role="region" aria-label="Description of steps" tabIndex={0}>
            {steps.length ? (
              steps.map((step, index) => (
                <div className={step.state} key={index}>
                  {step.state === "complete" ? (
                    <InkIcon name="approve" size={16} />
                  ) : step.state === "ended" ? (
                    <InkIcon name="alert" size={16} />
                  ) : (
                    <span className="step-dot" />
                  )}
                  <span>
                    {step.text}
                    {step.reason !== null && <InfoHint text={step.reason} label={whyLabel} />}
                  </span>
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
          <span className="small muted">
            Stopping is only possible while the loop is still running.
          </span>
          <span className="spacer" />
          {recoverable && (
            <Button disabled={busy} onClick={() => show("stopped")}>
              See the stopped run
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
          <Button
            onClick={() =>
              action.mutate({ kind: "openWorktree", repoId, key: ticket.key })
            }
          >
            Open worktree
          </Button>
          <Button
            disabled={!active || active.state === "stopping"}
            onClick={stop}
          >
            Stop the loop
          </Button>
          <Button variant="primary" onClick={() => show("output")}>
            <InkIcon name="dots" size={15} />
            Watch what the agents are doing
          </Button>
        </div>
        {action.error && (
          <Notice tone="danger">{errorMessage(action.error)}</Notice>
        )}
      </div>
      {ending !== null && !acknowledged ? (
        <EndedCard
          ending={ending}
          why={whyLabel}
          onConfirm={() => {
            confirmEnding(ending.job.id);
            setConfirmed(new Set([...confirmed, ending.job.id]));
          }}
        />
      ) : (
        paused &&
        questions.length > 0 && <DecisionOverlay {...context} questions={questions} />
      )}
    </section>
  );
}
/**
 * Whether the person confirmed what ended a command, kept per command in this
 * browser: the card is said once, and the steps carry it from then on. Storage
 * that cannot be read or written only means the card is said again.
 */
const endingKey = (jobId: string): string => "perbo:ended:" + jobId;
function endingConfirmed(jobId: string): boolean {
  try {
    return localStorage.getItem(endingKey(jobId)) === "confirmed";
  } catch {
    return false;
  }
}
function confirmEnding(jobId: string): void {
  try {
    localStorage.setItem(endingKey(jobId), "confirmed");
  } catch {
    // Kept for this page only.
  }
}
/** What ended the command, in the decision card's frame, read and confirmed. */
function EndedCard({
  ending: { title, sentence, reason, log },
  why,
  onConfirm,
}: {
  ending: RunEnding;
  /** What the `i` is called. */
  why: string;
  onConfirm: () => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    card.current?.focus();
  }, []);
  return (
    <div className="decision-overlay" data-screen="ended">
      <div
        ref={card}
        tabIndex={-1}
        className="decision-card decision-card--ended t-modal is-open"
        role="dialog"
        aria-label={title}
        aria-modal="false"
      >
        <div className="decision-titlebar">
          <InkIcon name="alert" size={15} />
          <h2>{title}</h2>
        </div>
        <div className="decision-body">
          <p className="ended-sentence">
            {sentence} <InfoHint text={reason} label={why} />
          </p>
          {log !== null && log.trim() !== "" && <pre className="ended-log">{log}</pre>}
          <div className="decision-actions">
            <span className="small muted">
              It stays at the top of the steps. The whole log is under Watch
              what the agents are doing.
            </span>
            <span className="spacer" />
            <Button variant="primary" onClick={onConfirm}>
              Got it
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
const AnswersSchema = z.record(
  z.string(),
  z.object({ text: z.string(), custom: z.boolean(), choice: z.enum(DECISION_CHOICES) }),
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
  const own = useRef<HTMLTextAreaElement>(null);
  const action = useAction(),
    question = questions[index]!,
    selected = answers[question.id];
  // A finding the executor is never handed takes only Ship as it is; a
  // question that takes no choice takes the person's words for a principle.
  const ownWords = question.choices.length === 0 || question.choices.includes("approach");
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
    setCustomSelected(answer?.custom ?? (question.options.length === 0 && ownWords));
  }, [questionId]);
  const choose = (text: string, isCustom: boolean, choice: DecisionChoice = "approach"): void => {
    setAnswers({ ...answers, [question.id]: { text, custom: isCustom, choice } });
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
        decisions: questions
          .filter((question) => question.choices.length > 0)
          .map((question) => ({
            findingKey: question.id,
            choice: answers[question.id]!.choice,
            answer: answers[question.id]!.text.trim(),
          })),
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
                        {question.choices.length > 0 && answers[question.id]?.choice === "ship_as_is"
                          ? "Ship as it is — the change is delivered unchanged for this"
                          : question.choices.length > 0 && answers[question.id]?.choice === "let_it_decide"
                            ? "Let it decide — the executor chooses within the contract"
                            : answers[question.id]?.custom
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
                {ownWords && (
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
                        onChange={() => {
                          setCustomSelected(true);
                          // Picking it is the request to type, so the caret goes
                          // with it. Done on the pick and not on the state, which
                          // also turns true when an earlier answer is restored —
                          // focus then would take the page off where it was.
                          own.current?.focus();
                        }}
                      />
                      <strong>
                        {question.options.length
                          ? "Something else — tell it what to do"
                          : "Tell it what the product should do"}
                      </strong>
                    </span>
                    <textarea
                      ref={own}
                      aria-label="Your approach"
                      placeholder="Type the approach in a sentence…"
                      value={custom}
                      onFocus={() => setCustomSelected(true)}
                      onKeyDown={(event) => {
                        // Enter sends what was typed, as Save and continue does;
                        // Shift+Enter is a new line. Nothing typed, nothing sent.
                        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                        event.preventDefault();
                        if (custom.trim()) advance();
                      }}
                      onChange={(event) => {
                        setCustom(event.target.value);
                        choose(event.target.value, true);
                      }}
                    />
                  </label>
                )}
                {question.choices.includes("ship_as_is") && (
                  <label
                    className={
                      "choice choice--ship" +
                      (!customSelected && selected?.choice === "ship_as_is" ? " selected" : "")
                    }
                  >
                    <span className="choice-heading">
                      <input
                        type="radio"
                        name="decision-choice"
                        checked={!customSelected && selected?.choice === "ship_as_is"}
                        onChange={() => choose(DECISION_WORDS.ship_as_is, false, "ship_as_is")}
                      />
                      <strong>Ship as it is</strong>
                    </span>
                    <p>Nothing is changed for this: the change is delivered as the review saw it.</p>
                  </label>
                )}
              </div>
            </>
          )}
          {error && <Notice tone="danger">{error}</Notice>}
          {action.error && (
            <Notice tone="danger">{errorMessage(action.error)}</Notice>
          )}
          <div className="decision-actions">
            {confirm ? (
              <>
              <span className="spacer" />
              <Button
                variant="primary"
                disabled={busy || pending !== null}
                onClick={submit}
              >
                {pending ? "Recording your decisions…" : "Confirm and resume"}
              </Button>
              </>
            ) : (
              <>
                <span className="small muted">
                  Can always change it before confirmation
                </span>
                <span className="spacer" />
                {ownWords && (
                  <Button
                    onClick={() => {
                      choose(
                        question.options.find((option) => option.recommended)
                          ?.title ?? DECISION_WORDS.let_it_decide,
                        false,
                        "let_it_decide",
                      );
                      if (index + 1 === questions.length) setConfirm(true);
                      else setIndex(index + 1);
                    }}
                  >
                    Let it decide
                  </Button>
                )}
                <Button variant="primary" onClick={advance}>
                  Save and continue
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
