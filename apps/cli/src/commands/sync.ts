import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  D073_CHANGES_REQUESTED,
  DEFAULT_MERGE_MODE,
  EXIT_CODES,
  HAND_OFF_NOTE,
  HandOffEvidenceError,
  MergeModeSchema,
  OPENER_UNKNOWN_NOTE,
  StopVerdictsSchema,
  TicketSchema,
  UNCHECKED,
  attributePullRequest,
  parsePullRequestReference,
  attributionOnRecord,
  deliveryChecksState,
  escapeStatus,
  handOff,
  observedThrough,
  reconcileStopVerdicts,
  resumeAtPullRequest,
  resumeWithUnrecordedOpener,
  transition,
  type D073Verdict,
  type DeliveredCheck,
  type DeliveryArm,
  type DeliveryChecksState,
  type ExecutionAttempt,
  type GithubCredential,
  type IncompleteReviewPath,
  type MergeMode,
  type StopVerdicts,
  type Ticket,
  type TicketState,
  type TicketEscapes,
} from "@perbo/contracts";
import {
  GithubCredentialError,
  mergeLoopPullRequest,
  pollPullRequest,
  type LoopMergeOutcome,
  type TicketDeliveryState,
} from "@perbo/runner";
import { branchName, recordedBranch } from "@perbo/workspace";
import { UsageError } from "../usage-error.js";
import { applyObservedPath, parseListArgs, UnreachableStateError } from "./admit.js";
import type { Streams } from "../streams.js";
import {
  listLocalRuns,
  readLocalRunRecord,
  writeLocalRunRecord,
  type LocalRunRecord,
} from "./run/local.js";
import { readAttemptsFile, readRepoConfig } from "./run/index.js";
import {
  latestAttemptBranch,
  listTickets,
  localRunBranch,
  localRunChange,
  readContract,
  readTicket,
  storeDir,
  ticketChange,
  writeTicket,
  type SyncedChange,
} from "../store/tickets.js";
import { EscapeCollectionError, readMergeFacts, writeTicketEscapes } from "./escapes/index.js";

/**
 * `perbo sync` — read delivery state through local `git`/`gh` and write it onto
 * the ticket (M1's second exit criterion, now that a ticket exists to update).
 *
 * Local `gh` reads the pull request, its merge state, its checks and its human
 * reviews, and the record it produces is idempotent by construction because the
 * poller writes the whole thing every time from what `gh` reported.
 *
 * `sync` is also how a **stranded** ticket comes back. A run killed between the
 * pull request being opened and the ticket being moved leaves the ticket saying
 * `executing` forever, with no command able to correct it; the attempt record
 * and `gh` between them already know where it should be, so sync reconciles it
 * there — or refuses, when no legal path reaches that state.
 *
 * SCP-157: it is also how a **failed** ticket comes back, when a person finishes
 * what the loop could not — a pull request that the loop never opened, on the
 * branch a failed attempt left behind. `sync` hands the ticket off to `pr_open`
 * on that evidence alone, and on to `merged` if `gh` already says so.
 *
 * SCP-173: a pull request on that branch is not always a person's, though. A
 * ticket that reached `changes_requested` was re-run, and a re-run that fails
 * leaves the loop's own pull request open behind it — the same number the
 * ticket's delivery record has held since the round that opened it. `sync`
 * walks that one to `pr_open` too, and says on the row that the loop opened it.
 * Calling it a hand-off would credit a person who was never there, and it is
 * the ticket's own record — not the shape of the transition — that tells them
 * apart.
 *
 * SCP-252: it is also how a `pr_open` ticket leaves that state when its pull
 * request closed without merging (D-083). `closed` is where the record
 * settles; a D-073 CHANGES REQUESTED verdict on that pull request sends it to
 * `changes_requested` instead, because the verdict is the fact about the
 * review and mergeability a fact about a branch the pull request no longer has.
 *
 * SCP-203: `sync --all-merged` is the same read, swept over every ticket whose
 * delivery already reports `merged` rather than asked one ticket at a time.
 * It exists because `commits_outside_loop` (SCP-196) and `github_credential`
 * (SCP-200) were both added after this store's first sixteen merges, so
 * `unattendedMergeStatus` reads all sixteen as `unknown` until each is read
 * against `gh` again — a one-time backfill, not a standing part of the loop,
 * and a person runs it once by hand. It writes only the delivery record, never
 * the ticket's own lifecycle state: a merged ticket has nowhere left to walk
 * to, and the state machine that reconciles a stranded or failed ticket is
 * `sync <key>`'s, not this sweep's.
 */

/** The phrase every reconciled row's note carries, stranded or handed off. */
const RECONCILED_NOTE = "reconciled after the fact by `perbo sync`";

/**
 * The delivery record one poll produces, written the same way whether it came
 * from `sync <key>` or from `sync --all-merged`'s sweep — one mapping from
 * what `gh` said to what lands on the ticket, so the two paths cannot drift.
 *
 * SCP-173: `opened_by` is the one field not taken from `gh`, because `gh` has
 * nothing to say about it — `attributionOnRecord` decides it from the ticket
 * as it was read, and a number the record already holds keeps the answer it
 * was given. That is what makes this write safe on a ticket sync does not go
 * on to walk: a stranger's pull request seen while it is `closed` is recorded
 * as a stranger's, so the sync that finds it reopened still calls it a
 * hand-off instead of a number the record now happens to name.
 *
 * `midRun` is what `attributionOnRecord` needs to decide `opened_by`: true only
 * for a stranded ticket, whose run died possibly after opening a pull request
 * it never got to record — the only ticket whose branch may carry the loop's
 * work under a number the record has never held. `sync --all-merged` never
 * passes it, because a ticket whose delivery already reports `merged` has no
 * run still in flight to attribute anything to.
 */
function writtenDelivery(
  ticket: Ticket,
  branch: string,
  observed: TicketDeliveryState,
  now: Date,
  midRun: boolean,
  /** SCP-202: the arm whose automation merged it in this run, where one did. */
  mergedBy: DeliveryArm | null = null,
): Ticket {
  const checks: DeliveredCheck[] = observed.checks.map((check) => ({
    name: check.name,
    conclusion: check.conclusion?.toLowerCase() ?? UNCHECKED,
  }));
  return TicketSchema.parse({
    ...ticket,
    delivery: {
      branch,
      pull_request_url: observed.pull_request_url,
      pull_request_number: observed.pull_request_number,
      state: observed.state,
      observed_at: observed.observed_at,
      opened_by: attributionOnRecord(ticket, observed, { midRun }),
      // SCP-192: taken from `gh` like the rest of this record. The loop opened
      // this pull request over a branch it had just merged the base into, so a
      // `conflicting` here is the base having moved since — which is a fact
      // about the branch, not about the ticket's state, and does not move it.
      mergeable: observed.mergeable,
      // SCP-196: taken from `gh` the same way. `unattendedMergeStatus` reads
      // it beside `opened_by` above to decide whether a merged ticket went
      // unattended.
      commits_outside_loop: observed.commits_outside_loop,
      // SCP-200: which credential this sync read GitHub through, from the poll
      // that read it. The path, never the token.
      github_credential: observed.github_credential,
      // SCP-206: the one field on this record `gh` cannot answer. GitHub
      // cannot tell the loop's pull request from a direct agent's, so the
      // answer comes from the record as it was read; taking it from `observed`
      // like the rest would turn every direct-arm row back into the loop's on
      // the first sync, and the comparison reads both arms through these
      // fields.
      arm: ticket.delivery.arm,
      // SCP-202: `gh` cannot answer this either — a merge the loop performed
      // is authenticated as the same credential it pushes under — so the
      // record keeps what it holds, and only a merge this process just made
      // writes it. That is what makes it first-hand.
      merged_by: mergedBy ?? ticket.delivery.merged_by,
      // Whether a remediation round ran before a person was asked is a fact
      // about the run, which `gh` never saw, so the record keeps what the run
      // wrote for the same reason `arm` and `merged_by` are kept.
      incomplete_review: ticket.delivery.incomplete_review,
      // Read from `gh` like the rest of this record, so a sync run while CI is
      // still going records what had concluded by then rather than keeping
      // what the run recorded when it opened the pull request. A check `gh`
      // reports with no conclusion is `unchecked` here for the same reason it
      // is on the run: nothing has concluded, which is not a pass.
      checks,
      checks_state: deliveryChecksState(checks),
    },
    updated_at: now.toISOString(),
  });
}

