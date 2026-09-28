import { useEffect, useRef, useState } from "react";
import { retainedBranch } from "@perbo/contracts/browser";
import { isLive } from "../../shared/jobs.js";
import { TYPED_TEXT_MAX_CHARS, type Job } from "../../shared/protocol.js";
import {
  Button,
  Checkbox,
  Dialog,
  FactList,
  Field,
  InfoHint,
  InkIcon,
  Notice,
  PageFooter,
  PageHeader,
  SectionLabel,
  Segmented,
  SuccessMark,
  Switch,
  cx,
} from "../ui/index.js";
import type { InkIconName } from "../ui/index.js";
import type { CoverageStatus, VerificationStrength } from "@perbo/contracts";
import { bridge, errorMessage, useAction, useOutputs } from "../workspace/index.js";
import { useShortcut } from "../shell/shortcuts.js";
import { useCreate } from "../shell/create.js";
import { useToast } from "../shell/Toast.js";
import { TaskHeader } from "./LoopScreen.js";
import { cliSentence, costLabel, reviewErrorSentence, taskRecords, watchTranscript } from "./task-context.js";
import type { TaskContext } from "./task-context.js";
import { retainedOutput } from "./retained-output.js";
import { displayKey } from "./ticket-workspace.js";

/**
 * While the browser is open on the pull request, the merge screen asks GitHub
 * for its state this often, this many times, and lands on the merged page as
 * soon as the merge is seen.
 */
export const SYNC_EVERY_MS = 5000;
export const SYNC_POLLS = 36;

/** The lines the latest attempt added and removed, summed over its changed files. */
function diffTotals(latest: ReturnType<typeof taskRecords>["latest"]): { added: number; removed: number } {
  return {
    added: latest?.changes.reduce((sum, file) => sum + (file.additions ?? 0), 0) ?? 0,
    removed: latest?.changes.reduce((sum, file) => sum + (file.deletions ?? 0), 0) ?? 0,
  };
}

/** A criterion card's icon, by the outcome the review recorded for it. */
const OUTCOME_ICON: Record<CoverageStatus, InkIconName> = {
  met: "approve",
  not_met: "reject",
  cannot_determine: "help",
};
/**
 * How a criterion's outcome was established, in the words its badge and the
 * table say and the badge's colour: green where an assertion proves it, amber
 * where it is inferred through a proxy, red where nothing retained
 * establishes it — asserted only, or not reviewed.
 */
const ESTABLISHED: Record<VerificationStrength, { words: string; tone: "green" | "amber" | "red" }> = {
  directly_verified: { words: "directly verified", tone: "green" },
  proxy: { words: "inferred", tone: "amber" },
  asserted_only: { words: "evidence not retained", tone: "red" },
};
function criterionMarks(
  coverage: { status: CoverageStatus; verification_strength: VerificationStrength } | undefined,
): { icon: InkIconName; tone: "green" | "amber" | "red"; established: string } {
  if (!coverage) return { icon: "help", tone: "red", established: "not reviewed" };
  const { words, tone } = ESTABLISHED[coverage.verification_strength];
  return { icon: OUTCOME_ICON[coverage.status], tone, established: words };
}

