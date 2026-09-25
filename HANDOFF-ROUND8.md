# Handoff: round 8 of `home-loop-and-planning-care-package`

This file rides on the work-in-progress branch only. Delete it before anything here reaches the pull-request branch.

## Where things stand

- The pull-request branch `home-loop-and-planning-care-package` ends at `1e0de26`, gated (`pnpm check` code stages; the validators run under a Python with `yaml`). Its PR body is on the pull request.
- This branch holds that commit plus one work-in-progress commit: six bundles that were built and reviewed but not finished. Every bundle has mutation-checked tests; the reviews below list what is still open. The tree may hold half-applied fixes from fixers that were cut off when the founder's usage ran out: read `git status`, run the tests named per bundle, and continue.
- Workflow the founder set: bundle by disjoint files → one Opus 5.5 builder per bundle → an independent Opus 5.5 reviewer per bundle (nothing lost, nothing beyond the ask, every test proven by mutation) → a fixer → a second read for large fixes → serial gate → ONE commit → local deploy on his Mac. No optimisation pass any more. No push or PR without his word. Commits carry `Assisted-by: LLM` and no `Co-Authored-By`. Never touch `packages/review/**` or `packages/runner/test/security.test.ts`; `git diff origin/main` on both must stay empty.

## Bundles and what is open

### 1. Continue after an interrupted run (runner `resume.ts`, `seal.ts`, `prompt.ts`, `loop/internal/{attempt,brief,state}.ts`, contracts `attempt.ts`)
Built and approved by two reviews. Retained diff taken with `--binary`; a diff that does not apply is dropped whole (reset to the sealed head) and the run continues; the diff is skipped where the branch already holds the sealed commit ("held"); the resumed executor's brief is truthful (`executor_resumed_v2`). Follow-ups noted, not fixed: a binary diff over 8 MiB leaves no `change.diff` and the refusal says "changed nothing"; the desktop's raw diff view shows base85 blocks; `packages/review/PROMPTS.md:22` says `executor_v11` (unprotected, one word).

### 2. Publish a retained branch later (`--publish-retained`; runner `loop/internal/retained.ts`, contracts `retained.ts`, CLI run command, desktop review/merge screens, D-NEW-publish-a-retained-branch-later)
Built, reviewed, fixed. "Next" always enabled on the review screen; the merge press publishes where no pull request exists. Declines now recorded at the seal (`ExecutionAttemptSchema.declines`); verification costs summed from `cv_` bundles; primary buttons at the bottom right; delivery record written under the run lock; preflight git and gh only. Still open when the last fixer was running: the `--publish-retained` help text in `usage.ts` lists only part of the refusals; `retainedBranch(ticket)` called outside the lock; a later run's declines without a new commit are missed (record as a known limit in D-NEW's Built line).