/**
 * The repository's `merge` switch (SCP-202, D-077), from the same
 * `.perbo/config.json` the run configuration is merged from.
 *
 * Absent is `person`, which is the decision rather than a fallback: D-077 is
 * effective when the loop has cleared D-076's bar, and a repository that has
 * not said otherwise has not said it has. A value that is neither is a
 * refusal, not a silent `person`: a typed switch that fails open in the safe
 * direction still leaves a person believing they turned something on.
 */
function repositoryMergeMode(dir: string): MergeMode {
  const raw = readRepoConfig(dir)?.["merge"];
  if (raw === undefined) return DEFAULT_MERGE_MODE;
  const parsed = MergeModeSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new UsageError(
    `${join(dir, "config.json")} sets 'merge' to ${JSON.stringify(raw)}; it must be "person" or "loop"`,
  );
}

export async function runSyncCommand(input: {
  argv: string[];
  streams: Streams;
  cwd: string;
  now?: Date;
  poll?: typeof pollPullRequest;
  /** The merge as `gh` reports it, for the escape record (SCP-145). */
  mergeFacts?: typeof readMergeFacts | undefined;
}): Promise<number> {
  const now = input.now ?? new Date();
  // SCP-202: taken out before the key is read, so it may be written either
  // side of it — `sync PRB-1 --merge` and `sync --merge PRB-1` are one thing
  // said two ways, and neither is worth a usage error.
  const merging = input.argv.includes("--merge");
  const argv = merging ? input.argv.filter((token) => token !== "--merge") : input.argv;
  if (argv[0] === "--all-merged") {
    if (merging) {
      throw new UsageError(
        "--merge takes one ticket: --all-merged is a read across the store, and merging every " +
          "pull request it finds is not something this command offers",
      );
    }
    return runSyncAllMergedCommand({ ...input, argv: argv.slice(1), now });
  }
  const [key, ...rest] = argv;
  if (!key || key.startsWith("--")) {
    // SCP-284: no key is the local-run sweep. A repository whose work was
    // never admitted has no key to name, and the runs in its store are the
    // whole population, so `perbo sync` on its own is the whole command.
    if (merging) {
      throw new UsageError(
        "--merge takes one ticket: a sweep over the local runs is a read, and merging every " +
          "pull request it finds is not something this command offers",
      );
    }
    return runSyncLocalRunsCommand({ ...input, argv, now });
  }
  const args = parseListArgs(rest);
  const dir = storeDir(resolve(input.cwd, args.repo), args.store);
  // SCP-284: a name that is not a ticket may still be a run this store holds
  // the record of, which is the only kind of name a repository with no ticket
  // store has. The ticket store is asked first, so a store holding both is
  // read exactly the way it always was — the rule `perbo inspect` follows for
  // the same two kinds of name.
  const localRun = existsSync(join(dir, "tickets", `${key}.json`)) ? null : readLocalRunRecord(dir, key);
  if (localRun !== null) {
    if (merging) {
      throw new UsageError(
        `--merge takes a ticket: ${key} is a local run, and D-077's conditions are stated over an ` +
          "approved contract and the review that ran against it",
      );
    }
    const { observed } = await syncLocalRun({
      dir,
      record: localRun,
      streams: input.streams,
      now,
      ...(input.poll ? { poll: input.poll } : {}),
    });
    // The same status the ticket path returns for the same thing: a read that
    // did not happen — no credential, a `gh` that could not be asked, a run
    // that published nothing — is `did_not_complete`, so a script branching on
    // sync's status can tell it from a pull request that was read. Nothing
    // here is a failure of the command; it is the reading not being available.
    return observed ? EXIT_CODES.approve : EXIT_CODES.did_not_complete;
  }
  const ticket = readTicket(dir, key);
  const reconciling = isStranded(ticket.state);
  // SCP-157: a `failed` ticket is never stranded — its own run already ended
  // — but it is the one state a person can still hand off from, so it is
  // checked for evidence on every sync exactly like a stranded ticket is.
  const handingOff = ticket.state === "failed";

  // The branch a stranded ticket never got to record on its delivery is read
  // from its attempts record, or derived rather than guessed: the runner names
  // a new branch from the ticket's key, its id and the approved contract's
  // outcome and nothing else, so the same inputs name it again here. That is
  // what makes a ticket recoverable at all — a run killed before
  // `recordDelivery` left nothing on the ticket to look the branch up by.
  const branch = ticket.delivery.branch ?? (reconciling ? derivedBranch(dir, key, ticket) : null);
  if (branch === null) {
    input.streams.stderr(
      `${key} has no branch yet: nothing has been executed against it, so there is no pull ` +
        "request to read.\n",
    );
    return EXIT_CODES.approve;
  }

  // SCP-202, D-077: the merge first, then the read — so the record this sync
  // writes is the record after it, and the ticket walks to `merged` on the
  // same evidence any other sync walks it on. A stop leaves the read to run
  // anyway: what the pull request says is worth writing down whether or not
  // the conditions to merge it held.
  let mergeOutcome: LoopMergeOutcome | null = null;
  if (merging) {
    const attempts = recordedAttempts(dir, ticket);
    const attempt = attempts[attempts.length - 1];
    if (attempt === undefined) {
      input.streams.stderr(
        `${key} was not merged: its attempts record names no attempt, so there is no loop attempt ` +
          "to carry into the merge commit — and a pull request with no attempt behind it is not " +
          "one the loop produced.\n",
      );
      return EXIT_CODES.did_not_complete;
    }
    try {
      mergeOutcome = await mergeLoopPullRequest({
        mode: repositoryMergeMode(dir),
        repository_root: ticket.repository_root,
        branch,
        pull_request_number: ticket.delivery.pull_request_number,
        // `sync` holds a ticket rather than a run configuration, so the base is
        // GitHub's own answer for this pull request.
        base_ref: null,
        state_root: join(dir, "state"),
        ticket_key: ticket.key,
        // SCP-227: what an approval of an earlier head is read against.
        paths_allowed: readContract(dir, key).scope.paths_allowed,
        attempt_id: attempt.attempt_id,
        now,
      });
    } catch (error) {
      if (!(error instanceof GithubCredentialError)) throw error;
      input.streams.stderr(`${key} was not merged: ${error.message}\n`);
      return EXIT_CODES.did_not_complete;
    }
    input.streams.stderr(
      mergeOutcome.merged
        ? `  ${key} merged by the loop: ${mergeOutcome.detail}\n`
        : `  ${key} was not merged — ${mergeOutcome.detail}\n`,
    );
  }

  let observed: TicketDeliveryState;
  try {
    observed = await (input.poll ?? pollPullRequest)({
      worktree: ticket.repository_root,
      branch,
      ticket_id: ticket.ticket_id,
      attempts: [],
      finding_keys: [],
      now,
      // SCP-206: the commits are judged by the trailer of the arm whose record
      // this is, so a direct arm's commits are not read against the loop's.
      arm: ticket.delivery.arm,
    });
  } catch (error) {
    // SCP-200: no credential at all, decided before the read. Distinct from
    // the `!observed.observed` branch below, which is a `gh` that was asked
    // and answered nothing — the two ask a person for different things, and
    // reading them as one is what left a signed-out machine looking like a
    // branch with no pull request.
    if (!(error instanceof GithubCredentialError)) throw error;
    input.streams.stderr(`${key} unchanged: ${error.message}\n`);
    return EXIT_CODES.did_not_complete;
  }

  if (!observed.observed) {
    // `gh` did not answer — an expired token, no network, a rate limit, or the
    // branch having no pull request at all, which `gh pr view` also reports as a
    // non-zero exit. Its empty record is indistinguishable from "there is no
    // pull request", and writing it would erase a URL already on the ticket. The
    // idempotence claim is about what `gh` reported, and it reported nothing.
    input.streams.stderr(
      reconciling
        ? `${key} unchanged: \`gh\` found no pull request on ${branch} — either there is none, ` +
            "or it could not be asked (an expired token, no network, a rate limit). Nothing " +
            `was reconciled and ${key} is still ${ticket.state}.\n`
        : handingOff
          ? `${key} left untouched: \`gh\` found no pull request on ${branch} to hand off — ` +
              "either there is none, or it could not be asked (an expired token, no network, a " +
              `rate limit). ${key} is still failed.\n`
          : `${key} unchanged: \`gh\` could not be asked about ${branch}. What is on ` +
              `the ticket is what it last said, at ${ticket.delivery.observed_at ?? "no time recorded"}.\n`,
    );
    return EXIT_CODES.did_not_complete;
  }

  if ((reconciling || handingOff) && observed.state === "none") {
    // `gh` answered and there is no pull request on the branch. There is nothing
    // to reconcile from, and the record is left exactly as it was: a stranded
    // ticket is wrong about its state, and overwriting its delivery record with
    // an empty one would make it wrong about its branch too. A `failed` ticket
    // is left the same way — SCP-157's hand-off has nothing to hand off from.
    input.streams.stderr(
      reconciling
        ? `${key} unchanged: \`gh\` found no pull request on ${branch}. Nothing was reconciled and ` +
            `${key} is still ${ticket.state}. Either the attempt never opened one, or it opened it ` +
            `on another branch: perbo run --ticket ${key}\n`
        : `${key} left untouched: \`gh\` found no pull request on ${branch}, so there is nothing to ` +
            `hand off. ${key} is still failed.\n`,
    );
    return EXIT_CODES.did_not_complete;
  }

  // SCP-252: where the closed-pull-request walk below put the ticket, and the
  // verdict that decided it. Null when there was no such walk — a pull request
  // that is not closed, or a ticket that was not at `pr_open` to walk.
  let closedWalk: TicketState | null = null;
  let closedVerdict: D073Verdict | null = null;

  // Written whole, from what `gh` said. Running this twice produces the same
  // file, which is the whole of the idempotence claim.
  let updated: Ticket = writtenDelivery(
    ticket,
    branch,
    observed,
    now,
    reconciling,
    mergeOutcome?.merged === true ? "loop" : null,
  );

  if (reconciling) {
    const attempts = recordedAttempts(dir, ticket);
    const path = statesReconciled({ attempts, delivery: observed.state, pull_request_url: observed.pull_request_url });
    try {
      updated = applyObservedPath(updated, path, now);
    } catch (error) {
      // The evidence points somewhere the transition table cannot reach. Nothing
      // is written — not the walk and not the delivery record, which would
      // otherwise leave the ticket half-reconciled and the refusal unrepeatable.
      if (!(error instanceof UnreachableStateError)) throw error;
      input.streams.stderr(
        `${key} unchanged: refusing to reconcile it to ${error.to}. ${error.message}.\n` +
          `  evidence: ${path.map((step) => step.to).join(" -> ")}\n`,
      );
      return EXIT_CODES.did_not_complete;
    }
  } else if (handingOff && (observed.state === "open" || observed.state === "merged")) {
    // SCP-157: the pull request is the caller's evidence — neither of these
    // ever asks `gh` itself — and the note says what `statesReconciled` says
    // for a stranded ticket, because this is the same kind of claim: a
    // reconstruction from what survived, not something this process watched
    // happen.
    //
    // SCP-173: which claim it is comes from the ticket as it was read, not from
    // `updated`, whose delivery record has already been overwritten with what
    // `gh` just said — comparing that to itself would attribute every pull
    // request to the loop. A ticket that reached `changes_requested` and then
    // failed on its re-run still names the number the loop opened, and finding
    // that same number on the branch is the loop's pull request outliving the
    // failure, not somebody finishing the work by hand.
    //
    // SCP-176: a third answer, `null`, is neither of those — a legacy record
    // with no `opened_by` and no history to decide it from either. The ticket
    // still walks to `pr_open` on the same evidence; the row just declines to
    // choose, rather than guessing the loop the way this used to.
    const pr = observed.pull_request_url ?? "the pull request";
    const evidence = { pull_request_url: observed.pull_request_url };
    const opened = `${RECONCILED_NOTE} from \`gh\`: ${pr} exists on ${branch}`;
    try {
      const attribution = attributePullRequest(ticket, observed);
      updated =
        attribution === "hand_off"
          ? handOff(updated, evidence, `${opened} — ${HAND_OFF_NOTE}`, now)
          : attribution === "loop"
            ? resumeAtPullRequest(
                updated,
                evidence,
                `${opened} — the loop opened it on an earlier round and it is still there after ` +
                  "the attempt that failed",
                now,
              )
            : resumeWithUnrecordedOpener(updated, evidence, `${opened} — ${OPENER_UNKNOWN_NOTE}`, now);
    } catch (error) {
      if (!(error instanceof HandOffEvidenceError)) throw error;
      input.streams.stderr(`${key} unchanged: ${error.message}.\n`);
      return EXIT_CODES.did_not_complete;
    }
    if (observed.state === "merged") {
      updated = transition(updated, "merged", `${RECONCILED_NOTE} from \`gh\`: ${pr} is merged`, now);
    }
  } else if (observed.state === "merged" && updated.state === "pr_open") {
    updated = transition(updated, "merged", `${observed.pull_request_url ?? "the pull request"} merged`, now);
  } else if (observed.state === "closed" && updated.state === "pr_open") {
    // SCP-252, D-083: `gh` reports the pull request closed and unmerged, so the
    // ticket has somewhere to go. `changes_requested` where a D-073 review left
    // CHANGES REQUESTED on it — the verdict is the fact about the review, and
    // mergeability a fact about a branch a closed pull request no longer has —
    // and `closed` otherwise, which is terminal for the record and re-runnable.
    //
    // Read off `updated` rather than `ticket`: `writtenDelivery` above has just
    // put `gh`'s answer on the record, and both rows are guarded on it saying
    // the pull request is closed.
    closedVerdict = observed.d073_verdicts.find(
      (one) => one.verdict === D073_CHANGES_REQUESTED,
    ) ?? null;
    const pr = observed.pull_request_url ?? "the pull request";
    updated =
      closedVerdict === null
        ? transition(updated, "closed", `${pr} was closed without merging`, now)
        : transition(
            updated,
            "changes_requested",
            `${pr} was closed without merging, carrying a ${D073_CHANGES_REQUESTED} ` +
              `verdict from ${closedVerdict.model} on head ${closedVerdict.head}`,
            now,
          );
    closedWalk = updated.state;
  }

  writeTicket(dir, updated);
  const stops = writeStopVerdicts({ dir, ticket: updated, observed, streams: input.streams });
  const escapes = syncEscapes({
    dir,
    change: ticketChange(updated),
    observed_at: observed.observed_at,
    streams: input.streams,
    mergeFacts: input.mergeFacts,
  });
  reportObservation({
    streams: input.streams,
    key,
    state: updated.state,
    observed,
    escapes,
    stops: stops.stops,
    now,
    rerun: `perbo run --ticket ${key}`,
    walked: closedWalk,
    verdict: closedVerdict,
  });
  // SCP-202: the read succeeded and the record is written; what did not happen
  // is the merge that was asked for, and a caller scripting `--merge` has to be
  // able to tell that from a merge that landed.
  return mergeOutcome !== null && !mergeOutcome.merged
    ? EXIT_CODES.did_not_complete
    : EXIT_CODES.approve;
}

