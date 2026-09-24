import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Notice } from "../ui/index.js";
import {
  DriftVerdictSchema,
  type DriftFinding,
  type DriftVerdict,
} from "@perbo/planning/browser";
import { bridge, errorMessage } from "../workspace/index.js";
import { isLive, newestReading } from "../../shared/jobs.js";
import { REREAD_COULD_NOT_START } from "../../shared/contract-editing.js";
import { WaitScreen } from "../tasks/wizard.js";
import { planPaneFor } from "./panes.js";
import { owedReading } from "./owed-reading.js";
import { QuestionCard, problemHead } from "./InterviewDock.js";
import type { InterviewEntry, Job } from "../../shared/protocol.js";
import type { PageProps } from "../shell/route.js";
import type { useContractEditing } from "../contract-editor.js";

type Editor = ReturnType<typeof useContractEditing>;

/** What tells one problem's card from the next: the record's count and the problem's own words. */
const problemKey = (open: readonly DriftFinding[]): string =>
  open.length === 0 ? "" : `${open.length}:${open[0]!.heading}:${open[0]!.difference}`;

/**
 * The Problems pane, between the plan and the contract
 * (D-128): a model reads the spec
 * against the plan and says where the two no longer promise the same thing,
 * and each place is a problem put to the person here, one at a time.
 *
 * Every way from the plan to the contract passes through here, and the pane
 * gets out of the way where there is nothing to say: a plan that agrees with
 * its spec — problems resolved elsewhere included — or a reading the person
 * has already gone on past, lands on the contract without a card. The verdict
 * is the CLI's, kept beside the ticket and keyed by the spec and the plan's
 * promise texts, so the model runs only where one of them moved since the
 * last reading — a hand edit of a criterion, or of the spec — and never for
 * an arrangement edit. The pane asks for that reading on every arrival,
 * whatever the record says, since a hand edit after a resolved round is
 * exactly what a record cannot know about; a reading that costs nothing is
 * the usual answer.
 *
 * What the pane shows is the session's own record of the problems, which the
 * host writes as a reading lands: the first still open, as a card of the
 * interview's own shape, whose last pick, or Enter in its own-words box,
 * posts the answer as a turn. The host reads the plan again once the
 * interview has finished the turn, and the next problem appears when that
 * reading records it; until then the pane says which of the two is happening.
 * The chat is not beside this pane — the card is the whole of what there is
 * to say — and the same problem is a card in the chat on every other pane,
 * answered there the same way. A question the interview asks of its own while
 * applying an answer is a card here too, for the same reason.
 *
 * **It is never a gate.** "Go on to the contract anyway" is there on every
 * problem, waiting or not, and records that the person went on; "Back to the
 * plan" is on every state. Nothing here becomes an edit, a path or an
 * argument: what a card sends is a string the person chose or typed
 * (ADR-0023 §4).
 */
