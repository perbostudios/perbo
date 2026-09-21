# CLI

The `perbo` binary. Perbo is a loop that takes a ticket on your repository to
a pull request: an executor writes the change in a worktree of its own, an
independent reviewer judges it against the plan and the repository's own checks,
and every finding the executor can close goes back to it on the branch, round
after round, until only what needs a person is left. That is what reaches you.
It runs on your machine, on your own model credential.

## Quick start

Before the first command, `doctor` checks your machine: Node 22 or newer; the package manager your repository installs with — missing it, `doctor` reports `install_binary_missing` and names what to get; a coding agent, `claude-cli` by default or `codex-cli` at 0.145.0 or later, already signed in; set `ANTHROPIC_API_KEY` to run the reviewer against a hosted Anthropic key instead of that local agent; and, once you publish, the GitHub CLI signed in (`gh auth login`).

In the repository you want changed, once the binary is installed:

```bash
perbo run --outcome "unslug() turns a slug back into spaced words" \
  --criterion "unslug('hello-world') returns 'hello world' :: a unit test covers it" \
  --path "src/**" --path "test/**"
```

The loop provisions a worktree of its own outside your checkout, installs and
verifies it with the commands the repository's own manifest declares, executes
one agent under the permission profile, seals the change set, runs the pinned
checks and reviews the result independently. It ends when the gate is open, or
when what is left is not something the executor closed; it prints how it ended,
what it cost, and the `perbo inspect` invocation that reads the whole record
back. With `--publish` the branch goes up and the pull request
opens, and a person merges it.

A repository the loop has not seen needs nothing set up first: with no
`.perbo/config.json` the run uses the checks the repository's own
`package.json` scripts imply, and names them as it starts.
`perbo doctor --repo . --write-config` pins those checks in that file, and
answers whether this machine and this repository can run a change at all.

Where the work is a ticket first, `perbo admit` records one and its contract,
`perbo approve` freezes it, and `perbo run --ticket PRB-1` binds the attempt to
that approved contract. Everything below is the detail.

## Build

One source tree, one entry point ([`src/main.ts`](src/main.ts)), open (D-075):
`apps/cli`'s own `build` bundles it into `dist/perbo.js`
([`tooling/package/bundle.mjs`](../../tooling/package/bundle.mjs)), and
[`test/bundle-hosts.test.ts`](test/bundle-hosts.test.ts) reads the shipped bundle's own module graph to
check it talks to the model provider the user pays for and to nothing of ours.
`pnpm release:pack` stages the same bundle into the design-partner tarball
([`tooling/package/pack.mjs`](../../tooling/package/pack.mjs)).

## Source layout

`src/` follows the repository's module layout ([docs/07](../../docs/07-monorepo-and-deployment.md), "Package layout").

| Directory | What it holds |
|---|---|
| [`command-line/`](src/command-line) | The argv edge: the terminal shell around the command table, and the usage text |
| [`commands/`](src/commands) | One module per command — a file where the command is one piece, a directory with an `index.ts` surface and an `internal/` where it is not |
| [`store/`](src/store) | `<repo>/.perbo/` and the records every command reads and writes |
| [`spec/`](src/spec) | The Spec (D-103): its pages, and whether a ticket's spec still matches the repository |
| [`endpoint/`](src/endpoint) | The loopback tool server the queue hosts for a session |

The root holds the two build entries — [`main.ts`](src/main.ts) for the binary and
[`index.ts`](src/index.ts) for the library — and the small modules every command shares.
[`version.ts`](src/version.ts) stays at the root: it reads `../package.json` from
`import.meta.url`, which names this package only from one level under `src/`.

A test sits beside the module it covers. [`test/`](test) holds the suites whose subject is the built
package — the compiled tree, the bundle, the packed tarball, the README quick start — and
`test/fixtures/`, the authored data the suites read — among it the repository `perbo index` is run
over.

## Install

A design partner receives one archive, `perbo-<version>.tgz`, and its SHA-256 by a separate route;
verifies the digest with `shasum -a 256 -c`; and installs with `npm install -g ./perbo-<version>.tgz`
or runs `node bin/perbo.mjs` from the extracted directory — one bundled file, no `node_modules`.
Node 22+, `git`, the package manager the repository installs with, a signed-in `gh` and a
signed-in Claude Code are the prerequisites, and `perbo doctor --repo .` checks all five. Run
`perbo baseline start` before anything else: the
baseline cannot be reconstructed once Perbo has run on the repository. The CLI does not update
itself. The full page — verification, the first three commands,
what leaves the machine, uninstall — is [`docs/install.md`](../../docs/install.md), and
`pnpm release:pack` builds the archive from [`tooling/package/pack.mjs`](../../tooling/package/pack.mjs).

## The six commands

| Command | What it does |
|---|---|
| `doctor` | Checks that a repository can run a ticket, and proposes its configuration |
| `baseline` | Times your direct-agent workflow, to compare against Perbo later |
| `review` | Reviews a change on its own — `review --pr owner/repo#412` needs nothing admitted, no ticket, nothing beyond the pull request itself |
| `inspect` | Reads back a run's attempts and reviews |
| `verdict` | Records your endorse or override on a stop, or accept or reject on a finding |
| `run` | Runs the loop end to end: write, check, review, fix, and — with `--publish` — open the pull request |

`admit`, `approve`, `edit`, `list`, `sync`, `serve`, `agent`, `interview`, `mcp`, `stops`, `escapes` and `principle` build a ticket queue across many repositories on top of the same loop. `index` is the one command that reads your code rather than your records. `perbo --help` has every command and flag; [docs/04](../../docs/04-ticket-workspace-and-review.md) is the specification.

## Commands