/**
 * One row of `sync`'s table, and everything the reading behind it is worth
 * saying out loud.
 *
 * One function rather than two (SCP-284): a local run's sync and a ticket's
 * report the same reading of the same pull request, and a second copy of these
 * lines would be a second answer to what `gh` said. What differs is carried in
 * as arguments — what to call the change, where the record now stands, and the
 * command that runs the work again — because those are the only two things
 * that are not facts about the pull request.
 */
function reportObservation(args: {
  streams: Streams;
  /** What the row is named by, and what a person types to read it back. */
  key: string;
  /** Where the change's own record stands after this sync. */
  state: TicketState;
  observed: TicketDeliveryState;
  escapes: TicketEscapes | null;
  /** Each stop on the pull request and how it was answered, if it was. */
  stops: ReadonlyArray<{ answer: StopVerdicts["stops"][number]["answer"] }>;
  now: Date;
  /** The command that runs this work again, in full. */
  rerun: string;
  /** Where a closed pull request moved the record, or null where none did. */
  walked: TicketState | null;
  /** The D-073 verdict that decided that move, where one did. */
  verdict: D073Verdict | null;
}): void {
  const { observed, streams, key } = args;
  streams.stdout(
    `${key}  ${args.state}  ${observed.state}` +
      `${observed.pull_request_url ? `  ${observed.pull_request_url}` : ""}\n`,
  );
  if (observed.mergeable === "conflicting" && observed.state !== "closed") {
    // SCP-192: the loop merges the base up before it opens a pull request, so a
    // branch that has stopped merging is the base having moved since. The
    // remedy is another run rather than a person's merge, and the line says so
    // where the person is already looking.
    //
    // SCP-235: a closed pull request is excluded here because "conflicts with
    // its base" is a fact about an open branch, and neither half of it is true
    // of one GitHub has already closed — a re-run opens a new pull request
    // rather than fixing this one, and the base did not do what closed it.
    streams.stderr(
      `  ${key} is no longer mergeable: \`gh\` reports the branch conflicts with its base. ` +
        `A re-run merges the base up again and re-reviews what it produces: ` +
        `${args.rerun}\n`,
    );
  }
  if (observed.state === "closed") {
    // SCP-252: where the walk above put the record, and why. A ticket that was
    // not at `pr_open` — one a person already moved on — reports the closure
    // and nothing more, because nothing moved.
    const pr =
      observed.pull_request_number !== null
        ? `pull request #${observed.pull_request_number}`
        : (observed.pull_request_url ?? "the pull request");
    streams.stderr(
      `  ${pr} closed without merging` +
        (args.walked === null
          ? ".\n"
          : args.verdict === null
            ? `; ${key} is now closed. The record is settled and the work can be run again: ` +
              `${args.rerun}\n`
            : `; ${key} is now changes_requested — a review left ` +
              `${D073_CHANGES_REQUESTED} on it (${args.verdict.model}, head ${args.verdict.head})\n`),
    );
  }
  if (observed.checks.length > 0) {
    streams.stderr(
      `\n${observed.checks
        .map((check) => `  ${check.name}: ${check.conclusion ?? check.status}`)
        .join("\n")}\n`,
    );
  }
  if (args.escapes !== null) {
    // Read against this sync's own clock, like every other reading of a record:
    // `stale` here means the fetch did not happen and the window has closed.
    const status = escapeStatus(args.escapes, args.now.toISOString());
    const window =
      status === "window open"
        ? `window open until ${args.escapes.window_closes_at}`
        : status === "stale"
          ? `window closed at ${args.escapes.window_closes_at} but this checkout saw only to ` +
            observedThrough(args.escapes)
          : "window closed";
    streams.stderr(
      `  escapes: ${window}, ${args.escapes.reverts.length} revert(s), ` +
        `${args.escapes.same_path.length} same-path commit(s) on ${args.escapes.default_branch}\n`,
    );
  }
  if (args.stops.length > 0) {
    const answered = args.stops.filter(
      (stop) => stop.answer === "endorse" || stop.answer === "override",
    ).length;
    const conflicts = args.stops.filter((stop) => stop.answer === "conflict").length;
    streams.stderr(
      `  stops: ${answered} of ${args.stops.length} answered` +
        (conflicts > 0 ? `, ${conflicts} with both boxes ticked` : "") +
        "\n",
    );
  }
}

