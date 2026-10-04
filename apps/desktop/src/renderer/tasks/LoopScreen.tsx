import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { DECISION_CHOICES, DECISION_WORDS, type DecisionChoice } from "@perbo/contracts/browser";
import { Button, InfoHint, InkIcon, Notice, NumberPop, PageHeader, SectionLabel, cx } from "../ui/index.js";
import { bridge, errorMessage, useAction } from "../workspace/index.js";
import { inTheWay, isRun } from "../../shared/jobs.js";
import { questionsOnRecord } from "../../shared/decisions.js";
import { WaitScreen } from "./wizard.js";
import { useShortcut } from "../shell/shortcuts.js";
import { COMPLETED, displayKey, stageName } from "./ticket-workspace.js";
import { WHEEL_STEPS, wheelFill } from "../../shared/runner-progress.js";
import { loopSteps, loopTally, runEnding, StageLog, taskRecords } from "./task-context.js";
import type { RunEnding, TaskContext } from "./task-context.js";
import { TYPED_TEXT_MAX_CHARS, type DecisionQuestion } from "../../shared/protocol.js";
import { pendingEgressQuestion } from "../../shared/egress-question.js";
import { EgressCard } from "./EgressCard.js";

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
/**
 * The progress bar: its stages (`WHEEL_STEPS`) in equal slices, filled as far
 * as `wheelFill` says for `stage`, the furthest stage the journey reached, and
 * the stage the loop is at, `at`, marked; every other stage below `stage` is
 * ticked. At completed every stage is ticked, the bar is full and nothing is
 * marked. Where the loop waits on the person the marked stage is shown in the
 * decision colour and its label reads "Decision required"; a stopped run's
 * marked stage is shown in the stopped colour (`projectTicket`).
 */
