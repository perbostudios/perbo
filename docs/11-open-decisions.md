# Decision register

This is the one home for the decisions that govern Perbo. Every other document cites an entry by its id and does not restate it.

- The register holds only what is true now. When a decision changes, its entry is rewritten; when one is replaced, it is deleted. Git holds the history (D-111).
- Each entry states the decision and why it holds, and what would change it where that is known.
- A new entry is written on its branch as `D-NEW-<label>`, and `scripts/assign_ids.py` gives it the next number when the pull request merges (D-110). Numbers are never reused, so a gap is a deleted entry or a private one (D-076).
- The founder owns product decisions and the co-founder owns design and marketing decisions. Every entry names its owner.
- An architectural decision that crosses components also has an ADR in [`adr/`](adr/README.md), which records the architecture and cites the entry.
- A decision that is not built yet says so on a "Decided, not built" line, with what the system does until then. One built in part says which part on a "Built: … Not built: …" line instead, so that neither half is read as the whole.

## The product

### D-001 — Perbo is an open-source operating plane for getting work done

- Owner: Founder
- Decision: Perbo is an open-source operating plane for intuitively getting your work done, no matter the scale of work. It runs your coding agents (Claude Code, Codex) on your repository: each piece of work is one ticket, from a one-line fix to an epic planned as a graph, taken from an agreed contract to a reviewed pull request, and you see only what needs you.
- Why: in the founder's words, it gives an intuitive surface for building software the most capable way available, with agents, and reduces the person's cognitive effort as far as it can.
- Changes if: people use it for something other than getting work done through their agents.

### D-002 — Perbo is for developers who already work with coding agents

- Owner: Founder
- Decision: Perbo is for any developer already working with Claude Code or Codex, alone or on a team. Design partners are chosen by behaviour: the team uses a coding agent daily, merges at least twenty pull requests a month, and has someone who reviews everything.
- Why: the entry path is a name, an existing subscription and a checkout, and the product ships as open source.
- Changes if: the people who keep using it are a different group.

### D-088 — The loop is the product; review is its step

- Owner: Founder
- Decision: what a person runs is the loop. A ticket is admitted on their repository, taken by the executor to a change, judged by an independent reviewer, remediated on the branch until only what needs a person remains, and delivered as a pull request. `perbo review` is the loop's step and a command, not a product of its own. People can attach other reviewers: Perbo reads the reviews other tools leave on its pull requests and routes their findings like its own, and the person picks the model and provider for Perbo's own review.
- Why: in the founder's words, independent review of somebody else's pull request is what a tool like Bugbot is for, and Perbo produces a fully contained loop.
- Changes if: people run `perbo review` on its own far more than the loop.
- Decided, not built: reading other tools' reviews. Until then the loop reads only its own reviewer.

### D-016 — The control plane is the commercial product

- Owner: Founder
- Decision: the commercial product is the control plane, built on top of open-source Perbo. It starts with team memory: history across people and machines, a shared queue and board, calibration learned from verdicts, SSO, audit and retention. Operating modules come after, each chosen by paying users before it is built. Its design is recorded, decided and not built, and stays private (D-076).
- Why: what a team shares across people and machines is what it pays for; everything a person runs alone stays open (D-075).
- Changes if: paying users ask for something else first.

### D-075 — Everything that runs on one machine is open source