/**
 * The stops on a pull request as `gh` read them, for a change with no stops
 * record to reconcile them against. The answers themselves, in the shape the
 * row prints from — nothing here is written to disk.
 */
const answeredStops = (
  observed: TicketDeliveryState,
): ReadonlyArray<{ answer: StopVerdicts["stops"][number]["answer"] }> =>
  observed.stop_answers.map((stop) => ({ answer: stop.answer }));

/**
 * The command a local run's work is run again by, from the source its contract
 * came from (SCP-284).
 *
 * A run has no ticket key to name, so the re-run is the command that minted
 * its contract in the first place: the pull request it was read from, or the
 * outcome that was typed. Quoted the way a shell needs it, because a line that
 * tells a person what to run has to be a line they can paste.
 */
export function localRunRerun(record: LocalRunRecord): string {
  const reference = record.source.reference;
  return reference !== null && parsePullRequestReference(reference) !== null
    ? `perbo run --pr ${reference}`
    : `perbo run --outcome ${JSON.stringify(record.contract.outcome)}`;
}

/**
 * One local run's sync: read its pull request, and write back what `gh` said
 * (SCP-284).
 *
 * The same reading as a ticket's, on the record a run keeps instead of a
 * ticket file. Where a ticket's delivery record is rewritten whole and its
 * lifecycle walked, a run's `pull_request` block is rewritten whole and there
 * is no lifecycle to walk — `localRunState` reads where the run stands off
 * exactly these fields, so a close, a merge and a review verdict each land in
 * one place and are read from it by `escapes`, `stops` and `inspect` alike.
 *
 * Two absences are left alone rather than written down, for the reason the
 * ticket path leaves them alone: a `gh` that could not be asked has reported
 * nothing, and a `gh` that answers "no pull request on that branch" must not
 * erase the URL the run itself published.
 */