### 3. Planning flow for basic tickets (renderer `planning/**`, `panes.ts` `flowFor`, `SimpleTask.tsx`, `ContractPane.tsx`, `ContractScreen.tsx` `contractShows`, `CriteriaEditor.tsx`, `GraphPane.tsx`, `shared/{protocol,contract-editing}.ts`, host `plan/**`, D-NEW-basic-and-epic-flows, D-130 rewritten)
Built and reviewed: CHANGES NEEDED. Founder's rules: spec-writing shows Spec and Explorer only; a flat plan is basic: Generate plan runs the impact check and the drift reading in the background, a pop-up ("The task is simple, so there is no graph." + Next) appears on landing, landing is Problems if drift, else Impact if flagged, else the contract; the contract is the lowest planning tab, shown while on it or while nothing changed since; basic contract shows editable criteria (edit → drift reading; no change marks on direct edits; the marks are for CHAT edits, which must still show there); epic contract shows the graph read-only (pan/zoom); the post-approval contract page mirrors that view; nodes show "N criteria · paths"; "How the work divides" gone from the graph view; title-bar name not on the contract tab; Plan it again lands on the contract (basic) or Graph (epic); an epic's criteria are edited IN THE GRAPH (node inspector), no Plan pane.
Review blockers, to fix (file:line at 4bce110):
1. Plan it again from an archived stopped ticket whose run job left the journal still projects to the review screen. Fix `apps/desktop/src/shared/jobs.ts:141-144`: `stoppedShort = !active && (inProgress || ["failed","cancelled"].includes(ticket.state))`, drop the unused `lastRun`; flip the test at `App.flows.test.tsx:813-818` that pins the old rule; update the comments at `ticket-workspace.ts:216-225` and `jobs.ts:125-128`. Test: archived failed ticket, run job absent → stopped screen with Plan it again; mutation.
2. Chat edits to a basic ticket's criteria are marked nowhere (only `GraphPane`/`GraphInspector` draw plan marks; `CriteriaEditor` and `ContractScreen.tsx:222` draw none). `EditingChange` (`protocol.ts:562`) needs an author (chat vs person) so the basic contract shows marks for chat edits only; restore the D-128 text in docs/11 (~798) the builder dropped. Test both cases; mutation.
3. A refused write leaves the contract tab stuck on "Writing the change into the contract…" (`ContractScreen.tsx:102-122` `writing` clears only on a new compile operation; a rejected `editingSubmit` creates none; `:230-233` shows the text instead of `editor.error`). Clear on error / when `submitting` returns to null with no new operation; Delete off when one criterion is left (`CriteriaEditor.tsx:170-180`). Test; mutation.
4. Profile migration on deploy: delete `lastView`, add `confirmed: null` and `impact: null`, set `lastPane: "criteria"` to `null` on every editing session in `workspace.json` (keep a `.bak`). And: a planning whose `impact` is null never gets its checks run (the Impact tab never appears; also after Plan it again): run the checks in `useDraftLanding` for any newly opened planning whose `impact` is null. Test; mutation.
5. The epic's node inspector (`GraphInspector.tsx:275-360`) can reword a criterion and change its verification kind only; it cannot add a criterion to a node, delete one, edit the assertion, or edit the requirement id; a reworded criterion loses its requirement citation. The founder ruled the graph is where an epic's criteria are edited: add those operations to the inspector through `packages/planning/src/graph-edit.ts` (validated edit path, D-100) with tests, and carry the requirement citation through a rewording.
6. Decide-and-document: a fresh flat draft never lands on Problems because `admit` seeds an agreeing verdict (`apps/cli/src/commands/admit.ts:1696, 2001`, D-128 by design): the founder was asked; until he answers, D-NEW says a fresh draft lands on Impact or the contract and later changes can land on Problems.
7. Tests missing: `flowFor` ignoring `scope.prohibited`; the pop-up never appearing for an epic (mutation survives); `CriteriaEditor` and `settled.ts` have no test beside them.
8. Docs: docs/15:21 restates D-NEW's flow (cite instead); the planning-mode doc's "where a pop-up says" reads as contract-only (it is over whichever pane the ticket lands on); stale "Plan pane" in `service.e2e.test.ts:3764,3785` and `change-marks.test.ts:176`; dead `.contract-nodes` CSS at `styles.css:4322-4335`.
Follow-ups (not now): a basic re-draft drops Explorer marks (predates this bundle; epics too).

### 4. Live Watch page (contracts `spoken.ts`, runner `adapter.ts`, `codex/index.ts`, `loop/internal/{review,seal}.ts`, desktop `runner-progress.ts`, `task-context.ts` `watchTranscript`, `retained-output.ts`, OutputScreen in `ReviewScreens.tsx`)
Built and reviewed; a fixer was running on: the recorded list must cover every attempt of the run (not only the latest); Codex subagent words must be marked on the record line and skipped; the 80,000-character log tail cut must drop the first partial line; Codex command progress lines folded to one line; reviewer-line redaction test; stage-word regression test; the stopped page's "Continue the task" moved to the far right (`StoppedScreen.tsx`, `.stopped-actions`, docs/15:30).

### 5. Home (`HomePage.tsx`, `ticket-workspace.ts`, `shared/archive.ts`, `Rail.tsx`, `TaskPage.tsx`, sample host)
Built and reviewed; a fixer was running on: stage the corrected order expectation in `App.test.tsx` (running before decided); re-send `ticketOpened` when `unseenAttention` becomes true while the page is open (a stop while open must not leave the circle); "completed" means a decided ticket only (greens get "waiting on your merge decision"); the decided group stays at the bottom under every sort; the unseen state in the card's accessible name; sample host `moveTicket` writes only lifecycle-legal rows and no row on stop.

### 6. Review cards (`ReviewScreens.tsx` cards, `styles.css`, docs/15:32)
Built and approved. The fixer above also changes the badge words to "directly verified", "inferred", "evidence not retained", "not reviewed" (card and table view; table column "Established").

## Founder's rulings today (apply everywhere)
- No caps on the count or length of records Perbo writes; only a cap a decision states by number stays (D-094, D-117, D-127, D-128). String-length caps still await his ruling.
- Primary (highlighted) button at the bottom right of every bottom bar.
- Chat-edit change marks only; direct edits show none.
- No chat dock on the contract or Problems tabs.
- The Watch page shows the agents' words live, no tool calls, latest at the bottom.
- Completed tickets stay on Home at the bottom with a check mark and Archive; nothing archives on its own; attention counts only until the ticket is opened.

## Before a local deploy
Check for runs in flight (`ps -axo pid,command | grep "perbo.js run"`); stopping the app terminates a running attempt. Package with `pnpm desktop:run`; stop the old app by pid; remove `Singleton*` in the profile directory; migrate `workspace.json` for new required fields with a `.bak`.