```bash
perbo doctor --repo . [--probe]
perbo run --ticket PRB-1 [--publish]
perbo run --ticket PRB-1 --relevel [--publish]
perbo run --contract c.json --config run.json [--publish]
perbo review --contract c.json --diff change.diff --checks checks.json --repo .
perbo review --pr owner/repo#412 [--repo .]
perbo review --head <ref> --base <ref> --outcome "..." [--criterion "what :: how it is proven"]
perbo admit --outcome "..." --criterion "what :: how it is proven" --path "src/**"
perbo admit --from owner/repo#412 [--provider claude-cli]
perbo admit --from-file issue.md [--provider claude-cli]
perbo edit PRB-1
perbo approve PRB-1
perbo list [--all] [--json]
perbo sync PRB-1
perbo sync [--repo .]            # every local run in the store
perbo sync <local run id>
perbo serve [--publish] [--interval 60s] [--once] [--json] [--no-endpoint]
perbo mcp [--drafter] [--json]
perbo agent [--provider claude|codex] [-- <provider args>]
perbo interview --repo . --spec specs/<slug> [--session <id>] [--model <id>] [--provider claude|codex]
perbo stops [--json] [--since <ISO date>] [--by-week]
perbo verdict <review> --endorse|--override <stop key> [--note "..."] [--replace]
perbo verdict <review> --accept|--reject <finding key> [--note "..."] [--replace]
perbo verdict --list <change> [--json]
perbo principle add "a product answer no general practice can settle" [--repo .]
perbo principle list [--repo .]
perbo index --repo . [--json]
perbo inspect PRB-1 [--attempt <id>] [--json]
perbo inspect PRB-1 --verify <attempt id> [--json]
perbo baseline start "<title>" | pause | resume | stop [--pr <url>] | abandon | list
perbo baseline open | time | seal | run | routing | result --partner <id>
```

`doctor` answers "can this repository be materialized into a worktree at all", and fails with a
named reason **before** an attempt rather than during one (ADR-0025). Everything it checks is local
until `--probe`, which makes one minimal call at the configured reviewer model and says whether the
provider answers this machine: the round trip when it does, and which of authentication, unknown
model, network or rate limit refused it when it does not, with the fix for that one. The key is
never printed, whatever the provider echoes back, and a failed probe leaves the exit code where it
was unless `--publish`, or this checkout has a `.perbo/config.json` at all — a run configured here
reviews, and the review goes through that provider. Then the exit is non-zero and the block says
why, naming the file and the keys in it the reviewer was read from, or saying that it names none
and the review takes the default. `run` drives the whole loop:
provision, materialize, execute one agent under the permission profile, seal the change set, run the
pinned checks, review independently, route `remediable` findings back to the executor for a bounded
number of rounds, and with `--publish` open the pull request — which a human merges. `review` is the
review step on its own, with nothing behind it.

`review --pr owner/repo#412` (or its URL) reviews a pull request nobody admitted: `gh` reads the
title, body and both commits, the contract's outcome and criteria come from that body — reported
as absent rather than invented when it states none — and the verdict, findings and routing go to
the repository's own `.perbo/reviews`. `--head <ref> --base <ref>` does the same for two local
refs, where the contract is typed instead as `--outcome` with any number of `--criterion`; both
forms record which of the two the contract came from, and neither writes anything to GitHub. A
pull request opened from a fork has its head commit in the fork, so the head repository `gh`
reports is where that commit is fetched from, and a fork that cannot answer for it is named in a
refusal before a reviewer is built; the review target records the `head_repository` it read the
head from and whether that was a `fork` or the `same_repository` (SCP-211).

`interview` is where a piece of work starts. It runs your own session, in this checkout, oriented
with the bundled grilling and domain-modelling skills, to question you until the intent is sharp and
write it down: `specs/<slug>/spec.md`, with any terms in `CONTEXT.md` and any decision that crosses
components as an ADR. `--provider claude` runs Claude Code through the Claude Agent SDK and
`--provider codex` runs Codex through `codex app-server`; the interview's rules are the same behind
either. It reads anything and runs read-only commands; that spec's own folder, `CONTEXT.md` and the
ADR folder are the only places it may write, and a write outside them is refused rather than put to
you — there are no permission prompts, and a refusal is streamed and printed with the rule that
refused it. Its `generate_plan` tool drafts one ticket from the spec once you have written it,
re-drafting that ticket rather than admitting a second; `edit_plan` and `undo_edit` change the plan
afterwards through the same validated path `edit --graph-edit` uses, recorded as the interview's and
undoable; `read_plan` reads it back; `ask_options` puts what it cannot settle itself to you as groups
of questions with the answers to pick from, and returns rather than waiting, so your pick arrives as
an ordinary turn in the option's own words. It cannot approve, publish or merge: there is no tool for
any of the three. Your turns arrive as JSON lines on stdin and every event leaves as one on stdout, so a
host can relay it; the session id is printed and kept in `.interview.json` beside the spec, and
`--session <id>` continues the conversation — the SDK's own session on Claude, and the app server's
thread resume on Codex. On Codex the session runs on your login and none of the rest of your Codex
configuration, because a tool server or an approval rule in it would decide a call before the
interview's rules were consulted, and every approval the app server asks for is answered by those
rules; anything it asks that they do not admit, an escalation for the rest of the session included,
is refused. On Claude the session runs your own Claude Code, the `claude` on `PATH` outside the
repository, through the Claude Agent SDK, which is installed beside the binary rather than bundled
into it; without either, the command says what to install and starts nothing.