async function syncLocalRun(input: {
  dir: string;
  record: LocalRunRecord;
  streams: Streams;
  now: Date;
  poll?: typeof pollPullRequest;
}): Promise<{ observed: boolean }> {
  const { record, streams, now } = input;
  const before = localRunChange(input.dir, record);
  const branch = localRunBranch(input.dir, record);
  const key = record.run_id;

  if (record.pull_request === null) {
    // Nothing was published, so there is nothing of this run's to read: the
    // row says where the run stopped and no `gh` is spent on it. A pull
    // request on this branch that the record does not name is somebody else's
    // claim to make, not this command's.
    streams.stdout(`${key}  ${before.state}  none\n`);
    streams.stderr(
      `  ${key} published no pull request` +
        (record.refusal === null
          ? ", so there is nothing to read back.\n"
          : `: ${record.refusal.reason.split("\n")[0] ?? "the run was refused"}\n`),
    );
    return { observed: false };
  }

  let observed: TicketDeliveryState;
  try {
    observed = await (input.poll ?? pollPullRequest)({
      worktree: before.repository_root,
      branch,
      ticket_id: record.run_id,
      attempts: [],
      finding_keys: [],
      now,
      // A local run is the loop's own, so its commits are judged by the loop's
      // trailer — the same arm `localRunDelivery` records.
      arm: "loop",
    });
  } catch (error) {
    // SCP-200: no credential at all, decided before the read.
    if (!(error instanceof GithubCredentialError)) throw error;
    streams.stderr(`${key} unchanged: ${error.message}\n`);
    return { observed: false };
  }

  if (!observed.observed) {
    streams.stderr(
      `${key} unchanged: \`gh\` could not be asked about ${branch}. What is on the run record is ` +
        `what it last said, at ${record.pull_request.observed_at ?? record.pull_request.opened_at}.\n`,
    );
    return { observed: false };
  }
  if (observed.state === "none") {
    streams.stderr(
      `${key} unchanged: \`gh\` found no pull request on ${branch}, so the one this run opened ` +
        `(${record.pull_request.url}) is left on its record rather than overwritten with an absence.\n`,
    );
    return { observed: false };
  }

  const updated: LocalRunRecord = {
    ...record,
    pull_request: {
      // The URL and the number as `gh` names them now; the moment the run
      // published stays what the run wrote, because nothing since observed it.
      url: observed.pull_request_url ?? record.pull_request.url,
      number: observed.pull_request_number ?? record.pull_request.number,
      opened_at: record.pull_request.opened_at,
      // Read from `gh` like the rest: a sync run while CI is still going
      // records what had concluded by then rather than keeping what the run
      // read when it opened the pull request. A check `gh` reports with no
      // conclusion is `unchecked` for the reason it is on a ticket: nothing
      // has concluded, which is not a pass.
      checks: observed.checks.map((check) => ({
        name: check.name,
        conclusion: check.conclusion?.toLowerCase() ?? UNCHECKED,
      })),
      checks_state: deliveryChecksState(
        observed.checks.map((check) => ({
          name: check.name,
          conclusion: check.conclusion?.toLowerCase() ?? UNCHECKED,
        })),
      ),
      state: observed.state,
      observed_at: observed.observed_at,
      mergeable: observed.mergeable,
      commits_outside_loop: observed.commits_outside_loop,
      github_credential: observed.github_credential,
      review_verdicts: observed.d073_verdicts.map((one) => ({ ...one })),
    },
  };
  writeLocalRunRecord(input.dir, updated);

  const after = localRunChange(input.dir, updated);
  // Neither of the two state records a ticket's sync writes is written here,
  // and the reason is one line in the record contracts rather than anything
  // this command decides: `TicketEscapesSchema.ticket_key` and
  // `StopVerdictsSchema.ticket_key` are both `TicketKeySchema`, which is
  // `PRB-118` and nothing else. A run nobody admitted has no such key, and the
  // one thing not to do about that is invent one — a synthesised `PRB-…` on a
  // measurement record is a claim that a ticket exists, in the two files
  // D-060's and SCP-145's numbers are read out of.
  //
  // What that costs is named where it is paid: the run is in the escape rate's
  // population — `escapeRows` reads it out of this store by `ticket_id` like
  // any other merged change — and reads `not observed` there, and it reaches
  // the precision-of-stopping reading not at all. Widening those two fields to
  // admit a change with no ticket key is a decision about what those two
  // published records mean, taken in `packages/contracts`, and it is not this
  // command's to take. What the boxes on the pull request said is reported
  // below rather than filed.
  const stops = answeredStops(observed);
  const escapes = null;
  if (after.state === "merged") {
    streams.stderr(
      `  escapes: ${key} merged, but an escape record's ticket_key must be a ticket key and this ` +
        "run has none, so the fourteen days after its merge are not read yet\n",
    );
  }
  const verdict =
    observed.state === "closed"
      ? (observed.d073_verdicts.find((one) => one.verdict === D073_CHANGES_REQUESTED) ?? null)
      : null;
  reportObservation({
    streams,
    key,
    state: after.state,
    observed,
    escapes,
    stops,
    now,
    rerun: localRunRerun(record),
    // A run has no lifecycle to walk, so a closed pull request always moves
    // its record: `localRunState` reads `closed` — or `changes_requested`
    // where the verdict says so — off the state this sync just wrote.
    walked: after.state,
    verdict,
  });
  return { observed: true };
}

/**
 * `perbo sync` with no key: every local run in the store, one pull request
 * each (SCP-284).
 *
 * The whole population, because there is no key to narrow it by and a run is
 * not something a person remembers the id of. One unreadable pull request does
 * not end the sweep — it is named and stepped over, the rule `--all-merged`
 * already follows — so a run whose branch was deleted cannot hide the reading
 * of every run after it.
 *
 * A repository with no store at all is the first thing this says, and it says
 * it in one line: `sync` reaching for `<repo>/.perbo/tickets` and failing on
 * a directory that was never created told a person who had run nothing that
 * their store was broken, when what is true is that nothing has run yet.
 */