export function LoopStages({
  stage,
  at = stage,
  mark = null,
}: {
  stage: number;
  at?: number;
  mark?: "decision" | "stopped" | null;
}) {
  const current = (number: number): boolean => number === at && stage !== COMPLETED;
  const done = (number: number): boolean => stage === COMPLETED || (number < stage && !current(number));
  return (
    <div className={cx("loop-stages", mark && "loop-stages--" + mark)}>
      <div className="progress-track">
        <span
          style={{
            width: wheelFill(stage) * 100 + "%",
          }}
        />
      </div>
      <div className="stage-labels">
        {WHEEL_STEPS.map((_step, index) => index + 1).map((number) => (
          <span
            key={number}
            className={cx(
              done(number) ? "complete" : current(number) && "current",
              current(number) && mark && "is-" + mark,
            )}
          >
            {done(number) ? <InkIcon name="approve" size={14} /> : <i />}
            {current(number) && mark === "decision" ? "Decision required" : stageName(number)}
          </span>
        ))}
      </div>
    </div>
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
    jobs,
    busy,
    recoverable,
    projection,
  } = taskRecords(context);
  const action = useAction();
  // What ended the last command, where it failed: said once in a card that is
  // confirmed, then kept at the top of the steps in the same words. Not while
  // the records it is read from are still being read after the command ended.
  // A run the person stopped is theirs to know already, so it heads the steps
  // with no card.
  const ending = active || projection.refreshing ? null : runEnding(jobs, latest);
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(() => new Set());
  const acknowledged =
    ending !== null && (ending.byPerson || confirmed.has(ending.job.id) || endingConfirmed(ending.job.id));
  const whyLabel = ending?.title === "The run ended" ? "Why the run ended" : "Why it failed";
  // The questions the record puts to the person: the card asks these, and the
  // projection pauses the loop only where there is one (`ticketRun`).
  const questions: DecisionQuestion[] = questionsOnRecord(detail);
  const observed = projection.observed;
  const paused = projection.paused,
    stage = projection.stage;
  // A run that ended on a verdict for the person is paused for them from the
  // moment it ends, before the records it wrote are read, and a run waiting on
  // the person's answer about a host is paused for them until they give it.
  const waiting = paused || projection.asking;
  // The decision card is up: paused with a question on the record, and no
  // ended card in front of it.
  const answering = paused && questions.length > 0 && !(ending !== null && !acknowledged);
  const page = useRef<HTMLElement>(null);
  const reviewResult = !active &&
    !recoverable &&
    !["executing", "verifying", "provisioning"].includes(ticket.state) && (
      <Button disabled={busy} onClick={() => show("review")}>
        Review the result
      </Button>
    );
  const title = recoverable
    ? "Ready to recover this task"
    : waiting
    ? "Paused for a decision"
    : (observed?.title ??
      (
        {
          provisioning: "Materialising the worktree",
          executing: "Working on the approved outcome",
          verifying: "Running deterministic checks",
          independent_review: "Independent review",
          pr_open: "The review is ready",
          merged: "Merged",
          closed: "Closed without merge",
          failed: "The loop stopped",
          changes_requested: "The run stopped short of the merge",
          cancelled: "The loop was stopped",
        } as Record<string, string>
      )[ticket.state] ??
      "Ready to start the loop");
  // Newest first: what ended the loop, or the step it is on, heads the list.
  const [stageLog] = useState(() => new StageLog());
  const recorded = loopSteps({
    history: ticket.history,
    jobs,
    active,
    attempts: detail.attempts,
    verdicts: detail.verdicts,
    log: stageLog,
    now: new Date().toISOString(),
  });
  const steps = [
    ...(ending !== null && acknowledged
      ? [{ text: ending.sentence, reason: ending.reason, why: whyLabel, at: ending.job.endedAt, state: "ended" as const }]
      : []),
    ...recorded.map((step, index) => ({
      ...step,
      why: "What the runner recorded",
      state: index === 0 && active ? ("current" as const) : ("complete" as const),
    })),
  ];
  const tally = loopTally({ jobs, active, attempts: detail.attempts });
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
  // D-137: the question the run is waiting on, where the
  // projection says it is asking — a run still going, never one being stopped —
  // so the card and Home agree.
  const asking = projection.asking && active !== undefined ? pendingEgressQuestion(active.log) : null;
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
    <section ref={page} className="screen screen--loop" data-screen="s12">
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
                : waiting
                ? "The loop stops here until you answer. Nothing is spending while it waits."
                : !active && ticket.state === "changes_requested"
                ? "The run has ended. Its work and evidence are kept."
                : "The agent owns the approach. You will only be interrupted if it reaches a real choice."}
            </p>
          </div>
        </div>
        <LoopStages stage={stage} at={projection.at} mark={recoverable ? "stopped" : waiting ? "decision" : null} />
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
                <div className={step.state} key={steps.length - index}>
                  {step.state === "complete" ? (
                    <InkIcon name="approve" size={16} />
                  ) : step.state === "ended" ? (
                    <InkIcon name="alert" size={16} />
                  ) : (
                    <span className="step-dot" />
                  )}
                  <span>
                    {step.text}
                    {step.reason !== null && <InfoHint text={step.reason} label={step.why} />}
                  </span>
                  {step.at === null ? (
                    <time />
                  ) : (
                    <time dateTime={step.at} title={new Date(step.at).toLocaleString()}>
                      {new Date(step.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </time>
                  )}
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
              <NumberPop value={tally.commands} />
            </dd>
          </div>
          <div>
            <dt>Spent</dt>
            <dd>
              {/* Tokens always, dollars where a provider gave them (D-104). */}
              <NumberPop value={tally.dollars ?? tally.tokens} />{" "}
              <small>
                {tally.dollars !== null && `${tally.tokens} · `}stops after {detail.effective.stallMinutes} min idle
              </small>
            </dd>
          </div>
          <div>
            <dt>Files touched</dt>
            <dd>
              <NumberPop value={tally.files} />
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
              Back to the stopped loop
            </Button>
          )}
          {!answering && reviewResult}
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
          <Button {...(answering ? {} : { variant: "primary" as const })} onClick={() => show("output")}>
            <InkIcon name="dots" size={15} />
            Watch what the agents are doing
          </Button>
          {/* A pause for the person: the decision is what the page is for, so
              it is the primary, rightmost, with the result beside it, and
              takes them to the card. */}
          {answering && reviewResult}
          {answering && (
            <Button
              variant="primary"
              onClick={() => page.current?.querySelector<HTMLElement>(".decision-overlay .decision-card")?.focus()}
            >
              Answer
            </Button>
          )}
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
        answering && <DecisionOverlay {...context} questions={questions} />
      )}
      {asking !== null && (
        <EgressCard
          repoId={repoId}
          ticketKey={ticket.key}
          question={asking}
          stallMinutes={detail.effective.stallMinutes}
        />
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
/**
 * Every answer together, as the principle the executor is handed: each
 * question's title and the words that answer it (D-065).
 */
function decisionText(
  key: string,
  questions: readonly DecisionQuestion[],
  answers: z.infer<typeof AnswersSchema>,
): string {
  return (
    "For task " +
    key +
    ":\n" +
    questions
      .map((question, index) => index + 1 + ". " + question.title + "\n" + (answers[question.id]?.text ?? ""))
      .join("\n\n")
  );
}
/** Whether a question takes the person's words: a finding the executor is never handed takes only Ship as it is. */
const takesWords = (question: DecisionQuestion): boolean =>
  question.choices.length === 0 || question.choices.includes("approach");
/** The keys that move a pick through a question's answers without making it. */
const ARROW_KEYS: ReadonlySet<string> = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
/** Why an offered answer cannot be picked: the message every answer goes down in has no room left for it. */
export const ANSWER_TOO_LONG =
  "This answer cannot be picked: it is longer than the room your other answers leave in the one message the executor is handed, so shorten one of them or write your own.";
/** What the card says when the Architect's answers could not be had, in one sentence (D-135). */
export const OPTIONS_FAILED = "The Architect’s suggested answers could not be fetched, so write your own below.";
/**
 * The Architect's answers to each question that takes the person's words,
 * asked for once as the card opens and kept for the page's life
 * (D-135). The host keeps them beside the ticket for the
 * review they answer, so reopening the card later spends nothing either.
 */
function useDecisionOptions(repoId: string, key: string, reviewId: string | null, asked: readonly string[]) {
  return useQuery({
    queryKey: ["decisionOptions", repoId, key, reviewId, ...asked],
    queryFn: () => bridge.request({ kind: "decisionOptions", repoId, key, findings: [...asked] }),
    enabled: asked.length > 0,
    networkMode: "always",
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
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
  // Set on the pick of Something else, and read once its box is there: the
  // caret goes into the box the pick opened.
  const wantsCaret = useRef(false);
  // What the last key on an answer was. An arrow key moves the pick through a
  // question's answers, and the browser reports each step as a click on the
  // answer reached: that step moves the pick, and neither takes it back nor
  // moves the caret into the box, or walking the answers would stop in it.
  const keyed = useRef<"arrow" | "space" | null>(null);
  const action = useAction(),
    question = questions[index]!,
    selected = answers[question.id];
  const ownWords = takesWords(question);
  const offers = useDecisionOptions(
    repoId,
    detail.ticket.key,
    taskRecords(context).review?.review_id ?? null,
    questions.filter(takesWords).map((entry) => entry.id),
  );
  // The Architect's recommendation first, as the chat's card puts it, and its
  // own order under that.
  const offered = ownWords
    ? [...(offers.data?.findings.find((finding) => finding.finding_key === question.id)?.options ?? [])].sort(
        (left, right) => Number(right.recommended) - Number(left.recommended),
      )
    : [];
  // Open while there is nothing to pick instead — the answers still coming,
  // or none to be had — and otherwise once Something else is picked.
  const fieldOpen = ownWords && (customSelected || offered.length === 0);
  // The person's words are held where they type them to the room the answer
  // has left: every answer goes down together as one principle, which holds
  // what a typed field holds, so nothing typed is refused when it is sent
  // (D-133). An offered answer longer than that room is
  // not one to pick, for the same reason.
  const room = Math.max(
    0,
    TYPED_TEXT_MAX_CHARS -
      decisionText(detail.ticket.key, questions, {
        ...answers,
        [question.id]: { text: "", custom: true, choice: "approach" },
      }).length,
  );
  const busy = Boolean(inTheWay(workspace.jobs, { repoId, key: detail.ticket.key, kind: "decide" }));
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
  const hasOffered = offered.length > 0;
  useEffect(() => {
    const answer = answers[questionId];
    setCustom(answer?.custom ? answer.text : "");
    setCustomSelected(answer?.custom ?? (!hasOffered && ownWords));
  }, [questionId]);
  // The answers arrived while this question was open and nothing was written
  // yet: the field closes into Something else, and the answers are there to
  // pick. Words already written keep it open.
  useEffect(() => {
    if (hasOffered && !answers[questionId]?.custom) setCustomSelected(false);
  }, [hasOffered]);
  useEffect(() => {
    if (!fieldOpen || !wantsCaret.current) return;
    wantsCaret.current = false;
    own.current?.focus();
  }, [fieldOpen]);
  const choose = (text: string, isCustom: boolean, choice: DecisionChoice = "approach"): void => {
    setAnswers({ ...answers, [question.id]: { text, custom: isCustom, choice } });
    setCustomSelected(isCustom);
    setError(null);
  };
  /** Pick Something else: its box opens, and the caret goes into it unless an arrow key walked there. */
  const pickOwn = (caret: boolean): void => {
    setCustomSelected(true);
    choose(custom, true);
    if (!caret) return;
    // Picking it is the request to type, so the caret goes with it. Done on
    // the pick and not on the state, which also turns true when an earlier
    // answer is restored — focus then would take the page off where it was.
    if (fieldOpen) own.current?.focus();
    else wantsCaret.current = true;
  };
  /** Nothing picked: a pick clicked again is taken back, as the chat's card takes it back. */
  const unpick = (): void => {
    setAnswers(Object.fromEntries(Object.entries(answers).filter(([id]) => id !== question.id)));
    setCustomSelected(false);
  };
  /**
   * One answer's radio, with the chat card's keys: an arrow key moves the pick
   * without opening anything, Space or Enter makes it, and a click on the pick
   * already made takes it back.
   */
  const radio = (checked: boolean, pick: (caret: boolean) => void, disabled = false) => {
    const answer = (): void => {
      const by = keyed.current;
      keyed.current = null;
      if (by === "arrow") {
        if (!checked) pick(false);
      } else if (by === "space" || !checked) pick(true);
      else unpick();
    };
    return (
      <input
        type="radio"
        name="decision-choice"
        checked={checked}
        disabled={disabled}
        onClick={() => {
          if (checked) answer();
        }}
        onChange={answer}
        onKeyDown={(event) => {
          keyed.current = ARROW_KEYS.has(event.key) ? "arrow" : event.key === " " ? "space" : null;
          if (event.key !== "Enter") return;
          event.preventDefault();
          pick(true);
        }}
        onKeyUp={() => {
          if (keyed.current === "arrow") keyed.current = null;
        }}
      />
    );
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
    const text = decisionText(detail.ticket.key, questions, answers);
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
  const shipPicked = !customSelected && selected?.choice === "ship_as_is";
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
                {/* D-065: the executor's own reasons for declining it, whole,
                    as the record holds them: data beside the question, never
                    an instruction. */}
                {question.declined.map((reason, at) => (
                  <div className="decision-declined" key={at}>
                    <SectionLabel>{at === 0 ? "The executor declined it" : "It declined it again"}</SectionLabel>
                    <p>{reason}</p>
                  </div>
                ))}
              </div>
              <div className={cx("decision-choices", "t-input", error && "is-error", shaking && "is-shaking")}>
                {offered.map((option) => {
                  const checked = !customSelected && selected?.choice === "approach" && selected.text === option.text;
                  const tooLong = option.text.length > room;
                  return (
                    <label className={cx("choice", checked && "selected")} key={option.text}>
                      <span className="choice-heading">
                        {/* The Architect's words, picked: the person's answer
                            exactly as if they had typed it. */}
                        {radio(checked, () => choose(option.text, false), tooLong)}
                        <strong>{option.text}</strong>
                        {option.recommended && <span className="choice-recommended">recommended</span>}
                      </span>
                      {tooLong && <p>{ANSWER_TOO_LONG}</p>}
                    </label>
                  );
                })}
                {ownWords && offers.isPending && offers.fetchStatus === "fetching" && (
                  <p className="small muted" role="status">
                    The Architect is suggesting answers. You can write your own meanwhile.
                  </p>
                )}
                {ownWords && offers.isError && (
                  <p className="small muted" role="status">
                    {OPTIONS_FAILED}{" "}
                    <InfoHint text={errorMessage(offers.error)} label="Why they could not be fetched" />
                  </p>
                )}
                {question.choices.includes("ship_as_is") && (
                  <label className={cx("choice", "choice--ship", shipPicked && "selected")}>
                    <span className="choice-heading">
                      {radio(shipPicked, () => choose(DECISION_WORDS.ship_as_is, false, "ship_as_is"))}
                      <strong>Ship as it is</strong>
                    </span>
                    <p>Nothing is changed for this: the change is delivered as the review saw it.</p>
                  </label>
                )}
                {ownWords && (
                  <label className={cx("choice", fieldOpen && "choice--custom", customSelected && "selected")}>
                    <span className="choice-heading">
                      {radio(customSelected, pickOwn)}
                      <strong>
                        {offered.length > 0
                          ? "Something else — tell it what to do"
                          : "Tell it what the product should do"}
                      </strong>
                    </span>
                    {fieldOpen && (
                      <textarea
                        ref={own}
                        aria-label="Your approach"
                        placeholder="Type the approach in a sentence…"
                        maxLength={room}
                        value={custom}
                        onFocus={() => {
                          setCustomSelected(true);
                          choose(custom, true);
                        }}
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
                    )}
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
                      choose(DECISION_WORDS.let_it_decide, false, "let_it_decide");
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