export function DriftPane({ workspace, navigate, editor }: PageProps & { editor: Editor }) {
  const session = editor.session;
  const id = session?.id ?? null;
  const key = session?.key ?? null;
  const repoId = editor.repoId;
  const drift = session?.drift ?? null;
  const conversation = session?.conversation ?? [];
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The reading this pane asked for: from the request until the workspace's
  // own job list holds it, which is a round trip later, the pane would
  // otherwise read as having nothing to wait on, and show the record for a
  // frame before the wait that precedes it.
  const [checking, setChecking] = useState(false);
  const [askedFor, setAskedFor] = useState<Job | null>(null);
  // The answer this pane sent and is waiting on: which problem it answered
  // and where the conversation stood, so that the turn after that point, the
  // record moving on from that problem or putting it again, and a note saying
  // the plan could not be read again are read as this answer's.
  const [sent, setSent] = useState<{ problem: string; after: number } | null>(null);
  const asked = useRef<string | null>(null);
  const check = useCallback(async (): Promise<void> => {
    if (id === null) return;
    setFailure(null);
    setChecking(true);
    try {
      setAskedFor(await bridge.request({ kind: "driftCheck", id }));
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setChecking(false);
    }
  }, [id]);
  // A planning with no spec has nothing to read the plan against — a ticket
  // the CLI admitted, or one opened from the board — and goes on to the
  // contract without asking: the host would refuse, and a refusal is not a
  // page to stand on the way there. Two facts say so, and either is enough:
  // the session has no spec, or the ticket was not drafted from one. The
  // second is the CLI's own refusal, and it holds where a spec was written
  // beside a plan that was admitted from a draft — the session then has a
  // slug the ticket does not, and `perbo drift` has nothing to read.
  const ticket = workspace.tasks.find(
    (row) => row.repoId === repoId && row.ticket.key === key,
  )?.ticket;
  const specless =
    session != null &&
    (session.specSlug === null || (ticket !== undefined && ticket.admission.spec === null));
  const newest =
    key === null
      ? null
      : newestReading(
          askedFor === null || workspace.jobs.some((entry) => entry.id === askedFor.id)
            ? workspace.jobs
            : [...workspace.jobs, askedFor],
          repoId,
          key,
        );
  // Whether a reading is under way for this planning, whoever asked for it —
  // counting the one about to be asked for on arrival, so the record is not
  // shown for a frame before the wait that precedes it.
  const reading = asked.current !== id || checking || (newest !== null && isLive(newest));
  // On arrival, once, whatever the record says: a reading already under way
  // for this planning is adopted rather than doubled — the model would be
  // asked the same question twice, and the second answer would land on top
  // of the first — and otherwise one is asked for. The host records what it
  // finds, and a record is what this pane shows.
  useEffect(() => {
    if (id === null || key === null || asked.current === id) return;
    asked.current = id;
    if (specless) {
      navigate({ page: "task", repoId, key, view: "contract" });
      return;
    }
    if (newest !== null && isLive(newest)) return;
    void check();
  }, [id, key, repoId, specless, newest, navigate, check]);

  // What the reading said, once it has landed and parses as a verdict. Read
  // off the job the workspace holds rather than trusted as typed: it crossed
  // a process boundary, and a page moved by a shape that is not a verdict
  // would be moved by nothing.
  const landed = newest !== null && !isLive(newest) ? newest : null;
  const verdict: DriftVerdict | null = useMemo(() => {
    if (landed === null || landed.state !== "completed") return null;
    const parsed = DriftVerdictSchema.safeParse(landed.result);
    return parsed.success ? parsed.data : null;
  }, [landed]);
  const jobError =
    landed === null
      ? null
      : landed.state === "completed"
        ? verdict === null
          ? "The reading came back in a shape this page does not understand."
          : null
        : (landed.error ?? "The reading did not finish.");

  const approved = ticket !== undefined && ticket.approved_at !== null;
  const thinking = (workspace.working ?? []).includes(id ?? "");
  // Nothing to say: straight on to the contract, which is where the person
  // was going. Both a plan that agrees with its spec and problems they have
  // already gone past at this state. On arrival that holds whatever the
  // session records, since problems resolved on another pane — answered in
  // the chat beside the Graph — are nothing to stop for on the way, unless a
  // question stands or a turn is in flight, either of which the way on waits
  // for. After arrival, only while the session records no problems, because
  // a reading that found none after some were open here is the one that
  // resolved them in front of the person, and that is a page, not a way
  // through. A plan approved while it was read is settled, findings or none:
  // the contract is where it went.
  //
  // Arrival lasts until the reading it asked for or adopted has landed, and
  // ends early where an answer is sent from here.
  const [arrived, setArrived] = useState(false);
  const passing =
    verdict !== null &&
    !reading &&
    (verdict.findings.length === 0 || verdict.dismissed || approved) &&
    (drift === null || (!arrived && sent === null && !thinking && session?.asking == null));
  useEffect(() => {
    if (landed === null || key === null || reading) return;
    if (passing) navigate({ page: "task", repoId, key, view: "contract" });
    setArrived(true);
  }, [landed, passing, reading, key, repoId, navigate]);

  const running = (workspace.interviews ?? []).includes(id ?? "");
  const open = drift?.open ?? [];
  const problem = open[0];
  // The question the interview is putting of its own, if one stands: raised
  // while it applied an answer, and answered here the same way, since the
  // chat is not beside this pane to answer it in.
  const asking = useMemo(() => {
    const held = session?.asking ?? null;
    if (held === null) return null;
    const line = conversation.find((entry) => entry.n === held.entry)?.line;
    if (line === undefined || line.kind !== "asked" || line.drift !== undefined) return null;
    const group = line.groups[held.answered];
    if (group === undefined) return null;
    return { key: `${held.entry}:${held.answered}`, group, number: held.answered + 1, of: line.groups.length };
  }, [session?.asking, conversation]);
  // Whether the pane is still waiting on an answer it sent: until the reading
  // the answer is owed has landed and the record shows what it decided, or
  // the interview stops, or the host says the plan could not be read again.
  const since = (entry: InterviewEntry): boolean => sent !== null && entry.n > sent.after;
  const putAgain = conversation.some(
    (entry) => since(entry) && entry.line.kind === "asked" && entry.line.drift !== undefined,
  );
  const couldNotReread: string | null =
    conversation.flatMap((entry) =>
      since(entry) && entry.line.kind === "note" && entry.line.text.startsWith(REREAD_COULD_NOT_START)
        ? [entry.line.text]
        : [],
    )[0] ?? null;
  // The reading the answer is owed has landed once the answer is on the
  // record as a turn, that turn is owed no reading — so a reading that
  // started before the answer was applied never counts as its reading — none
  // is running, and the Architect is no longer applying the answer. The wait
  // holds through the turn too: while it is in flight, a reading that started after
  // the answer's line and landed ahead of the Architect's first reply looks
  // like the answer's own. That reading has decided the record, whatever it
  // found. But the reading's job settles here a round trip ahead of the
  // record it wrote, which this pane reads over the bridge: the wait holds
  // until the record no longer shows the problem that was answered, or shows
  // it put again, so the answered card is never up to be answered a second
  // time. Where no problem was answered — the interview's own question over
  // the resolved state — the reading landing is the whole of it, since a
  // reading that recorded nothing leaves the record as it was.
  const owing = owedReading(conversation, { drift, running }, newest);
  const reread =
    sent !== null &&
    owing.turn !== null &&
    owing.turn > sent.after &&
    !owing.owed &&
    !thinking &&
    (newest === null || !isLive(newest));
  const decided =
    reread && (sent.problem === "" || problemKey(open) !== sent.problem || putAgain);
  const awaiting = sent !== null && !decided && couldNotReread === null && running;
  // An answer decided is an answer no longer waited on: a reading that runs
  // later — after a turn from the chat, or on arrival — is not this
  // answer's, and the wait over it says what it is, a check.
  useEffect(() => {
    if (decided) setSent(null);
  }, [decided]);

  const send = async (text: string): Promise<void> => {
    if (id === null || busy || thinking) return;
    setBusy(true);
    setFailure(null);
    setSent({ problem: problemKey(open), after: conversation.at(-1)?.n ?? 0 });
    try {
      await bridge.request({ kind: "interviewTurn", id, text });
    } catch (error) {
      setSent(null);
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  // Back is to the plan's own pane, and to Home where there is no planning
  // to go back to: a link that opened on nothing still needs a way off it.
  const back = (): void => {
    if (id === null) {
      navigate({ page: "home" });
      return;
    }
    navigate({ page: "planning", sessionId: id, pane: planPaneFor(workspace.drafts, id) ?? "spec" });
  };
  const contract = (): void => {
    if (key === null) return;
    navigate({ page: "task", repoId, key, view: "contract" });
  };
  // Going on with the problems open is recorded before the page moves, so the
  // same reading is not put to the person again at the same state. Where the
  // record cannot be written the page still moves: this is advice, and the
  // contract is theirs to reach.
  const goOn = async (): Promise<void> => {
    if (id === null) return;
    setBusy(true);
    try {
      await bridge.request({ kind: "driftDismiss", id });
    } catch {
      // The verdict stays open; the reading is asked again the next time through.
    } finally {
      setBusy(false);
    }
    contract();
  };

  // Nothing to read yet — the session is still being opened, or it has no
  // plan drafted to read — and the same way back as the reading has, so this
  // is a step to stand on and never a page to be stuck on.
  if (!session || key === null)
    return (
      <section className="screen drift" data-screen="drift">
        <div className="pane-head">
          <h2>Problems</h2>
        </div>
        <p className="small muted">Opening this planning…</p>
        <div className="approve-actions pane-confirm">
          <Button onClick={back}>Back to the plan</Button>
        </div>
      </section>
    );
  // The footer every state has: back to the plan, and — where a problem is
  // open — the quiet way on past it, waiting or not, because the wait is
  // never a gate either. Once every problem is resolved, and nothing is
  // waited on or asked, the way on is Confirm the plan, to the right of the
  // way back as on every pane's footer. "The plan", not "the contract": this
  // is still planning, and the contract is where confirming it leads.
  const footer = (resolved = false): ReactNode => (
    <div className="approve-actions pane-confirm">
      {problem !== undefined && <span className="small muted">Going on leaves the problems open.</span>}
      <Button onClick={back}>Back to the plan</Button>
      {resolved && (
        <Button variant="primary" onClick={contract}>
          Confirm the plan
        </Button>
      )}
      {problem !== undefined && (
        <button
          type="button"
          className="text-button small"
          disabled={busy}
          onClick={() => void goOn()}
        >
          Go on to the contract anyway
        </button>
      )}
    </div>
  );
  // Resolving an answer the pane sent, or checking the plan afresh.
  const waiting = (resolving: boolean, status = "Reading the plan against the spec…"): ReactNode => (
    <section className="screen drift" data-screen="drift">
      <WaitScreen
        bare
        title={resolving ? "Resolving the problem" : "Checking the plan against the spec"}
        description={
          resolving
            ? "Your answer went to the chat as your turn, which moves the spec and the plan together. The plan is read against the spec again once it is done."
            : "A model reads the two and says where they no longer promise the same thing. Nothing is changed by the reading."
        }
        status={status}
      />
      {footer()}
    </section>
  );
  // A reading under way, whoever asked for it: the next thing the pane shows
  // is what it records, so nothing else is shown over it. And the way through
  // to the contract, which is being taken: nothing is shown over that either.
  if (reading || passing) return waiting(awaiting || thinking);
  const error = failure ?? couldNotReread ?? jobError;
  if (error !== null)
    return (
      <section className="screen drift" data-screen="drift">
        <div className="pane-head">
          <h2>Problems</h2>
          <span className="sub">where the plan and the spec no longer promise the same thing</span>
        </div>
        <div className="drift-body">
          {/* Never a wall: a reading that could not be made is said, and the
              contract stays where it was. */}
          <Notice tone="danger">{error}</Notice>
        </div>
        <div className="approve-actions pane-confirm">
          <span className="small muted">The contract is still where approving happens.</span>
          <Button onClick={back}>Back to the plan</Button>
          <Button variant="primary" onClick={contract}>
            Go on to the contract anyway
          </Button>
        </div>
      </section>
    );
  // The interview's own question, ahead of everything — the next problem, the
  // resolved state and the way on to the contract alike: it stands between
  // the person and confirming, since it is waiting on them, and the reading
  // that follows their answer is what decides what comes next. No count in
  // the corner, because it is not a problem and not one of the count.
  if (asking !== null)
    return (
      <section className="screen drift" data-screen="drift">
        <div className="pane-head">
          <h2>Problems</h2>
          <span className="sub">the Architect asks, before it goes on</span>
        </div>
        <div className="drift-body">
          <h3 className="drift-asking-head">A question from the Architect</h3>
          <p className="drift-intro">
            The Architect has a question of its own before it can go on. What you send goes to it
            as your turn, and the plan is read against the spec again once it is done.
          </p>
          <div className="drift-cards" key={asking.key}>
            <QuestionCard
              group={asking.group}
              number={asking.number}
              of={asking.of}
              standing="interview"
              busy={busy}
              onSend={(text) => void send(text)}
            />
          </div>
        </div>
        {footer()}
      </section>
    );
  // The answer is with the interview, or the plan is about to be read again
  // to see whether it closed the problem: the next one appears when that
  // reading records it, and until then the pane says which of the two is
  // happening rather than leaving the answered card up to be answered again.
  if (awaiting || (thinking && problem !== undefined))
    return waiting(
      true,
      thinking ? "The Architect is applying your answer…" : "Reading the plan against the spec again…",
    );
  // No record yet, and no reading: the way through is being taken (the
  // effect above), or the record the reading wrote is on its way.
  if (drift === null) return waiting(false);
  return (
    <section className="screen drift" data-screen="drift">
      <div className="pane-head">
        <h2>Problems</h2>
        <span className="sub">where the plan and the spec no longer promise the same thing</span>
        {problem !== undefined && (
          <>
            <span className="spacer" />
            <span className="drift-count" role="status">
              <b>{problemHead(open.length)}</b>
              <span className="small muted">
                {open.length === 1 ? "the last one" : `${open.length - 1} more after this`}
              </span>
            </span>
          </>
        )}
      </div>
      <div className="drift-body">
        {problem !== undefined ? (
          <>
            <p className="drift-intro">
              One at a time. Pick how to close it, or say it in your own words: what you send goes
              to the chat as your turn, and it moves the spec and the plan together. The next
              problem appears once the plan has been read against the spec again.
            </p>
            {/* A new card for each problem, so a pick on one is not a pick on
                the next. The count is the pane's corner and not the card's
                head, which the chat's card carries because it has no corner. */}
            <div className="drift-cards" key={problemKey(open)}>
              <QuestionCard
                group={{
                  title: problem.heading,
                  parts: [{ question: problem.difference, options: problem.options }],
                }}
                number={1}
                of={1}
                standing="problem"
                busy={busy}
                onSend={(text) => void send(text)}
              />
            </div>
          </>
        ) : (
          <div className="drift-resolved" role="status">
            <h3>Every problem is resolved</h3>
            <p className="drift-intro">
              The plan and the spec promise the same thing again. The contract is where approving
              freezes the plan.
            </p>
          </div>
        )}
      </div>
      {footer(problem === undefined)}
    </section>
  );
}