async function runSyncLocalRunsCommand(input: {
  argv: string[];
  streams: Streams;
  cwd: string;
  now: Date;
  poll?: typeof pollPullRequest;
}): Promise<number> {
  const args = parseListArgs(input.argv);
  const repo = resolve(input.cwd, args.repo);
  const dir = storeDir(repo, args.store);
  if (!existsSync(dir)) {
    input.streams.stdout(
      `nothing to sync: ${repo} has no ${dir} yet, so nothing has run here — ` +
        '`perbo run --outcome "..."` runs something, and `perbo sync` reads its pull request back\n',
    );
    return EXIT_CODES.approve;
  }
  const runs = listLocalRuns(dir);
  const tickets = listTickets(dir);
  if (runs.length === 0) {
    if (tickets.length > 0) {
      throw new UsageError(
        `${dir} holds tickets and no local runs, so sync needs a ticket key, e.g. PRB-1, or ` +
          "--all-merged",
      );
    }
    input.streams.stdout(
      `nothing to sync: ${dir} holds no local runs and no tickets — ` +
        '`perbo run --outcome "..."` runs something, and `perbo sync` reads its pull request back\n',
    );
    return EXIT_CODES.approve;
  }
  let read = 0;
  let unread = 0;
  for (const record of runs) {
    try {
      const { observed } = await syncLocalRun({
        dir,
        record,
        streams: input.streams,
        now: input.now,
        ...(input.poll ? { poll: input.poll } : {}),
      });
      if (observed) read += 1;
      else unread += 1;
    } catch (error) {
      // Every way one run can end badly, not only the credential `syncLocalRun`
      // already names: a `git` that cannot resolve the store's repository, a
      // run record whose branch cannot be derived, a state file that cannot be
      // written. A sweep across a whole store must not let one of them hide
      // every run after it — the rule `--all-merged` follows for the same
      // reason, and the same one this sweep's own summary is counted under.
      // Nothing is swallowed: the run is named with what went wrong.
      unread += 1;
      input.streams.stderr(
        `${record.run_id} unread: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}\n`,
      );
    }
  }
  // The count the table is read against, so "three runs, one row" is a fact a
  // person is told rather than one they have to notice.
  input.streams.stdout(
    `${runs.length} local run${runs.length === 1 ? "" : "s"}: ${read} read, ${unread} unread\n`,
  );
  // A store can hold both kinds, and this sweep read one of them. Said out
  // loud rather than left to be noticed: a table that quietly covered half the
  // store would read as the whole of it, and a ticket is still synced by name.
  if (tickets.length > 0) {
    input.streams.stderr(
      `  ${tickets.length} ticket${tickets.length === 1 ? "" : "s"} in ${dir} ` +
        `${tickets.length === 1 ? "was" : "were"} not read: a sync with no key reads the local ` +
        "runs. Name one — perbo sync PRB-1 — or read every merged one with " +
        "perbo sync --all-merged\n",
    );
  }
  return EXIT_CODES.approve;
}

export interface SyncAllMergedArgs {
  repo: string;
  store: string | null;
  /** Re-read a ticket even where `commits_outside_loop` is already known. */
  force: boolean;
}

/**
 * Its own small parser rather than `parseListArgs`: `--force` has no meaning
 * for any other list-shaped command, and giving every one of them a flag this
 * is the only user of would be a wider surface for no reader's benefit.
 */
export function parseSyncAllMergedArgs(argv: readonly string[]): SyncAllMergedArgs {
  const args: SyncAllMergedArgs = { repo: ".", store: null, force: false };
  const tokens = argv.flatMap((token) => {
    if (!token.startsWith("--")) return [token];
    const eq = token.indexOf("=");
    return eq === -1 ? [token] : [token.slice(0, eq), token.slice(eq + 1)];
  });
  const value = (index: number, token: string): string => {
    const next = tokens[index];
    if (next === undefined) throw new UsageError(`${token} requires a value`);
    return next;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    switch (token) {
      case "--repo":
        args.repo = value(++i, token);
        break;
      case "--store":
        args.store = value(++i, token);
        break;
      case "--force":
        args.force = true;
        break;
      default:
        throw new UsageError(`unknown option '${token}' for sync --all-merged`);
    }
  }
  return args;
}

/** How `commits_outside_loop` reads on one row of `sync --all-merged`'s output. */
const commitsOutsideLoopCell = (value: boolean | null): string => (value === null ? "unknown" : String(value));

/**
 * SCP-203: read every merged ticket's pull request once and fill
 * `commits_outside_loop` and `github_credential`, so `unattendedMergeStatus`
 * has an answer for tickets that merged before either field existed.
 *
 * The population is every ticket whose **delivery** reports `merged` — not
 * every ticket whose own lifecycle state does. The two usually agree, but a
 * ticket a person finished by hand from `changes_requested` or `failed` can
 * carry a merged pull request on its delivery record with its own `state`
 * left where the loop's run last put it (SCP-157/SCP-173 walk some of those
 * cases forward; a sweep across the whole store is not one of them). Filling
 * this ticket's two fields on such a record is exactly what a person re-reading
 * "did anyone else touch what merged" wants, whether or not the ticket's own
 * lifecycle state has caught up — and `unattendedMergeStatus` still gates its
 * own count on `state === "merged"`, so this sweep visiting a wider population
 * cannot move that count on its own.
 *
 * A ticket already carrying a non-null `commits_outside_loop` is left alone
 * unless `--force` asks to re-read it — the sweep is a one-time backfill for
 * a field that used to be null, not a standing re-poll of settled history. A
 * pull request `gh` cannot answer for — no credential, or `gh pr view` itself
 * failing — is named unreadable and skipped; it does not fail the sweep, the
 * same distinction `sync <key>` already draws between "no pull request" and
 * "could not ask".
 */