`admit` creates a native ticket and its contract in `plan_review`, from a typed outcome, criteria
and scope, or — with `--from owner/repo#412` or `--from-file issue.md` — from a model's draft of the
issue. `edit` opens that
contract before approval; `approve` freezes it; `list` projects the local ticket store; and `sync`
reconciles one ticket with its pull request through local `git` and `gh` — including walking a
`failed` ticket to `pr_open` and on to `merged` when its branch carries one, marked a hand-off only
when the ticket's own delivery record has never seen that pull request, and walking a `pr_open`
ticket to `closed` when its pull request closed without merging, or to `changes_requested` where
that pull request carries a D-073 CHANGES REQUESTED verdict. `perbo sync` with no key does the
same read for work nobody admitted: every local run in the store, one pull request each, with the
merge, the close, the D-073 review verdicts and the checks its head reported written onto the run
record `perbo run` keeps about itself, so `escapes` and `stops` count a local run's merge wherever
they count it off a change's own record. Two records under `<store>/state` are not written, both
because each is keyed by a `ticket_key` a run has none of: the escape *window*, so a merged run
reads `not observed` under `escapes` and each sync says so rather than leaving it to be noticed;
and the *stop verdicts*, so the boxes ticked on a run's pull request are printed by `sync` and not
filed, leaving the run in the populations `stops` reads off a change record — unattended merges,
cost per merged change, loop merges — and out of the precision of stopping, which is read from
those files. One run the sweep could not read is
named and stepped over, and it ends with how many it read. A store that also holds tickets says how
many that sweep did not read; those are still synced one key at a time. A repository with no
`.perbo` directory, or one holding neither runs nor tickets, says so in one line and exits 0.
`principle add` records a
product answer that general practice could not settle, and `principle list` prints those answers.

`index` builds this repository's exported symbols and its import graph with TypeScript's own
parser and writes them to `<repo>/.perbo/index.json`. No type checker runs, nothing is sent
anywhere, and no code is edited: the record is names, kinds, lines and paths, and holds no line of
the source it read. It reads the tracked `.ts .tsx .mts .cts .js .jsx .mjs .cjs` files — never
`node_modules`, `dist` or the store — and a file over a megabyte, a symbolic link, or one carrying a
name the record cannot hold is listed as skipped rather than dropped, because a name the index does
not hold reads to everything downstream as a name that no longer exists. A relative specifier resolves by the extension and `index.*` rules the code itself
uses, so a `.js` written for a `.ts` file lands on the `.ts`; a workspace package name resolves
through the entry its own manifest declares, or through its `src/index.*` where that entry is a
build output no checkout carries; anything else is external. The summary goes to stdout and
`--json` prints the record. A repository with no tracked TypeScript or JavaScript is told so, and
named by the extensions it does carry, and no index is written — exit 0 either way, because
neither answer is a failure. Nothing keeps the file current: it carries the commit it was built
at and whether the tracked files were that commit's or carried uncommitted changes, and
rebuilding it is this command. The stale-spec check is what reads it, and believes it only at
this checkout's commit with nothing uncommitted either side — when it records what a spec names as
well as when it judges a spec against that record. `perbo approve` is what records it, and an index
it cannot believe at that moment contributes no `@Symbol` at all: that ticket's spec is never stale
for a symbol again, for the life of the ticket. The record says that happened, so every later
reading of the ticket reports those names as not judged and sends you back here — but nothing after
approval puts the baseline back. **Commit what you are carrying and rebuild the index before you
approve.**

## Admit, edit, approve

**The model drafts; the person approves.** `perbo admit --from owner/repo#412` reads the issue
through local `gh`, hands its title and body to a model as delimited `trust="external"` data
alongside the repository's tree, and takes back a constrained draft: one outcome, the criteria
the work has, each with an assertion and a kind, a proposed scope of one to eight globs, a
rationale and, where the work divides, the nodes and edges of an execution graph
(`@perbo/planning`, prompt `draft_v4`). The draft is written beside the ticket as
`<KEY>.draft.json` with the model, provider, tokens and cost that produced it, and the contract is
created in `plan_review`. **A draft is never executed; only an approved contract is.** The person's
`approve` is the authority boundary under ADR-0023 §4 — a scope glob a model proposed becomes an
action parameter only after a human has confirmed it. `--outcome`, `--criterion` and `--path`
given with `--from` override the draft's corresponding part; without `--from`, admission calls no
model and every part is typed.

**Work that never reached a tracker.** `perbo admit --from-file issue.md` drafts the same way from
a Markdown file — the first line is the title, the rest is the body — for a bug reported in a
message or a note somebody wrote down. It takes the same path through the model as `--from`: the
same prompt, the same `trust="external"` block, the same constrained draft, the same candidate in
`plan_review` that nobody has approved. The two flags are mutually exclusive, because one contract
is drafted from one issue and picking a winner would give the ticket the other's provenance. A file
is external text, not trusted text: the ticket records the path as its source — resolved, so it
still names that file wherever `inspect` is later run — and every line of the file that claims the
work is already done or that addresses the drafter is quoted back on the draft at the line number
the file has it on, flagged for the person and never acted on. A body carrying more of those than
the draft lists is reported by its full count, with the listing saying how many it left out.

**Work that has a spec.** `perbo admit --from-spec specs/<slug>/spec.md` drafts from a spec folder
in the repository (D-103): the same prompt and the same `trust="external"` block as an issue, with
two things a spec adds. Its requirement ids are the only ones a criterion may cite, and a draft
citing one the spec does not carry is refused; its No-Gos are read from the `## No-Gos` heading and
never drafted. The ticket records the spec's repository-relative path and the SHA-256 of the bytes
the drafter saw, and beside them every file the loop commits with the spec, each with its own
hash: the spec's whole folder but for the interview's session record, and the `CONTEXT.md` and the
files under the ADR folder that the checkout has changed since its last commit. A spec lives in a
folder of its own under the spec folder, because that folder is what is recorded and committed, and
one named anywhere else is refused before a model is asked anything. The ADR folder is `docs/adr` unless
`.perbo/config.json` names another under `adr`. A spec outside the repository is refused before a
model is asked anything.

The folder is `specs` unless `.perbo/config.json` names another under `specs`, and it is off
limits to the executor: a write under it is refused as `write_prohibited_path` before it happens,
whether or not the contract names it, with the reviewer's `scope.prohibited_path` behind that. Only
`spec.md` is drafted from; a supporting file may sit beside it and is never read. Beside it,
`specs/<slug>/nodes/<node>.md` is generated from the spec and the graph for each node of the plan —
its title, the requirements derived to it, its criteria and their verification, its paths and the
spec's No-Gos. Admission and every edit that moves the contract or the graph rewrite those pages and
remove the page of a node the plan no longer has; the desktop rewrites them when the spec itself is
saved. A `## Notes` section written in one by hand is kept.