export function ReviewScreen(context: TaskContext) {
  const { detail, repoId, show, navigate } = context;
  const { ticket, criteria, latest, busy, elapsed, projection } =
    taskRecords(context);
  const [table, setTable] = useState(false),
    [feedback, setFeedback] = useState<string | null>(null),
    [note, setNote] = useState("");
  const action = useAction();
  const { verified, ready, review, closuresVerified, kind, priorReview } = projection.evidence;
  const selectedFinding = review?.findings.find(
    (finding) => finding.key === feedback,
  );
  // The merge screen is always the next one: it merges the pull request, or
  // opens it first where the run retained its branch, or says why neither.
  useShortcut("openPullRequest", () => show("merge"));
  useShortcut("output", () => show("output"));
  return (
    <section className="screen" data-screen="s15">
      <TaskHeader {...context} />
      <div className="review-body">
        <div className="review-summary">
          <InkIcon name={ready ? "approve" : "alert"} size={34} />
          <div>
            <h1>
              {ticket.state === "merged"
                ? "Merged"
                : ready && ticket.delivery.pull_request_url
                  ? "Ready to merge"
                  : "Review the result"}
            </h1>
            <p>
              {kind === "closure" ? closuresVerified ? "Remediation closures verified" : "Remediation closures need attention" :
                verified === null ? "Criterion evidence is not retained" : `${verified} of ${criteria.length} criteria directly verified`} ·{" "}
              {latest?.checks.every((check) => check.status === "passed") &&
              latest.checks.length
                ? "deterministic checks green"
                : "inspect the checks below"}{" "}
              ·{" "}
              {kind === "closure" ? `${projection.evidence.closure?.open_keys.length ?? 0} unresolved closures` :
                // A review that ended on an error says why in one sentence,
                // and the error as the review recorded it sits behind the `i`.
                review?.error ? (
                  <>
                    {reviewErrorSentence(review.error, "review findings unavailable")}{" "}
                    <InfoHint text={review.error.message} label="The review's error" />
                  </>
                ) :
                review ? `${review.findings.filter((finding) => finding.status === "open").length} unresolved findings` : "review findings unavailable"}
            </p>
          </div>
        </div>
        <div className="review-columns">
          <div>
            <SectionLabel>The report</SectionLabel>
            {projection.refreshing && <Notice>Refreshing the recorded outcome. The report below is the last loaded evidence.</Notice>}
            {kind === "closure" && <Notice>Closure verification checks the requested fixes. It does not produce a new independent review of every criterion.</Notice>}
            {priorReview && <details className="evidence-details"><summary>Earlier independent review</summary><pre>{JSON.stringify(priorReview, null, 2)}</pre></details>}
            {table ? (
              <table className="report-table">
                <thead>
                  <tr>
                    <th>Criterion</th>
                    <th>Outcome</th>
                    <th>Established</th>
                  </tr>
                </thead>
                <tbody>
                  {criteria.map((criterion) => {
                    const coverage = review?.coverage.find(
                      (row) => row.criterion_id === criterion.id,
                    );
                    return (
                      <tr key={criterion.id}>
                        <td>{criterion.text}</td>
                        <td>
                          {coverage?.status.replaceAll("_", " ") ??
                            "not reviewed"}
                        </td>
                        <td>{criterionMarks(coverage).established}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              criteria.map((criterion, index) => {
                const coverage = review?.coverage.find(
                  (row) => row.criterion_id === criterion.id,
                );
                const number = String(index + 1).padStart(2, "0");
                const marks = criterionMarks(coverage);
                // The card carries the criterion and its badge; the evidence
                // is behind the `i` beside the criterion.
                const evidence =
                  (coverage?.evidence?.location
                    ? coverage.evidence.location.file +
                      (coverage.evidence.location.line
                        ? ":" + coverage.evidence.location.line
                        : "") +
                      " · "
                    : "") +
                  (coverage?.evidence?.assertion ??
                    coverage?.evidence?.ref ??
                    coverage?.note ??
                    criterion.expected_verification.assertion);
                return (
                  <div className="review-criterion" key={criterion.id}>
                    <span
                      className="review-outcome"
                      role="img"
                      aria-label={
                        coverage?.status.replaceAll("_", " ") ?? "not reviewed"
                      }
                    >
                      <InkIcon name={marks.icon} size={15} />
                    </span>
                    <span className="criterion-number">{number}</span>
                    <span className="review-criterion-text">
                      {criterion.text}
                    </span>
                    <InfoHint
                      text={evidence}
                      label={`The evidence for criterion ${number}`}
                    />
                    <span
                      className={cx(
                        "evidence-strength",
                        `evidence-strength--${marks.tone}`,
                      )}
                    >
                      {marks.established}
                    </span>
                  </div>
                );
              })
            )}
            {review?.findings.map((finding) => (
              <div className="refinement-note" key={finding.key}>
                <InkIcon name="alert" size={15} />
                <div>
                  <strong>
                    {finding.status === "open"
                      ? "Finding to resolve"
                      : "Refinement caught this"}
                  </strong>
                  <p>{finding.statement}</p>
                  <p className="mono small">
                    {finding.file}
                    {finding.line ? ":" + finding.line : ""} · {finding.routing}
                  </p>
                  <button
                    className="text-button small"
                    onClick={() => {
                      setFeedback(finding.key);
                      setNote("");
                    }}
                  >
                    Record feedback
                  </button>
                </div>
              </div>
            ))}
            <button
              className="text-button small"
              onClick={() => setTable(!table)}
            >
              {table ? "Show criterion cards" : "View as a table"}
            </button>
            {latest?.checks.length ? (
              <details className="evidence-details">
                <summary>Deterministic check results</summary>
                {latest.checks.map((check) => (
                  <details key={check.name}>
                    <summary className="changed-file">
                      <span className="spacer">{check.name}</span>
                      <span>{check.status}</span>
                    </summary>
                    <pre>
                      {check.detail ||
                        "This check did not retain additional output."}
                    </pre>
                  </details>
                ))}
              </details>
            ) : null}
            {latest?.verification !== null &&
              latest?.verification !== undefined && (
                <details className="evidence-details">
                  <summary>Remediation closure record</summary>
                  <pre>{JSON.stringify(latest.verification, null, 2)}</pre>
                </details>
              )}
            {detail.verdicts.length > 0 && (
              <details className="evidence-details">
                <summary>Recorded human feedback</summary>
                <pre>{JSON.stringify(detail.verdicts, null, 2)}</pre>
              </details>
            )}
          </div>
          <aside className="review-side">
            <div>
              <SectionLabel>Cost and time</SectionLabel>
              <FactList
                className="run-facts"
                rows={[
                  ["Total spent", costLabel(detail)],
                  ["Time elapsed", elapsed],
                  ["Refinements", Math.max(0, detail.attempts.length - 1)],
                  ["Diff", (latest?.changes.length ?? 0) + " files"],
                ]}
              />
              <p className="small muted" style={{ marginTop: 15 }}>
                {detail.cost.partial
                  ? "Partial pricing · some provider costs are unavailable."
                  : "Recorded by the runner. No estimate replaces missing data."}
              </p>
            </div>
            <div>
              <SectionLabel>Actions</SectionLabel>
              <Button onClick={() => show("output")}>
                View the retained diff
              </Button>
              <Button
                disabled={
                  busy ||
                  !review?.findings.some((finding) => finding.status === "open")
                }
                onClick={() => {
                  const finding = review?.findings.find(
                    (finding) => finding.status === "open",
                  );
                  if (finding) {
                    setFeedback(finding.key);
                    setNote("");
                  }
                }}
              >
                Send a finding back
              </Button>
              <Button onClick={() => show("output")}>Loop history</Button>
              <Button
                disabled={busy || !ticket.delivery.pull_request_url}
                onClick={() =>
                  action.mutate({ kind: "sync", repoId, key: ticket.key })
                }
              >
                Refresh from GitHub
              </Button>
              <Button
                onClick={() =>
                  action.mutate({ kind: "export", repoId, key: ticket.key })
                }
              >
                Export evidence
              </Button>
              {!["merged", "pr_open"].includes(ticket.state) && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    navigate({
                      page: "task",
                      repoId,
                      key: ticket.key,
                      view: "contract",
                    })
                  }
                >
                  Review contract and retry
                </Button>
              )}
            </div>
          </aside>
        </div>
        {action.error && (
          <Notice tone="danger">{errorMessage(action.error)}</Notice>
        )}
      </div>
      {/* The highlighted action at the bottom right. */}
      <PageFooter>
        <span className="spacer" />
        <Button variant="primary" onClick={() => show("merge")}>
          Next
        </Button>
      </PageFooter>
      {feedback && (
        <Dialog title="Send a finding back" onClose={() => setFeedback(null)}>
          <p>{selectedFinding?.statement}</p>
          <Field id="feedback-note" label="Your assessment">
            <textarea
              id="feedback-note"
              maxLength={TYPED_TEXT_MAX_CHARS}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="What should the next attempt address?"
            />
          </Field>
          <p className="small muted">
            Feedback is recorded with the finding. It does not waive the review
            gate. Review the contract before starting another run.
          </p>
          <div className="dialog-actions">
            <Button
              disabled={!note.trim() || busy}
              onClick={() => {
                void action
                  .mutateAsync({
                    kind: "verdict",
                    repoId,
                    key: ticket.key,
                    findingKey: feedback,
                    decision: ["advisory", "remediable"].includes(
                      selectedFinding?.routing ?? "",
                    )
                      ? "accept"
                      : "endorse",
                    note,
                  })
                  .then(() => setFeedback(null))
                  .catch(() => undefined);
              }}
            >
              Record feedback
            </Button>
            <Button
              onClick={() => {
                setFeedback(null);
                navigate({
                  page: "task",
                  repoId,
                  key: ticket.key,
                  view: "contract",
                });
              }}
            >
              Review and retry
            </Button>
          </div>
          {action.error && (
            <Notice tone="danger">{errorMessage(action.error)}</Notice>
          )}
        </Dialog>
      )}
    </section>
  );
}
export function OutputScreen(context: TaskContext) {
  const { detail, repoId, show } = context,
    { ticket, jobs, active, latest, recoverable } = taskRecords(context);
  const [tab, setTab] = useState("Transcript"),
    [copied, setCopied] = useState(false),
    [follow, setFollow] = useState(true);
  const action = useAction();
  // Every attempt of the ticket, in order, over all its runs: the transcript
  // follows the whole loop, not one run.
  const attempts = detail.attempts,
    outputs = useOutputs(
      repoId,
      ticket.key,
      attempts.map((attempt) => attempt.id),
    );
  const log =
    jobs.at(-1)?.log ??
    "No desktop command output has been recorded for this task.";
  // The latest attempt's own read: its terminal, its changes, its records.
  const output = outputs.at(-1);
  const recorded = retainedOutput(output?.data?.transcript);
  // The agents' own words over the whole ticket, the latest at the bottom:
  // the last run's from its log, while it goes and once it has ended, and from
  // the records an attempt whose start the log's tail cut, one whose stretch
  // of the log holds no turn, and every attempt that is not the last run's own.
  const transcript = watchTranscript(
    jobs,
    active,
    attempts.map((attempt, at) => ({ attempt, transcript: outputs[at]?.data?.transcript })),
  );
  const terminal =
    [
      recorded.terminal,
      latest?.checks
        .map((check) => check.detail)
        .filter(Boolean)
        .join("\n\n"),
    ]
      .filter(Boolean)
      .join("\n\n") || log;
  return (
    <section className="screen screen--output" data-screen="s12b">
      <PageHeader
        title={
          <>
            <span className="mono muted">{displayKey(ticket.key)}</span>
            <span className="task-header-title">Agent output</span>
          </>
        }
      >
        <Segmented
          label="Agent output"
          value={tab}
          options={["Transcript", "Terminal", "Changes"].map((label) => ({ value: label, label }))}
          onChange={setTab}
        />
      </PageHeader>
      <div className="output-banner">
        <InkIcon name="dots" size={24} />
        <span className="spacer">
          Recorded output — not the same thing as evidence. The reviewer never
          reads the executor’s narrative, and the merge decision should rest on
          verified criteria.
        </span>
        <span className="follow-toggle">
          follow
          <Switch on={follow} label="Follow the output" onChange={setFollow} />
        </span>
      </div>
      {tab === "Transcript" && (
        <div
          className="transcript"
          ref={(element) => {
            if (element && follow) element.scrollTop = element.scrollHeight;
          }}
        >
          {transcript.map((entry, index) => (
            <div
              className={
                "transcript-entry" +
                (/decision raised|finding/.test(entry.label)
                  ? " transcript-entry--decision"
                  : "")
              }
              key={index}
            >
              <header>
                <strong
                  className={entry.author === "Reviewer" ? "reviewer-name" : ""}
                >
                  {entry.author}
                </strong>
                <span>{entry.label}</span>
              </header>
              <p>{entry.text}</p>
            </div>
          ))}
          {transcript.length === 0 && (
            <p className="muted">
              The executor’s and the reviewer’s own words appear here as they
              say them, the latest at the bottom.
            </p>
          )}
        </div>
      )}
      <div
        className={
          "output-columns" +
          (tab !== "Transcript" ? " output-columns--expanded" : "")
        }
      >
        {tab !== "Changes" && (
          <div className="output-terminal">
            <SectionLabel>
              Terminal · {latest ? "retained output" : "runner progress"}
            </SectionLabel>
            <pre
              className="terminal-output"
              ref={(element) => {
                if (element && follow) element.scrollTop = element.scrollHeight;
              }}
            >
              {terminal}
            </pre>
          </div>
        )}
        {tab !== "Terminal" && (
          <div className="output-changes">
            <div className="row">
              <SectionLabel>Changes · sealed attempt</SectionLabel>
              <span className="spacer" />
              <span className="mono muted small">
                {latest?.changes.length ?? 0} files
              </span>
            </div>
            {latest?.changes.map((file) => (
              <div className="changed-file" key={file.path}>
                <code title={file.path}>{file.path}</code>
                <span className="added">+{file.additions ?? "?"}</span>
                <span className="removed">−{file.deletions ?? "?"}</span>
              </div>
            ))}
            {!latest?.changes.length && (
              <p className="small muted">
                Changed files are available after the runner seals this attempt.
              </p>
            )}
            {output?.data?.diff && (
              <details className="evidence-details" open={tab === "Changes"}>
                <summary>Retained diff · latest attempt</summary>
                <pre>{output.data.diff}</pre>
              </details>
            )}
          </div>
        )}
      </div>
      {tab !== "Transcript" && (
        <div className="output-records">
          {output?.data?.transcript && (
            <details className="evidence-details">
              <summary>Raw provider record · latest attempt</summary>
              <pre>{output.data.transcript}</pre>
            </details>
          )}
          <details className="evidence-details">
            <summary>Attempts and ceilings · {detail.attempts.length}</summary>
            {detail.attempts.map((attempt) => (
              <section className="outlined-card" key={attempt.id}>
                <strong>
                  Run {attempt.run} · round {attempt.round}
                </strong>
                <p>{attempt.termination}</p>
                <FactList
                  rows={attempt.ceilings.map((ceiling) => [
                    ceiling.resource.replaceAll("_", " "),
                    (ceiling.used ?? "unknown") +
                      " / " +
                      (ceiling.ceiling ?? "no ceiling") +
                      (ceiling.hit ? " · reached" : ""),
                  ])}
                />
              </section>
            ))}
          </details>
        </div>
      )}
      {output?.error && (
        <Notice tone="danger">{errorMessage(output.error)}</Notice>
      )}
      {output?.data?.notes.map((note) => (
        <Notice key={note}>{note}</Notice>
      ))}
      {/* The highlighted action at the bottom right. */}
      <PageFooter>
        <button
          className="text-button mono small"
          onClick={() =>
            action.mutate({ kind: "export", repoId, key: ticket.key })
          }
        >
          Export kept evidence
        </button>
        <span className="spacer" />
        <Button
          onClick={() => {
            void navigator.clipboard
              .writeText(
                transcript
                  .map(
                    (entry) =>
                      entry.author + " · " + entry.label + "\n" + entry.text,
                  )
                  .join("\n\n"),
              )
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? "Copied" : "Copy transcript"}
        </Button>
        {/* A stopped ticket's loop is the paused one its stopped page opened. */}
        <Button variant="primary" onClick={() => show("loop")}>
          {recoverable ? "Back to the paused loop" : "Back to the loop"}
        </Button>
      </PageFooter>
      {action.error && (
        <Notice tone="danger">{errorMessage(action.error)}</Notice>
      )}
    </section>
  );
}
export function MergeScreen(context: TaskContext) {
  const { detail, repoId, show } = context,
    {
      ticket,
      contract,
      criteria,
      review,
      latest,
      repo,
      busy,
      elapsed,
      jobs,
    } = taskRecords(context);
  const action = useAction(),
    [opened, setOpened] = useState(false),
    // The checks the page still makes on its own while the browser is open
    // on the pull request.
    [polls, setPolls] = useState(0),
    // Whether the person has come back to the app since it opened there.
    [returned, setReturned] = useState(false),
    [pressed, setPressed] = useState<string | null>(null),
    // The checks of GitHub this press asked for, by job: what the page says of
    // the pull request is read from these alone, never from a check an earlier
    // visit made.
    [checks, setChecks] = useState<readonly string[]>([]);
  const url = ticket.delivery.pull_request_url;
  const merged = ticket.delivery.state === "merged";
  const sync = (): void =>
    void action
      .mutateAsync({ kind: "sync", repoId, key: ticket.key })
      .then((job) => setChecks((ids) => [...ids, (job as Job).id]))
      .catch(() => undefined);
  const open = (): void => {
    setOpened(true);
    setPolls(SYNC_POLLS);
    setChecks([]);
  };
  // No pull request yet: the branch the run retained, which the press
  // publishes first, or why there is none (D-136).
  const retained = url ? null : retainedBranch(ticket);
  const publishing = jobs.filter((job) => job.kind === "publish").at(-1);
  const publishingNow = publishing !== undefined && isLive(publishing);
  const pressedState = publishing?.id === pressed ? publishing.state : null;
  const mergeable = Boolean(url) || (retained?.refusal === null && !busy);
  const merge = () => {
    if (url)
      void action
        .mutateAsync({ kind: "openPullRequest", repoId, key: ticket.key })
        .then(open)
        .catch(() => undefined);
    else
      void action
        .mutateAsync({ kind: "publish", repoId, key: ticket.key })
        .then((job) => setPressed((job as Job).id))
        .catch(() => undefined);
  };
  // The host opens the pull request in the browser once it is published.
  useEffect(() => {
    if (pressedState === "completed") open();
  }, [pressedState]);
  const diff = diffTotals(latest);
  const verified =
    review?.coverage.filter(
      (row) =>
        row.status === "met" &&
        row.verification_strength === "directly_verified",
    ).length ?? 0;
  useEffect(() => {
    if (opened && merged) show("complete");
  }, [opened, merged, show]);
  // Every few seconds while the browser is open on the pull request, a check
  // of GitHub, one at a time, until the merge is seen or the checks run out.
  useEffect(() => {
    if (!opened || merged || busy || polls === 0) return;
    const timer = setTimeout(() => {
      setPolls((left) => left - 1);
      sync();
    }, SYNC_EVERY_MS);
    return () => clearTimeout(timer);
  }, [opened, merged, busy, polls]);
  // Coming back to the app is a check of its own, and what it finds is said.
  useEffect(() => {
    if (!opened || merged) return;
    const back = (): void => {
      setReturned(true);
      if (!busy) sync();
    };
    window.addEventListener("focus", back);
    return () => window.removeEventListener("focus", back);
  }, [opened, merged, busy]);
  const checked = jobs.filter((job) => job.kind === "sync" && checks.includes(job.id)).at(-1);
  const stillOpen = opened && !merged && (returned || polls === 0) && checked?.state === "completed";
  useShortcut("openPullRequest", mergeable ? merge : null);
  return (
    <section className="screen" data-screen="s16">
      <TaskHeader {...context} />
      <div className="merge-body">
        <div className="merge-question">
          <div>
            <h1>{retained?.refusal ? "Nothing to merge" : "Merge?"}</h1>
            <p className="muted">
              {retained?.refusal
                ? `${retained.refusal}.`
                : (url
                    ? "The pull request is open on your branch."
                    : `The run kept ${retained?.branch} on this machine and has not pushed it. ` +
                      "Merge on GitHub pushes it and opens its pull request with the run's review, " +
                      "running and reviewing nothing again, then takes you there.") +
                  " perbo will not merge it — the thing that wrote this code and the thing that " +
                  "reviewed it are the same system, so the last call is yours."}
            </p>
          </div>
          <div className="merge-score">
            <strong>
              {verified} of {criteria.length}
            </strong>
            <small>criteria satisfied</small>
          </div>
        </div>
        <div className="merge-evidence">
          <div className="merge-evidence-header">
            <strong className="mono">
              {repo?.name}#{ticket.delivery.pull_request_number ?? "—"}
            </strong>
            <span className="spacer" />
            <span className="small muted">
              {ticket.delivery.branch ?? "retained branch"} → {repo?.branch}
            </span>
          </div>
          <div className="merge-checks">
            {[
              [
                "Deterministic checks",
                latest?.checks.length &&
                latest.checks.every((check) => check.status === "passed")
                  ? "green"
                  : "inspect results",
              ],
              ["Scope ledger", (latest?.changes.length ?? 0) + " files"],
              ["Independent review", latest?.reviewDecision ?? "not recorded"],
              ["Base commit", contract.base.base_commit.slice(0, 7)],
            ].map(([label, value]) => (
              <div className="merge-check" key={label}>
                <InkIcon
                  name={
                    value === "green" || value === "approve"
                      ? "approve"
                      : "dots"
                  }
                  size={16}
                />
                <span>{label}</span>
                <span className="mono">{value}</span>
              </div>
            ))}
          </div>
          <div className="merge-evidence-footer">
            <span className="mono spacer">
              +{diff.added} −{diff.removed} · {latest?.changes.length ?? 0} files
            </span>
            <span className="mono muted">
              {costLabel(detail)} · {elapsed} ·{" "}
              {Math.max(0, detail.attempts.length - 1)} refinements
            </span>
          </div>
        </div>
        <div className="scope-message">
          <InkIcon name="locked" size={22} />
          <span>
            Merging closes the ticket after Perbo refreshes its status from
            GitHub. The contract, findings and cost stay in the archive.
            Deployment and outcome are opt-in, and not on this screen.
          </span>
        </div>
        {/* The highlighted action at the far right. */}
        <div className="merge-actions">
          <Button onClick={() => show("review")}>Back to review</Button>
          {url && (
            <Button
              disabled={action.isPending}
              onClick={() =>
                void action
                  .mutateAsync({ kind: "callOff", repoId, key: ticket.key })
                  .then(() => show("called-off"))
                  .catch(() => undefined)
              }
            >
              Don’t merge
            </Button>
          )}
          <Button variant="primary" disabled={!mergeable} onClick={merge}>
            Merge on GitHub
          </Button>
        </div>
        {!url && publishingNow && (
          <div className="scope-message" role="status">
            <span className="spacer">
              Pushing {ticket.delivery.branch} and opening its pull request.
            </span>
          </div>
        )}
        {!url && publishing?.state === "failed" && (
          <Notice tone="danger">{cliSentence(publishing.error ?? publishing.log)}</Notice>
        )}
        {opened && !merged && (
          <div className="scope-message" role="status">
            <span className="spacer">
              {stillOpen
                ? "The pull request is still open on GitHub. Merge it there, then refresh its status here."
                : polls > 0
                  ? "The pull request is open in your browser. Merge it there: Perbo checks GitHub every few seconds and moves on as soon as it sees the merge."
                  : "The pull request is open in your browser. Complete the merge there, then refresh its status here."}
            </span>
            <Button className="small" disabled={busy} onClick={sync}>
              Refresh merge status
            </Button>
          </div>
        )}
        {opened && checked?.state === "failed" && (
          <Notice tone="danger">{cliSentence(checked.error ?? checked.log)}</Notice>
        )}
        {action.error && (
          <Notice tone="danger">{errorMessage(action.error)}</Notice>
        )}
      </div>
    </section>
  );
}
/**
 * Where the merge decision lands: merged, or called off with the pull request
 * left open. Leaving the page — Go now, Create another ticket's choice, the
 * timed return, the Home key or the rail — files the ticket in the archive
 * while Archive ticket is checked, as it is to begin with; unchecked, it stays
 * on Home (D-097).
 */
export function CompletionScreen(context: TaskContext & { merged: boolean }) {
  const { detail, navigate, repoId, merged } = context,
    { repo, ticket, latest } = taskRecords(context),
    create = useCreate(),
    toast = useToast(),
    [seconds, setSeconds] = useState(3),
    [archiving, setArchiving] = useState(true),
    // A person deciding on the page — the box, or Create — is not sent away
    // mid-decision: the timed return stops.
    [held, setHeld] = useState(false);
  const filing = useRef(archiving);
  filing.current = archiving;
  useEffect(() => {
    if (held) return;
    const timer = setInterval(
      () => setSeconds((value) => Math.max(0, value - 1)),
      1000,
    );
    return () => clearInterval(timer);
  }, [held]);
  useEffect(() => {
    if (!held && seconds === 0) navigate({ page: "home" });
  }, [seconds, held, navigate]);
  // The page is left when it unmounts, read a beat later so StrictMode's
  // second mount, which cancels it, is not a leave.
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = ticket.key;
  useEffect(() => {
    if (leaving.current !== null) clearTimeout(leaving.current);
    return () => {
      leaving.current = setTimeout(() => {
        if (!filing.current) return;
        void bridge
          .request({ kind: "archive", repoId, keys: [key], archived: true })
          .then(() => toast(`${displayKey(key)} filed in the archive`))
          .catch((error: unknown) => toast(errorMessage(error)));
      }, 0);
    };
  }, [repoId, key, toast]);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const diff = diffTotals(latest);
  return (
    <section className="screen" data-screen={merged ? "s17" : "s18"}>
      <PageHeader
        title={
          <>
            <span className="mono muted">{displayKey(ticket.key)}</span>
            <span className="task-header-title">
              {merged ? "Merged" : "Not merged"}
            </span>
          </>
        }
      >
        <span className="mono small completion-repo">
          {repo?.name} <span className="added">+{diff.added}</span>{" "}
          <span className="removed">−{diff.removed}</span>
        </span>
      </PageHeader>
      <div className="completion-body">
        <SuccessMark name={merged ? "approve" : "reject"} size={62} />
        <div className={cx("completion-message", "t-stagger", shown && "is-shown")}>
          <h1 className="t-stagger-line t-stagger-line--1">
            {merged
              ? repo?.name +
                "#" +
                ticket.delivery.pull_request_number +
                " is merged"
              : "The merge is called off"}
          </h1>
          <p className="t-stagger-line t-stagger-line--2">
            {merged
              ? archiving
                ? "The ticket is closed, its observed status is updated, and the whole record — contract, findings and cost — is filed in the archive as you leave."
                : "The ticket is closed, its observed status is updated, and the whole record — contract, findings and cost — stays with the ticket on Home until you archive it."
              : archiving
                ? "Nothing was merged and nothing was thrown away. The pull request stays open on its branch, and the ticket is filed in the archive as you leave, with the diff, the review findings and the cost."
                : "Nothing was merged and nothing was thrown away. The pull request stays open on its branch, and the ticket stays on Home with the diff, the review findings and the cost."}
          </p>
        </div>
        <dl className="completion-facts">
          <div>
            <dt>{merged ? "Merged as" : "Left open as"}</dt>
            <dd>
              {repo?.name}#{ticket.delivery.pull_request_number}
            </dd>
          </div>
          <div>
            <dt>Total cost</dt>
            <dd>{costLabel(detail)}</dd>
          </div>
          <div>
            <dt>Filed in</dt>
            <dd>{archiving ? "Archive" : "Home"}</dd>
          </div>
        </dl>
        <div className="scope-message completion-return">
          <InkIcon name="dots" size={20} />
          <span className="small muted">
            {held ? "Staying here until you go." : "Returning you to the work list."}
          </span>
          {!held && <span className="mono">{seconds}s</span>}
        </div>
        <Checkbox
          checked={archiving}
          onChange={(checked) => {
            setHeld(true);
            setArchiving(checked);
          }}
        >
          Archive ticket
        </Checkbox>
        <div className="completion-actions">
          <Button onClick={() => navigate({ page: "home" })}>
            <InkIcon name="home" size={18} />
            Go now
          </Button>
          <Button
            onClick={() => {
              setHeld(true);
              create.open();
            }}
          >
            Create another ticket
          </Button>
        </div>
      </div>
    </section>
  );
}
