import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  FactList,
  Field,
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
import { errorMessage, useAction, useOutput } from "../data.js";
import { useShortcut } from "../shell/shortcuts.js";
import { TaskHeader } from "./LoopScreen.js";
import { costLabel, taskRecords } from "./task-context.js";
import type { TaskContext } from "./task-context.js";
import { retainedOutput } from "./retained-output.js";
import { displayKey } from "./ticket-workspace.js";

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
  useShortcut("openPullRequest", ticket.delivery.pull_request_url ? () => show("merge") : null);
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
                review ? `${review.findings.filter((finding) => finding.status === "open").length} unresolved findings` : "review findings unavailable"}
            </p>
          </div>
          <Button
            variant="primary"
            disabled={!ticket.delivery.pull_request_url}
            onClick={() => show("merge")}
          >
            Open pull request
          </Button>
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
                    <th>Evidence</th>
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
                        <td>
                          {coverage?.verification_strength.replaceAll(
                            "_",
                            " ",
                          ) ?? "unavailable"}
                        </td>
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
                return (
                  <details className="review-criterion" key={criterion.id} open>
                    <summary>
                      <InkIcon
                        name={
                          coverage?.verification_strength ===
                          "directly_verified"
                            ? "approve"
                            : "alert"
                        }
                        size={17}
                      />
                      <span className="criterion-number">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="review-criterion-text">
                        {criterion.text}
                      </span>
                      <span className="evidence-strength">
                        {coverage?.verification_strength.replaceAll("_", " ") ??
                          "not reviewed"}
                      </span>
                    </summary>
                    <div className="review-evidence">
                      {coverage?.evidence?.location
                        ? coverage.evidence.location.file +
                          (coverage.evidence.location.line
                            ? ":" + coverage.evidence.location.line
                            : "") +
                          " · "
                        : ""}
                      {coverage?.evidence?.assertion ??
                        coverage?.evidence?.ref ??
                        coverage?.note ??
                        criterion.expected_verification.assertion}
                    </div>
                  </details>
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
      {feedback && (
        <Dialog title="Send a finding back" onClose={() => setFeedback(null)}>
          <p>{selectedFinding?.statement}</p>
          <Field id="feedback-note" label="Your assessment">
            <textarea
              id="feedback-note"
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
    { ticket, jobs, latest } = taskRecords(context);
  const [tab, setTab] = useState("Transcript"),
    [copied, setCopied] = useState(false),
    [follow, setFollow] = useState(true);
  const action = useAction(),
    output = useOutput(repoId, ticket.key, latest?.id);
  const log =
    jobs.at(-1)?.log ??
    "No desktop command output has been recorded for this task.";
  const recorded = retainedOutput(output.data?.transcript);
  const transcript = recorded.entries;
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
              The executor’s recorded messages appear after the attempt is
              sealed. Runner progress is available below while it works.
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
            {output.data?.diff && (
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
          {output.data?.transcript && (
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
      {output.error && (
        <Notice tone="danger">{errorMessage(output.error)}</Notice>
      )}
      {output.data?.notes.map((note) => (
        <Notice key={note}>{note}</Notice>
      ))}
      <PageFooter>
        <Button variant="primary" onClick={() => show("loop")}>
          Back to the loop
        </Button>
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
        <span className="spacer" />
        <button
          className="text-button mono small"
          onClick={() =>
            action.mutate({ kind: "export", repoId, key: ticket.key })
          }
        >
          Export kept evidence
        </button>
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
    } = taskRecords(context);
  const action = useAction(),
    [opened, setOpened] = useState(false);
  const verified =
    review?.coverage.filter(
      (row) =>
        row.status === "met" &&
        row.verification_strength === "directly_verified",
    ).length ?? 0;
  useEffect(() => {
    if (opened && ticket.delivery.state === "merged") show("complete");
  }, [opened, ticket.delivery.state, show]);
  useShortcut(
    "openPullRequest",
    ticket.delivery.pull_request_url
      ? () => {
          void action
            .mutateAsync({ kind: "openPullRequest", repoId, key: ticket.key })
            .then(() => setOpened(true))
            .catch(() => undefined);
        }
      : null,
  );
  return (
    <section className="screen" data-screen="s16">
      <TaskHeader {...context} />
      <div className="merge-body">
        <div className="merge-question">
          <div>
            <h1>Merge?</h1>
            <p className="muted">
              The pull request is open on your branch. perbo will not merge it
              — the thing that wrote this code and the thing that reviewed it
              are the same system, so the last call is yours.
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
              +
              {latest?.changes.reduce(
                (sum, file) => sum + (file.additions ?? 0),
                0,
              ) ?? 0}{" "}
              −
              {latest?.changes.reduce(
                (sum, file) => sum + (file.deletions ?? 0),
                0,
              ) ?? 0}{" "}
              · {latest?.changes.length ?? 0} files
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
        <div className="merge-actions">
          <Button
            variant="primary"
            disabled={!ticket.delivery.pull_request_url}
            onClick={() => {
              void action
                .mutateAsync({
                  kind: "openPullRequest",
                  repoId,
                  key: ticket.key,
                })
                .then(() => setOpened(true))
                .catch(() => undefined);
            }}
          >
            Merge on GitHub
          </Button>
          <Button onClick={() => show("called-off")}>Don’t merge</Button>
          <Button onClick={() => show("review")}>Back to review</Button>
        </div>
        {opened && (
          <div className="scope-message">
            <span className="spacer">
              The pull request is open in your browser. Complete the merge
              there, then refresh its status here.
            </span>
            <Button
              className="small"
              disabled={busy}
              onClick={() =>
                action.mutate({ kind: "sync", repoId, key: ticket.key })
              }
            >
              Refresh merge status
            </Button>
          </div>
        )}
        {action.error && (
          <Notice tone="danger">{errorMessage(action.error)}</Notice>
        )}
      </div>
    </section>
  );
}
export function CompletionScreen(context: TaskContext & { merged: boolean }) {
  const { detail, navigate, merged } = context,
    { repo, ticket } = taskRecords(context),
    [seconds, setSeconds] = useState(3);
  useEffect(() => {
    const timer = setInterval(
      () => setSeconds((value) => Math.max(0, value - 1)),
      1000,
    );
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (seconds === 0) navigate({ page: "home" });
  }, [seconds, navigate]);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
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
        <span className="mono muted small">
          {repo?.name} · {repo?.branch}
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
              ? "The ticket is closed, its observed status is updated, and the whole record — contract, findings and cost — stays with the ticket on Home until you archive it."
              : "Nothing was merged and nothing was thrown away. The pull request stays open on its branch, and the ticket keeps the diff, the review findings and the cost."}
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
            <dd>{merged ? "Home · completed" : "Home · review"}</dd>
          </div>
        </dl>
        <div className="scope-message completion-return">
          <InkIcon name="dots" size={20} />
          <span className="small muted">
            Returning you to the work list
            {merged ? "." : " — the ticket will be waiting where you left it."}
          </span>
          <span className="mono">{seconds}s</span>
        </div>
        <Button onClick={() => navigate({ page: "home" })}>
          <InkIcon name="home" size={18} />
          Go now
        </Button>
      </div>
    </section>
  );
}