A run puts those recorded files on the ticket's branch as its first commit past the contract's
base, before the executor is invoked, and refuses the run naming the file where one of them has
changed or gone since approval. The change set the checks, the review, the verification and the
pull request read leaves every file that commit holds out, so the review reads the diff after the
spec while the pull request carries it.

**Starting over from the spec.** `perbo admit --from-spec <path> --start-over PRB-1` drafts that
ticket's plan again: the same key, `ticket_id` and `plan_id`, a new plan version, and the drafted
graph, criteria and scope replacing what stood, so the graph edits made since the last draft go with
them. The spec's edits and its No-Gos survive because they are in the file. The replaced edits stay
in `PRB-1.draft.json` marked replaced — they stop counting towards `edit_count`, and `--undo` cannot
reach across the re-draft. It admits no other ticket, refuses a ticket that is not in `plan_review`,
and, like every other drafting flag, cannot approve in the same command.

**Level is derived, not chosen.** `derivePlannedRisk` over the declared scope sets the level: one
package and nothing sensitive is P1; several packages, or a path under `auth`, `billing`,
`secrets`, a migration, a dependency manifest or configuration is P2; `.github/**`, `infra/**` or
a policy path is P3. `--level` may raise the derivation and is refused when it would lower it
(D-010). A P2 contract's added fields are derived from the scope; a P3 contract's decision fields
— named approver, alternatives, contingency — are a person's, and `approve` refuses one that still
says `not yet stated` until `perbo edit` states them. The ticket records `level_source` and
`derived_level`.

**Criteria say how they are proven.** `--criterion "text :: assertion :: kind"` sets the kind:
`test` when left out, or `artifact`, `query`, `metric`, or `manual` with `--manual-reviewer` and
`--manual-reason`. A documentation or decision ticket is admitted with `artifact` criteria and a
`docs/**` scope; nothing in admission assumes the proof is code.

**Edit before approval.** `perbo edit PRB-1` opens `PRB-1.contract.json` in `$VISUAL` or
`$EDITOR` by argv and re-validates it on return: a contract that no longer parses is refused with
its issues listed and the file left as edited, so the person fixes their text rather than losing
it. `--outcome`, `--criterion` and `--path` edit without an editor, each replacing the whole of its
part. After either, the level is derived again from the new scope — never lower than the
derivation — and the context manifest hash is recomputed. An approved contract is immutable
(ADR-0016) and `edit` refuses it. A plan's execution graph changes only through `--graph-edit`
(D-100): the editor refuses a change to `nodes`, `--criterion` is refused on a plan with a
graph, and `--path` is refused where it would leave a node's paths outside the scope.

**`edit` is the only way to change a contract.** `admit` and `edit` write `PRB-1.contract.json` and
the copy in `PRB-1.draft.json` together — nothing else writes either — and `approve` compares them:
any difference — the outcome, a criterion, a scope glob, or a field nobody types — is refused, with
every differing field named by its path and the person sent to `perbo edit`. A counter-seal that is
missing or does not parse is refused the same way, so the check is not one a `rm` opts out of.
Nothing was shown to anybody, so nothing is counted as an edit and no attempt starts; running `edit`
rewrites both files, re-derives the level and records what changed. `perbo run --ticket` checks the
pair again before it binds an attempt — an approved contract is immutable, so the way back there is
the file the pair came from, not an edit.

The requirement follows the ticket: `admission.counter_sealed_at` records when the pair was last
written together, and a ticket that has none — one admitted before counter-seals — is neither
required to have one nor compared against it. Its first `perbo edit` seals it from then on.

**Admission is instrumented (D-003, ADR-0027).** `admission.elapsed_ms` is the command's own
runtime. `approve` adds `human_elapsed_ms`, the wall clock from the contract first being rendered
to its approval, and `edit_count`, the number of fields `perbo edit` changed between the contract
as first rendered and the one approved — outcome, each criterion added, removed or reworded, each
scope glob added or removed, each counted once however many edits touched it. A ticket with no
draft snapshot beside it has no edits to read, and reports them as unknown.

Every stop the pull-request body lists — a `blocks` or `escalates` finding, or one the executor
declined for a person — carries two task-list boxes: *I wanted to be asked before this was fixed* and
*The agent should have fixed this on its own*. Ticking one in the GitHub UI is the whole of scoring.
`sync` reads the ticks back (an HTML comment keys each box to its finding, so a reworded body still
counts) and writes `<store>/state/<ticket_id>.stops.json`, whole, every time; `stops` reports precision
of stopping over those files — endorsed / (endorsed + overridden), by change, with a 95% Wilson
interval — and never without the companion D-060 makes mandatory: the share of changes that reached
a person, one with a pull request or one answered here with `verdict`, on which they were shown
anything at all. `--since <ISO date>` compares both against the changes first seen before it and
warns when precision rose while the companion fell. `--by-week` adds, beside that total and in the
same columns, one row per ISO-8601 week from the since date through the current week — a week
nothing fell in reads `n=0` rather than going missing — and runs the same widening test between each
consecutive pair, naming the pair it read. Under `--json` the weeks are an array keyed by ISO week
label, `2026-W01` for the week that starts 29 December 2025.

