# Handover: what the reviewing agent needs to check

This file rides on the work-in-progress branch `home-loop-round8-wip` only, beside `HANDOFF-ROUND8.md`. Delete both before anything here reaches the pull-request branch.

It is written for the agent the founder runs locally to check this work. It says what exists, where, what was verified and how, and what is known to be open. `HANDOFF-ROUND8.md` holds the product detail of round 8; this file does not repeat it.

## Two lines of work, on two branches

| | Pull request #13 | Round 8 |
|---|---|---|
| Branch | `home-loop-and-planning-care-package` | `home-loop-round8-wip` |
| Base | `main` at `1e19a82` | `1e0de26` (the pull request's head before its fix commits) |
| Head | `350a097` | this commit |
| State | pushed, not merged; its D-073 review at `350a097` approved | gated locally; the round-8 review of `493bc10` found no code blocker, and its two doc defects are fixed |

Round 8 does **not** carry the pull request's eight fix commits (`013d867`, `0b1b180`, `2256433`, `923a249`, `7e26a4b`, `e0f854b`, `c669777`, `350a097`). Reconcile the two branches before round 8 moves to the pull-request branch: the guard files (`packages/runner/src/shell/internal/*`, `pretool.ts`, `profile.ts`) and `docs/08`, D-105 and ADR-0038 changed on both. Round 8 removes every `.slice(0, 200)` from the guard's refusal details; #13 keeps them and adds `backup.ts:58`, `command.ts:360` and `sed.ts:347`: strip them all in the merge and rerun `packages/runner/src/shell/index.whole-detail.test.ts`. #13 already fixes the two wrapped D-NEW ids in `apps/desktop/src/host/routes.ts`.

## Pull request #13

https://github.com/perbostudios/perbo/pull/13. Every commit carries `Assisted-by: LLM` and no `Co-Authored-By`. `packages/review/**` and `packages/runner/test/security.test.ts` are byte-identical to `main` there.

Each fix commit answers an independent Claude Opus 5.5 D-073 review, posted as an issue comment on the pull request:

| Review (comment id) | Read at | Blocked on | Answered by |
|---|---|---|---|
| 5826090814 (an attached file) | `1e0de26` | a directory write reaching a prohibited path; URL-shaped inline write targets skipped (`C://…`) | `013d867` |
| 5832192430 | `013d867` | docs/08 promised a directory is refused where any prohibited glob can match inside it; the code checked literal globs only. Advisory: `mv` sources, `date -us`/`--se=` | `0b1b180` |
| 5835720714 | `0b1b180` | BSD `date -f`/`-r` set the clock though docs/08 said refused. Advisory: `cp`/`mv` into a folder over-refused | `2256433` |
| 5837585829 | `2256433` | GNU-abbreviated `--target-directory`; backup suffixes writing a second, unjudged path; ADR-0038 stale | `923a249` |
| 5840204055 | `923a249` | a substitution-built word fed as an option to an allow-listed command (a regression against main on the Claude hook); `sed` scripts that write or run programs | `7e26a4b` |

`e0f854b`, `c669777` and `350a097` follow `7e26a4b`, and the D-073 review at `350a097` approved.

`013d867` also aligned the Architect chat's model wording to D-102's, rewrote test comments that told a story, and made the ticket store's race test deterministic.

## Round 8

### Commits
- `fa02f17`: wave 1. Section 3 items 1–8 of `HANDOFF-ROUND8.md`, independently reviewed once, the review's four blockers fixed, gated.
- `cc77b23`: wave 2. Everything below, one independent review, one fix round for its findings, gated.
- `493bc10`: the planning fixer's stopped work merged in, keeping the round's files. The round-8 review of it found no code blocker and two doc defects, which are fixed.
- `93ca6ad`: the fix round applying the founder's five rulings. Among them, the drift reading's "could not start" note says one sentence with its error behind the "i" in both hosts.
- This commit: closes the fix-round review's findings. A typed ticket is named apart from every ticket in the store, so two sharing a first sentence become "… 2". One chooser names a ticket in both hosts, `ticketName` in `@perbo/planning` (root and browser entries), and the sample host refuses a kept title over 60 characters in the CLI's words (D-127). The sample host's reading records what the try that ran found. The contract page's hold while the reading pop-up is up is tested. A confirm on its way to the Problems pane ends when the route ends anywhere else (`routeReached` in `renderer/planning/panes.ts`), so a later arrival by the rail reads nothing.

### What wave 2 does, by the founder's rulings
**Planning flow** (D-NEW-basic-and-epic-flows, D-128, D-130):
- Epic: Spec (Spec, Explorer) → plan (adds Graph and Impact) → Contract; Problems appears only while a drift problem is open and is always the **lowest** tab, below Contract, for both shapes. Basic: Spec → Impact only if flagged → Contract → Problems only while open.
- An epic's criteria are edited by hand in the Graph node inspector (reword and verification kind, the Node button's placeholder too); the chat edits them too; the epic's contract and the post-approval contract page show the graph read-only. Change marks show only the chat's edits.
- A drafted plan (Generate plan, Plan it again, Start over) is never read and never lands on Problems: basic lands on Impact if flagged, else the contract; epic on its Graph.
- Readings happen only at Confirm the plan (epic) and Confirm contract (basic), only when the spec or criteria changed since the last reading, behind a "Checking for drift" page. A reading that cannot run is retried (`shared/reading-retry.ts`) and then reported by a centred pop-up (`ReadingFailedNotice`); there is no way past it.
- Open problems hold the confirm on both shapes, by every route (button, shortcut, the contract route, both hosts' `run`/approve); the way on is answering or editing; resolved → the tab goes and a person on it is moved back to where they confirm.
- `perbo drift --dismiss` / `driftDismiss` is refused once the plan has any hand edit since it was drafted (contract page, Graph pane, `perbo edit`); no edits or only the chat's allow it.

**Nothing shown is cut** (D-NEW-nothing-shown-is-cut): length caps stay; model-written overflow is asked again to condense (the Architect chat, the drift reading, bounded asks); typed fields stop at their limit (one constant per limit in `apps/desktop/src/shared/protocol.ts`); lines Perbo composes name whole items then "and K more"; tool output is recorded and shown whole, with a one-sentence summary and the full output behind an "i" in chat notes; no CSS ellipsis or line clamp in the renderer (`renderer/styles.test.ts` fails on one); the cut of a first turn names only the folder, and "Untitled" is display only: the spec file carries no title line until named; drift text is redacted before its length is measured. Excluded: identifiers, log excerpts, the executor's final account (D-092), `@perbo/model`'s transport first line (SCP-188).

**`packages/review` is byte-identical to `main`**: the round's edits there were never authorised (D-079) and are removed. `packages/model` is unchanged from `fa02f17`.

### Open in round 8 (not fixed; for the founder)
The wave-2 fix round closed that review's three blockers:
- an epic approvable from its contract route while a problem was open, now held in the renderer and refused by both hosts' `run`/approve;
- a surviving mutation in `DriftPane.tsx`;
- stale "last tab" and "advice, not a gate" wording.

These are known and not fixed:
- **An epic's hand edit can race Confirm the plan.** If the hand edit's `form.draft` update has not reached the renderer yet, Confirm the plan can pass without a reading. The host refusal covers the case where problems are open.
- **An epic missing from the drafts list gets no `NOT_LISTED` hold** in the renderer; only a basic ticket does. The host refusal covers open problems.
- **Typed-limit composition can still overflow.** Picking a longer choice after filling another part's own words to the room left can push a group's composed turn over 12,000 characters (`InterviewDock` `roomFor`, `LoopScreen` `room`). `ManifestDialog` drops a whole paste if any line is too long.
- **The interview's condense counter resets** on any line that fits, so a model alternating long and short messages can keep being asked again.
- **`DraftEditSchema.summary` (300 characters) can overflow.** "Always prohibit ${glob} in this repository" exceeds it for a glob longer than about 265 characters. This predates the round.
- **`ExplorerPane.tsx` shows 14 files, then "… K more".** This predates the round, and no decision states that number.

For the founder, not an agent (D-079): `packages/review/PROMPTS.md` names `executor_v11`, and the runner's executor prompt is `executor_v14`. It is a one-word fix.

## How the work was verified
- Every behaviour has a test beside its module, and every test was proven by mutation (revert the fix, see the test fail, restore, see it pass). Each bundle had an independent Opus 5.5 reviewer who re-ran mutations itself; a surviving mutation was a blocker.
- The gate: `pnpm check` (`scripts/check.mjs`), with the validators under a Python ≥ 3.10 carrying `yaml` (`PERBO_PYTHON=python3`). On `cc77b23`, every stage was run on its own, and the code stage with `turbo --continue` so one failure hides nothing. Install, build, runtime, corpus, validators, protected paths and the regression dry run (against the corpus `.github/corpus-pin.json` pins) pass. Every package's typecheck and lint pass. The tests pass apart from ten that are all on the environment list below:
- desktop: 1449 pass, 1 fails;
- CLI: 1445 pass, 6 fail;
- runner: 2689 pass, 2 fail;
- evaluation: 1042 pass, 1 fails;
- contracts 470, review 345, planning 242, workspace 163 and model 65: all pass.
- Environment facts for anyone re-running in a cloud container: it runs as **root** (file modes are ignored), **`GH_TOKEN` is set** (skips `gh auth status`), `GIT_CONFIG_*` sets an `insteadOf`, and `ssh-keygen` must be installed. These tests fail there on the CI-green `1e0de26` exactly as on this branch: desktop e2e "refuses the rename whole…" (chmod); CLI `admit.from-spec` "cannot be read", `agent` "cannot write the launch file", `review/index.ticketless` ac_1/ac_4, `run/index.refused`, `run/local` "read through gh"; runner `pretool.subagent-guard-state` "cannot record", `loop/index.orphans` "survivor", `push-remote` "to an ssh remote"; evaluation `baseline.test.ts`; `workspace` `diagnostic.ignored-paths` times out under full parallel load only. As a non-root user without `GH_TOKEN`, the permission and `gh` ones pass.

## What to check first
1. `git show fa02f17` (wave 1), `git diff fa02f17 493bc10` (wave 2 and the merged fixer's work) and `git diff 493bc10 HEAD` (the fix round and this commit) against `AGENTS.md`, `packages/runner/AGENTS.md`, `packages/review/AGENTS.md` and `HANDOFF-ROUND8.md`'s rulings.
2. That every route to a confirm holds on open problems.
3. That `git diff origin/main -- packages/review` is empty.
4. The merge with pull request #13: the `.slice(0, 200)` hazards above.

## Before a local deploy
Quit Perbo, then from the repository root migrate the profile (it keeps `workspace.json.bak`, changes nothing on a second run, refuses a file that is not a profile):

```
node scripts/migrate-workspace-round8.mjs ~/Library/Application\ Support/Perbo
```

The rest of the deploy steps are in `HANDOFF-ROUND8.md`.
