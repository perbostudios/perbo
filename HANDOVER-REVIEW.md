# Handover: what the reviewing agent needs to check

This file rides on the work-in-progress branch `home-loop-round8-wip` only, beside `HANDOFF-ROUND8.md`. Delete both before anything here reaches the pull-request branch.

It is written for the agent the founder runs locally to check this work. It says what exists, where, what was verified and how, and what is known to be open. `HANDOFF-ROUND8.md` holds the product detail of round 8; this file does not repeat it.

## Two lines of work, on two branches

| | Pull request #13 | Round 8 |
|---|---|---|
| Branch | `home-loop-and-planning-care-package` | `home-loop-round8-wip` |
| Base | `main` at `1e19a82` | `1e0de26` (the pull request's head before its fix commits) |
| Head | `e0f854b` | this commit |
| State | pushed, CI green on `e0f854b`, not merged; the latest D-073 review (of `923a249`) blocked; `7e26a4b` and `e0f854b` answer and refine it and have not been reviewed | one commit on top of `fa02f17`, gated locally, pushed; not reviewed after its last fix round |

Round 8 does **not** carry the pull request's six fix commits (`013d867`, `0b1b180`, `2256433`, `923a249`, `7e26a4b`, `e0f854b`). Reconcile the two branches before round 8 moves to the pull-request branch: the guard files (`packages/runner/src/shell/internal/*`, `pretool.ts`, `profile.ts`) and `docs/08`, D-105 and ADR-0038 changed on both.

## Pull request #13

https://github.com/perbostudios/perbo/pull/13. Every commit carries `Assisted-by: LLM` and no `Co-Authored-By`. `packages/review/**` and `packages/runner/test/security.test.ts` are byte-identical to `main` there.

Each fix commit answers one independent Claude Opus 5.5 D-073 review, posted as an issue comment on the pull request. The first four were written by separate Opus 5.5 cloud sessions; `7e26a4b` and `e0f854b` were pushed from the founder's own machine:

| Review (comment id) | Read at | Blocked on | Answered by |
|---|---|---|---|
| 5826090814 (an attached file) | `1e0de26` | a directory write reaching a prohibited path; URL-shaped inline write targets skipped (`C://…`) | `013d867` |
| 5832192430 | `013d867` | docs/08 promised a directory is refused where any prohibited glob can match inside it; the code checked literal globs only. Advisory: `mv` sources, `date -us`/`--se=` | `0b1b180` |
| 5835720714 | `0b1b180` | BSD `date -f`/`-r` set the clock though docs/08 said refused. Advisory: `cp`/`mv` into a folder over-refused | `2256433` |
| 5837585829 | `2256433` | GNU-abbreviated `--target-directory`; backup suffixes writing a second, unjudged path; ADR-0038 stale | `923a249` |
| 5840204055 | `923a249` | a substitution-built word fed as an option to an allow-listed command (a regression against main on the Claude hook); `sed` scripts that write or run programs | `7e26a4b`, **not yet reviewed** |

`013d867` also aligned the Architect chat's model wording to D-102's, rewrote test comments that told a story, and made the ticket store's race test deterministic.

### What `7e26a4b` and `e0f854b` claim, to check first (no D-073 review has read them)
From its message:
- A word a substitution builds is refused where a command whose options write or run a program still reads options. `find src $(echo -delete)`, `git diff $(printf -- --output=/tmp/x)`, `git log $(echo --output=/tmp/x)`, `node $(printf -- -e) …`, `python3 $(echo -c) …` and `rg $(echo --pre=sh) x` are refused on both executors. The fifth review showed the hook answered `allow` to these, where main deferred them.
- A command stops reading options at `--`, and a Git revision reader at `--end-of-options` too, so `git diff --end-of-options $(git merge-base HEAD main)` is admitted and the bare spelling refused. `find`, an interpreter and `dd` never stop reading options. `ls`, `cat`, `head`, `tail`, `wc`, the effect-free verbs and `git rev-parse`/`merge-base`/`ls-files` admit a substitution anywhere. A command the guard does not read (`tsc $(echo --outDir) /tmp/out`) is left to the agent's layer on Claude and refused on Codex.
- A `sed` script is read as GNU and BSD `sed` read it (`packages/runner/src/shell/internal/sed.ts`):
  - a `w`, `W` or `s///w` file is judged as a write;
  - `e` and `s///e` are refused as a program run;
  - a script the line does not spell is refused;
  - BSD's `-I` is an in-place edit.
- docs/08 and D-105 state both rules; docs/08's BSD `date` sentence is split; ADR-0038 names the measured rule beside the current one.

`e0f854b` then, from its message: holds a wildcard prohibited glob against a directory only where something on disk that the write reaches matches it; judges `mkdir`, `rmdir`, `touch` and `mkfifo` as the directory itself; reads the word after a bare `sed -i` as BSD's suffix only where GNU cannot read it. Re-run the second and fourth reviews' wildcard-directory commands against it, since it narrows that rule.

Run the fifth review's commands through `judgePreToolCall` and `codexCommandDecision` on the head and on main. Also check that ordinary work still passes: `git diff $(git merge-base HEAD main)` now needs `--end-of-options`, which may change what an executor's routine commands meet.

## Round 8

### Commits
- `fa02f17`: wave 1. Section 3 items 1–8 of `HANDOFF-ROUND8.md`, independently reviewed once, the review's four blockers fixed, gated.
- This commit: wave 2. Everything below, one independent review, one fix round for its findings, gated; no review after that fix round.

### What wave 2 does, by the founder's rulings
**Planning flow** (D-NEW-basic-and-epic-flows, D-128, D-130):
- Epic: Spec (Spec, Explorer) → plan (adds Graph and Impact) → Contract; Problems appears only while a drift problem is open and is always the **lowest** tab, below Contract, for both shapes. Basic: Spec → Impact only if flagged → Contract → Problems only while open.
- An epic's criteria are edited by hand in the Graph node inspector (reword and verification kind, the Node button's placeholder too); the chat edits them too; the epic's contract and the post-approval contract page show the graph read-only. Change marks show only the chat's edits.
- A drafted plan (Generate plan, Plan it again, Start over) is never read and never lands on Problems: basic lands on Impact if flagged, else the contract; epic on its Graph.
- Readings happen only at Confirm the plan (epic) and Confirm contract (basic), only when the spec or criteria changed since the last reading, behind a "Checking for drift" page.
- Open problems hold the confirm on both shapes, by every route (button, shortcut, the contract route, both hosts' `run`/approve); the way on is answering or editing; resolved → the tab goes and a person on it is moved back to where they confirm.
- `perbo drift --dismiss` / `driftDismiss` is refused once the plan has any hand edit since it was drafted (contract page, Graph pane, `perbo edit`); no edits or only the chat's allow it.

**Nothing shown is cut** (D-NEW-nothing-shown-is-cut): length caps stay; model-written overflow is asked again to condense (the Architect chat, the drift reading, bounded asks); typed fields stop at their limit (one constant per limit in `apps/desktop/src/shared/protocol.ts`); lines Perbo composes name whole items then "and K more"; tool output is recorded and shown whole, with a one-sentence summary and the full output behind an "i" in chat notes; no CSS ellipsis or line clamp in the renderer (`renderer/styles.test.ts` fails on one); the spec's cut title names only the folder and its title line says "Untitled" until named; drift text is redacted before its length is measured. Excluded: identifiers, log excerpts, the executor's final account (D-092), `@perbo/model`'s transport first line (SCP-188).

**Founder-authorised edits in `packages/review`** (D-079), exactly two: `src/verdict.ts` shows the verdict fragment whole (the reviewer's prompt, policy and blocking are unchanged), and `PROMPTS.md:22` names the current executor prompt version; plus `src/verdict.test.ts`. `packages/review/test/**` is untouched. **Consequence:** any pull request carrying this triggers `build.yml`'s live regression suite (about fifteen dollars on the maintainer's key), and D-010 requires its summary in the pull-request body. `packages/model` is unchanged from `fa02f17`.

### Open in round 8 (not fixed; for the founder)
The last fix round closed the wave-2 review's three blockers:
- an epic approvable from its contract route while a problem was open, now held in the renderer and refused by both hosts' `run`/approve;
- a surviving mutation in `DriftPane.tsx`;
- stale "last tab" and "advice, not a gate" wording.

No review has read that round. These are known and not fixed:
- **"Go on to the contract anyway" is still offered** when a reading *fails* and no problem is open, and a basic ticket has the same way past (`CONFIRM_WITHOUT`). The hold on open problems is not affected. The founder's words were "there is no 'Go on to the contract anyway'", so this needs his call.
- **A reading also starts on arriving at the Problems tab** (by the tab or `reopenPane`) after a hand edit, not only at a confirm.
- **An epic's hand edit can race Confirm the plan.** If the hand edit's `form.draft` update has not reached the renderer yet, Confirm the plan can pass without a reading. The host refusal covers the case where problems are open.
- **An epic missing from the drafts list gets no `NOT_LISTED` hold** in the renderer; only a basic ticket does. The host refusal covers open problems.
- **Typed-limit composition can still overflow.** Picking a longer choice after filling another part's own words to the room left can push a group's composed turn over 12,000 characters (`InterviewDock` `roomFor`, `LoopScreen` `room`). `ManifestDialog` drops a whole paste if any line is too long.
- **The interview's condense counter resets** on any line that fits, so a model alternating long and short messages can keep being asked again.
- **`DraftEditSchema.summary` (300 characters) can overflow.** "Always prohibit ${glob} in this repository" exceeds it for a glob longer than about 265 characters. This predates the round.
- **`ExplorerPane.tsx` shows 14 files, then "… K more".** This predates the round, and no decision states that number.
- **The drift reading's "could not start" note** (`REREAD_COULD_NOT_START`) still quotes its error inline, not behind an "i".
- **The spec's title line says "Untitled" in the file itself**, not only on screen. The Architect is told to title it, and `perbo admit` and the sample host skip "Untitled" when naming a ticket. Whether the founder meant display-only is unconfirmed.
- **Any pull request carrying this commit runs the live reviewer regression suite**, because of the `packages/review` edits. Its summary goes in the pull-request body (D-010).

## How the work was verified
- Every behaviour has a test beside its module, and every test was proven by mutation (revert the fix, see the test fail, restore, see it pass). Each bundle had an independent Opus 5.5 reviewer who re-ran mutations itself; a surviving mutation was a blocker.
- The gate: `pnpm check` (`scripts/check.mjs`), with the validators under a Python ≥ 3.10 carrying `yaml` (`PERBO_PYTHON=python3`). On this commit, every stage was run on its own, and the code stage with `turbo --continue` so one failure hides nothing. Install, build, runtime, corpus, validators, protected paths and the regression dry run (against the corpus `.github/corpus-pin.json` pins) pass. Every package's typecheck and lint pass. The tests pass apart from ten that are all on the environment list below:
- desktop: 1449 pass, 1 fails;
- CLI: 1445 pass, 6 fail;
- runner: 2689 pass, 2 fail;
- evaluation: 1042 pass, 1 fails;
- contracts 470, review 345, planning 242, workspace 163 and model 65: all pass.
- Environment facts for anyone re-running in a cloud container: it runs as **root** (file modes are ignored), **`GH_TOKEN` is set** (skips `gh auth status`), `GIT_CONFIG_*` sets an `insteadOf`, and `ssh-keygen` must be installed. These tests fail there on the CI-green `1e0de26` exactly as on this branch: desktop e2e "refuses the rename whole…" (chmod); CLI `admit.from-spec` "cannot be read", `agent` "cannot write the launch file", `review/index.ticketless` ac_1/ac_4, `run/index.refused`, `run/local` "read through gh"; runner `pretool.subagent-guard-state` "cannot record", `loop/index.orphans` "survivor", `push-remote` "to an ssh remote"; evaluation `baseline.test.ts`; `workspace` `diagnostic.ignored-paths` times out under full parallel load only. As a non-root user without `GH_TOKEN`, the permission and `gh` ones pass.

## What to check first
1. `git diff fa02f17 HEAD` (wave 2) and `git show fa02f17` (wave 1) against `AGENTS.md`, `packages/runner/AGENTS.md`, `packages/review/AGENTS.md` and `HANDOFF-ROUND8.md`'s rulings.
2. That every route to a confirm holds on open problems (the last fix round added the epic contract route and both hosts; nobody reviewed it after).
3. That the two `packages/review` edits are exactly the authorised two.
4. Pull request #13's `7e26a4b` and `e0f854b`, which no D-073 review has read yet.

## Before a local deploy
Quit Perbo, then from the repository root migrate the profile (it keeps `workspace.json.bak`, changes nothing on a second run, refuses a file that is not a profile):

```
node scripts/migrate-workspace-round8.mjs ~/Library/Application\ Support/Perbo
```

The rest of the deploy steps are in `HANDOFF-ROUND8.md`.