Under the table, that precision is read against the bar it exists for: **≥70% with the 95% Wilson
interval wholly on one side of it**, at live `n`. Nine unanimous endorsed stops is the smallest
population whose lower bound can clear 70%, so below one that could resolve a pass the line reads
`CANNOT RESOLVE` and prints no verdict — the two numbers are still there; what cannot resolve is the
reading, not the sample. An interval that spans 70% is a `FAIL`, and says it spans rather than
resolving below. Every number reported here as a partner reading leaves out the stops an AI stand-in
answered (D-058): a stand-in signs its tick, or answers with `verdict --stand-in`, and those answers
are **dogfood** — counted in the `dogfood stops excluded` row, in the per-week column of the same
name, and beside the before-window figures `--since` prints, so an `n` that shrank always says why.
Because the label is self-declared, it can be wrong both ways, and the line under the verdict says
so wherever the label had anything to say. An unsigned tick counts as a person's, so `n` is an upper
bound on the answers a person gave rather than a guarantee; and the signature is text in a
pull-request body, so whoever can edit the body can sign ticks *out* of the partner population —
enough of them and `CANNOT RESOLVE` stands where a `FAIL` was available, the overriding ones and
what is left passes. Where the verdict would have read differently with the excluded answers pooled
back in, the line says that too — with the `n` that population would have carried and the verdict it
would have read, labelled as no partner reading. A stop already recorded as the
stand-in's is taken back by saying so: an `perbo:answered-by who=person` comment on the ticked
line, or the same answer through `verdict` without `--stand-in`.

Beside precision of stopping, `stops` prints D-076's own number: **unattended merges**, of the
tickets that merged, the share that merged from a pull request the loop opened with every commit on
it carrying the loop's own attempt trailer — no commit from outside it — with the same 95% Wilson
interval and `n`. Whether the loop opened the pull request is `delivery.opened_by` (SCP-173/176);
whether a person's commit reached it anyway is read at `sync` time from `gh pr view --json commits`,
one commit at a time, from **the message alone** — never from who git records as the author, because
the loop pushes under a credential that can read as a person's and a merge-up or seal commit it made
carries its attempt id in the message regardless. The bar proposed: at least 80% of 20 consecutive
tickets merge unattended (D-076, awaiting the founder's confirmation). Beside the share, the cost per
merged ticket — all runs, priced rows only, unpriced attempts counted and named — the same roll
`inspect` shows for one ticket, summed. `--since` bounds this population too, by when each ticket's
own history says it merged.

`verdict` is the same answer taken here rather than on the pull request (SCP-181), for the times
there is no pull request yet, no `gh` credential, or no reason to leave the terminal.
`perbo verdict <review> --endorse|--override <stop key>` answers a stop exactly as the two boxes
do, and `--accept|--reject <finding key>` judges any finding, stop or not. `<review>` is a ticket
key, a pull request — url or number — or a review id, and the key is a finding key, whole or by any
prefix that names one finding: **the same key the checkbox carries**, so a stop answered either way
is one decision about one finding. The row goes to `<store>/verdicts.json` with who took it, when
and the note; nothing leaves the machine and nothing on the network is asked. Who took it is this
repository's own `git config user.name` and `user.email` — the two lines git already asks every
contributor for, carried on the row as `decided_by`, with no account and no token anywhere in it —
or `--author` where you are recording somebody else's decision. Where the repository names neither
and `--author` is absent, nothing is written and the two lines to set are printed: a record that
names nobody is not evidence of who decided. `stops` and `escapes` print the author beside each
decision that carries one, and a row written before the field existed keeps being read exactly as
it was. `stops` counts it beside the answers read off pull requests — the local record fills in a
stop nobody ticked, and where both exist the later answer stands — and `inspect` prints it beside
its finding. A key that already carries a decision is refused without `--replace`; with it, the
earlier decision is superseded on the record rather than overwritten, because "we changed our mind"
is part of what the file is for.

`perbo verdict --list <change>` reads that record back: every decision recorded for one change —
the finding key, the decision, who decided and when — newest first, a superseded row kept and
marked, and `no decisions recorded` where none were taken. Who decided is the `decided_by` pair the
row carries, and `not recorded` where it carries none, rather than the `author` line dressed up as
one. `--json` prints the rows as `<store>/verdicts.json` holds them, narrowed to that change.

## List

`list` prints the local ticket store as a table — key, state, outcome, priority and source — showing
active work by default and everything with `--all`. The count line, and the advice when nothing is
admitted, go to `stderr`; with `--json` the count is in the document's `counts` and no count line
is printed.

`--json` prints the same listing, under the same filter, as **one JSON document on `stdout` and
nothing else**: no table, no headings, no colour. The shape is an object —
`schema_version`, `store`, `filter`, `counts` and `tickets` — whose entries are the stored ticket
records verbatim, state and full transition history included, and it is written down in
[`docs/design/list-json.md`](../../docs/design/list-json.md) rather than left to be discovered by
parsing. An empty store is a document with an empty `tickets` array, not empty stdout, and both modes
exit `0`.

```bash
perbo list --json | jq -r '.tickets[] | select(.state == "pr_open") | .key'
```

These commands need no Perbo account, database or service. `review` is the
same code path the seeded-defect corpus is scored through — corpus runs and real runs are the same
program. `perbo --version` reads the version from [`package.json`](package.json), which is the only
CLI release-version source.

## Doctor

`doctor` answers three questions before a ticket is run, in the order they would otherwise fail,
and prints what judges an attempt in this store — and what would score the reviewer — alongside
them.

**The machine.** `preflight()` from the runner checks node, git, the binary a worktree is installed
with (spawned without a shell, as the install is; none where the checkout installs nothing), the
coding agent binary and the reviewer transport the repository's `.perbo/config.json` names (or
the defaults it will get), and
`gh` on every run: a `gh` that is not on PATH is reported whatever the run does — as a warning when
the run will not publish, since `sync`, `stops` and the next `--publish` all need it, and as a
blocking finding when it will. Only a run that will publish — `--publish`, or a store whose
`config.json` sets `publish` — asks `gh auth status`, because that is a network round-trip; a run
that does not publish is told about a missing binary and nothing else.
Every finding carries the one command that clears it. `run` performs the same check before it
provisions anything: a blocking finding prints and exits `3` with the ticket untouched, where it
used to surface as an `ENOENT` stack trace with the ticket left in `provisioning`.