async function runSyncAllMergedCommand(input: {
  argv: string[];
  streams: Streams;
  cwd: string;
  now: Date;
  poll?: typeof pollPullRequest;
}): Promise<number> {
  const args = parseSyncAllMergedArgs(input.argv);
  const dir = storeDir(resolve(input.cwd, args.repo), args.store);
  const merged = listTickets(dir).filter((ticket) => ticket.delivery.state === "merged");

  let filled = 0;
  let unchanged = 0;
  let unreadable = 0;

  for (const ticket of merged) {
    if (!args.force && ticket.delivery.commits_outside_loop !== null) {
      unchanged += 1;
      input.streams.stdout(
        `${ticket.key}  ${ticket.delivery.opened_by ?? "none"}  ` +
          `${commitsOutsideLoopCell(ticket.delivery.commits_outside_loop)}\n`,
      );
      continue;
    }

    const branch = ticket.delivery.branch;
    if (branch === null) {
      // Unreachable in practice — a merged pull request has a branch it merged
      // from — but a store can hold a record written by hand or by an earlier
      // version, and this is read the same way any other unreadable one is.
      unreadable += 1;
      input.streams.stdout(`${ticket.key}  unreadable: no branch is recorded on its delivery\n`);
      continue;
    }

    let observed: TicketDeliveryState;
    try {
      observed = await (input.poll ?? pollPullRequest)({
        worktree: ticket.repository_root,
        branch,
        ticket_id: ticket.ticket_id,
        attempts: [],
        finding_keys: [],
        now: input.now,
        // SCP-206: judged by the trailer of the arm whose record this is.
        arm: ticket.delivery.arm,
      });
    } catch (error) {
      // SCP-200: no credential at all. Named and skipped, the same as any
      // other ticket `gh` could not answer for — a batch sweep over a whole
      // store must not let one signed-out read fail every ticket after it.
      if (!(error instanceof GithubCredentialError)) throw error;
      unreadable += 1;
      input.streams.stdout(`${ticket.key}  unreadable: ${error.message}\n`);
      continue;
    }

    if (!observed.observed) {
      unreadable += 1;
      input.streams.stdout(`${ticket.key}  unreadable: \`gh\` could not be asked about ${branch}\n`);
      continue;
    }

    // Never `midRun`: every ticket this sweep visits already has a merged
    // delivery record, so there is no run still in flight to attribute a
    // pull request to.
    const updated = writtenDelivery(ticket, branch, observed, input.now, false);
    writeTicket(dir, updated);
    filled += 1;
    input.streams.stdout(
      `${updated.key}  ${updated.delivery.opened_by ?? "none"}  ` +
        `${commitsOutsideLoopCell(updated.delivery.commits_outside_loop)}\n`,
    );
  }

  input.streams.stdout(
    `${merged.length} merged ticket${merged.length === 1 ? "" : "s"}: ${filled} filled, ${unchanged} unchanged, ` +
      `${unreadable} unreadable\n`,
  );
  return EXIT_CODES.approve;
}

/**
 * The states a run leaves a ticket in while it is still running.
 *
 * A ticket found in one of these when no run is in progress is stranded: the
 * process that would have moved it on is gone, and every one of them is a state
 * the lifecycle expects something to happen next from. `pr_open`, `merged`,
 * `closed`, `changes_requested` and `failed` are settled — a person, GitHub or
 * a later run moves those — and `ready` has never been executed, so none of
 * them is reconciled.
 */
export const STRANDED_STATES = [
  "provisioning",
  "executing",
  "verifying",
  "independent_review",
] as const satisfies readonly TicketState[];

export function isStranded(state: TicketState): boolean {
  return (STRANDED_STATES as readonly TicketState[]).includes(state);
}

/**
 * The branch this ticket's attempt is on: the one its records name, or the one
 * the runner would derive for it.
 *
 * A recorded branch is kept (D-098) — the delivery record's, then the latest
 * attempt's — so a ticket that published on `ayo/` is looked up there whatever
 * its key derives now. Where none is recorded, `branchName` is the runner's own
 * naming function, called with the runner's own inputs — the ticket's key, its
 * id and the **approved** contract's outcome. Re-deriving the name rather than
 * reimplementing it is the point: a slug rule that drifted between the two
 * would send sync looking for a pull request that exists under a name it does
 * not compute.
 */
export function derivedBranch(dir: string, key: string, ticket: Ticket): string {
  const recorded = recordedBranch(
    { delivery: ticket.delivery.branch, attempt: latestAttemptBranch(dir, ticket.ticket_id) },
    ticket.ticket_id,
  );
  if (recorded !== null) return recorded;
  let outcome: string;
  try {
    outcome = readContract(dir, key).outcome;
  } catch (error) {
    throw new UsageError(
      `${key} is ${ticket.state} with no branch recorded, and its plan contract could not be ` +
        "read, so the branch its attempt would have used cannot be derived: " +
        `${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
  }
  return branchName({ ticket_key: ticket.key, ticket_id: ticket.ticket_id, outcome });
}

/** The attempts the loop recorded for this ticket. Absent is empty, not a fault. */
function recordedAttempts(dir: string, ticket: Ticket): ExecutionAttempt[] {
  const path = join(dir, "state", `${ticket.ticket_id}.attempts.json`);
  if (!existsSync(path)) return [];
  return readAttemptsFile(path).attempts;
}

/**
 * The states the record and `gh` between them support, as a path for
 * `applyObservedPath` to walk.
 *
 * The counterpart of `statesObserved`, and deliberately not the same function:
 * that one is written from a run this process just watched, and this one is
 * written after the fact from what survived it. Each step is claimed only where
 * something durable says so — an attempt in the attempts record, a pull request
 * `gh` can still see — and **every note says which**, because a history that
 * reads as first-hand observation when it is not is the failure `applyObservedPath`
 * exists to refuse.
 *
 * There is no `provisioning` step: every state this reconciles from is already
 * at or past it, so the step could only ever be skipped.
 */
export function statesReconciled(evidence: {
  attempts: ReadonlyArray<Pick<ExecutionAttempt, "attempt_id" | "termination">>;
  delivery: TicketDeliveryState["state"];
  pull_request_url: string | null;
}): Array<{ to: TicketState; note: string }> {
  const from = RECONCILED_NOTE;
  const path: Array<{ to: TicketState; note: string }> = [];

  const count = evidence.attempts.length;
  if (count > 0) {
    path.push({
      to: "executing",
      note: `${from} from the attempts record: ${count} attempt${count === 1 ? "" : "s"} recorded`,
    });
    // Claimed wherever an attempt ran, for the same reason `statesObserved`
    // claims it wherever a round ran: zero checks is a fact about the
    // repository's configuration, not a stage that was skipped.
    path.push({
      to: "verifying",
      note: `${from} from the attempts record: the last of ${count} attempt${
        count === 1 ? "" : "s"
      } terminated ${evidence.attempts[count - 1]?.termination.reason ?? "unrecorded"}`,
    });
  }

  // A pull request is only ever opened after the independent review has run
  // (the loop publishes from the review artifact), and the change set it carries
  // is the one a completed attempt produced. Both have to hold: a pull request
  // with no completed attempt behind it in the record is a disagreement between
  // the two sources, and the walk is left unable to reach its terminal state
  // rather than papered over.
  const completed = evidence.attempts.find((attempt) => attempt.termination.reason === "completed");
  const pr = evidence.pull_request_url ?? "the pull request";
  if (completed && evidence.pull_request_url !== null) {
    path.push({
      to: "independent_review",
      note:
        `${from} from \`gh\` and the attempts record: ${pr} exists over attempt ` +
        `${completed.attempt_id}, and a pull request is opened only once the review has run`,
    });
  }

  switch (evidence.delivery) {
    case "open":
      path.push({ to: "pr_open", note: `${from} from \`gh\`: ${pr} is open` });
      break;
    case "merged":
      path.push({ to: "pr_open", note: `${from} from \`gh\`: ${pr} was opened before it was merged` });
      path.push({ to: "merged", note: `${from} from \`gh\`: ${pr} is merged` });
      break;
    case "closed":
      path.push({
        to: "changes_requested",
        note: `${from} from \`gh\`: ${pr} was closed without merging`,
      });
      break;
    default:
      // `none` never reaches here: the caller stops on it, because an absent
      // pull request is evidence of nothing rather than evidence of failure.
      break;
  }
  return path;
}