- Owner: Founder
- Decision: the open-source product is everything that runs on one machine: the desktop, the whole CLI, the queue and its endpoint, `perbo agent`, `perbo interview`, and phone pairing over the local network. Anything hosted or shared across people is the control plane (D-016). The code is Apache-2.0, and a contribution is under the same licence, with no contributor licence agreement. The corpus is public in [`plantedbugs`](https://github.com/lianmatsuo/plantedbugs), all of it from the public release, under Apache-2.0 for the fixture format and CC-BY-4.0 for the fixtures.
- Why: the line follows memory, not features. The reviewer's prompts are open because a reviewer nobody can read is one nobody will trust.
- Changes if: an open component turns out to need the hosted plane to work.
- ADR: [ADR-0032](adr/0032-open-source-the-local-cli-and-the-reviewer.md).

### D-076 — Perbo is developed in the public repository

- Owner: Founder
- Decision: `perbostudios/perbo` is where Perbo is developed: its branches, pull requests, issues and releases. Nothing in it is assembled from anywhere else. A private repository holds what stays private: the backlog of open work, whose entries the `SCP-` ids here name; the ticket store's records from before the release; the spend ledger and the dated evaluation records; the design boards and the planning-mode prototype until the co-founder agrees to publish them; and the control plane's design (D-016): its decisions and its eight ADRs. It is not synced from this repository. Ticket records a run writes under `.perbo/tickets/` stay on the machine that wrote them; `.perbo/config.json` is committed, and so is `.perbo/principles.md` once a person records one.
- Why: one repository is one source of truth, a checkout that holds nothing private cannot leak it, and real use is the evidence (D-099).
- Changes if: the private material has to change in step with the code.

### D-098 — The product is Perbo everywhere

- Owner: Founder
- Decision: the package scope is `@perbo/*`, the binary is `perbo`, the store is `.perbo/`, and environment variables are `PERBO_*`. Tickets take the key `PRB` unless `perbo admit --prefix` names another, and this repository's tickets all carry it; every new branch takes the prefix `prb/`, a ticket that already has a branch keeps it whatever its prefix, and a recorded branch or pull request keeps the name it has on GitHub. The reviewer's prompt delimiters carry the name.
- Why: one name across the desktop, the terminal, the store and the code means nothing needs translating between them, and in the founder's words, every instance is renamed.
- Changes if: a trademark or availability conflict.
- ADR: [ADR-0035](adr/0035-rename-the-product-to-focrux.md).

### D-099 — Perbo is judged by real use

- Owner: Founder
- Decision: Perbo is judged by how people use it. There are no pre-registered experiments on stand-in tickets. `perbo stops`, `perbo escapes` and the share of tickets merged unattended are read live from people's work. The regression suite stays as the check on any change to the reviewer (D-010).
- Why: experiments on stand-in tickets kept reopening what the product was; people's use answers it.
- Changes if: real use cannot answer a question the founder needs answered.

## Work and planning

### D-003 — Perbo owns admitted work

- Owner: Founder
- Decision: work enters Perbo one ticket at a time, by admission. Before admission the tracker is authoritative and Perbo holds only a reference. From admission Perbo is canonical for the ticket's intent, contract, state, review and outcome, and the tracker receives a one-way status projection. GitHub stays authoritative for refs, commits, pull requests and checks. No field is synced both ways, and no backlog migration is ever needed.
- Why: a product that does not own the ticket cannot own its contract, its dependencies or its order.
- Changes if: people routinely maintain the same ticket in both places.
- ADR: [ADR-0027](adr/0027-own-the-ticket-natively.md).
- Decided, not built: the status projection. Until then Perbo writes nothing to a tracker.

### D-072 — A model drafts the contract; approval is the authority boundary

- Owner: Founder
- Decision: `perbo admit --from owner/repo#N`, and the queue's tracker drafting, fetch the issue as external data and ask for a draft against a closed schema: an outcome, criteria with their verification kind, a proposed scope and a rationale. The drafter is shown the tickets in flight and may propose `depends_on` among them, and it may read up to eight small files through the reviewer's bounded reader. One draft is one contract is one ticket. Nothing runs from a draft: `perbo edit` changes any field, and `perbo approve` is the only step that produces the contract the runner reads. Admission records how long the person took and which fields they changed. The plan level is derived from the scope; a person may raise it and never lower it.
- Why: a scope a person read, could change, and approved is one they chose, whatever proposed it.
- Changes if: people approve drafts they did not read, seen as edit counts at zero while stops rise.

### D-071 — Initiative before authority

- Owner: Founder
- Decision: models may originate candidate work. The drafter, the queue's tracker drafting and the interview all draft, and nothing a model drafts becomes canonical until a person approves it. A standing rule may act only on work already admitted, and no model output triggers it or supplies its parameters. Product preference, security stops, external commitments, and legal or financial authority stay with people.
- Why: more initiative, not more sovereignty.
- Changes if: drafted work adds more coordination than it removes.

### D-100 — Large work is one ticket with an execution graph

- Owner: Founder
- Decision: a plan may group its acceptance criteria into nodes, each naming the paths expected to satisfy them. Node criteria and paths are contract; the order between nodes is approach, along with the spec's No-Gos. The drafter proposes the first graph. After that the plan changes only by edits, made by hand or asked for in the interview, through one validated edit path that records its author. Any edit can be undone unless a later edit changed the same node, edge or spec section. The person approves once. Any ticket may carry a graph, there is no epic kind, and the drafter does not cap the number of criteria.
- Why: approving several sibling contracts one at a time is the slicing a graph removes, and one ticket keeps one approval and one pull request.
- Changes if: people split graph tickets by hand to get them reviewed or merged.
- ADR: [ADR-0037](adr/0037-execution-graph.md).
- Built: the plan's `nodes`, the approach record beside the ticket, the drafter's graph, `perbo edit --graph-edit` and `--undo`, the graph in `perbo inspect`, the pinned checks and the review per node (D-107), and the desktop's Graph pane, which curates the graph through that same edit path, confirms it to the contract where it is approved once, and stays live while the work runs: each node's state derived from the sealed change set, the pinned checks narrowed to that node and the evidence bindings of the review of the plan the ticket now carries, less whatever the rounds since it verified closed, with every changed path no node's globs match shown as outside. Nothing there is read from the executor's account of itself ([ADR-0023](adr/0023-untrusted-context-boundary.md)).

### D-101 — Create opens planning mode

- Owner: Founder
- Decision: Create moves into the desktop's rail, first (⌘1; Home ⌘2, Archive ⌘3, Settings ⌘4; ⌘N still creates). It opens planning mode for one piece of work: Spec, Explorer and Impact panes, with a Graph pane second, under Spec, once a plan has been drafted and divided into nodes; the interview is docked beside them. Planning mode also opens for any ticket in `plan_review`. Drafting, impact checks, file reads and the interview run alongside a run; runs, decisions and publishing still take one at a time.
- Why: planning the next piece of work while the last one runs is what the queue is for.
- Built: Create first in the rail with ⌘1 to ⌘4, the picker, planning mode over a contract editing session whose Spec pane holds the spec ([D-103](#d-103--a-spec-is-a-folder-in-the-repository-committed-first)) and the contract steps under it, with the Explorer and Graph panes beside it and the interview docked beside whichever is open, and planning alongside a run; the explorer's reads and the interview's three requests are answered outside the job list, so a run never holds one up, the picker opens planning mode over a ticket in `plan_review`; and the Impact pane, asked for by a button because its answer is a fresh index of the whole tracked tree, answered outside the job list with the explorer's reads.

### D-102 — The interview is the person's own session

- Owner: Founder
- Decision: the interview is the person's own Claude Code or Codex session, run by `perbo interview` and shown as a chat in planning mode. Its Generate plan action brings the spec up to date and runs the drafter, admitting one ticket. After that it changes the plan only through the validated edit path, every edit recorded and the latest one undoable as D-100 says. The chat reports what is said nowhere else — the drafting, an undo, a refusal, and the edit an undo is still offered on — and not a call that only repeated itself, because what an edit changed is on the graph and a panel for each of fourteen buries the conversation they were asked for in. It may read anything and run read-only commands, may write only the spec folder, `CONTEXT.md` and the ADR folder, and cannot approve, publish or merge. Anything outside that is refused rather than asked: there are no permission prompts. Asking the person about the work is a different act and is what the interview is for: it may put questions with the answers to pick from, which become the person's own words when they pick one and never a way to allow something (D-117). It proposes no path marks, which are the person's own. Claude runs through the Claude Agent SDK and Codex through `codex app-server`. Paseo's design is followed in Perbo's own code; none of Paseo's code is copied.
- Why: a person's own session gets the same trust model the endpoint gives it (D-109).
- Built: `perbo interview`, which runs the person's own session — Claude Code through the Claude Agent SDK, Codex through `codex app-server` — with the bundled grilling and domain-modelling skills in its orientation and its own tools in-process, the interview's rules deciding every call behind either and the transport owning only how its provider is asked and what it streams back; the runner's write guard deciding every write before it runs, with this piece of work's own spec folder, `CONTEXT.md` and the ADR folder as the only writable paths and a list of read-only shapes bounding the commands it is asked about, holding every command that reading finds — the line's own invocations, and each one a substitution, a process substitution, an unquoted here-document body, a wrapper or a function body stands in front of, at any nesting depth — to that list, refusing a bare environment assignment that would set what a later shape resolves and runs in, refusing by name a flag that would let one of those shapes write or run a program, and refusing outright what that reading cannot resolve — a quoting, a command, a variable's value, or a program name a closure check finds unaccounted for — so that nothing but the listed read-only shapes runs, rather than promising that every way to disguise a write is named (SCP-355), each refusal reported rather than asked; `generate_plan`, which drafts one ticket from the spec and re-drafts that ticket rather than admitting a second; `edit_plan` and `undo_edit`, through the validated edit path with the interview as author; `read_plan`; `ask_options`, which puts what it cannot settle itself as groups of questions with the answers to pick from, one group at a time, answered as an ordinary turn in the options' own words; the streamed JSON-line protocol and the session id kept beside the spec; the same interview on Codex, behind one session interface, where `codex app-server` runs a thread with a read-only sandbox and an `untrusted` approval policy, so that every write and every command outside the set Codex itself trusts as read-only is asked about, each of those questions is answered by the interview's own judgement rather than reaching the person, the interview's tools are the thread's dynamic tools, and `--session` continues the thread through the app server's own resume; and the chat in planning mode, docked beside every pane, which the desktop host relays that protocol to — it spawns the command as a long-lived child with its argv built from the registered repository and the planning session's own records, shows each refusal as a refusal with nothing to answer, shows the plan edit an undo is still offered on as the plan's own record took it with an undo on its number, and keeps the conversation on the planning session so leaving and restarting come back to it.

### D-103 — A spec is a folder in the repository, committed first

- Owner: Founder
- Decision: a spec lives at `specs/<slug>/spec.md` (the folder is configurable), under the headings Outcome, Requirements, No-Gos, Rabbit holes and Notes, naming code as `@Symbol` or by path. Each requirement carries an id, `R1` upward, written into the spec when the requirement is written and never reused. A criterion records the requirement it was drafted from, so the node a requirement lands in is derived from its criteria rather than written down a second time, and is shown beside the requirement's id, the requirement itself being read in the section it is written in. The folder also holds a page per node, `specs/<slug>/nodes/<node>.md`, generated from the spec and the graph: the node's title, the requirements derived to it, its criteria and their verification, its paths, and the spec's No-Gos. A node's page is regenerated whenever either changes, and the Notes section in it is written by hand and survives that. Only `spec.md` is drafted from. The drafter drafts from it as it drafts from an issue, and also reads the repository's `CONTEXT.md`, its ADR titles and `principles.md` as data. Admission records the spec's path and content hash. The loop commits the spec folder, with the interview's `CONTEXT.md` and ADR changes, as the first commit on the ticket's branch, and review reads the diff after that commit. `specs/**` is a standing prohibited path for the executor. A spec edited after approval, or naming code that no longer exists, is stale: a ticket that has not started returns to `plan_invalid`, and a running one is flagged and continues.
- Why: a spec is intent upstream of the contract, and its staleness is detected rather than kept in step by hand ([ADR-0016](adr/0016-minimal-machine-maintained-planning.md)). A node reads on its own without giving a requirement a second place to be written, which would drift, and a re-draft moves a requirement between nodes with no edit to the spec.
- Built: the spec folder and the slug the title takes, minted from the person's first turn to the interview where they have not titled the planning themselves (D-118), created when missing, with the folder itself `specs` unless `.perbo/config.json` names another under `specs`; the writer that gives each requirement its id and hands out no id twice; `perbo admit --from-spec <path>`, which reads `spec.md` under those headings, drafts from it as it drafts from an issue, records on the admission record the spec's path, its content hash and every file the loop commits with it — the spec's whole folder, and the `CONTEXT.md` and the files under the ADR folder (`docs/adr` unless `.perbo/config.json` names another under `adr`) that the checkout has changed — and takes the No-Gos from its own heading, with `--start-over <KEY>` re-drafting a ticket in `plan_review` from the same spec; a criterion recording the requirement id it was drafted from; the page per node, regenerated whenever the spec or the graph changes and keeping the Notes written in it by hand; the requirement's node beside it in the Spec pane, which writes the spec into the repository; the spec folder as a standing prohibited path for the executor; and the loop committing those recorded files as the branch's first commit past the contract's base, before the executor runs and with its own `Attempt:` trailer, refusing the run where one of them has changed or gone, and keeping every file that commit holds out of the change set the checks, the review, the verification and the pull request read. Staleness is read from the spec's own bytes against the hash approval recorded — approval and not admission, because D-103 makes an edit *after approval* the stale one and the spec is ordinarily edited in `plan_review` while the draft is read, with admission's hash — and the files the loop commits with it — left standing on a spec approval could not read — and from the `@Symbol` and path names in it against the names approval recorded the repository as having — which is what separates a name the repository has lost from one the plan is for and the work has yet to write — answered against `perbo index` and the checkout, every path judged after it resolves; `perbo run --ticket` reads it before it moves the ticket or makes a worktree and leaves a stale ticket at `plan_invalid`, `perbo inspect` prints it for every ticket drafted from a spec so a run in flight is flagged and not interrupted, a name the index cannot answer for is reported unjudged rather than refusing a run, a ticket approved before the recorded names existed has every name in its spec reported unjudged, only a path git tracks is recorded so a build output in one checkout cannot make a clone read the spec as stale, and approval over a tree the index cannot be believed against records no symbol at all — for the life of the ticket, and records that it happened, so every later reading of it reports the spec's `@Symbol` names as unjudged and names `perbo index` rather than calling the spec current. The reading says which moment it took the spec's bytes from: approval for a contract that has been approved, admission for a ticket still in `plan_review`.

### D-104 — Sizes, not forecasts

- Owner: Founder
- Decision: a plan shows a size, S to XL, derived by fixed thresholds from its nodes, its criteria, and the files and packages in scope, with the counts beside it. S is 1 node, at most 4 criteria, 10 files and 1 package, the size of a ticket before graphs; M at most 3 nodes, 10 criteria, 25 files and 2 packages; L at most 6, 20, 50 and 3; XL beyond. A plan takes the largest size any of its counts reaches. Runs show usage as each provider reports it: tokens always, dollars where given. Nothing forecasts cost or time.
- Why: a description of the graph forecasts nothing, and nothing measures a forecast (D-097).
- Built: `perbo inspect` derives the size and shows it with its counts, marking the ones that set it, and the desktop's Graph pane shows the same size beside the graph, recomputed after every edit. Not built: a run's usage as each provider reports it.

### D-015 — Perbo reads code and never edits it

- Owner: Founder
- Decision: editing code stays in the person's editor. Perbo's surfaces read code and write only planning artifacts. The one piece of code intelligence is a TypeScript and JavaScript symbol and import index, built on demand for impact warnings, `@Symbol` completion and stale-spec checks.
- Why: every surface serves writing a spec and a contract; none needs an editor or a language server.
- Changes if: people ask to edit code inside Perbo more than they use their editor.
- ADR: [ADR-0018](adr/0018-defer-custom-ide-until-evidence-gates.md).
- Built: the index itself, `perbo index`; `@Symbol` completion over it in the desktop's Spec pane — the repository's exported names offered as a reference is typed, the one chosen written in with the caret past it, every reference marked behind the text, one the index does not hold marked apart with the two nearest names offered in its place and each replacing every use of it in that section, and a head saying how many do not resolve, with the index's size and the commit it was built at behind the **i** beside it; impact warnings over it in planning mode's Impact pane, which on demand lists what the draft in hand is likely to touch that its scope does not cover: files outside that scope importing what the draft changes or what the spec names, and the path classes `risk.ts` recognises in a package the scope or the spec reaches, each warning advice that becomes a scope change through the draft's own mark or a No-Go through the spec's own save, on the person's click; and the stale-spec check over it (D-103), which reads the record only where it was built at this checkout's commit with nothing uncommitted either side — a reading that cannot believe the index reports what it could not judge, and an approval that cannot believe it records no `@Symbol` at all, for the life of the ticket, recording that it could not so every later reading of that ticket says so too, since nothing after approval puts those names back, which is why the index matters most at approval. The two panes read the index through the host running `perbo index` over the registered repository and nothing a renderer sent, and the stale-spec check reads the `.perbo/index.json` the checkout already holds and runs nothing ([ADR-0023](adr/0023-untrusted-context-boundary.md) §4), and a repository the index cannot describe is said to be one rather than shown as an index holding no names, because a person acts differently on each. Not built: nothing.

## Running the work

### D-045 — What judges an attempt is immutable during it

- Owner: Founder
- Decision: during an attempt, the review policy and reviewer configuration, the corpus, tests marked `protected` or `contract`, workflow and branch-protection configuration, and the check set pinned at approval cannot change. Ordinary tests, new tests, and generated snapshots the plan permits can.
- Why: the rule protects what judges the attempt, not tests as a category, because writing tests is most of implementing a ticket.
- Changes if: more than about one attempt in ten needs a waiver.

### D-022 — Some actions are refused whatever the request

- Owner: Founder
- Decision: the runner never writes `.github/**`, `CODEOWNERS` or branch-protection settings, and never writes outside the worktree root, whatever the contract or the person asks.
- Why: those paths change what judges the work, or reach beyond it.
- Changes if: only by a new decision, never by a request.

### D-105 — Prohibited paths are refused at write time

- Owner: Founder
- Decision: the write guard refuses a write to a path the contract prohibits, even inside the allowed paths, using the same match as the reviewer's `scope.prohibited_path` finding. That blocking finding stays as the backstop.
- Why: the same rule applied earlier saves a remediation round for every slip, and subagents write as well as the executor.
- Built: the guard's refusal, with the review's finding behind it, and a repository's standing prohibited list under `paths_prohibited` in `.perbo/config.json`, each entry carrying what put it there. The planning mode explorer writes it, admission folds it into every new ticket's `paths_prohibited`, the guard reads it again when a run starts, so an entry added after admission binds the ticket's later runs, and `perbo doctor` reports it in its own `PROHIBITED` block. Under Windows semantics the guard also refuses a spelling Windows resolves to a prohibited path — another letter case, a trailing dot or space, a stream, a short 8.3 name — which the review's exact match does not see.

### D-096 — No ceilings on a run; a stall detector stops a hang

- Owner: Founder
- Decision: an attempt has no cost, token, wall-clock, iteration or command ceiling. A stall detector stops an attempt that shows no tool activity for a set time. The per-ticket limit on remediation rounds stays. A cost cap remains only where the executor is billed per token, with an API key in its environment. After every compaction, the executor and each subagent receive their brief again.
- Why: people read spend on their own provider accounts, so what still has to stop is a hang, and a credential that bills per token. Every iteration ceiling that fired cut ordinary work.
- Changes if: an attempt runs away in a way the stall detector does not see.
- Built: the stall detector (`attempt_stall_ms`, 20 minutes by default; a stall terminates the attempt `stalled` and ends the run), the ceilings removed, the cost caps bound to a per-token credential, and the brief after every compaction — a `SessionStart` hook under the `compact` matcher on Claude, `thread/inject_items` answering a `contextCompaction` item on Codex, the recorded brief plus a state block composed from the round's records, and each re-injection on the attempt. Not built: nothing.

### D-106 — The executor may delegate to subagents

- Owner: Founder
- Decision: on Claude and on Codex, the executor may start subagents from roles Perbo defines. The runner enforces only the trust boundaries: every subagent write passes the ticket's scope guard, repository and personal agent definitions stay unreachable, every subagent's activity is recorded against it, and the reviewer receives none of it. How many subagents, which roles and which model are the executor's call. Codex needs version 0.145.0 or later.
- Why: delegation is the executor's responsibility; the product keeps the checks that protect scope and independence.
- Changes if: a subagent write escapes the scope guard, or a subagent's account reaches review.
- ADR: [ADR-0038](adr/0038-subagents.md).
- Built on Claude: three roles Perbo defines, passed as `--agents` and enforced by the guard's hook, which now judges the tool under both names Claude Code answers to for it — `Agent` and `Task` — and refuses both a `subagent_type` outside them and a call a subagent made, whatever role that one names; the guard's directory kept per agent in one file each, so interleaved calls lose nothing, and a call refused, rather than judged from a directory the shell has left, wherever the guard cannot keep track of an agent's directory — a file that will not read back, or a move it cannot record; personal definitions held unreachable by the closed set and by the measured precedence of `--agents` over `~/.claude/agents` on a shared name (ADR-0038, 2026-09-15); every command record naming the role that ran it, except the two the runner is handed no name for — a refusal reported only by the result envelope, which names no agent, and the amendment that refusal makes, which is keyed by tool and command text and so can land on an identical line another agent ran; and the executor's account taken from the top-level session's last message alone. Built on Codex (SCP-327): the same three roles, written as `agents/<name>.toml` files under the isolated `CODEX_HOME` with `agents.enabled=true`; the write guard's state and Codex's own usage report kept per thread instead of one shared object, since a spawned agent is its own thread; a subagent starting one of its own refused reactively, as the attempt `prohibited_action` (`enable_own_tooling`), because Codex offers no request to refuse a spawn before it happens; a child's role looked up once with `thread/read` on its first activity and named on its command records; and `doctor` refusing a Codex older than 0.145.0, wherever the binary is checked. How it holds is in ADR-0038. Not built: whether Codex itself restricts a spawn's role to the ones configured, rather than a free-form or unnamed one — a live run settles it. The live test both halves build from is recorded in ADR-0038 (2026-09-12).

### D-094 — Selected skills guide execution

- Owner: Founder
- Decision: Perbo ships the 25 skills of Matt Pocock's published bundle, at a pinned revision and with their licence. A person can select up to three as executor guidance. The runner appends their text to the execution and remediation briefs and records their revision and content hash on each attempt; selecting none leaves the brief unchanged. Skills do not enable native skill discovery, repository instructions, hooks, plugins or extra permissions, and neither the review nor closure verification receives them.
- Why: the founder asked for these skills in the product's agents, and pinning keeps what reached a run knowable.
- Changes if: a selected skill is missing from execution, reaches review, or widens authority; or the reviewing run keeps catching a working rule the executor could not have known, which would call for a person-authored conventions file under `.perbo/`, delivered as data the way principles are (D-065).

### D-092 — A remediation round is briefed with its predecessor's account

- Owner: Founder
- Decision: the executor of a remediation round receives, beside the routed findings, the previous attempt's own account of its change: the files it touched and why, the tests it wrote and what it verified, sealed with its change set. The account goes to the executor's next round and nowhere else; the reviewer's inputs do not change (D-061).
- Why: a fresh agent re-reading the repository to close findings that already name a file and a line costs nearly as much as the build.
- Changes if: rounds close fewer findings with the account than without it.

### D-051 — A finding the executor can close goes back to it

- Owner: Founder
- Decision: the blocking matrix has a fifth outcome, `remediable`: the finding is real and closing it needs no decision only a person can make, so it returns to the executor as work, within the round limit, instead of reaching a person. `security.*` and `context.*` findings never route, and neither do deterministic rows.
- Why: people should not be asked to adjudicate findings an agent can close; asking them is an interruption, not a gate.
- Changes if: on real changes, a routed round ends worse than the first review would have.

### D-065 — Fix by the established practice; stop only where no practice answers

- Owner: Founder
- Decision: the routing policy in force sends every stopping finding on a routable row to the executor. The executor either closes it by the established practice (a platform primitive, a lockfile dependency, the settled pattern, implemented completely) or declares `NO_PRACTICE <finding_key>: <reason>`. A declined finding stays open, ends the loop `escalated`, and reaches the pull request under "No determinable practice — for you to decide". `security.*` and `context.*` stop whatever the row or severity; deterministic rows stop; the last round stops. A person's answer to a decline is recorded with `perbo principle add` into `.perbo/principles.md`, which the executor reads and cannot write. The pull request lists what was found, what the executor closed and verified, what is left for a person, and what was advisory.
- Why: in the founder's words, it is always better to fix than not to fix, and only not worth it when the effect is neutral; nobody but the owner can decide a neutral product question.
- Changes if: declines stay near zero while preference questions are silently fixed.

### D-081 — On a P1 change, a routable finding is routed

- Owner: Founder
- Decision: a semantic finding on a P1 change that names a criterion, says the executor can close it and points in a negative direction is routed `remediable`, as it is on P2 and P3. A finding about the evidence alone never closes a gate by itself.
- Why: a small change is where a routable finding is most worth closing without a person.
- Changes if: people override P1 routings more often than they accept them.

### D-085 — A remark on how a criterion was evidenced goes to the executor

- Owner: Founder
- Decision: every finding about how a criterion was evidenced, rather than that it fails (every `criterion.*` finding except `criterion.not_met`, and the `evidence.*` family), routes to the executor where it can close it, with no notice to the person. It never counts as the reviewer detecting the defect (D-082).
- Why: in the founder's words, these are defects to send back to the executor.
- Changes if: a fixture's defect is best named by such a remark, which this rule then under-counts.

### D-089 — A legibility block the change caused goes back once

- Owner: Founder
- Decision: a `legibility.*` finding on bytes the change added or modified routes to the executor for one round, with the byte and the line in the finding. A second block, or a block on a file the change did not touch, stops.
- Why: an illegible edit is the executor's own defect, and one round removes it.
- Changes if: an illegible edit survives its round.

### D-090 — A pinned check the change broke goes back once

- Owner: Founder
- Decision: a `check.*` finding whose pinned check ran and failed on the change's tree, where the base passed the workspace's verify command, routes to the executor for one round with the check's last lines. The verifier runs the pinned checks again before asking anything else. A check that did not run, or one that fails on a base that did not verify, stops at once.
- Why: a failing check the change caused is the executor's to fix, and one round removes it.
- Changes if: rounds are spent on checks the executor cannot fix.

### D-061 — Later rounds verify the fix; they do not review again

- Owner: Founder
- Decision: a change gets one full independent review. Every later round runs closure verification: for each routed finding, whether the fix closed it. The pinned checks and the scope computation run first and can only fail the verification, and `cannot_tell` counts as not closed.
- Why: every further full review is another independent chance to stop correct work, so the loop would not terminate.
- Changes if: changes pass verification while a person, reading them, would say the finding is still there.

### D-107 — A graph is reviewed per node and once overall

- Owner: Founder
- Decision: a ticket with an execution graph is reviewed once per node (that node's criteria, and the part of the diff inside its paths) and once over the whole change, for the outcome, anything that crosses nodes, and any path allowed in the explorer that no node names. The pinned checks also run once per node, narrowed to that node's paths as a failed check's rerun is narrowed to the files that own it, and each node's results reach that node's review. It changes the reviewer, so it carries a regression-suite run and adds graph-shaped fixtures to the corpus. No-Gos brief the executor; nothing checks them yet.
- Why: each review stays near the size of change the reviewer is measured on, and a node that fails its own checks is found before the whole change is.
- Built: the pinned checks per node, narrowed to the node's paths, recorded with the attempt and shown per node in `perbo inspect`; review per node and once overall (SCP-328) — `reviewGraph` reviews each node in plan order, on that node's criteria, the part of the diff inside its paths and that node's own check results, then the whole change unnarrowed but for its checks, and combines the N+1 artifacts into the gate's one view: the stricter reading wins wherever the overall review and a node's judged the same criterion, and where the same finding key repeats across them, the reading the gate treats as stricter wins — blocking, then escalating, then remediable — and the first where none of those tell the two apart — so a node-local blocking or escalating finding closes the gate on its own, even against a repeated key the whole-change review itself read as advisory. A node with no file inside its paths is not reviewed on its own. The per-node artifacts are recorded beside the combined one in the ticket store and shown per node in `perbo inspect`, beside its checks. A flat plan calls the reviewer once, on its input as the caller built it. The graph-shaped corpus fixtures. Not built: No-Gos still brief the executor; nothing checks them yet.

### D-037 — Review independence by risk level

- Owner: Founder
- Decision: at every level the reviewer never sees the executor's narrative or transcript, is grounded only in the criteria, the diff, the check output and the files it selects itself, runs as a separate process with its own context, and treats deterministic checks as authoritative. A different model family is required only at P3. Several complete implementations are never the default.
- Why: the cheapest properties carry most of the independence.
- Changes if: a different model family turns out to add much more than the other properties.
- Decided, not built: a different model family at P3. Until then every review runs on the configured reviewer model.

### D-062 — A generated path may declare its sources

- Owner: Founder
- Decision: a contract may declare which source globs explain a change to a generated path. A generated file that changes with no declared source in the same diff is a deterministic blocking finding, `scope.generated_without_source`. Declaring nothing changes nothing.
- Why: a hand edit and a regeneration cannot be told apart from bytes, but "output changed, no input changed" is a fact.

### D-063 — Credentials are cited by location, and redacted mechanically

- Owner: Founder
- Decision: the reviewer cites a committed credential by location and shape, never by value, and the artifact writer redacts every string it writes. The regression suite checks that every cited credential was redacted.
- Why: a reviewer that reports a leak correctly would otherwise reproduce it.

### D-011 — A ticket closes at merge

- Owner: Founder
- Decision: a ticket closes when its pull request merges, or moves to `closed` or `changes_requested` (D-083). Nothing observed after the merge keeps it open.
- Why: tickets that wait on an observed outcome never close.

### D-083 — A pull request closed without merging

- Owner: Founder
- Decision: `perbo sync` moves a `pr_open` ticket to `closed` when GitHub reports its pull request closed and unmerged, and to `changes_requested`, with delivery `closed`, where the pull request carries a changes-requested review verdict. `closed` is terminal for the record, and the ticket can be run again.
- Why: the record says what happened in a state, not in a printed line.

### D-041 — The person merges; a repository may let the loop merge

- Owner: Founder
- Decision: the person merges by default. A repository may opt into `merge: loop`. Then the loop, and the queue, merge a pull request the loop opened only when all of these hold: a separate review run approved that head, every check reported on it is green, GitHub reports it mergeable, every commit on the branch carries the attempt trailer, and nothing outside the loop has touched the branch since the approval. Any missing condition is a stop that names itself. The merge trusts only the verdict the review run itself left (SCP-229), and that lands before any repository opts in.
- Why: people keep the merge unless they choose otherwise, and a merge the loop performs is gated the way an agent's merge to this repository is (D-073).
- Changes if: a loop merge is reverted, or charged with an escape a review should have caught.
- ADR: [ADR-0010](adr/0010-progressive-autonomy.md).
- Decided, not built: SCP-229. Until it lands, the merge reads the verdict from any comment.

### D-108 — The queue runs tickets, re-levels branches and merges in order

- Owner: Founder
- Decision: `perbo serve` is one process over the store. On each tick it:
  - fetches the base ref, the queue's only fetch;
  - reads every open pull request through `sync`, and merges in queue order where the repository opted into `merge: loop` (D-041);
  - decides which tickets wait by set arithmetic over approved records: `depends_on`, the intersection of `paths_allowed`, and a sealed branch's actual paths, with generated paths exempt. So `blocked` is reachable;
  - re-levels every open branch that fell behind the base before starting anything new;
  - starts `perbo run --ticket` children up to `concurrent_local_attempts`;
  - drafts open tracker issues carrying a configured label into `plan_review`, one per tick.

  A clean re-level keeps the review approval when the change's content hash is unchanged and the base touched nothing in scope. A conflict starts a reconciliation round, briefed with the base commit, the conflicting paths and the merged ticket's approved contract, and bounded as remediation rounds are (D-096). A re-level refuses a branch carrying a commit the loop did not make. Nothing in the queue approves.
- Why: overlap is an ordering over records, never a judgement, so no overseer agent is needed; the loop's own merge step plus a fetch poll is the event, so there is nothing to host.
- Changes if: the queue deadlocks or starves, or a re-level pushes a change nobody reviewed.
- ADR: [ADR-0036](adr/0036-queue.md).

### D-109 — The queue's tool endpoint and `perbo agent`

- Owner: Founder
- Decision: `perbo serve` hosts a loopback MCP endpoint with a bearer token per role (person, drafter). Its tools are this build's own commands, run in-process with arguments built as values. They are reads (`list_tickets`, `inspect_ticket`, `stops`, `escapes`, `queue_state`) plus `admit_ticket`, `edit_ticket`, `sync_ticket`, `queue_pause` and `queue_resume`. It never approves, publishes or merges. `perbo mcp` prints the client configuration and writes nothing. `perbo agent [--provider claude|codex]` launches the person's own session in the primary checkout, with the endpoint injected for that launch, and the person's own configuration applies. The executor is given neither the token nor the address and keeps ADR-0030's empty MCP configuration, and the reviewer's inputs do not change. The executor runs as the person's user, so a program it starts could read the endpoint record; the tools are bounded so that a token holder can at most draft, edit an unapproved contract, sync, and pause or resume the queue.
- Why: a person's own session should reach the queue, and nothing reachable through the endpoint approves, publishes or merges.
- Changes if: a ticket is approved without a person's keystroke, or a session string reaches a flag.

### D-091 — Commit signing is the person's choice

- Owner: Founder
- Decision: the loop signs its commits only where the person's git configuration signs, and it never refuses a merge, a seal or a delivery because a commit is unsigned. Where a repository's base branch requires signed commits, GitHub enforces that, and the loop says so.
- Why: one repository owner's preference must not become a condition on every repository.
- Decided, not built: SCP-280. Until it lands, the loop's merge gate refuses unsigned commits.

### D-049 — Local host resources

- Owner: Founder
- Decision: `concurrent_local_attempts` defaults to 1. A `local_workspace_bytes` budget reclaims leases on total size as well as staleness. A suspended host is a disconnect: an attempt running across it ends with `host_suspended`, and ending it kills the agent's process group.
- Why: the substrate is a developer's laptop.
- Changes if: an attempt's peak disk use passes 10 GiB.
- Decided, not built: reclaiming on total size. Until then only stale leases are reclaimed.

### D-012 — Materialized secrets never leave the machine

- Owner: Founder
- Decision: secrets the runner materializes into a worktree are excluded from every change set, run bundle, log and artifact by content hash, not by filename alone. The model provider is a third destination: the executor and the reviewer read the worktree, so the person is told what reaches their provider.
- Why: "nothing leaves your machine" is a two-party claim in a three-party system.

### D-013 — Supported repositories and environments

- Owner: Founder
- Decision: Perbo runs on any GitHub repository a standard git worktree can check out, with a declared materialization manifest where a worktree needs files git does not carry. `perbo doctor` proposes the manifest: an install with the package managers this build supports — pnpm, npm, yarn and bun — and a verification with the repository's test script. The kind of repository is never a reason to refuse it: where there is no test script a worktree can run, because none is declared, the package manager is one this build does not install with, its lockfile has nothing beside it to install from, or each test script starts a service, `doctor` says so as an advisory, installs nothing it cannot, and verifies with `git status --porcelain`, so an attempt there is judged by the review and whichever checks are pinned, and its base counts as unmeasured. A repository `doctor` cannot materialize at all, such as a checkout that is not a git repository or signs its commits with a key that cannot sign, is refused with the reason.
- Why: Perbo has to work with any kind of repository people bring, and one whose tests a worktree cannot run still has work to do. The environment half of a repository is the likeliest cause of a first-run failure, so `doctor` names what it could not set up before an attempt rather than during one.
- Changes if: a class of repository people bring cannot be materialized.

### D-035 — Untrusted context is data, never instruction

- Owner: Founder
- Decision: every context item carries a trust label: `system`, `user`, `repo` or `external`. Repository and external content never occupies an instruction position. The verdict is structured output over the plan's criteria, deterministic checks outrank any model claim about them, and no model output becomes an action parameter.
- Why: test output, documentation, dependency READMEs and issue bodies are attacker-controlled in any repository with contributors.
- Changes if: a fixture flips a verdict or something is exfiltrated.
- ADR: [ADR-0023](adr/0023-untrusted-context-boundary.md).

### D-036 — A worktree is materialized, not merely provisioned

- Owner: Founder
- Decision: a worktree acquires its environment from a declared materialization manifest, which `perbo doctor` proposes. Secrets are materialized locally and excluded from artifacts, installs use the package manager's shared store, and attempts get their own ports or run one at a time.
- Why: a fresh worktree has no dependencies, no environment files and no local configuration.
- ADR: [ADR-0025](adr/0025-worktree-environment-contract.md).

### D-039 — Replay claims are tiered

- Owner: Founder
- Decision: every run bundle carries `replayability: exact | re_executable | forensic`, defaulting to `forensic`. The tier degrades visibly as inputs expire or providers retire model versions.
- Why: a bundle that references a mutable remote is not replayable, and that failure is silent.
- ADR: [ADR-0026](adr/0026-replay-claim-tiering.md).
- Decided, not built: the tier is set when a bundle is written and never lowered afterwards (SCP-085).

### D-070 — An unknown dollar cost stays unknown

- Owner: Founder
- Decision: every model artifact records a `cost_basis`: `transport_reported`, `provider_list_estimate` or `unavailable`. An unknown cost is never summed as zero, and a total is called all-in only when every component is priced. Token counts are always kept.
- Why: a partial total reads as a whole one.

### D-115 — The loop will not need GitHub

- Owner: Founder
- Decision: the loop will run without GitHub — against another host, a plain Git remote, or no remote at all — delivering a branch or a patch where there is no pull request to open. Git stays: a worktree is how an attempt gets a scope it cannot write outside. What a delivery is where there is no pull request, and where admission reads its issue from, are not yet decided.
- Why: a repository that is not on GitHub has no way through the loop today. An admission drafted from an issue reads it through the GitHub CLI, and every delivery ends in a pull request opened the same way.
- Decided, not built: all of it. Until then both go through the GitHub CLI, and a run that has to open a pull request without it is refused at preflight.

## The desktop

### D-093 — The Perbo desktop runs Claude Code and Codex

- Owner: Founder
- Decision: the desktop is a local app around the bundled CLI, built from the supplied hand-drawn assets and shared components. Claude Code and Codex plan, execute and review on the person's existing subscription logins; API credentials are optional. Each person authenticates with their own credential. Perbo never reads, stores or forwards a subscription credential, never pays for, resells or intermediates usage, and never modifies a provider's binary. The agent binary's path, version and hash are recorded on every attempt.
- Why: people already have these subscriptions, and the product runs where their agents already run.
- Changes if: a provider's terms stop permitting it.
- ADR: [ADR-0033](adr/0033-focrux-local-desktop-and-subscription-providers.md).

### D-095 — Durable desktop editing and one workspace projection

- Owner: Founder
- Decision: unfinished contract fields, criterion buffers and model choices survive a full restart. There is one resumable new-task session and one editor per existing ticket. Drafting and compilation stay attached to the session that asked for them while the person navigates elsewhere. A completed run offers **Review result** first. Polling is about 15 seconds idle and 2 seconds active, and progress updates do not trigger repository reads. Admission is never repeated automatically.
- Why: a person's unfinished work must not be lost, and a late result must never land in the wrong session.
- Changes if: edits are lost, a result lands in another session, or an admission is duplicated.
- ADR: [ADR-0034](adr/0034-desktop-editing-and-workspace-projection.md).

### D-097 — Perbo UI v2; the phone's surfaces follow pairing

- Owner: Founder
- Decision: the desktop follows the v2 boards (`design/perbo-v2`). The rail's settings pill holds General, Usage and Connections. General holds the name, the four moments the loop may interrupt a person, appearance and an away-from-keyboard hold. Usage reports a provider's plan windows only from the provider's own reply, and a spend ledger summed from retained attempts. Shortcuts are rebindable, except the two money bindings. Completed tickets stay on Home until archived by hand, and archiving is a desktop preference, never a ticket state. There is a dark theme, and motion is vendored from transitions.dev at a pinned commit. The desktop shows no forecast, and no phone surface until pairing lands; the phone boards are the target for that work.
- Why: nothing shown is invented; every number comes from a provider or the records.
- Changes if: the desktop shows a number no provider reported, or a desktop preference changes a ticket's state.

## Review quality and the corpus

### D-010 — The regression suite holds reviewer quality

- Owner: Founder
- Decision: a change to the reviewer prompt, the blocking matrix, or the default model or provider carries a regression-suite run in its pull request ([`regression-suite`](evaluation/regression-suite.md): 30 fixtures from the public corpus, one repeat), with the `unstated_regression` row first. Two bars are hard: no flipped verdict, and every cited credential redacted (D-055). Every other row is read against the previous suite run on the same model.
- Why: the suite is how a reviewer change shows it did no harm.
- Changes if: a reviewer change passes the suite and then misses defects in real use.

### D-055 — The adversarial control's two hard bars

- Owner: Founder
- Decision: across every fixture that must not be approved, no run approves; and across every occasion a reviewer cites a credential, the credential is redacted. Both bars are 100%. Detecting and reporting an injection is a reported rate, not a gate.
- Why: detection and harm differ; a reviewer that reaches the right verdict and leaks nothing has done its job.

### D-052 — Rule authority attaches to a rule family

- Owner: Founder
- Decision: a rule's authority attaches to its family, the first dotted segment of its id, and the families are a closed enum in the verdict schema. The full id stays free text and keys the finding.
- Why: single rule ids rarely recur, so only families build a history.
- Decided, not built: authority is still demoted per full rule id, and the verdict schema has no family enum (SCP-095).

### D-053 — The corpus has an `unstated_regression` class

- Owner: Founder
- Decision: a seventh defect class, `unstated_regression` (prefix `reg`), holds changes that satisfy their criterion and break something the criterion never mentioned. Such a fixture is anchored to a file rather than a criterion.
- Why: reverts with a stated reason are the only defects with public ground truth that a real review missed.

### D-054 — Detection is scored from the findings

- Owner: Founder
- Decision: a fixture's defect counts as detected when an attributable blocking finding was raised, whatever the review's decision. A review that blocked and did not conclude still detected it.
- Why: the decision answers whether the review resolved everything, which is a different question.

### D-066 — An escalated finding counts as surfaced

- Owner: Founder
- Decision: beside detected, the suite reports surfaced, which also counts an attributable finding routed `escalates`. Advisory and waived findings count in neither.
- Why: an escalation puts the defect in front of a person, and scoring it as a miss would measure the routing table.

### D-068 — A merged commit is not automatically a clean change

- Owner: Founder
- Decision: a fixture drawn from a merged commit that a good reviewer has checkable objections to is `contested`. It leaves the clean denominator and is scored as a disagreement rate. The mode requires a written objection of at least forty characters and the person who verified it.
- Why: dropping such fixtures would bias the corpus toward changes the reviewer happened to like.

### D-069 — A file anchor proves locus, not the seeded mechanism

- Owner: Founder
- Decision: a finding whose only match to a fixture is the expected file is a candidate. A criterion match or a declared rule-prefix match confirms detection, and recall counts confirmed detection.
- Why: a path identifies where, not what.

### D-082 — A criterion called met but asserted-only does not confirm detection

- Owner: Founder
- Decision: on a blocking-mode fixture, `criterion.not_met` on the anchored criterion confirms detection, and `criterion.unverified` on it is a candidate.
- Why: calling the defective criterion met, with only asserted evidence, is not finding the defect.

### D-086 — A remediation round on a clean change is the loop's work

- Owner: Founder
- Decision: a routed finding on a clean change counts as passing the gate when an executor exists to take it, as it always does in the loop.
- Why: in the loop a routed finding costs a round and reaches no person.

### D-060 — Precision of stopping

- Owner: Founder
- Decision: precision of stopping is the share of stopped changes where the person endorses the stop, meaning they would have wanted to be asked before it was fixed. `perbo stops` reads it live from the endorse-or-override answer on each pull request, always beside the share of changes on which a person was shown anything. A reading of 70% or more needs a Wilson interval wholly on one side of the bar; below nine unanimous stops it cannot resolve.
- Why: it measures the stops people actually feel, and the companion shows a gate that improves by hiding findings.

### D-079 — A check the product runs is changed by a person

- Owner: Founder
- Decision: the repository validators, the reviewer's prompt and policy, the scorer and the corpus are edited only by a person, on their own branch under D-073, never by the attempt they would verify. Admission refuses a ticket whose work is such a path.
- Why: an executor that can edit the check verifying it can make the check say what the change needs.
- Changes if: a second, independent check exists to read these paths against.

## Partners, distribution and law

### D-084 — What a partner needs before their first ticket

- Owner: Founder
- Decision: before a partner's first ticket, the rename has landed, their direct-agent baseline has been captured (D-038), they have an installable build, and they have the disclosure and have signed the agreement (D-047). Nothing else waits.
- Why: that is what the first hour needs.

### D-038 — The baseline comes before first use

- Owner: Founder
- Decision: a partner's direct-agent baseline is captured with `perbo baseline` before they first use Perbo: the same partner, comparable tickets, agent-direct, wall clock from start of work to pull request.
- Why: it cannot be reconstructed afterwards.

### D-047 — The partner agreement

- Owner: Founder
- Decision: a partner receives the written disclosure ("What leaves your machine" on the [install page](install.md)) and signs a one-page agreement covering what they share with the founder. There is no processor agreement or subprocessor list, because a local build sends nothing to Perbo. A lawyer confirms this before the first partner signs.
- Why: the partner's code and prompts travel only to their own providers, under their own credentials.

### D-046 — Releases are verifiable, and a copy updates itself to a verified one

- Owner: Founder
- Decision: Perbo is released from the public repository. Each release carries a `SHA256SUMS` file, a detached minisign signature over it made with a key that never leaves the founder's machine, a build provenance attestation and an SBOM (D-048). The desktop updates itself. It asks the public repository for its latest release, and where that is newer than the copy running it names both versions beside a changelog link and an update button. The button downloads the release's `SHA256SUMS`, its signature and the image for this machine, and replaces the app only when all three agree: the signature checks against the public key compiled into the app, the image's SHA-256 is the line the signed file gives it, and the version that line names is newer than the copy running, so an older release, however validly signed, is never installed over a newer one. A copy Homebrew installed is left to `brew upgrade`, which the prompt names instead. The request for the latest release is the one the app makes on its own behalf, and the install page's disclosure names it.
- Why: a copy that cannot tell its user it is out of date goes on running whatever it shipped with. An update channel is a remote-code-execution path by design, so this one runs only what the founder's key signed: an update is trusted on its signature, not on the host that served it or the connection it came over. The binaries are not code-signed (D-116), and the update framework Electron uses on macOS will not install over an unsigned app, so the check is made here instead.
- Changes if: the signing key leaves the founder's machine, or the binaries are code-signed and notarized.
- Decided, not built: the signing key and the signing on the founder's machine, the release workflow that builds and publishes, the updater, and the disclosure's line for the request. Until then nothing is released, and the app makes no request of its own.

### D-116 — The desktop is a free download

- Owner: Founder
- Decision: anyone can download the desktop from perbostudios.com, which links to the latest release on the public repository. The first release is for macOS only, as separate disk images for Apple silicon and for Intel; Windows follows once the loop runs there end to end. A Homebrew cask installs the same app and puts the CLI on `PATH`. The binaries are not code-signed or notarized: the download page says how to open one that macOS has quarantined, and a Homebrew install needs no such step. The CLI is not published to npm. The workspace carries one version number, and the first public release is 0.1.0. The download page says what makes the app useful before anyone installs it: Git, the GitHub CLI to open a pull request (D-115), and Claude Code or Codex signed in. A design partner downloads the same release as anyone else, and the tarball handed over out of band is retired.
- Why: the product is free and runs on the person's machine (D-075), so a download is how people meet it, and one channel is one thing to get right for each version.
- Changes if: a release has to reach people who cannot open an unsigned binary.
- Decided, not built: the disk images, the release workflow, the cask and the download page. Until then the app is built from source with `pnpm desktop:package`, and `release.yml` still drafts the partner tarball.

### D-048 — Product-regulation artefacts come with the first binary release

- Owner: Founder
- Decision: an SBOM, a vulnerability-handling policy, a disclosure contact and a declared support period are prepared for the first distribution of a binary, which the public release is.
- Why: obligations of this kind attach to placing a product on a market.
- Built: the vulnerability-handling policy, the disclosure contact and the declared support period, in [`SECURITY.md`](../SECURITY.md). Not built: the SBOM, which the release workflow produces with each release (D-046).

### D-030 — Nothing learns from private content without opt-in

- Owner: Founder
- Decision: nothing learns from a person's private content across people or customers without their explicit opt-in.
- Why: calibration from verdicts in the control plane must not become training on private code.

## How this repository works

### D-073 — An agent merges here only after an independent review

- Owner: Founder
- Decision: a session working on this repository may merge a pull request only after a separate agent run on Claude Fable 5.1 (Claude Opus 5 when Fable is unavailable) has read the whole diff against [AGENTS.md](../AGENTS.md), and the `AGENTS.md` of each package the diff touches, and left an unqualified approve as a review comment naming the model. The reviewing run is never the authoring session. The founder may merge without it. A change to the reviewer carries its regression-suite summary in the pull-request body (D-010), and the review treats its absence as blocking.
- Why: the product's own principle applied to its repository: what writes and what judges are separate runs.
- Changes if: a reviewed merge lands an escape a person reading the diff would have stopped.

### D-078 — Documentation and decision tickets are admissible

- Owner: Founder
- Decision: a ticket whose criteria are validator outcomes is admissible. A validator's pass is `proxy` evidence wherever the validator cannot tell two documents apart. This repository runs its work through Perbo when that is convenient.
- Why: a green validator says an entry is well formed, never that it is right.
- Changes if: validator-criteria tickets land entries that turn out wrong on substance.

### D-114 — An agent's part in a commit is named

- Owner: Founder
- Decision: a commit an agent wrote carries the trailer `Assisted-by: LLM`, the Linux kernel's convention, and no `Co-Authored-By` naming a model; `.claude/settings.json` sets that trailer for Claude Code sessions in this repository. No commit carries a sign-off: a contribution is under Apache-2.0 by the licence's section 5, with no contributor licence agreement. The independent review an agent's merge needs (D-073) is maintainer tooling, recorded as a review comment, and is never a required approval on `main`.
- Why: a history written almost entirely by agents should say so in a form other projects already read, and in the founder's words, "we should remove this requirement for a sign off".
- Changes if: a required-approval rule a machine can satisfy is found to catch what the review comment does not.

### D-113 — The repository carries everything an agent needs

- Owner: Founder
- Decision: whatever a person or an agent must know to work here is in this repository: decisions in this register, architecture in the ADRs, terms in `CONTEXT.md`, and the way of working, the environment and its traps in `AGENTS.md`; open work is the one thing kept elsewhere, in the private backlog (D-076). A session's own memory, a chat or a bundle beside the repository is a cache and never a source, so anything a session learns that a later one would need is written here in the same change. A handoff is a pointer to this repository. A session that cannot find what it needs here records the gap as a defect instead of working from a private note.
- Why: in the founder's words, the repository is the source of truth and must hold everything needed. Knowledge kept in one machine's session memory is invisible to every other person, agent and account, and a decision nobody can read is not a decision.

### D-110 — Identifiers are numbered at merge

- Owner: Founder
- Decision: a branch writes new decisions and ADRs as `D-NEW-<label>` and `ADR-NEW-<label>` (in `adr/NEW-<label>.md`). Whoever merges runs `scripts/assign_ids.py --apply` as the last commit, which numbers them after the highest ids `main` and the branch have ever held, so a deleted entry's number is never reused, rewrites every reference, and validates the result strictly.
- Why: sessions working in parallel minted the same numbers on their own branches.

### D-111 — The repository keeps a source of truth only

- Owner: Founder
- Decision: every document states what is true now. A superseded or deprecated decision, ADR or comment is deleted, not marked. A document cites a decision by its id instead of restating it. Git holds the history.
- Why: in the founder's words, "we only keep a source of truth, not history". Old positions left in place were read as current.

### D-112 — Trademarks, patents and the brand under Apache-2.0

- Owner: Founder
- Decision: the repository says nothing about trademarks or patents beyond Apache-2.0's own terms, which grant no trademark rights and carry a patent licence. The Perbo name, logo and artwork are not licensed under Apache-2.0; all rights in them are reserved, and `NOTICE` names the files.
- Why: the founder's choice. The artwork is the co-founder's; reserving it keeps the brand out of forks while the code stays Apache-2.0.

### D-117 — The interview asks with answers to pick from

- Owner: Founder
- Decision: the interview puts what it cannot settle from the repository, the spec or what the person
  has already said through `ask_options`, which carries groups of questions, each group's parts read
  together because one part's answer bears on another's. It asks for all of it in the one call and
  returns without waiting — a tool returns to the model, and one that waited on a person would hold
  the turn open — and the dock puts one group at a time, so what the session may ask cheaply the
  person is not asked cheaply. Every part offers at least two answers, may carry the session's own
  recommendation — which is put first, a person reading a list of answers reading the top of it — and
  always carries two of the reader's own: leaving the choice to the interview, and saying the answer is
  none of these, which brings the box back. While a group is in front of the person the box is not, so
  there is one way to answer rather than two; their own words are never closed off, they are asked for. Picking sends the options' own wording as
  an ordinary turn. How much of an asking has been answered is recorded on the planning rather than
  counted back out of the turns, which cannot tell an answer from a question the person typed
  instead: a turn that is not the group's answer ends the asking, because the session is about to
  answer what was said and a card left standing would answer a question nobody is asking any more.
  The conversation keeps the questions either way, behind the line that says they were asked: a
  card holds what has to be read and what it wrote is there for the asking, so a chat of long
  accounts is a chat nobody reads. This is not a permission prompt: a call the guard refused is still reported and
  never asked (D-102).
- Why: a person sees only what needs them (D-001), and prose questions arriving five at a time are
  read as a wall and answered as one. Metering them is the reader's job rather than the session's,
  because a rule the session is asked to follow is one it can drift from, while a queue it cannot
  reach holds. The wording that goes back is the option's own so the answer is the person's sentence
  and not a token only the app understands, which also keeps what the session wrote out of every
  action parameter ([ADR-0023](adr/0023-untrusted-context-boundary.md) §4): it reaches a turn and
  nothing else.
- Built: `ask_options` and the `asked` event beside the interview's other tools, bounded at four
  groups of four parts of eight options and refused at the tool above that; the host relaying it
  under the clipping and redaction every other field the session writes is given, flattening the
  whitespace a label goes back down as; the asking and the count answered recorded on the planning,
  moved on by an answer and ended by anything else or by the line itself falling out of the
  conversation's cap; and the dock's card, which puts one group with its parts lettered, holds Send
  until every part is answered, and sends the options' own words.

### D-119 — A pause says which pause it is

- Owner: Founder
- Decision: the dock says the interview is working for as long as it owes the person a word, and
  says nothing once the next word is theirs. Which it is comes from the session's own report that
  its turn has ended — every transport knows this and each says it differently, so it is carried in
  one shape (`idle`) as the session's words are. A turn the person sends starts the waiting; the
  turn ending, the session ending, the child going and the person stopping it each end it, because
  a pause nothing is coming out of is not a pause to sit through. Turns in flight are counted
  rather than flagged: a person who sends a second before the first is answered is owed two.
- Why: a session that says a line and then reads the repository before saying the next looks, from
  the conversation alone, exactly like one that has finished or fallen over. Read from the last
  line's kind the dock went quiet at the very moment the person most needed telling that something
  was still coming, and a person who thinks a tool has hung stops it.
- Built: the `idle` event on the interview's protocol, emitted by the Claude transport when the SDK
  reports a turn's result and by the Codex transport when a turn ends however it ended; the host
  counting what each planning is owed and carrying it on the interview's change beside the asking,
  clearing it when the child closes, the session ends or the person stops it; the snapshot listing
  the plannings mid-turn, so a dock opened part way through one knows it; and the dock's own line,
  which says *Working…* while a tool is the last thing to have happened and *Thinking…* otherwise.

### D-118 — An untitled planning is named by its first turn

- Owner: Founder
- Decision: the interview writes `specs/<slug>/spec.md`, so a planning with no slug has nowhere to write. Where the person has not titled it in the Spec pane, the host cuts a title from their first turn — the first sentence, its opening dropped, clipped to a whole word within the slug's cap — writes the spec with it and records the slug, then starts the interview on that spec and sends the turn. The chat says which folder was named. A turn no folder name can come from is refused as before, naming the title it could not take. The folder is minted once and is not moved afterwards; the title in it stays editable.
- Why: a person opening planning and typing what they want should be talking to the interview, not stopped by a field they have not found. Their own words name the folder, so nothing a model returned becomes a path ([ADR-0023](adr/0023-untrusted-context-boundary.md) §4). The naming is said rather than silent because a slug outlives the message it came from.
- Built: `specTitleFromMessage` in `@perbo/planning`, the host naming the spec on the first turn and saying so as a note, and the browser preview doing the same.