**The repository.** The ADR-0025 materialisation diagnostic: the package manager the lockfile
implies, the untracked files a fresh worktree would need, the command that proves the thing runs,
and a named refusal where a worktree of it cannot be materialized at all.

**A repository with no lockfile.** Not a refusal. The manifest names the package manager where no
lockfile does, and the install proposed — and written — is the one that manager can run without
one: for pnpm, `pnpm install --prefer-offline --ignore-scripts`, which is the frozen form
(`pnpm install --frozen-lockfile --prefer-offline --ignore-scripts`) without the flag that needs a
lockfile. The same run says the install is unpinned, names the file whose absence is the reason
(`(unpinned: no pnpm-lock.yaml)`), and carries a `lockfile_missing` advisory naming
`pnpm install --lockfile-only` as what writes it. It writes no lockfile into the worktree, because
the runner's install is not the executor's work and a file it leaves behind is sealed into the
attempt as though it were. A `doctor` on a configuration already written reads its install back
against the checkout — `consistent with this checkout` while it still is, and an
`install_could_pin` advisory naming the frozen form from the moment the repository commits a
lockfile the file predates, since `doctor` never rewrites a `config.json` that exists.

**A repository with no test script a worktree can run.** Not a refusal either
([D-013](../../docs/11-open-decisions.md)). A package that declares no test script, a project whose
package manager this build does not install with, such as uv, a lockfile with no `package.json`
beside it (for pnpm, no `pnpm-workspace.yaml` either), and a package whose every test script starts a service are each materialized and verified
with `git status --porcelain`, with an advisory naming which (`no_verification_command`,
`unsupported_package_manager`, `package_manifest_missing` or `verification_requires_service`), so an
attempt there is judged by the review and whichever checks are pinned, and its base counts as
unmeasured. Where nothing is installed, no scripts are read either, as for a checkout that names no
manager (`package_manager_undetected`). A test script that starts a service is neither the
verification nor a proposed check; `test:unit` is tried after `test` for both. `doctor
--write-config` pins that manifest, and a `doctor` on it afterwards says `verify_outgrown` where the
package declares a test script the pinned manifest does not run, carrying `install_could_pin` where
that has moved too, and `install_outgrown` once the repository names a manager this build installs
with and has something for it to install.

**A repository that is one package of a monorepo.** Two roots, and the report names both: a
`CHECKOUT` line for the package the run was pointed at and a `WORKSPACE` line for the workspace
above it, said only when they differ. The package is what the outcome is about, so the checks come
from *its* `package.json` — `packages/web`'s `test`, not the root's `turbo run test`, which would
run every package. The install is the workspace's business, because that is where the lockfile is
and where the manager resolves the member graph from: it runs at the workspace root with the
package filtered (`--filter` for pnpm and bun, `--workspace` for npm), and the
install line names that directory. Yarn has no per-member install that a `yarn.lock` distinguishes
the major version for, so a yarn workspace installs whole — a superset of what the package needs.
The manager is read at the workspace root too: a member of a pnpm monorepo has no lockfile of its
own, and answering `npm` for it proposed an install resolving a different dependency graph from
the one the repository runs. A directory the workspace does not *list* is not a member — the
manager matches its `packages`/`workspaces` globs, and a scratch directory that merely sits below a
monorepo is its own checkout. That directory has to be one an attempt can reach: a worktree is a
checkout of the repository it was made from, so where the workspace root sits *above* that
repository — a package that is its own Git checkout inside somebody's monorepo — the filtered
install has no workspace root to run in, and materialization refuses it by name
(`install_root_outside_worktree`) rather than running the command somewhere it would mean something
else. Point the run at a checkout that contains its own workspace root. The verification is carried
across the same way and in the other direction: it was read from the package's own scripts, so it
runs at the package's directory inside the worktree — `pnpm run test` at the worktree root of a
monorepo is the root's script of that name, which is a different suite from the one the derivation
named.

**The ceilings.** The effective limits table — `DEFAULT_LIMITS` overlaid by the config's `limits`
block, which is exactly what the runner enforces — and every attempt on record under
`.perbo/state/*.attempts.json` that stalled or terminated on a ceiling, naming the ticket, the
resource, the value reached and the key that raises it (`limits.limits.<name>`). The table marks
each row `default`, `per-token default` for the two cost keys that bind only an executor billed per
token, `config` where the repository set one, and `not set` where nothing bounds the resource at all
([D-096](../../docs/11-open-decisions.md)). The dogfood run hit `attempt_iterations` at 61 against 60
twice before anyone could see what the ceiling was; `run` now prints the same one-line summary on
stderr before it provisions anything.

**What judges.** The `JUDGING` block names every path that judges an attempt in this store, each
against the key it came from: `.perbo/**`, which the runner refuses every write to, under `store`,
then each entry of `protected_paths` and each entry of `protected_tests` in the store's
`config.json`, under its own key, then the `definition_path` of every check the same `config.json`
pins, under `checks[<check_id>].definition_path` — the runner seals a write to one of those as
`modify_judging_artifact`, so approval refuses a scope that reaches it and the refusal names the
check (`scripts/** overlaps protected scripts/validate_docs.py
(checks[check_docs].definition_path)`). One file two checks are run from is one entry naming both,
`checks[check_typecheck,check_unit].definition_path`. An approved scope may not overlap any of
them, and before this block the only way to learn the list was to write a scope and be refused at
approval. Both config keys are named even when they contribute no path — `(unset)` where the store does not set the key
at all (including a store with no `config.json`, which reports `.perbo/**` alone and does not
error), `(none)` where it sets the key and the key lists nothing new, since an empty list is a
decision and a missing key is not. `checks` has no such entry: a check pins a definition or it does
not, and a store that pins none is judging by nothing it has left undeclared. `--json` emits the same entries under `judging_paths`, one
object per line of the block, with `path` (`null` for a key that contributes none), `source` and
`set`. It is the same reader approval refuses a scope with, so the list is what a scope will
actually be checked against.