/**
 * SCP-145: what the escape rate needs, read here so that `perbo escapes`
 * needs nothing.
 *
 * Only for a merged ticket — before the merge there is no window to open — and
 * only through local `git` and `gh`. A failure to read the history is named on
 * stderr and leaves the previous record alone: the same rule the delivery
 * record follows, and for the same reason. A ticket whose record is missing
 * reads `not observed` rather than zero.
 */
function syncEscapes(args: {
  dir: string;
  change: SyncedChange;
  observed_at: string;
  streams: Streams;
  mergeFacts?: typeof readMergeFacts | undefined;
}): TicketEscapes | null {
  const change = args.change;
  if (change.state !== "merged" || change.branch === null) return null;
  try {
    const facts = (args.mergeFacts ?? readMergeFacts)({
      repositoryRoot: change.repository_root,
      branch: change.branch,
      pull_request_number: change.delivery.pull_request_number,
    });
    if (facts === null) {
      args.streams.stderr(
        `  escapes: ${change.key} is merged on its record but \`gh\` reports no merge commit ` +
          "for its pull request, so no escape record was written\n",
      );
      return null;
    }
    return writeTicketEscapes({
      dir: args.dir,
      repositoryRoot: change.repository_root,
      ticket: change,
      facts,
      observed_at: args.observed_at,
      streams: args.streams,
    });
  } catch (error) {
    if (!(error instanceof EscapeCollectionError)) throw error;
    args.streams.stderr(`  escapes: ${change.key} unchanged — ${error.message}\n`);
    return null;
  }
}

/**
 * D-060, measured live: the stop answers `gh` read out of the pull-request
 * body, written whole to `<store>/state/<ticket_id>.stops.json` beside the
 * attempt record. Same idempotence rule as the ticket, with one memory: a
 * stop's `answered_at` is kept from the previous file while its answer is
 * unchanged, so it dates the person's click rather than the latest sync.
 *
 * The stops are what the body's markers say. The attempt record beside this
 * file holds no review, so there is nothing else to reconcile them against;
 * the marker carries the rule id and routing for that reason.
 */
export function writeStopVerdicts(args: {
  dir: string;
  /** The change the answers are about: a ticket, or a local run (SCP-284). */
  ticket: Pick<SyncedChange, "ticket_id" | "key">;
  observed: TicketDeliveryState;
  streams: Streams;
}): StopVerdicts {
  const stateDir = join(args.dir, "state");
  const path = join(stateDir, `${args.ticket.ticket_id}.stops.json`);
  let previous: StopVerdicts | null = null;
  if (existsSync(path)) {
    try {
      previous = StopVerdictsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      // What is lost is the memory of when each answer first appeared; the
      // answers themselves come from the pull request. Named, not silent.
      args.streams.stderr(
        `warning: ${path} is not a readable stops record and is being rewritten from the pull ` +
          `request: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}\n`,
      );
    }
  }
  const verdicts = reconcileStopVerdicts({
    previous,
    ticket: { ticket_id: args.ticket.ticket_id, key: args.ticket.key },
    pull_request_url: args.observed.pull_request_url,
    observed: args.observed.stop_answers,
    observed_at: args.observed.observed_at,
  });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(verdicts, null, 2)}\n`);
  return verdicts;
}

/**
 * Record the branch and pull request a completed run produced.
 *
 * SCP-173: a run that opened no pull request observed **nothing** about one,
 * and where the ticket already names one — the loop's own, from the round that
 * published it — that record stands. Overwriting it with an absence said the
 * pull request had gone when it was still open on the branch, and it is the
 * only thing that can tell a later `perbo sync` whose pull request it is: a
 * ticket that reached `changes_requested` behind a published pull request and
 * then failed on its re-run came out of the re-run with an empty record and
 * read back as a stranger's hand-off. The branch is still taken from this run,
 * which is where the work is now, and `observed_at` is kept along with the
 * values it dates rather than being moved forward over an unobserved one.
 *
 * What that changes for a reader, said plainly because it is visible in
 * `perbo inspect` and in `perbo list --json`: a `failed` ticket whose latest
 * run produced nothing still shows the pull request url the earlier round
 * published, `state: "open"`, and the `observed_at` of that earlier round. All
 * three are true — the pull request is open, and the timestamp says when that
 * was last seen, which is what `observed_at` is for and why it sits beside the
 * values rather than tracking `updated_at`. The reading to avoid is that a
 * fresh `updated_at` dates the delivery record; it never did.
 */
export function recordDelivery(
  ticket: Ticket,
  result: {
    workspace: { branch: string };
    pull_request: { url: string; number: number | null } | null;
    /** SCP-200: the credential path the run published through, where it did. */
    github_credential?: GithubCredential | null;
    /**
     * Which way this run's review reached its end where it could not resolve
     * every criterion. The run is the only thing that knows it, and this is
     * where a person reading the ticket meets it.
     */
    incomplete_review?: IncompleteReviewPath | null;
    /**
     * What the checks on the published head said, read by the run before it
     * returned. Absent on a run that opened nothing.
     */
    delivery_checks?: { checks: readonly DeliveredCheck[]; state: DeliveryChecksState } | null;
  },
  at: Date,
): Ticket {
  const opened = result.pull_request;
  const incomplete_review = result.incomplete_review ?? null;
  const read = result.delivery_checks ?? null;
  return TicketSchema.parse({
    ...ticket,
    delivery:
      opened === null && ticket.delivery.pull_request_url !== null
        ? { ...ticket.delivery, branch: result.workspace.branch, incomplete_review }
        : {
            branch: result.workspace.branch,
            pull_request_url: opened?.url ?? null,
            pull_request_number: opened?.number ?? null,
            state: opened ? "open" : "none",
            observed_at: at.toISOString(),
            // The run being recorded is the loop's own, so a pull request it
            // opened is the loop's — the one place that fact is first-hand,
            // and the only place `loop` is ever written from.
            opened_by: opened ? "loop" : null,
            // SCP-192: the loop merged the base up before opening this, but
            // whether GitHub can merge it is GitHub's to say and nothing has
            // asked yet. `perbo sync` is what fills this in.
            mergeable: null,
            // SCP-196: likewise — whether a person's commit later reaches this
            // pull request is `gh`'s to say, and nothing has asked yet.
            commits_outside_loop: null,
            // SCP-200: the path this run's own `gh` published through, which
            // the run is first-hand about. `perbo sync` overwrites it with
            // the path it later polls through.
            github_credential: result.github_credential ?? null,
            // SCP-206: the run being recorded is the loop's own, which is what
            // makes this the one place `loop` is written from first-hand. The
            // direct arm writes its own record and its own arm.
            arm: "loop",
            // Whether a remediation round ran before a person was asked, from
            // the run that ran it. `gh` cannot see this, so nothing else can
            // write it.
            incomplete_review,
            // The reading the run took of the head it published, before this
            // record existed. `perbo sync` re-reads it from `gh` afterwards.
            checks: opened && read ? [...read.checks] : [],
            checks_state: opened && read ? read.state : null,
          },
    updated_at: at.toISOString(),
  });
}