**The corpus.** One `CORPUS` line for the cache at `.local/corpus-cache`, which is what the
regression suite scores the reviewer against and is cloned rather than checked in. `absent` where
there is no directory or it holds no fixtures; otherwise the commit the cache records in its own
`corpus-pin.json` and the number of fixture directories it holds; `behind` where that commit and
the one `.github/regression-score.json` was measured against are different, naming both. Absent and behind name
`perbo-corpus prepare` as the fix. A cache that records no commit is not evidence of divergence and
is not reported as behind — it is reported as present, saying it records none. `--json` emits the
same reading under `corpus_cache`, with `state`, `cached_commit`, `scored_commit`, `fixtures` and
`fix`. It is a warning in every state: the corpus is what scores the reviewer, not what runs an
attempt, so it never moves the exit code.

A checkout with no `.perbo/config.json` is shown a proposed one — checks from the scripts
`package.json` declares, the materialisation manifest the diagnostic proposed with a portable
`source_checkout`, and every default limit written out so each has a key to raise.
`--write-config` writes it. It never overwrites a file that exists.

Exit `0` means materializable and the machine is ready; `1` means one of them is not.

## Inspect

`inspect PRB-1` reads a ticket's attempts back (dogfood limitation 5: every attempt wrote an
immutable bundle and nothing read one). It joins `.perbo/state/<ticket_id>.attempts.json` to the
bundle store — the execution bundle by attempt id, the one independent review by the change set it
judged, each round's closure verification by its `cv_<attempt>` subject — and renders, per attempt:
its outcome, then the stop reason and where it stopped for an attempt that stopped, then what it
cost, and only after those the bundle the work is in, when it started and ended, the agent model
and binary version, how many times the brief was given back after a compaction where any was
([D-096](../../docs/11-open-decisions.md)), the stall window,
iterations, commands, wall clock, tokens and cost **against their ceilings** (`iterations 61 / 60 —
ceiling hit`, using the ceiling in force when it was hit rather than the one in the file today, and
`no ceiling` where nothing bounds one), the
checks — the whole-change results, then each node's under its node id with the paths its run was
narrowed to, or the reason it was not ([D-107](../../docs/11-open-decisions.md)) — the review
decision and every finding with its rule, routing, location and statement as persisted,
closure verification per round, the executor's declines, and the pull request — marked
`(handed off — a person opened it, not the loop)` when the last row that walked the ticket to
`pr_open` recorded itself as a hand-off. It is read off that record and not off the
`failed -> pr_open` transition, which a hand-off shares with the loop's own pull request found again
on the branch of a re-run that failed. A `failed` ticket still shows the pull request an earlier
round published, because a run that opened none said nothing about the one that is still open; the
delivery record's `observed_at` dates it at the round that saw it.

The record is appended to, never replaced, so a ticket that has been run more than once has every
run's attempts on it — including a run a ceiling cut short. Attempts are listed in the order they
were made, each labelled `run N · round M`: the run is the ticket's own run count, and attempts
sharing a root attempt id are one run whatever their remediation rounds. Attempts carrying no root
at all are one run together: a record written before attempts had roots was replaced by each run
rather than appended to, so what such a record holds is the one run that wrote it. A re-run's first
attempt records `continues_attempt_id` naming the previous run's last, so the chain a reader
follows crosses runs.

Above the attempts it prints the ticket's admission record — how the criteria arrived and how
many there were, the person's own time from first rendering to approval in seconds, minutes or
hours (the unit follows the rounded value, so 59_999 ms reads `1.0 minute`, never `60.0 seconds`),
how many fields they edited, and the level the scope derived to with the source of that level.
A measurement the record does not carry reads `not recorded`, never `0`.

A cost whose basis is `unavailable` is printed as `unavailable`, on the attempt's own `cost` line
and against the cost ceiling. It is never `$0.0000`.

`--attempt <id>` narrows to one attempt and adds the bundle's object listing — names, sizes,
whether the bytes were retained — and the change set's file list. `--json`, or a piped stdout,
emits the same report as JSON, with the admission record verbatim under `admission` and each
attempt's own record verbatim under `record` — the `ExecutionAttempt` as the loop wrote it, in its
own shape, so a script reads what a person reads without opening the attempts file itself. A ticket that has never run says so in one sentence. Nothing here
writes.

`--verify <attempt id>` checks the record rather than reading it. A bundle is content-addressed —
every artifact is stored under `sha256(bytes)` and the manifest carries the hash — and until this
nothing ever recomputed one, so the record was trusted exactly as far as the file system was.
`--verify` re-hashes every object that attempt's bundles name and prints `verified: n objects`,
exit 0. An object whose bytes are not what the bundle names is a **mismatch**, printed with the
expected hash and the found one; an object the manifest names, says was retained, and the store
does not hold is **missing** — deliberately a different word, because one is corruption and the
other is absence and a person acts differently on each. Either exits 2. An artifact the bundle
itself records as `retained: false` is neither: the store never held those bytes and says so, so it
is named and does not fail the check. A store that holds no bundle for the attempt at all is not a
pass either — there is nothing to stand behind, and `verified` over an empty set is a green light
for a record nobody checked. It takes the attempt id itself and so is refused beside `--attempt`,
which would be the same question answered twice. The check constructs no bundle store, opens the
manifests and the objects for reading, and writes nothing at all — not even a directory.

```bash
perbo inspect PRB-1 --verify att_0f3c9a12b4d6e8f0
```

## Where a run publishes

A run opens its pull request against one branch and names it before it starts: its first lines carry `base <ref> — <source>`, and `perbo inspect` prints `base <ref> (<source>)` beside the pull request. The source is one of three:

- **branch**: the branch this checkout is on.
- **config**: a `base_ref` in `.perbo/config.json`, or in the file `--config` names. It beats both derivations, and the configuration `perbo doctor --write-config` writes pins the derived one.
- **remote default**: for a checkout on no branch, the branch `refs/remotes/origin/HEAD` names, or, when the run publishes, GitHub's default branch where that ref is absent.

Where none of them names a branch, the run refuses with `base_ref_unknown` before anything is provisioned, and names the `config.json` to set `base_ref` in. A `base_ref` that is not a branch name is refused too, with the file and the value quoted back.

## Baseline

`baseline` is the D-038 stopwatch: the partner's direct-agent wall clock from "start work" to
"pull request opened", pauses excluded, kept in `<repo>/.perbo/baseline.json`. It has to be
captured **before** the first ticket goes through the loop and it cannot be reconstructed
afterwards, so `start` looks for admitted tickets and, finding one, records
`captured_before_first_use: false` rather than refusing — a late number is still a number, it is
just not the one the comparison wants.

```bash
perbo baseline start "Paginate search" --ref acme/api#412
perbo baseline pause          # lunch, a meeting: excluded from the reading
perbo baseline resume
perbo baseline stop --pr https://github.com/acme/api/pull/418
perbo baseline abandon --reason "blocked on a design question"
perbo baseline list [--json]
```

One entry is open at a time; `start` while one is open refuses and names it. `list` prints the
count, the median and p90 of completed entries, and warns until there are ten of them, which is
where D-038 takes its median.

## The E1 harness

Six more subcommands turn those readings into the comparison D-038 defines, in
`<repo>/.perbo/e1.json`.

```bash
perbo baseline open --partner acme --agreed-on 2026-08-25 \
  --agreed-with "Rae Okonkwo, engineering lead" --record https://acme.example/e1-agreement.pdf
perbo baseline time --partner acme --item ACME-412 --title "Paginate search" \
  --started 2026-08-26T09:00:00Z --opened 2026-08-26T11:30:00Z --interruptions 25
perbo baseline time --partner acme --from bl_9f2c1a0b7d34 --item ACME-413   # from the stopwatch
perbo baseline seal --partner acme                                          # ten, and no more
perbo baseline run --partner acme --item ACME-412 \
  --started 2026-09-14T09:00:00Z --opened 2026-09-14T10:05:00Z \
  --friction 12 --defect "the reset token stayed valid after use :: https://…/pull/9#r1"
perbo baseline routing --partner acme --period "weeks 3-4" --eligible 20 --voluntary 13
perbo baseline result [--partner acme] [--json]
```

The order is the point, and each step refuses what would make the number unfalsifiable:

- **thresholds before measurement.** `open` records the agreed pass bars and the date they were
  agreed; a reading that started before that date is refused, and the bars cannot be re-agreed once
  anything has been timed against them.
- **ten, then a seal.** A baseline is complete at exactly ten readings, each with a work-start, a
  pull-request-opened time and self-reported interruptions subtracted from the recorded wall clock.
  `seal` stores a digest of the ten; afterwards nothing may be added, and a reading edited underneath
  the seal makes the result `void` rather than quietly better.
- **no product run before the seal.** `run` refuses until the baseline is sealed, which is the one
  thing that cannot be recovered afterwards.
- **the ratio is the ten and nothing else.** A `run` for work outside the sealed ten is recorded and
  excluded, and says so. `--friction`, `--abandoned` and `--defect`, and the `routing` observations,
  are stored as their own fields and never move the ratio.
- **`--agent` is its own arm.** The AI stand-in's agent-direct baseline is reported in its own
  section, `counts_toward_e1: false`, and the cohort read raises rather than counting it.

`result` prints the ratio over the matched pairs, the same ratio through ticket 5 where the
learning curve is allowed 1.25×, every confounder, and a verdict of `pass`, `fail`, `incomplete`
(the measurement is not finished — an unobserved rate is not a zero) or `void`.

## Exit codes

| | |
|---|---|
| `0` | `approve` — and no other code means the gate passed |
| `1` | Usage or input error: bad flags, an unreadable contract, a verdict naming a `criterion_id` absent from the plan |
| `2` | `changes_requested`, `escalate` or `remediable` — the review completed and the gate is closed |
| `3` | `error` or `incomplete` — the review did not complete |

`2` and `3` are separate because they fail differently. A caller treating every non-zero code as
blocking is correct; a caller checking only for `2` merges changes whose review never ran.

The unknown-`criterion_id` case exits `1` rather than `3` even though the artifact says `error` — the
input was bad, so it is not a review outcome. The artifact is still emitted, so a pipeline that
captured stdout still has something to read.

## Streams

`stdout` carries the `ReviewArtifact` as JSON whenever it is piped and a human rendering when it is a
terminal; progress, warnings and diagnostics always go to `stderr`. `perbo review … > review.json`
therefore yields a valid artifact under every outcome, including `error`. `--json` forces JSON on a
terminal.

The human rendering is drawn in `docs/design` — `CliReview` and
`CliError`. It is readable at 80 columns and every distinction carries a textual mark as well as a
colour: `✓` `~` `!` `?` `✗` for verification strength and check status, `[BLOCK]` `(esc)` `(adv)`
`(waived)` for blocking, and `[FIX]` for a finding routed to the executor. A test asserts no line
exceeds 80 columns even when a finding tries.

## Resuming

A review that ends in `error` or `incomplete` writes what it did establish to `--state` (default
`.perbo/reviews`) and prints the command to continue:

```bash
perbo review --resume rev_01J8QM
```

That re-runs only the criteria the first attempt never reached, and merges the two — findings by
their stable key, so a criterion already settled is not paid for twice. A completed review leaves
nothing behind.

## Credentials

BYOK. The coding agent authenticates with the user's own credential and Perbo never reads, stores
or forwards it — every attempt records which class it used, and so far that is always
`subscription`, meaning Perbo saw no credential at all. The reviewer reads `ANTHROPIC_API_KEY` from
the environment where it uses the SDK transport. No key is written to a run bundle, a log, an
artifact or a fixture, and a test asserts it.

The **runner** holds the Git credential and performs the push and the pull-request creation itself.
The agent's environment is built from an allow-list, `gh` is on its deny list, and it never sees a
token.
