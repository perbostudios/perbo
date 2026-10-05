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

### D-133 — Nothing a person reads is cut

- Owner: Founder
- Decision: text Perbo shows a person is never cut, mid-sentence or otherwise; where it has to fit a limit it is made more concise without losing what it says. Length caps stay, and so does a count cap a decision states by number (D-094, D-117, D-127, D-128). Who meets a cap depends on who writes the text:
  - a model that writes a capped field is told the limit, or a tighter one it can count, up front and asked to write concisely, and where its text still runs past it the same session is asked again to condense it, rather than the text being clipped;
  - a person typing into a capped field is held to it where they type, from the same constant the field's schema reads — where their words go down composed with others as one field, to the room the rest leaves — and what they typed is never refused when sent or cut afterwards;
  - a line Perbo composes — progress, notes, refusal reasons, pull-request sections — is written to fit in whole sentences, and where it names a list it names whole items and then "and K more";
  - output from a tool rather than a model — git's and gh's refusals, a check's summary line, a provider's rate-limit or reset sentence, quoted evidence, the command the write guard refused — is recorded whole and shown whole, and no field that holds it carries a length cap; where a screen has room for one line, Perbo writes that line in whole sentences and the whole output sits behind an "i".

  An identifier no person reads as prose — a session id, a tool, rule or finding key held to a record's field width or shortened for display, a spec's folder named from the words cut from a person's first turn (D-118) — and an excerpt of a log (a check's output tail, a job's log tail, a transcript line) are not text shown to a person under this rule. Nor is text only a model reads: the executor's account of its change (D-092) briefs the next round's executor and is never shown to a person, so it stays held to its 4,000 characters and past them is cut with a marker the next executor reads. Nor is the reviewer's package, `packages/review`, within this rule's reach: it is a check the product runs, changed only by a person (D-079), so the fragment of a verdict its rejection quotes stays folded onto one printable line and cut at 120 characters, the schema's issues at 400; the desktop says a review whose answer could not be used in one sentence, with that recorded error behind an "i".
- Why: in the founder's words, text shown to a person "should not be cut. Should only be made more concise and condensed without loss of information if it is shown to the user." A sentence cut short reads as something it did not say.
- Changes if: a field has to hold text no condensing fits, and the person would rather see it cut than not at all.
- Built: the runner's records and lines carry whole the command a refusal is about, the processes a sweep ended, git's and gh's refusals at a merge, a check's summary line and a transport's failure and reset sentence, and name five whole items then how many more; `perbo interview`'s guard, `perbo serve`, `perbo inspect` and `perbo review`'s card say theirs whole, the cards wrapping a value under its column rather than clipping it; the desktop's chat records the Architect's refusals, tool reports, edit summaries and its own notes whole, and a note about a tool's output — why a line of the chat did not parse or could not be recorded, a stopped chat's stderr, its process's error — says what happened in one sentence with the output, redacted and whole, behind an "i"; it hands a message of the Architect's past its 12,000 characters, or a question redaction lengthened past its field, back to the same session to condense, at most twice running before it says what it did not show; a review that ended on an error is said on the review page's summary, and a run it ended on the loop page's ended card, in one sentence — "The reviewer's answer could not be parsed." where the reviewer answered and no verdict it returned could be accepted — with the error as the review recorded it behind an "i"; the executor is told its limit up front, and the Architect a tighter one it can count — a chat message of two sentences at most (D-102) — and that a message past its field is handed back; the reading of a plan against its spec measures each finding as the person is shown it, redacted in `perbo drift` before its lengths are checked, and hands one whose words run past a field, redaction included, back to the same session to condense, at most twice, and the desktop, whose redaction may know a credential the command's environment does not, fails a reading a field of which it still finds past its length rather than cutting or leaving out that field. Every field a person types into that has a limit holds them to it where they type, from the constant the request's schema reads (`TYPED_TEXT_MAX_CHARS`, `TYPED_PATH_MAX_CHARS`, `SPEC_TITLE_MAX_CHARS`, `PERSON_NAME_MAX_CHARS`, `ARCHIVE_SEARCH_MAX_CHARS` in `apps/desktop/src/shared/protocol.ts`, `TICKET_NAME_CAP` in `@perbo/contracts`): a turn in the chat and on the question page, a spec's title and sections, a criterion and its assertion, a new allowed path, each off-limits glob, a note on a review, a person's name, the search of Home and the archive, a ticket's name; where the words go down composed with others as one field — a part's own words in a lettered group of the Architect's questions, an own-words answer on the loop page — the box holds the room the rest of the composition leaves, so nothing typed is refused when sent. The desktop clips no text at the edge of its box: a line longer than its box wraps onto as many lines as it takes, the title bar and a page's header growing to hold it, and a test reads the stylesheet the renderer ships and fails on `text-overflow: ellipsis` or a line clamp. A spec has no title line until the Architect or the person names the work, and the app shows Untitled in its place (D-118). Not built: a transport's failure that `@perbo/model` records keeps its first line only, and that line to 300 characters with an ellipsis, which SCP-188 keeps from quoting what was sent.

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
- Decision: models may originate candidate work. The drafter, the queue's tracker drafting and the chat all draft, and nothing a model drafts becomes canonical until a person approves it. A standing rule may act only on work already admitted, and no model output triggers it or supplies its parameters. Product preference, security stops, external commitments, and legal or financial authority stay with people.
- Why: more initiative, not more sovereignty.
- Changes if: drafted work adds more coordination than it removes.

### D-100 — Large work is one ticket with an execution graph

- Owner: Founder
- Decision: a plan may group its acceptance criteria into nodes, each naming the paths expected to satisfy them. Node criteria and paths are contract; the order between nodes is approach, along with the spec's No-Gos. The drafter proposes the first graph. After that the plan changes only by edits, made by hand or asked for in the chat, through one validated edit path that records its author. Any edit can be undone unless a later edit changed the same node, edge or spec section. The person approves once. Any ticket may carry a graph, there is no epic kind, and the drafter does not cap the number of criteria.
- Why: approving several sibling contracts one at a time is the slicing a graph removes, and one ticket keeps one approval and one pull request.
- Changes if: people split graph tickets by hand to get them reviewed or merged.
- ADR: [ADR-0037](adr/0037-execution-graph.md).
- Built: the plan's `nodes`, the approach record beside the ticket, the drafter's graph, `perbo edit --graph-edit` and `--undo`, the graph in `perbo inspect`, the pinned checks and the review per node (D-107), and the desktop's Graph pane, which curates the graph through that same edit path, confirms it to the contract where it is approved once, and stays live while the work runs: each node's state derived from the sealed change set, the pinned checks narrowed to that node, each under the pinned command's status (D-107), and the evidence bindings of the review of the plan the ticket now carries, less whatever the rounds since it verified closed, with every changed path no node's globs match shown as outside. A switch under Settings · General, off unless the person turns it on, also marks a node whose own narrowed run did not pass where the pinned command did, beside its state and never as it, saying the pinned command passed and judges the check (D-107). Nothing there is read from the executor's account of itself ([ADR-0023](adr/0023-untrusted-context-boundary.md)).

### D-101 — Create opens planning mode

- Owner: Founder
- Decision: Create moves into the desktop's rail, first (⌘1; Home ⌘2, Archive ⌘3, Settings ⌘4; ⌘N still creates). It opens planning mode for one piece of work: a Spec and an Explorer pane while the spec is written, and the panes a plan needs once one is drafted — for a plan divided into nodes a Graph second, under Spec, then Impact — then the contract, with Problems below it while a problem is open (D-138); the chat is docked beside them. Planning mode also opens for any ticket in `plan_review`. Drafting, impact checks, file reads and the chat run alongside a run, and so do other tickets' runs ([D-049](#d-049--local-host-resources)): a ticket's run starts as soon as its contract is confirmed, whatever another ticket's run is doing, never held or queued behind it. One ticket's run, decisions and publishing take one at a time, and while one is under way that ticket's approval waits for it, the contract naming the one it waits for.
- Why: planning the next piece of work while the last one runs is what the queue is for.
- Built: Create first in the rail with ⌘1 to ⌘4, the picker, planning mode over a contract editing session whose Spec pane holds the spec ([D-103](#d-103--a-spec-is-a-folder-in-the-repository-committed-first)) and offers no second way to start a plan beside it, with the Explorer and Graph panes beside it and the chat docked beside whichever is open but the contract and the Problems pane, and planning alongside a run; the explorer's reads and the chat's three requests are answered outside the job list, so a run never holds one up, the picker opens planning mode over a ticket in `plan_review`; and the Impact pane, which checks once when the planning first has a plan and by its button after that, because its answer is a fresh index of the whole tracked tree, with the count of what falls outside also on the contract page, which is the last screen where a scope can still be widened, answered outside the job list with the explorer's reads.

### D-102 — The chat is the person's own session

- Owner: Founder
- Decision: the chat is the person's own Claude Code, Codex or OpenCode session, run by `perbo interview` and speaking in planning mode as the Architect. It writes the spec and stops there: generating the plan from it is the person's own press, made in one place — **Generate plan** at the foot of the Spec pane, under the spec it drafts from. Once a turn, as soon as the spec is written, or at the turn's end where that comes first, because the session goes on composing after the write and the spec is readable already, the chat puts a note saying the spec is written and naming the three ways on — read and change it on the Spec pane, ask for a change in the chat, or press Generate plan there. The note carries no press of its own, because anything more the person adds to the spec is at their own discretion, and for the rest of that turn the one line under it says only that the turn is finishing, because Generate plan waits for it, and nothing the session says after it is shown, because the note has said it. Generate plan waits for the Architect to finish, and so do Confirm the plan and Confirm contract: while a turn is in flight — from the moment the person sends one until it is over — each press is held, its shortcut does nothing, and the sentence under it says the chat is still talking and the press is theirs once it has finished, so whatever the person last asked the chat for reaches the spec before the drafter reads it, and reaches the plan before a confirm reads it or approves it. Both hosts refuse an approval of a ticket while the chat on a planning over it owes a turn, saying so, so a press that slips past a page is refused too, and a confirm that reaches the Problems pane mid-turn decides nothing until the turn is over. Once it is, the confirm compares the state the turn left, asked of the host at the press, and never a copy read before the turn's edits landed. The person may stop the chat at any moment, mid-turn included — it is their own session — and a stopped turn ends as any turn does, marking what it changed and freeing the press. Behind the pane the host stops the chat and waits for its session to end before it drafts, so a caller that presses mid-turn anyway drafts from the spec that turn left behind. The pane withholds that press while a group of questions the Architect asked still stands, and the host refuses it there too, because the answers change the spec it would draft from (D-117). The session is two conversations in turn under one name, the Chat: while there is no plan it questions the person and writes the spec, and once there is one every turn changes the spec and the plan together (D-128), the conversation from before the plan folded behind one line. Once there is a plan it changes it only through the validated edit path, every edit recorded and the latest one undoable as D-100 says. The chat reports what is said nowhere else — an undo, a refusal, and the edit an undo is still offered on — and not a call that only repeated itself, because what an edit changed is on the graph and a panel for each of fourteen buries the conversation they were asked for in. It may read anything and run read-only commands, may write only the spec folder, `CONTEXT.md` and the ADR folder, and cannot approve, publish or merge. Anything outside that is refused rather than asked: there are no permission prompts. Asking the person about the work is a different act and is what the chat is for: it may put questions with the answers to pick from, which become the person's own words when they pick one and never a way to allow something (D-117). What it says in the chat is only what needs the person — a question, or something that needs their word — and never an account of what it wrote or read or is about to do, nor an offer of what it could do next: a message is two sentences at most and none where nothing needs the person, a question is one sentence, and the message beside a group of questions is at most one sentence on why they arise and restates none of the questions, their answers or its own pick, which the card shows. A chat message is told no number of characters, because a length it is told to stay under is a length it writes up to. It proposes no path marks, which are the person's own. Claude runs through the Claude Agent SDK, Codex through `codex app-server` and OpenCode through `opencode acp` ([D-134](11-open-decisions.md)). The chat runs on the Architect model the person chose under Settings · Connections, from the catalog of the connection the executor runs on, while the planning drafts on that connection; with none chosen, on Claude it runs on Claude Opus 5.5 wherever Claude Code's catalog offers it, and otherwise, as on Codex, on the planning's executor model, which is the model its spec is drafted with. Paseo's design is followed in Perbo's own code; none of Paseo's code is copied.
- Why: a person's own session gets the same trust model the endpoint gives it (D-109).
- Built: `perbo interview`, which runs the person's own session — Claude Code through the Claude Agent SDK, Codex through `codex app-server` — with the bundled grilling and domain-modelling skills in its orientation and its own tools in-process, the chat's rules deciding every call behind either and the transport owning only how its provider is asked and what it streams back; the runner's write guard deciding every write before it runs, with this piece of work's own spec folder, `CONTEXT.md` and the ADR folder as the only writable paths and a list of read-only shapes bounding the commands it is asked about, holding every command that reading finds — the line's own invocations, and each one a substitution, a process substitution, an unquoted here-document body, a wrapper or a function body stands in front of, at any nesting depth — to that list, refusing a bare environment assignment that would set what a later shape resolves and runs in, refusing by name a flag that would let one of those shapes write or run a program, and refusing outright what that reading cannot resolve — a quoting, a command, a variable's value, or a program name a closure check finds unaccounted for — so that nothing but the listed read-only shapes runs, rather than promising that every way to disguise a write is named (SCP-355), each refusal reported rather than asked; four tools and no more, which is the whole of the guarantee that it cannot admit, approve, publish or merge — there is no such tool to reach: `edit_plan` and `undo_edit`, through the validated edit path with the Architect as author; `read_plan`; `ask_options`, which puts what it cannot settle itself as groups of questions with the answers to pick from, one group at a time, answered as an ordinary turn in the options' own words; the streamed JSON-line protocol, which says as the write is admitted that the spec is being written, and the session id kept beside the spec; the same chat on Codex, behind one session interface, where `codex app-server` runs a thread with a read-only sandbox and an `untrusted` approval policy, so that every write and every command outside the set Codex itself trusts as read-only is asked about, each of those questions is answered by the chat's own judgement rather than reaching the person, the chat's tools are the thread's dynamic tools, and `--session` continues the thread through the app server's own resume; the same chat on OpenCode, where `opencode acp` asks about every command, file change and read outside the checkout, each answered by the chat's own judgement, the chat's tools are served to the session on a loopback tool server, and `--session` continues the session through ACP's `session/resume` ([D-134](11-open-decisions.md)); and the chat in planning mode, docked beside every pane, which the desktop host relays that protocol to — it spawns the command as a long-lived child with its argv built from the registered repository and the planning session's own records, shows each refusal as a refusal with nothing to answer, shows the plan edit an undo is still offered on as one line with an undo on its number, and a refused call of the chat's own tools as its name with the first sentence of why under it, whole, and the whole reason behind an `i` where there is more, says the spec is being written on the chat's status line while it is, and puts the note once a turn, a moment after that write lands with no plan beside the spec and the file's bytes are read, or at the turn's end — of its own accord, stopped or dying — where that comes first, holding what the session says in that moment and dropping it once the note is said, or saying it where no note comes; withholds Generate plan while a question stands or a turn is in flight, a turn counted from the moment the dock sends it, and holds Confirm the plan and Confirm contract and the approve shortcut by the same count (`useChatTalking` in `renderer/planning/turn-hold.ts`, each with `chatStillTalking` in `renderer/planning/panes.ts` under it), both hosts refusing an approval over a planning whose chat owes a turn (`turnHoldsApproval` in `shared/contract-editing.ts`), the Problems pane holding a confirm's arrival until the turn is over, and every confirm reading the state it compares from the host as it is pressed (`readingNow` in `renderer/planning/turn-hold.ts`), while Stop the chat stays offered through the turn and is held only while a stop is under way, and drops it once the plan exists, the host refusing that press behind the pane over a standing question and otherwise stopping the Architect and waiting for its child to exit before it drafts; reads itself Chat, folding the conversation from before the plan behind one line once there is one; and keeps the conversation on the planning session so leaving and restarting come back to it.

### D-103 — A spec is a folder in the repository, committed first

- Owner: Founder
- Decision: a spec lives at `specs/<slug>/spec.md` (the folder is configurable), under the headings Outcome, Requirements, No-Gos, Rabbit holes and Notes, naming code as `@Symbol` or by path. Each requirement carries an id, `R1` upward, written into the spec when the requirement is written and never reused. A criterion records the requirement it was drafted from, so the node a requirement lands in is derived from its criteria rather than written down a second time, and is shown beside the requirement's id, the requirement itself being read in the section it is written in. The folder also holds a page per node, `specs/<slug>/nodes/<node>.md`, generated from the spec and the graph: the node's title, the requirements derived to it, its criteria and their verification, its paths, and the spec's No-Gos. A node's page is regenerated whenever either changes, and the Notes section in it is written by hand and survives that. Only `spec.md` is drafted from. The drafter drafts from it as it drafts from an issue, and also reads the repository's `CONTEXT.md`, its ADR titles and `principles.md` as data. Admission records the spec's path and content hash. The CLI, and the desktop's panes and findings, read that path as recorded. The desktop's rename, delete, **Plan it again** and the picker's delete of a spec take it as the ticket's spec only where it is `<folder>/<slug>/spec.md` under the spec folder the repository configures, and treat a ticket recording any other path as drafted from no spec, because each of them ends in a write or a recursive delete. The loop commits the spec folder, with the chat's `CONTEXT.md` and ADR changes, as the first commit on the ticket's branch, and review reads the diff after that commit. `specs/**` is a standing prohibited path for the executor. A spec edited after approval, or naming code that no longer exists, is stale: a ticket that has not started returns to `plan_invalid`, and a running one is flagged and continues.
- Why: a spec is intent upstream of the contract, and its staleness is detected rather than kept in step by hand ([ADR-0016](adr/0016-minimal-machine-maintained-planning.md)). A node reads on its own without giving a requirement a second place to be written, which would drift, and a re-draft moves a requirement between nodes with no edit to the spec.
- Built: the spec folder and the slug the title takes, minted from the person's first turn to the chat where they have not titled the planning themselves (D-118), created when missing, with the folder itself `specs` unless `.perbo/config.json` names another under `specs`; the writer that gives each requirement its id and hands out no id twice; `perbo admit --from-spec <path>`, which reads `spec.md` under those headings, drafts from it as it drafts from an issue, records on the admission record the spec's path, its content hash and every file the loop commits with it — the spec's whole folder, and the `CONTEXT.md` and the files under the ADR folder (`docs/adr` unless `.perbo/config.json` names another under `adr`) that the checkout has changed — and takes the No-Gos from its own heading, with `--start-over <KEY>` re-drafting a ticket in `plan_review` from the same spec; a criterion recording the requirement id it was drafted from; the page per node, regenerated whenever the spec or the graph changes and keeping the Notes written in it by hand; the requirement's node beside it in the Spec pane, which writes the spec into the repository; the spec folder as a standing prohibited path for the executor; and the loop committing those recorded files as the branch's first commit past the contract's base, before the executor runs and with its own `Attempt:` trailer, refusing the run where one of them has changed or gone, and keeping every file that commit holds out of the change set the checks, the review, the verification and the pull request read. Staleness is read from the spec's own bytes against the hash approval recorded — approval and not admission, because D-103 makes an edit *after approval* the stale one and the spec is ordinarily edited in `plan_review` while the draft is read, with admission's hash — and the files the loop commits with it — left standing on a spec approval could not read — and from the `@Symbol` and path names in it against the names approval recorded the repository as having — which is what separates a name the repository has lost from one the plan is for and the work has yet to write — answered against `perbo index` and the checkout, every path judged after it resolves; `perbo run --ticket` reads it before it moves the ticket or makes a worktree and leaves a stale ticket at `plan_invalid`, `perbo inspect` prints it for every ticket drafted from a spec so a run in flight is flagged and not interrupted, a name the index cannot answer for is reported unjudged rather than refusing a run, a ticket approved before the recorded names existed has every name in its spec reported unjudged, only a path git tracks is recorded so a build output in one checkout cannot make a clone read the spec as stale, and approval over a tree the index cannot be believed against records no symbol at all — for the life of the ticket, and records that it happened, so every later reading of it reports the spec's `@Symbol` names as unjudged and names `perbo index` rather than calling the spec current. The reading says which moment it took the spec's bytes from: approval for a contract that has been approved, admission for a ticket still in `plan_review`.

### D-104 — Sizes, not forecasts

- Owner: Founder
- Decision: a plan shows a size, S to XL, derived by fixed thresholds from its nodes, its criteria, and the files and packages in scope, with the counts beside it. S is 1 node, at most 4 criteria, 10 files and 1 package, the size of a ticket before graphs; M at most 3 nodes, 10 criteria, 25 files and 2 packages; L at most 6, 20, 50 and 3; XL beyond. A plan takes the largest size any of its counts reaches. Runs show usage as each provider reports it: tokens always, dollars where given. Nothing forecasts cost or time.
- Why: a description of the graph forecasts nothing, and nothing measures a forecast (D-097).
- Built: `perbo inspect` derives the size and shows it with its counts, marking the ones that set it, and the desktop's Graph pane shows the same size beside the graph, recomputed after every edit. The loop page's strip shows a ticket's usage over every run, tokens always and dollars where a provider gave them, counting along while a run goes from the runner's `tally:` line and read from the records once it ends, its commands the ones an attempt was let run (`admittedCommands`) and each review's usage joined to the attempt its bundle records, a review taken once more after its provider refused it carrying both calls' usage in one bundle; nothing on it forecasts time. Not built: the review and merge screens, Home's cards and the Usage page show dollars alone.

### D-127 — A ticket's name is the fewest words that tell it apart

- Owner: Founder
- Decision: a ticket is called what the drafter named it: as few words as tell this work apart from every other ticket in the repository's store, whatever its state. What it is, not what is being done to make it, and nothing that tells it apart from nothing — the file or folder it lands in, "a single file", "app", "page", the repository. No set length, and at most 60 characters. The drafter is shown every other ticket's name, however many, but for the one it is drafting again, and a name it returns that is already one of them, ignoring case and spacing, is passed over and not refused. Where nothing drafted a name, or the one drafted is taken, a ticket drafted from a spec is called by the spec's title, where it has one (D-118), and failing that every ticket is called by its outcome's first whole sentence. No name is ever over 60 characters and none is a cut: a title or a sentence past them is passed over whole, as a taken one is. Where every one of them is passed over, the first that fits with a number after it that no ticket carries names the ticket — "Dark mode toggle 2" — and failing even that, its key. A name the person gave the spec on the Spec pane is kept for the spec, the ticket and the plan: while the person, not the Architect, was the last to title the spec and the spec still states that title, the ticket is called by it as it stands, whatever the drafter proposed and whatever another ticket is called, and the spec is left as it is. That name is held to the same 60 characters: a longer title is refused at admission, for the person to shorten, and never cut. An edit never renames a ticket: the outcome may be reworded as often as a person likes and the name stays. The name is display only: the branch and the pull request are named from the approved outcome, and no name reaches a path, a branch or a command ([ADR-0023](adr/0023-untrusted-context-boundary.md) §4). A name a person gives a ticket on the board is held to the same 60 characters, is kept on that machine, not on the ticket, and the drafter is not shown it. A ticket drafted from a spec and its spec carry one name: every admission without `--keep-title`, `--start-over` included, rewrites the spec's title line to the ticket's name, and when a person renames a ticket that is not yet approved, its spec's title follows. Only the title line moves; the folder keeps the slug it was minted with, which the admission record names. An approved ticket's spec is left as approval read it, because the run commits it against the hash approval recorded (D-103).
- Why: a board is read by scanning it, and a name that repeats its neighbours' words or carries the whole outcome makes every row read alike. Only the other names say which words tell this one apart, so the drafter is shown them, and an exact repeat is caught by a check rather than by the prompt. An edit that renamed the ticket to its outcome would put back the sentence the name exists to replace. The Spec pane, the picker and the contract's head each show the work's name, and a spec titled one way beside a ticket named another reads as two pieces of work. A name the person typed is their own choice of what the work is called, and admission replacing it with a model's would take that choice back.
- Built: `draftContract` in `@perbo/planning` shows the drafter a `names` block beside the board and requires the draft's `name` under this rule (`draft_v7`); `perbo admit` passes every ticket's title but the one `--start-over` names. `ticketName` in `@perbo/planning`, exported from its root and browser entries, chooses the drafted name, the spec's title where it has one, then the outcome's first sentence (`firstSentence`), passing over one `sameName` (`@perbo/contracts`) finds taken and one past `TICKET_NAME_CAP`, then the first of them with the lowest free number after it that fits, then the ticket's key; `perbo admit` names every ticket with it, a typed one, which has no drafted name, against every ticket in the store as a drafted one is, and the desktop's sample host names a sample ticket with it too, from its spec's title and its outcome, since it has no drafter; with `--keep-title` it takes the spec's title as it stands, `keptTitleRefusal` refusing one past `TICKET_NAME_CAP` (`@perbo/contracts`) before a model is asked, which the sample host refuses in the same words before it drafts, and the spec is left unwritten; that one constant is the 60 characters the drafter's schema, admission and the desktop's rename each hold a name to; `perbo edit` leaves the title alone, and so does the sample host. The desktop drafts through `perbo admit --from-spec`, so it names tickets the same way. The planning session's `named` records who last titled its spec and with what: the person, from a Spec-pane save that changed the title it read, spacing aside, or the Architect, from a chat turn that left the spec stating another title than it began with, and not one that left it with none (D-118); `keepsPersonsTitle` in `apps/desktop/src/shared/contract-editing.ts` adds `--keep-title` to Generate plan, to Start over and to `replan` where the person's is the title the spec states; `replan` carries the record to the planning over the plan it drafts again, and the sample host keeps the same record under the same rule. `retitleSpecFile` in `@perbo/planning` is the one writer of the spec's title line: `perbo admit` calls it once nothing can refuse the admission and records the spec's hash as renamed, so the drift verdict it seeds holds, and the desktop host calls it when a ticket not yet approved is renamed; the sample host titles its spec with `retitleSpec` at the same two moments.

### D-015 — Perbo reads code and never edits it

- Owner: Founder
- Decision: editing code stays in the person's editor. Perbo's surfaces read code and write only planning artifacts. The one piece of code intelligence is a TypeScript and JavaScript symbol and import index, built on demand for impact warnings, `@Symbol` completion and stale-spec checks.
- Why: every surface serves writing a spec and a contract; none needs an editor or a language server.
- Changes if: people ask to edit code inside Perbo more than they use their editor.
- ADR: [ADR-0018](adr/0018-defer-custom-ide-until-evidence-gates.md).
- Built: the index itself, `perbo index`; `@Symbol` completion over it in the desktop's Spec pane — the repository's exported names offered as a reference is typed, the one chosen written in with the caret past it, every reference marked behind the text, one the index does not hold marked apart with the two nearest names offered in its place and each replacing every use of it in that section, and a head saying how many do not resolve, with the index's size and the commit it was built at behind the **i** beside it; impact warnings over it in planning mode's Impact pane, which lists what the draft in hand is likely to touch that its scope does not cover, once when the planning first has a plan and by its button after that: files outside that scope importing what the draft changes or what the spec names, and the path classes `risk.ts` recognises in a package the scope or the spec reaches, each warning advice that becomes a scope change through the draft's own mark or a No-Go through the spec's own save, on the person's click; and the stale-spec check over it (D-103), which reads the record only where it was built at this checkout's commit with nothing uncommitted either side — a reading that cannot believe the index reports what it could not judge, and an approval that cannot believe it records no `@Symbol` at all, for the life of the ticket, recording that it could not so every later reading of that ticket says so too, since nothing after approval puts those names back, which is why the index matters most at approval. The two panes read the index through the host running `perbo index` over the registered repository and nothing a renderer sent, and the stale-spec check reads the `.perbo/index.json` the checkout already holds and runs nothing ([ADR-0023](adr/0023-untrusted-context-boundary.md) §4), and a repository the index cannot describe is said to be one rather than shown as an index holding no names, because a person acts differently on each. Not built: nothing.

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
- Built: the guard's refusal, with the review's finding behind it, and a repository's standing prohibited list under `paths_prohibited` in `.perbo/config.json`, each entry carrying what put it there. The planning mode explorer writes it, admission folds it into every new ticket's `paths_prohibited`, the guard reads it again when a run starts, so an entry added after admission binds the ticket's later runs, and `perbo doctor` reports it in its own `PROHIBITED` block. Under Windows semantics the guard also refuses a spelling Windows resolves to a prohibited path — another letter case, a trailing dot or space, a stream, a short 8.3 name — which the review's exact match does not see. It refuses a write to a whole directory a prohibited glob covers or names a place inside, too — `rm -r src/generated` under `src/generated/**`, `rm -r src` under the same glob, and the worktree root under any prohibited glob — and to a directory a prohibited glob reaches inside through a wildcard where something on disk that the write removes or puts there matches it, inside the allowed paths as much as outside them — `rm -r src/keys` under `**/*.pem` while `src/keys/k.pem` is there — which the review sees only as the files under it; `rm -rf src/lib` with nothing matching under it is admitted. `mkdir`, `rmdir`, `touch` and `mkfifo` are judged as the directory itself, since they write nothing below it. A `cp`, `mv`, `install` or `ln` into a directory on disk is judged by the path each source takes there, `src/other/a.ts` for `cp src/a.ts src/other/`, and a source that is a directory on disk as a directory under that name holding what the source holds; a destination judged whole holds what each source inside the worktree that is a directory on disk holds, as well as what is on disk there. Each source of an `mv` is judged as a write to its own path, since the move removes it from there. A backup a `cp`, `mv`, `ln`, `install`, `rsync` or `sed -i` keeps beside what it replaces, `<dest><suffix>`, is judged as a write too, the word after a bare `sed -i` being BSD's suffix only where GNU cannot read it as the script or the file it takes it for, and a writer's long option is read by any unambiguous prefix, as GNU reads it, so `cp --t=/tmp` is refused as `cp --target-directory=/tmp` is. A `sed` script is read as GNU and BSD `sed` read it: the file a `w` or `W` command or an `s///w` flag names is judged as a write, and its `e` command, its `s///e` flag and a script the line does not spell are refused as a program run. A word the line builds when it runs — a substitution, or a variable the line assigns one — where a command whose options can write or run a program still reads options is refused, since it can be the option that writes, and a variable the line assigns a value it spells is judged with that value in its place as well as as written: `git diff $(git merge-base HEAD main)` and `X=--output=/tmp/x; git diff $X` are refused, and `git diff --end-of-options $(git merge-base HEAD main)`, `pnpm test -- $(git ls-files src)`, `python3 -m pytest $(git ls-files test)` and `rg -e "$(cat pat)" src` admitted, because every command stops reading options at `--`, `node` and Python at the program they run, and an option's value is a value. A word where the program or `git`'s verb stands that begins with an expansion, `$Y` or a variable the line assigns in a subshell, ends nothing, so `node $Y "$(printf -- -e)" …` is refused, and a substitution that prints an object name or an absolute path begins no option, so `node "$(git rev-parse --show-toplevel)/scripts/build.js"` is admitted (docs/08).

### D-096 — No ceilings on a run; a stall detector stops a hang

- Owner: Founder
- Decision: an attempt has no cost, token, wall-clock, iteration or command ceiling. A stall detector stops an attempt that shows no tool activity for a set time. The per-ticket limit on remediation rounds stays. A cost cap remains only where the executor is billed per token, with an API key in its environment. After every compaction, the executor and each subagent receive their brief again.
- Why: people read spend on their own provider accounts, so what still has to stop is a hang, and a credential that bills per token. Every iteration ceiling that fired cut ordinary work.
- Changes if: an attempt runs away in a way the stall detector does not see.
- Built: the stall detector (`attempt_stall_ms`, 20 minutes by default; a stall terminates the attempt `stalled` and ends the run), the ceilings removed, the cost caps bound to a per-token credential, and the brief after every compaction — a `SessionStart` hook under the `compact` matcher on Claude, `thread/inject_items` answering a `contextCompaction` item on Codex, the recorded brief plus a state block composed from the round's records, and each re-injection on the attempt; on OpenCode the brief rides in the session's own instructions, which a compaction does not remove, so there is nothing to re-inject and no state block is composed ([D-134](11-open-decisions.md)). Not built: nothing.

### D-106 — The executor may delegate to subagents

- Owner: Founder
- Decision: on Claude and on Codex, the executor may start subagents from roles Perbo defines. The runner enforces only the trust boundaries: every subagent write passes the ticket's scope guard, repository and personal agent definitions stay unreachable, every subagent's activity is recorded against it, and the reviewer receives none of it. How many subagents, which roles and which model are the executor's call. Codex needs version 0.145.0 or later.
- Why: delegation is the executor's responsibility; the product keeps the checks that protect scope and independence.
- Changes if: a subagent write escapes the scope guard, or a subagent's account reaches review.
- ADR: [ADR-0038](adr/0038-subagents.md).
- Built on Claude: three roles Perbo defines, passed as `--agents` and enforced by the guard's hook, which now judges the tool under both names Claude Code answers to for it — `Agent` and `Task` — and refuses both a `subagent_type` outside them and a call a subagent made, whatever role that one names; the guard's directory kept per agent in one file each, so interleaved calls lose nothing, and a call refused, rather than judged from a directory the shell has left, wherever the guard cannot keep track of an agent's directory — a file that will not read back, or a move it cannot record; personal definitions held unreachable by the closed set and by the measured precedence of `--agents` over `~/.claude/agents` on a shared name (ADR-0038, 2026-09-15); every command record naming the role that ran it, except the two the runner is handed no name for — a refusal reported only by the result envelope, which names no agent, and the amendment that refusal makes, which is keyed by tool and command text and so can land on an identical line another agent ran; and the executor's account taken from the top-level session's last message alone. Built on Codex (SCP-327): the same three roles, written as `agents/<name>.toml` files under the isolated `CODEX_HOME` with `agents.enabled=true`; the write guard's state and Codex's own usage report kept per thread instead of one shared object, since a spawned agent is its own thread; a subagent starting one of its own refused reactively, as the attempt `prohibited_action` (`enable_own_tooling`), because Codex offers no request to refuse a spawn before it happens; a child's role looked up once with `thread/read` on its first activity and named on its command records; a child thread's items written to the attempt's retained transcript marked `subagent`, so what reads the record back never takes a subagent's words for the executor's; and `doctor` refusing a Codex older than 0.145.0, wherever the binary is checked. How it holds is in ADR-0038. Not built: whether Codex itself restricts a spawn's role to the ones configured, rather than a free-form or unnamed one — a live run settles it. The live test both halves build from is recorded in ADR-0038 (2026-09-12).

### D-134 — OpenCode is a connection for all three roles

- Owner: Founder
- Decision: OpenCode is a connection beside Claude Code and Codex, and the person chooses it per role: the executor (`agent_provider: opencode-cli`), the reviewer (`reviewer_provider: opencode-cli`) and the chat (`perbo interview --provider opencode`, the drafting choice in planning mode). Every role runs `opencode acp`, OpenCode 2.0.14 or later, and holds it to the guarantees the other connections are held to. OpenCode runs its own tools, and every command, every file change and every call reaching outside the role's directory is put to Perbo before it runs and answered by the runner's write guard for the executor and by the chat's rules for the chat — once, never for the session — while every other tool of OpenCode's, subagents, skills, web fetch and search among them, is denied and so not offered. A refusal ends OpenCode's turn, so the role starts the next one itself with the refusal in its own words. Each role runs OpenCode under directories Perbo made for the process, with the project's configuration off and no tool server, plugin, formatter, language server, sharing or update, and its own text in the one instruction file OpenCode reads, which a compaction does not remove; the chat keeps its sessions so `--session` continues one, outside the checkout in a mode-0700 directory of Perbo's own per repository under `~/.perbo/opencode/`, and refuses to start where that directory holds anything Perbo does not recognise from OpenCode 2.0.14, since a repository that carried OpenCode's database would carry saved approvals with it ([ADR-0030](adr/0030-neutralise-repository-supplied-agent-configuration.md)). OpenCode keeps a login and the "always allow" rules a person gave it in one database, and a saved rule decides a call before any client is asked, so no role reads the person's OpenCode data: a role authenticates with `OPENCODE_API_KEY`, OpenCode Zen's key, passed by name, or runs OpenCode's free models without one, and the connection offers no sign-in. The reviewer holds no tool it can use and answers in JSON the transport reads only whole, because ACP carries no output schema; a read or a command its model reaches for is refused and the review's turn carries on, the model told no tool is available, up to three refused calls a turn. OpenCode takes no effort level from Perbo.
- Why: the founder's ruling that OpenCode is wired to all three roles for the person to choose, and a connection is only offered where its protocol lets Perbo keep the guard, the egress allow-list, the configuration boundary and the verdict's shape it keeps on the others ([ADR-0023](adr/0023-untrusted-context-boundary.md), [ADR-0030](adr/0030-neutralise-repository-supplied-agent-configuration.md)).
- Changes if: OpenCode carries a person's login apart from their saved approvals, which would let a role run on their own sign-in; or ACP gains an output schema, which the reviewer would then use.
- Built: the executor adapter (`packages/runner/src/opencode/`), the reviewer transport (`packages/model/src/opencode.ts`), the chat transport (`apps/cli/src/commands/interview/opencode.ts`), whose four tools are served to the session on a loopback tool server behind a token of the process's own; the configuration every role starts with, in `@perbo/contracts`; `perbo doctor` naming the OpenCode each role runs and refusing one older than 2.0.14; the desktop's OpenCode connection and model catalogue, read under the same configuration from OpenCode's own server (`opencode serve`), not from ACP's `session/new`, whose list on 2.0.14 offers a priced model behind a key nobody set and refuses it at the turn: the catalogue lists a model only where OpenCode reports its price as nothing or its provider's integration as connected, reading the model list until two readings agree and each of OpenCode's lists entry by entry, leaving out an entry it does not know, says in one sentence where nothing can run or OpenCode's answer cannot be read, and removes the server's scratch home only once the server has exited; and every role, before it opens its own session, waits in sessions of scratch directories until OpenCode's ACP server offers the model it runs (`awaitOpenCodeModel`), because the server keeps the catalogue a directory's first session saw, which before its plugins settle lacks models the settled one holds and names another default — the chat with no model named waits until two such sessions name the same default with none but refused ones between them, and selects that default by name for a new session while a resumed one keeps the model it already runs on — a session OpenCode refuses counting toward the sessions the wait may open, and any other failure, the process gone or, for the reviewer alone, a request timed out, ending the wait at once in its own words. Two agreeing sessions stand for a settled catalogue only while OpenCode's plugins settle within the gap between them (`OPENCODE_SESSION_RETRY_MS`): where they take longer, two unsettled snapshots agree, and the chat runs on the unsettled default, or is refused it where the settled catalogue lacks it. The reviewer's session, whose read and shell tools are there only because OpenCode Zen's free models refuse a session offering neither, asks about both and refuses every call, never `always`, so none runs and its empty scratch directory stays empty: OpenCode then ends its turn `cancelled`, and the review's turn prompts again in the same session with one sentence saying no tool is available to the reviewer (`NO_TOOLS`), its usage and dollars summed into the turn, until the model answers or has had four calls refused in the turn, which fails it `provider_unavailable` naming the count (`REVIEWER_REFUSED_TOOL_CALLS`, three), and a tool OpenCode reports having run fails it outright. The model package's lint boundary exempts `packages/model/src/opencode.ts` from its ban on starting a process, as it exempts the other two CLI transports, the shell-string ban holding there still; that exemption changes a check the product runs and is a person's change ([D-079](11-open-decisions.md)). Not built: subagents on OpenCode, whose `task` tool is denied; a person's own OpenCode login, which no role reads; and the regression suite through the OpenCode reviewer — `packages/evaluation` refuses `--provider opencode-cli`, so no D-010 measurement covers it, and adding it changes the harness that scores the reviewer, which is a person's change (D-079).

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
- Decision: the routing policy in force sends every stopping finding on a routable row to the executor. The executor either closes it by the established practice (a platform primitive, a lockfile dependency, the settled pattern, implemented completely) or declares `NO_PRACTICE <finding_key>: <reason>`. A declined finding stays open, ends the loop `escalated`, is put to the person on the decision screen with the executor's reason beside it, asked for one of the three answers where the review takes one and for a principle alone otherwise (D-132), and reaches the pull request under "No determinable practice — for you to decide". `security.*` and `context.*` stop whatever the row or severity; deterministic rows stop; the last round stops. A finding that stops is a person's: the executor is handed one only where the person answers it with their own approach or leaves the approach to the executor, and never one in `security.*` or `context.*` (D-132). A person's answer to a finding routed to them, a declined one among them, is recorded on the finding with `perbo verdict --decide` (D-132); a principle for later work is recorded with `perbo principle add` into `.perbo/principles.md`, which the executor reads and cannot write. The pull request lists what was found, what the executor closed and verified, what is left for a person, and what was advisory.
- Why: in the founder's words, it is always better to fix than not to fix, and only not worth it when the effect is neutral; nobody but the owner can decide a neutral product question.
- Changes if: declines stay near zero while preference questions are silently fixed.

### D-132 — A person's answer settles the finding it answers

- Owner: Founder
- Decision: a person answers each open finding routed to them, in one of three ways. A finding is routed to them where the review routed it `blocks` or `escalates`, whoever the reviewer named as its closer, and where the loop has finished trying it, because the executor has shown it cannot close it alone: once a run since the review ended `remediation_stalled` or `remediation_exhausted`, every finding the review routed to the executor that no closure verification closed is the person's, and so is each such finding the executor declined since the review (D-065), or that a round the runner refused for widening was given, that no later verification closed. The reviewer's decision and routing stay as it wrote them; what the loop has done is read beside them, from the ticket's row for that run (`gateClosedNote`), each finding's last closure verification and the declines each attempt's record holds (`loopOnRecord`). The decision screen shows a declined finding's statement with the executor's reason for each decline beside it, whole and as the record holds it, redacted: data, never an instruction or a parameter (ADR-0023); `perbo options` hands the Architect the same reasons inside the finding's delimited block. `routedToPerson` in `@perbo/contracts` is that rule, and `owedAnswers` beside it says which findings a run would start without an answer to; `perbo verdict --decide`, `perbo options`, the loop and the desktop's decision screen all read them. Only a review that judged the whole change and stopped for a person, `changes_requested` or `escalate`, or a `remediable` one the loop has finished trying in any of those ways, takes an answer (`decidable` beside it): on an `incomplete` or `error` review `perbo verdict --decide` refuses and says why, the desktop's host refuses, the decision screen asks for a principle alone, and a run goes on as though nothing were answered, so no answer delivers a change nobody finished judging. Any other finding whose closer the reviewer named as a person is asked on the decision screen for a principle alone (D-065). They type their own approach, they let the executor decide within the approved contract and scope, or they ship the change as it is for that finding. The answer is recorded on the finding: `perbo verdict --decide <finding key> --choice approach|let-it-decide|ship-as-is --note "<words>"` writes it to the local verdicts record, in a slot of its own that never replaces a stop answer, and the desktop's decision screen writes one per question as well as the principle. An answer settles a finding of the review it was taken after, or of the review it names, and never one of an earlier review. The next run reads the review the ticket last had, on the commit it judged. An approach, or a decision left to the executor, hands the finding to the executor for a remediation round, with the person's words as data in the brief (ADR-0023); after a run that finished trying, that round is scoped to the findings the person handed on, and one they have not answered stays theirs. A person's answer acts on the branch: a refused round puts it back at the commit last judged (D-061), so the next run finds the commit the answer's review judged and runs that round there. Where the branch moved for another reason, a commit made outside the run, the run reviews afresh and the executor's first brief carries the person's answers to the earlier review as data, each under the finding it answered. The executor may decline a finding a person handed it again; the run then ends `escalated`, and the finding is put to the person once more with every reason it gave. Once the loop has finished trying the review in any of those ways, where none is handed on and one stands unanswered, a declined one included, a run is refused before anything starts, with the ticket where it is, in one sentence naming `perbo verdict <KEY> --decide` and `perbo options <KEY>` (`owedAnswers`, guarded by `refuseOwedAnswers` in `@perbo/runner`): `perbo run` refuses it before it moves the ticket, the loop again under its run lock, and the desktop's host before it starts the command. Each reads the branch the ticket's records name the same way (`ticketBranchStillAt` in `@perbo/workspace`, against `judgedCommit`): a branch that has moved past the commit judged, a person's own commit on it included, is reviewed afresh rather than refused. The ticket's history is never rewritten: a refusal by the loop after the command moved the ticket appends a row that returns it to the state the command found it in, `changes_requested` or `failed`, under `ANSWERS_OWED_NOTE`, and every row written since, another run's included, stands; a reader of how the last run ended passes over that row (`settledRow`). The host puts that fact on the ticket it reads (`Detail.owed`), and the contract page offers Answer in place of Start the loop where it holds a question. An explicit `--resume-from` carries an attempt's work into a fresh review and is not refused. This is the one way D-065 lets the executor be handed a finding that blocks or escalates. A `security.*` or `context.*` finding is never handed to it, so its only answer is to ship it as it is: the decision screen offers no other, and the desktop's host refuses a set of answers holding one it cannot take before it records any. The closure verifier checks the round, not a fresh review (D-061). A finding it closes is never handed again. A round that stalls or exhausts its attempts with a handed finding still open ends the run `escalated`, the finding open for the person to decide again; a round that regressed a check or the scope ends the run as a change request, as any round does. The run delivers once nothing routed to a person is open and every finding handed to the executor is closed. A finding shipped as it is is closed by the answer itself, so a run on which every standing finding is shipped as it is or already verified closed executes nothing, reviews nothing again and goes where an approval goes. The ticket then moves from `provisioning` to `pr_open` on that run's own row; with publishing on and no attempt on record that sealed the judged commit, the run stops `terminated` and says so rather than moving the ticket with no pull request. The review on record is never written again: every reader takes the answers and the closure verifications beside it. The loop records each answer on its finding in the review it returns, and the pull request lists them, by name and never by address. An answer is not a stop answer, so precision of stopping never counts it (D-060), and the AI stand-in cannot record one (D-121). On the desktop a decision that answers a finding publishes as the run that stopped for it was going to, and a principle alone publishes nothing. A pause is never empty: the loop page's pause, its decision card, the wheel's "Decision required", Home's yellow and the decision notice all count the questions the record puts to the person (`decisionQuestions`), and a ticket in `changes_requested` with none is a stop, red on Home, whose stopped page says how its run ended in words and offers **Plan it again** as the way forward, since nobody can answer its verdict (D-129), unless its pull request is open, as an escalated run that published leaves it: then neither Plan it again nor Delete is offered, and the page says in one sentence naming the pull request that it is closed or merged on GitHub first and then read again with **Refresh from GitHub**, which the page offers: once that reads it closed or merged, both are offered again. One whose review cannot be read is a stop too, its page saying so.
- Why: the reviewer keeps no state between reviews, so a fresh review of an unchanged commit raises the same findings again. A run that stalled or ran out of rounds, or an executor that declined a finding, has shown the executor cannot close what it left open, so another round is the same brief against the same evidence; left routed to the executor, those findings are a pause with nothing to answer and no way forward, and a run started on them unanswered pays for that brief again and ends on the same questions. A principle reaches only the executor, so an answer recorded only as a principle settles nothing, and the same person is asked the same questions on every run. An answer that asks for a change needs a round to make it, and one that asks for none needs no round at all.
- Built: the three answers through `perbo verdict --decide --choice` and the desktop's decision screen; the findings a stalled or exhausted run left open, and the findings the executor declined, put to the person by every reader, the executor's reasons beside them; a run refused while they stand unanswered with none handed on, on the branch as the loop reads it, by the command, by the loop, which appends the row that returns the ticket, and by the desktop's host, whose ticket read says so for the contract page; the round on the findings handed to the executor, verified closed, and the delivery without a round where every answer shipped the change as it is; the pause, Home's colour and the decision notice only where a question is put; each answer printed under its finding by `perbo inspect`; the desktop asking nothing already shipped as it is or verified closed; the pull request section; the lifecycle rows from `provisioning` to `pr_open`, and to `changes_requested` under `ANSWERS_OWED_NOTE`; and a finding shipped as it is read as closed on the plan's graph. Not built: the reviewer is not given the answered findings as data on a later review. Its inputs are the ones `buildContext` in `packages/review/src/prompt.ts` renders (the plan, the change set, the checks and the tree), and adding one is a change to the reviewer's prompt, which carries a regression-suite run (D-010). Until then an answer settles a finding only on the review it answered: a branch moved by a commit made outside the run is reviewed afresh, and a finding that review raises again is asked again, while only the executor's brief carries the earlier answers. A run that ends `escalated` with nothing asked, as an incomplete review's can, is a stop whose page says the review put nothing to the person.

### D-135 — The decision screen offers the Architect's answers

- Owner: Founder
- Decision: each question on the loop page's decision screen that takes the person's words offers answers to pick, as the Architect's questions in the chat do. The Architect proposes two to four principles from the finding's statement, the criterion it sits on, the approved contract and the change the review judged, each one or two sentences written whole, one marked recommended and listed first; "Something else" comes last and opens the field the person types their own approach in. Ship as it is stays a fixed answer where the finding takes it (D-132), and Let it decide stays the button beside Save and continue and is never one of the answers. A picked answer is the person's approach exactly as typed words are: the same choice and the same principle, recorded as D-132 records it, and nothing the model wrote becomes a branch, a path, a command or a target ([ADR-0023](adr/0023-untrusted-context-boundary.md)). The answers come from `perbo options <KEY> --finding <key>…`, which the desktop's host runs on the Architect's own provider and model (D-102), with the person's credential inherited and written nowhere, once as the card opens and for every question at once. They are kept beside the ticket in `<KEY>.options.json` for the review they answer, so opening the card again spends nothing, and a later review replaces them. The model is told an answer's length, 400 characters; an answer past it once redacted, a finding left unanswered, or answers without exactly one recommended is handed back to the same session to put right, at most twice, and never cut (D-133). The two to four is the prompt's request and not a bound: how many answers are kept is not limited. While they are asked for, the typed field is there at once; if they cannot be had, the card says so in one sentence with why behind its "i", and the field stands. A finding never handed to the executor takes only Ship as it is, and nothing is asked for it.
- Why: the founder's ruling. A person asked a product question answers faster by picking from concrete answers than by writing a principle from nothing, as they already do in the chat, and Let it decide is already the button beside Save and continue, so offering it again among the answers would be a second way to say one thing.
- Changes if: people write their own answer far more often than they pick one, or pick the recommended one without reading the others.

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
- Decision: a `check.*` finding whose pinned check ran and failed on the change's tree, where the base passed the workspace's verify command, routes to the executor for one round with the pinned command and the check's last lines. The verifier runs the pinned checks again before asking anything else, and where one still fails it says which, by its command, and what the round changed. A check that did not run, or one that fails on a base that did not verify, stops at once.
- Why: a failing check the change caused is the executor's to fix, and one round removes it.
- Changes if: rounds are spent on checks the executor cannot fix.

### D-061 — Later rounds verify the fix; they do not review again

- Owner: Founder
- Decision: a change gets one full independent review. Every later round runs closure verification: for each routed finding, whether the fix closed it. The pinned checks and the scope computation run first and can only fail the verification, and `cannot_tell` counts as not closed. A round that widened the change set instead of narrowing it is refused before any verification is paid for; the refused commit and its diff stay on the record and the runner puts the ticket's branch back at the commit last judged (`restoreJudgedCommit`), so the next run verifies a round built on judged work rather than reviewing work nobody judged. It moves only the ticket's own branch, only backwards along its line and only by argv git, and leaves the branch where it is where the worktree is not on the ticket's branch, where the branch does not carry the judged commit, or where the record holds no readable review, as with `retain_context: false`.
- Why: every further full review is another independent chance to stop correct work, so the loop would not terminate.
- Changes if: changes pass verification while a person, reading them, would say the finding is still there.

### D-107 — A graph is reviewed per node and once overall

- Owner: Founder
- Decision: a ticket with an execution graph is reviewed once per node (that node's criteria, and the part of the diff inside its paths) and once over the whole change, for the outcome, anything that crosses nodes, and any path allowed in the explorer that no node names. The pinned checks are also recorded once per node and reach that node's review; where the whole change passed, a unit check runs again narrowed to the node's changed test files with the check's own runner, as a failed check's re-run is, and only the pinned command's result judges the check. It changes the reviewer, so it carries a regression-suite run and adds graph-shaped fixtures to the corpus. No-Gos brief the executor; nothing checks them yet.
- Why: each review stays near the size of change the reviewer is measured on, and a node's own tests are evidence for its review.
- Built: the pinned checks per node, narrowed to the node's changed test files with the check's own runner where the whole change passed, and the whole-change result otherwise, recorded with the attempt and shown per node in `perbo inspect`; a narrowed result also records what the node's own run came to as `run_status`, beside the pinned command's status, which nothing decides on and which `perbo inspect` prints beside the node's check; review per node and once overall (SCP-328) — `reviewGraph` reviews each node in plan order, on that node's criteria, the part of the diff inside its paths and that node's own check results, then the whole change unnarrowed but for its checks, and combines the N+1 artifacts into the gate's one view: the stricter reading wins wherever the overall review and a node's judged the same criterion, and where the same finding key repeats across them, the reading the gate treats as stricter wins — blocking, then escalating, then remediable — and the first where none of those tell the two apart — so a node-local blocking or escalating finding closes the gate on its own, even against a repeated key the whole-change review itself read as advisory. A node with no file inside its paths is not reviewed on its own. The per-node artifacts are recorded beside the combined one in the ticket store and shown per node in `perbo inspect`, beside its checks. A flat plan calls the reviewer once, on its input as the caller built it. The graph-shaped corpus fixtures. Not built: No-Gos still brief the executor; nothing checks them yet.

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

### D-136 — A person publishes a retained branch later

- Owner: Founder
- Decision: a run that ended `approved` or `escalated` without publishing keeps its branch on the machine and opens nothing. A person's press publishes that branch later: `perbo run --ticket <KEY> --publish-retained`, or Merge on GitHub on the desktop's merge screen, which the review screen's Next always leads to. It goes through the same delivery a publishing run ends in: the runner pushes the branch and opens the pull request against the base with the review on record and the person's answers under it, holding the person's credential, then takes the merge step and reads the head's checks. The body is the one the run would have opened itself: its attempts, what each closure verification of them cost, read from the verification's bundle, and what the executor declined (D-065), which each attempt records at its seal. Nothing is executed or reviewed again, so the machine is asked for `git` and `gh` and nothing else. It refuses, and pushes nothing, where the ticket's last run did not end so, which is said before the machine is asked anything, where the ticket already has its pull request or its delivery is not the loop's own, where a run of the ticket holds its run lock, where the plan has no acceptance criteria, so no review judged it, where the branch is not one the loop minted, where no review or no attempt that sealed the judged commit is on record, where the run ended `escalated` and an attempt's record does not say what its executor declined, where the branch has moved past the commit the review judged, where what the branch carries past its base could not be listed whole, so whether the loop made all of it cannot be said, where the branch carries a commit the loop did not make, or where the base names no commit or has moved past what the run judged; each refusal names what it found, and `perbo run --ticket <KEY> --publish` judges what is there instead. The ticket stays in the state the run left it, and only its delivery record changes, written before the run lock is let go. On the desktop the press then opens the pull request in the browser, as it does where one is already open.
- Why: a retained branch is a change the review has already judged, so publishing it takes a person's press and not another run; and what is published has to be exactly that change, with the pull request that run would have opened.
- Built: `perbo run --ticket <KEY> --publish-retained` and the desktop's Merge on GitHub press over it, with every refusal above; the ticket is read once before the machine is asked anything and again under the run lock, so a run of the ticket that started and ended between the two is refused by what it left. A known limit: where a later run of the ticket declines without making a new commit, the branch is still at the commit the review judged, so the pull request lists the attempts of the run that sealed that commit, what they cost and what their executors declined, and not what the later run's executor declined.

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
  - starts a `perbo run --ticket` child for every ready ticket not already running, in queue order and in the same tick, up to `concurrent_local_attempts` where the limits set one (D-049);
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
- Decision: runs of different tickets go on at the same time, as many as are started. `concurrent_local_attempts` is unbounded unless a repository's limits set a number, which then holds this machine to it, hand-started runs included. One ticket takes one run, decision or publication at a time, held by its run lock. A worktree's lease on this host holds while the run's process lives, so one ticket's provisioning never reclaims another's worktree mid-run, and for seven days at most from when that process took it, because a process id the system has handed on answers too. A review its provider refused waits and is taken once more over the same sealed commit before its verdict is routed, because runs side by side make a rate limit likely: until the reset the provider stated, where that is within `wait_for_provider_ms`, at once where that reset has already passed, and the fixed transport delay where it stated none; a stated reset past the bound is not waited for and ends the run `review_failed` naming the reset and the key, and so does a second refusal. A `local_workspace_bytes` budget reclaims leases on total size as well as staleness. A suspended host is a disconnect: an attempt running across it ends with `host_suspended`, and ending it kills the agent's process group.
- Why: the founder's ruling, "the user should be able to run them in parallel", and no caps on what the product does. The disk is a developer's laptop, so its budget stays.
- Changes if: an attempt's peak disk use passes 10 GiB, or runs side by side on one laptop fail where the same runs one at a time pass.
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
- Decision: every context item carries a trust label: `system`, `user`, `repo` or `external`. Repository and external content never occupies an instruction position. The verdict is structured output over the plan's criteria, deterministic checks outrank any model claim about them, and no model output becomes an action parameter. The executor's egress allow-list is the model provider, GitHub and the package registries, plus the exact host names a repository lists under `network_allow_list` in `.perbo/config.json`.
- Why: test output, documentation, dependency READMEs and issue bodies are attacker-controlled in any repository with contributors, and a repository's own tooling fetches from hosts outside the defaults, as Chrome for Testing does.
- Changes if: a fixture flips a verdict or something is exfiltrated.
- ADR: [ADR-0023](adr/0023-untrusted-context-boundary.md).

### D-137 — An unlisted host asks the person

- Owner: Founder
- Decision: a host off the executor's resolved allow-list (D-035) named by a call the runner holds before it runs — a tool call the write guard's hook answers under Claude Code, a command Codex asks approval for, or a command OpenCode asks permission for over ACP — is put to the person as a question, and the attempt waits on the answer rather than stopping. One question per run, not per host: the first unlisted host asks, and every later one in that run is refused without asking and recorded, the executor told in the refusal that the network is closed for the rest of the run and to finish without it. Refuse is the default and the highlighted answer, with Allow beside it. An allow is that one host, not a category: the held call runs, the host joins the run's live list and the repository's `network_allow_list` in `.perbo/config.json`, and the same attempt carries on. A refusal refuses the held call, tells the executor the network is closed for the rest of the run, and is remembered on the ticket, so that host is never asked about again on it and is refused on every later run of it. The wait is the attempt's stall window, `attempt_stall_ms`, which does not count the wait as idle; unanswered within it, the attempt ends `unlisted_egress_host`, as it does where nothing holds the call — a tool the guard is not installed for, such as Read, Glob or Grep. Only a plain host name is asked about, since only that can be written to the list; any other is refused. The run records the question on the ticket, in `<store>/state/<ticket id>.egress.json`, with its key, the host, the whole command, the attempt waiting on it and when it expires, and prints it as a progress line. The person answers with `perbo verdict <KEY> --egress <question key> --allow|--refuse`, or on the desktop's card, which is in the decision card's frame under "Decisions required", shows the host and the whole command, and is raised on the loop page while the run waits; Home counts the ticket as waiting on the person's answer, and the loop page's steps and Watch show the pause as "Waiting on you: allow <host>?". The run reads the answer off the ticket's record, and closes the question on it when it stops waiting with none — the window passed, or the attempt stopped for another reason — acting on an answer that landed first; every change to the record is made under its lock and from the record read again under it. `perbo verdict --egress` refuses a question already answered, one the run closed, one whose window has passed, and one no live run of the ticket asked — none is live, or the live one started after the question was asked — and the desktop's press carries the question's key and the answer and nothing the run printed. The host written to the configuration is the runner's own egress record of what the command named, shown whole to the person and written only on their press ([ADR-0023](adr/0023-untrusted-context-boundary.md)). Each attempt's record lists every host it named, allowed or denied, and each refused call carries `unlisted_egress_host` as its rule.
- Why: the founder's ruling. A repository's own tooling reaches for hosts outside the defaults, and an attempt that stops on the first of them leaves the person nothing to do but add the host and run again; a question while the call is held is one press. One question a run keeps the person from being asked host after host, and a refusal that closes the network tells the executor to stop reaching for it rather than trying the next mirror.
- Changes if: runs wait on questions a person almost always refuses, or a host allowed this way is reached for something other than what the command showed.

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
- Decision: the desktop is a local app around the bundled CLI, built from the supplied hand-drawn assets and shared components. Claude Code and Codex plan, execute and review on the person's existing subscription logins, and OpenCode on its own, with no login: a key in the app's environment or OpenCode's free models ([D-134](11-open-decisions.md)); API credentials are optional. The executor and the reviewer each run on the model and the effort the person chose for that role, from the levels the provider's catalog reports for that model; the effort is a provider setting like the model and changes neither the reviewer's prompt nor its policy (D-079). A model picker lists every model the provider's catalog offers — for OpenCode, only the ones it reports a person can run now ([D-134](11-open-decisions.md)) — Claude Opus 5.5 first wherever Claude Code's catalog offers it, and a role with no model chosen takes Opus 5.5 there and, where the catalog does not offer it, the row the provider marks its default. A new profile is set up with Opus 5.5 for an executor on Claude Code where its catalog offers it and Claude Opus 5 (`claude-opus-5`) where it does not, and `perbo doctor` proposes the same `model` for a repository's `.perbo/config.json`, asking the agent binary's catalog; the Architect takes Opus 5.5 by its rule (D-102); the reviewer keeps `DEFAULT_CLAUDE_MODEL` (D-010), which a proposal naming Opus 5.5 pins as `reviewer_model`. A planning with no ticket yet has no models of its own and takes the defaults for new tasks as they are now, so a change under Connections reaches a planning already open — the next chat it starts, its draft and the ticket it admits, while a chat already running keeps the model and provider it started with — and the ticket keeps the models it was admitted with as its own; the repository's `model` is what a run outside the desktop takes where nothing names one. The model id has one home, `PREFERRED_CLAUDE_MODEL` in `@perbo/model/defaults`, with the rule for the id a catalog offers it by. Each person authenticates with their own credential. Perbo never reads, stores or forwards a subscription credential, never pays for, resells or intermediates usage, and never modifies a provider's binary. The agent binary's path, version and hash are recorded on every attempt.
- Why: people already have these subscriptions, and the product runs where their agents already run.
- Changes if: a provider's terms stop permitting it.
- ADR: [ADR-0033](adr/0033-focrux-local-desktop-and-subscription-providers.md).

### D-095 — Durable desktop editing and one workspace projection

- Owner: Founder
- Decision: unfinished contract fields, criterion buffers and model choices survive a full restart. There is one resumable new-task session and one editor per existing ticket. Drafting and compilation stay attached to the session that asked for them while the person navigates elsewhere. A completed run offers **Review result** first. Polling is about 15 seconds idle and 2 seconds active, and progress updates do not trigger repository reads. Admission is never repeated automatically.
- Why: a person's unfinished work must not be lost, and a late result must never land in the wrong session.
- Changes if: edits are lost, a result lands in another session, or an admission is duplicated.
- ADR: [ADR-0034](adr/0034-desktop-editing-and-workspace-projection.md).

### D-120 — The desktop's sample records are a test double, not a shipped mode

- Owner: Founder
- Decision: the adapter that answers the desktop's request table from sample records is a development and test surface, `src/sample-host/`, and the packaged renderer does not contain it. The tests are driven against it under jsdom and the design preview is `preview.html`, a page Vite's production build has no entry for; the renderer knows one adapter slot, `window.perbo`, filled by preload in Electron, by that page in a browser and by the test setup under jsdom. It answers the same Request table the host answers and is held to it by a conformance suite that runs one contract against both. The protocol carries no field only the sample writes: a screen renders one reply shape, whichever adapter answered.
- Why: a double the product ships is a second implementation of every screen's data, and the fields it added — a mode flag, a curated description, a progress figure — are things the product cannot show, against "nothing shown is invented" ([D-097](11-open-decisions.md)). Held to one table by a suite that runs on both, the preview is evidence about the app rather than a picture of it.
- Changes if: the preview needs to show something the host cannot answer, which is the point at which it has stopped standing in for the host.
- ADR: [ADR-0033](adr/0033-focrux-local-desktop-and-subscription-providers.md), [ADR-0034](adr/0034-desktop-editing-and-workspace-projection.md).

### D-097 — Perbo UI v2; the phone's surfaces follow pairing

- Owner: Founder
- Decision: the desktop follows the v2 boards (`design/perbo-v2`). The rail's settings pill holds General, Usage and Connections. General holds the name, the four moments the loop may interrupt a person, appearance and an away-from-keyboard hold. Usage reports a provider's plan windows only from the provider's own reply, and a spend ledger summed from retained attempts. Shortcuts are rebindable, except the two money bindings. Completed tickets — their merge decided, merged, closed without merge or called off — and tickets whose run stopped, stay on Home until archived by hand, and nothing archives one on its own. Don't merge on the merge screen is the person's merge decision on a pull request left open: the press records it on this machine against that pull request, and the ticket counts as completed while that pull request is the one it has open; a run of the ticket starting forgets it, and a pull request opened later waits on its own merge decision. The merge screen's two outcomes, merged and called off, each land on a page with an Archive ticket box, checked to begin with: leaving that page with the box checked is the person's hand, and files the ticket — a called-off one with its pull request still open — while unchecked it stays on Home among the completed. A ticket the loop still carries cannot be archived, nor one whose pull request still waits on the merge decision; archiving and a call-off are desktop preferences, never a ticket state. A ticket whose merge is decided, merged, closed without merge or called off, sits at the foot of Home under every colour, with a check mark in its progress wheel and Archive on its card as a stopped one has. The rail's Home badge counts only the tickets that need the person — a finding waiting on an answer, a stopped run, a pull request waiting on the merge decision — and have not been opened since they came to stand there, read from the ticket's own history and when its page was last opened; each such card carries a blue circle until it is opened, a page open as the ticket comes to need the person counting as that opening, and a ticket that comes to need the person again counts again. Completed names only a ticket whose merge is decided; a pull request waiting on that decision is counted and filtered in its own words. There is a dark theme, and motion is vendored from transitions.dev at a pinned commit. The desktop shows no forecast, and no phone surface until pairing lands; the phone boards are the target for that work.
- Why: nothing shown is invented; every number comes from a provider or the records.
- Changes if: the desktop shows a number no provider reported, or a desktop preference changes a ticket's state.

## Review quality and the corpus

### D-010 — The regression suite holds reviewer quality

- Owner: Founder
- Decision: a change to the reviewer prompt, the blocking matrix, or the default model or provider carries a regression-suite run in its pull request ([`regression-suite`](evaluation/regression-suite.md): 30 fixtures from the public corpus, one repeat), with the `unstated_regression` row first. Two bars are hard: no flipped verdict, and every cited credential redacted (D-055). Every other row is read against the previous suite run on the same model. The reviewer's default is `DEFAULT_CLAUDE_MODEL` in `@perbo/model/defaults`, Claude Opus 5, until a suite run on another model makes that the default: a new setup takes Claude Opus 5.5 for the executor and the Architect where Claude Code's catalog offers it and leaves the reviewer on that default (`withOfferedDefaults` in `apps/desktop/src/shared/contract-editing.ts`), and a `.perbo/config.json` `perbo doctor` proposes with `model` on Opus 5.5 pins `reviewer_model` to it (`proposeRepoConfig` in `apps/cli/src/commands/run/index.ts`, D-093). A person may still choose any model the catalog offers for the reviewer.
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

### D-121 — A stand-in's stops are dogfood, never a partner reading

- Owner: Founder
- Decision: a stop an AI stand-in answered — a tick the stand-in signed, or `verdict --stand-in` — is a dogfood number: every row that carries it says so, it is counted in its own `dogfood stops excluded` row and column, and it is never pooled with a partner's precision. A store with no baseline captured before first use ([D-038](11-open-decisions.md)) has no partner population, so every row it holds is dogfood.
- Why: precision of stopping is the partner reading the product is judged by; a number that mixed the stand-in's answers into it would be quoted as a partner's.
- Changes if: a stand-in's answers are shown to track a partner's closely enough to pool.

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

### D-122 — Every package states its interface; a module keeps its interior

- Owner: Founder
- Decision: each package's entry file lists by name what other packages import from it, and its `package.json` `exports` names one subpath per runtime that consumes it — `.`, and `./browser` where the desktop renderer imports it; nothing else in a package is reachable from outside it. A module with an interior is a directory with one surface and an `internal/` that nothing outside it imports. A module's unit tests sit beside it and are typechecked with it, and the build leaves them out. A module one package uses lives in that package, and `@perbo/contracts` holds what two or more share. A package's `test/` keeps only what cannot sit beside a module — a test a pull request may not edit, a suite whose subject is the repository rather than one module, and data a test reads — and `scripts/test-placement.test.mjs` holds four packages to that. The layout is in [docs/07](07-monorepo-and-deployment.md), and the architecture in ADR-0040.
- Why: when an interface is not stated, every internal symbol is public and no refactor stays inside its package; a test the gate does not typecheck drifts from the interface it tests.
- Changes if: a package gains a consumer outside this repository, or the lint rules that hold the boundaries need more exceptions than there are modules.
- ADR: [ADR-0040](adr/0040-package-interface.md).

### D-123 — One model client, four transports, in a package of its own

- Owner: Founder
- Decision: every model call this repository makes goes through `@perbo/model`: one port, `Model`, carrying one turn of the read-or-submit protocol against a schema the calling process supplied; four transports onto it (the Anthropic SDK, a local `claude` binary, a local `codex` binary, a local `opencode` binary — [D-134](11-open-decisions.md)); token accounting and the list-price estimate that says what a turn cost. No other package imports a provider SDK, and no other package starts a provider binary for a model call. `@perbo/review` holds what judges — context assembly, the blocking matrix, the structured verdict, closure verification and artifact redaction — and nothing else. What counts as credential-shaped is `@perbo/contracts` ([D-063](11-open-decisions.md)). A provider's refusal of the request Perbo built — the API's HTTP 400 or `invalid_request_error`, Claude Code's `api_error_status` 400, Codex's `codexErrorInfo` `badRequest` or `httpStatusCode` 400, OpenCode's `data.errorName` `provider.invalid-request`, or a JSON-RPC invalid request or invalid params from Codex's app-server or OpenCode's ACP server — fails the turn `request_refused`, read from the provider's structured error, never retried and never followed by an offer to try again.
- Why: drafting, review, closure verification and the doctor's probe all make the same call, and reaching it through the reviewer puts a provider SDK in the drafter's dependency graph and the reviewer's package in the drafter's. A change to the request bytes is then indistinguishable from a change to the judgement. Separated, each has one home and one set of tests, and the reviewer's package holds only what a reviewer-change review has to read.
- Changes if: a caller needs a protocol this port cannot carry — a conversation that is not read-or-submit — in which case the port grows a second shape rather than a second client.
- Note: a change to a default model, to the request a transport builds or to the price card is a change to the reviewer under [D-010](11-open-decisions.md), and `.github/workflows/build.yml` has to watch `packages/model/` for that to hold.

### D-112 — Trademarks, patents and the brand under Apache-2.0

- Owner: Founder
- Decision: the repository says nothing about trademarks or patents beyond Apache-2.0's own terms, which grant no trademark rights and carry a patent licence. The Perbo name, logo and artwork are not licensed under Apache-2.0; all rights in them are reserved, and `NOTICE` names the files.
- Why: the founder's choice. The artwork is the co-founder's; reserving it keeps the brand out of forks while the code stays Apache-2.0.

### D-117 — The Architect asks with answers to pick from

- Owner: Founder
- Decision: the Architect puts what it cannot settle from the repository, the spec or what the person
  has already said through `ask_options`, which carries groups of questions, each group's parts read
  together because one part's answer bears on another's. It asks for all of it in the one call and
  returns without waiting — a tool returns to the model, and one that waited on a person would hold
  the turn open — and the dock puts one group at a time, so what the session may ask cheaply the
  person is not asked cheaply. Every part offers at least two answers, may carry the session's own
  recommendation — which is put first, a person reading a list of answers reading the top of it — and
  always carries two of the reader's own: leaving it as the Architect's call, and saying the answer is
  none of these, which opens a box for that part, inside that answer, while the group's other parts
  stay pickable. So there is one way to answer rather than two — the card, with the chat's box away
  while it stands — and their own words are never closed off, they are asked for. Picking and typing
  send nothing: one bar across the card's foot sends the whole group, and only once every part is
  answered — a pick clicked again being taken back, Something else by a click on its opened answer
  around the box with what was typed in it kept for when it is picked again, and the arrow keys
  moving a pick without making it until Enter or Space does — as one line a part in the option's wording
  or the person's, as an ordinary turn. How much of an asking has been answered is recorded on the planning rather than
  counted back out of the turns, which cannot tell an answer from a question the person typed
  instead: a part answered in the person's own words still answers the group, because the letter it
  goes under says which question it answers, unless what it says is word for word an answer a group
  waiting behind offers and its own question does not, which makes the turn that group's answer and
  not this one's; a group of one part has no letter to say that with, so
  what it sends is a sentence like any other. A group the person is answering is never replaced: the
  session may ask again before every group it asked is answered — often as it reads the answer to the
  group before — and what it asks then waits behind every group still to be answered, put in the
  order it was asked once nothing ahead of it is left to answer, so the picks and words on the card stay
  where they are and no group asked is lost. The same holds for a problem between the plan and the
  spec put on the card: a question the session asks while one is up waits behind it, and only a later
  reading's problem takes the place of the problem the reading before it put. A turn that is not the
  group's answer ends the asking and every asking waiting behind it, because the session is about to
  answer what was said and a card left standing would answer a question nobody is asking any more.
  Only the person's word does that: Perbo's own turn, asking the session to write something again
  condensed, answers nothing it asked, and the answer to a problem put on the card answers the
  problem and not the questions waiting behind it, so the turn says as much as it goes down and the
  session's record of its asking stays where the card's is. Their own words past a problem end both.
  A session the chat starts afresh rather than continuing, as it does once the planning drafts on
  another provider, has asked nothing and heard no answer, so nothing the session before it asked is
  put any more and the answers the person gave it start empty too, a question the new session asks
  again being put as a card and answered once more; all of it stays in the conversation to be read,
  and a problem on the card stays, being Perbo's own question rather than a session's.
  A question is put once. Two parts are the same question when their words are the same once trimmed
  and they offer the same answers, by label and in any order; a detail, a recommendation or a title
  worded otherwise does not make a new one. `ask_options` refuses a call that puts one again — still
  waiting on the person, already answered, or twice in the call itself — whole, in one sentence naming each as already asked
  and carrying the answer given, and puts nothing; and the host passes over any group whose every
  question the person has already answered, putting the next one or the asking behind it, so each
  question has a card once and each answer goes down once. `ask_options` names a part in that
  sentence by its question, and by its answers as well where another part in sight is worded alike
  and offers others. Writing the spec takes nothing down: the
  session writes it as it reads each answer, and a group it asked is waiting on the person, whether
  or not the spec was written meanwhile, until a turn of theirs answers it or is not its answer.
  While its card stands the chat's box is away, so that turn is the card's: on a group of more than
  one part it is the answer, a part in the person's own words included, unless a part says word for
  word what only a group waiting behind offers; on a group of one part it is the answer where it is
  one of the answers offered, word for word, and what the person types in its Something else box
  otherwise is not, and ends the asking. Reading the person's
  answer back off the turn rather than flagging it on the way in means a person who types the lettered lines out themselves has answered, wherever they
  typed them; that is the same widening as a person typing an option's wording out, and it is meant.
  The conversation keeps the questions either way, behind the line that says they were asked: a
  card holds what has to be read and what it wrote is there for the asking, so a chat of long
  accounts is a chat nobody reads. This is not a permission prompt: a call the guard refused is still reported and
  never asked (D-102).
- Why: a person sees only what needs them (D-001), and prose questions arriving five at a time are
  read as a wall and answered as one. Metering them is the reader's job rather than the session's,
  because a rule the session is asked to follow is one it can drift from, while a queue it cannot
  reach holds. That queue is the host's: the tool returns before anything is answered, so a second
  call asking something new is put behind the groups still standing rather than refused, since a
  refusal would drop a question where waiting only delays it. A question asked again is another
  matter: it is answered twice, and two answers to one question can disagree, so the tool refuses it
  with the answer already given, from what it has read off the person's turns, kept beside the spec
  with the session so a session resumed in a new process refuses it too, and the host passes over a
  group the person has already answered. The tool's record and the card's are two readings of the
  same turns, and they agree only while both read the same turn against the same group, which is why
  a turn that is not the person's word on the session's questions says so rather than being read as
  one. Taking a group down because the spec was written would leave the session's record waiting on
  a question the person was never shown, and refuse the session the one way to put it again. A card replaced under a person
  part way through it takes their picks with it and leaves the questions it asked to be typed out by
  hand. The wording that goes back is the option's own so the answer is the person's sentence
  and not a token only the app understands, which also keeps what the session wrote out of every
  action parameter ([ADR-0023](adr/0023-untrusted-context-boundary.md) §4): it reaches a turn and
  nothing else.
- Built: `ask_options` and the `asked` event beside the Architect's other tools, bounded at four
  groups of four parts of eight options and refused at the tool above that; the host relaying it
  under the redaction every other field the session writes is given, flattening the
  whitespace a label goes back down as; `ask_options` refusing a question put again, by `sameQuestion`
  in the interview protocol, against the groups waiting and the answers read off the person's turns,
  both kept under `asking` in the session's `.interview.json` beside the spec as they change, each
  time written whole to a file beside it and renamed over it, and read back by `--session`, which
  says on stderr where a record beside the spec cannot be read; a turn carrying `asking` — `kept` for Perbo's ask to condense and for the answer
  to a problem on the card, `ended` for the person's own words past one — moving that record as the
  card moves, and any other turn read against the first group waiting and the groups behind it;
  the asking, the count answered, the askings waiting behind it and every answer to the Architect's
  own questions (`asking`, `askingNext` and `answers`) recorded on the planning, so a restart keeps
  them, a group already answered passed over wherever an asking is put, a later asking
  added behind the one standing and a reading's problem taking the place of the one before it, moved
  on by an answer — a lettered line a part, whatever is said under the letter but another waiting
  group's answer word for word, so a part in the person's own words moves it as a picked one does — with the last group's answer putting the first
  asking waiting, and ended with everything waiting by anything else, an asking whose line fell out of
  the conversation's cap being passed over for the one behind it, and taken down with everything
  waiting and every answer, a problem on the card apart, where the chat is started without
  `--session` (`newInterview`); and the card, in the dock and on the Problems pane alike,
  which puts one group with its parts lettered, gives each part that said the answer is none of these
  a box inside that answer, holding what is typed in it to the room the group's one turn leaves
  (D-133), and sends from the bar at its foot, enabled once every part is picked or
  said, each part lettered in the option's own words or the person's — a lettered part on one line, since a newline
  under a letter would read as a part that was never answered — a lone part bare, which has no letter
  to be read against and so goes down in the paragraphs it was written in.

### D-128 — A plan may be rearranged freely and may not quietly promise something else

- Owner: Founder
- Decision: an edit may arrange a plan any way at all — nodes split, merged, re-pathed, edges drawn
  and removed, a criterion moved between nodes, an assertion or a verification kind rewritten — and
  none of that changes what the work is for. Two things do: the outcome, and a criterion's own
  words. An edit changing either takes the spec with it, and the Architect is held to that in the
  same turn: it is the only editor holding both documents (D-102), so an edit of a promise made
  without writing the spec is refused, by name, saying what is still direct. The same holds the
  other way about: when the Architect writes the spec while a plan is drafted, it moves the plan
  to answer it in the same turn, or says in one line why the plan needs no change. A person is not
  held to either — on a basic ticket's contract, at the Spec pane, in their own editor, or through
  the queue's endpoint with their own token — because a hand edit writes one document and not the
  other: the person's own edit, and a chat turn that wrote the spec and judged the plan needs no
  change, are the ways the two can still part, and reading the difference afterwards is the
  answer to both. On the way from the plan to the contract a model reads the
  spec's outcome and requirements against the plan's outcome and criteria and reports where the
  words no longer promise the same thing — never how the plan is arranged and never how a
  criterion is proven, because neither is a promise. The verdict is kept beside the ticket against
  two hashes, the spec's bytes and the plan's promise texts, and holds while neither moves: an
  arrangement edit keeps it, a plan just drafted has it by construction, a chat turn that moved
  the plan carries it forward — only from a state that had it, so a hand edit never read is not
  washed away by a later turn — a rename, which moves only the title line the reading never reads,
  carries the verdict as it stands, and a hand edit of a promise or of the spec, or a chat turn that
  wrote the spec and left the plan, lets it go. It is never read as a plan is drafted, since a plan
  the model drafts from the spec counts as satisfying it (D-138); it is read
  when the person confirms the plan — an epic's **Confirm the plan**, a basic ticket's **Confirm
  contract** — where the spec or the plan's promise moved since the last reading, and after a turn
  of the chat only where it answered a difference still open: a turn otherwise starts no reading,
  and what it moved is read at the confirm (D-138). Each difference is put,
  one at a time, as answers to pick from in D-117's shape, on a page of its own and in the chat
  beside every other pane, with the person's own words beside them; whichever they
  pick goes to the Architect as an ordinary turn, so the spec and the plan move together under the
  guard above, and nothing the model returned becomes anything but a turn
  ([ADR-0023](adr/0023-untrusted-context-boundary.md) §4). The confirm is refused while a
  difference is open, for an epic as for a basic ticket, until each is resolved
  (D-138). It
  is a reading of words, apart from the id-level disagreements the contract page lists — a
  requirement nothing cites, a citation pointing at nothing — which stay where they are. A
  criterion an edit writes carries the requirement it answers, as a drafted one does, and a
  criterion may not cite a requirement the spec does not carry.
- Why: the two part only where something changes one document without the other, and asking the
  Architect to write both in the same turn is a prompt, not a guarantee. Holding it is cheap because the rule is narrow: nearly
  every edit is arrangement and cannot make the two disagree, so only a promise has to carry a spec
  write, and the text is compared rather than assumed so that changing how a criterion is proven
  stays direct. Refusing at the edit is the guarantee held from the side where the work is still in
  hand, and it needs no reading, no model and no second record to go stale. Reading the difference
  afterwards is the weaker answer — it detects what should not have happened — but it is the only
  answer for a hand edit, which this rule deliberately leaves free, and it is bounded by the same
  narrowness: a plan the chat moved with its spec agrees with it by construction, so a reading is
  owed only where a hand moved a promise or the spec, or a chat turn wrote the spec without moving
  the plan, and the verdict is keyed by exactly those two so that nothing else asks for one. A chat turn carries the verdict forward rather than
  earning a fresh one because the guard already held that turn to the spec; it carries it only
  from a state that had one, because a turn cannot vouch for a hand edit it did not see. The
  difference goes back through the chat rather than through an edit of its own because the
  Architect is the one editor holding both documents: an answer picked on the page moves the spec
  and the plan under the same guard, where a direct edit would have to be held to it again; a
  difference the person means to keep is closed the same way, by an answer that moves the spec to
  say it. It holds the confirm for the reason D-138 gives, and it is read
  there rather than after every turn because a turn the guard held to the spec needs no reading,
  and one that wrote the spec alone is read before anything is frozen. A citation is checked where the
  contract freezes rather than at every edit, so a drafter may leave a requirement uncited and no
  later edit is refused over a state whoever is editing did not create.
- Built: the chat's own guard, which refuses an `edit_plan` changing the outcome or a
  criterion's words — writing them, adding or dropping a criterion whole, or taking back an edit
  that did — where the spec was not written in the turn in hand, measured against a baseline taken
  as each turn begins and again as each ends, so one spec write covers the edits made beside it,
  the next change has to say so again, and a turn queued behind a running one is measured from where
  that one finished rather than from before its write — and says in the refusal what is still
  direct, so it does not read as a wall; the same rule stated in the session's orientation, so it
  is met before it is hit, beside the rule that a spec write with a plan drafted moves the plan in
  the same turn or says in one line why it needs no change; the reading, `perbo drift`, which
  gives a model the spec's outcome and requirements and the plan's outcome and criteria, each
  delimited as data, and takes back at most six differences, each with two to four answers in the
  person's own voice and at most one recommended, refusing any other shape; the verdict at
  `.perbo/tickets/<KEY>.drift.json`, keyed by the spec's bytes and the plan's promise texts — the
  outcome and each criterion's words, sorted, so that ids and arrangement are not in it — with
  where it came from, whether it was dismissed, and the model's provenance where
  one ran: written empty by `admit` as it drafts a plan from a spec, carried forward by the
  chat at the end of a turn that moved the plan, from a verdict that stood as the turn began
  and stayed the turn's own — a hand edit beside it is not carried — dismissed by
  `perbo drift --dismiss` at the same state, and refused at any other or once the plan has an edit
  by hand since it was drafted (D-138), and printed back without a model wherever
  the two hashes still match — a reading records its own verdict only where the spec and the plan
  still match what it judged, keeps one that another reading or a dismissal wrote for that same
  state, and a printed verdict's `cached: true` says no model ran for it or its result was not
  recorded; the desktop's `driftCheck`, a job in
  the same manner as drafting, and `driftDismiss`, which no page of the desktop asks for,
  and which the host refuses for a session with no spec, no plan or an approved ticket, passes
  `perbo drift --dismiss`'s refusal on, and otherwise clears the differences it keeps; and the
  Problems pane, which an epic's every way from the plan to the contract passes through, which
  reads the plan as a Confirm the plan opens it, only where the spec or the plan's promise moved
  since the last reading, and on any other arrival reads nothing and puts the last reading's
  problems, and which goes on to the contract tab on its own when nothing is open — problems
  resolved from another pane included; where a reading finds differences the host keeps them on
  the planning until a reading finds them closed or the contract is approved;
  the pane hides the chat, and while any of them is open it sits in the rail as its lowest tab,
  labelled "Problems" (D-138), and opening the ticket
  from Home or the picker lands there (D-130); it puts one problem at a time — the first still open, as a card
  in the chat's own shape, recommended answer first and the person's own words last, with a
  counter in its corner reading "Problem 1 of N" and "N more after this" — whose bar at its foot posts the
  answer as a turn, says "Resolving the problem" while the Architect applies it and while the
  plan is read against the spec again, which the host asks for on its own once a turn ends while
  a problem is open, at the state it records as read, and shows the next problem when that reading records it — the same list found again is put
  again only where no card stands to answer it, never over a question the Architect is
  asking of its own, and never by a reading a chat turn overlapped, which resolves none
  either, because it read a plan the turn's answer had not reached yet; the same problem is put in the chat as an asked line in D-117's shape headed
  "Problem 1 of N", so it is answered from any other pane the same way and the same re-read
  follows; once none is open the person is moved back to where they confirm — an epic's Graph, a
  basic ticket's contract — and the Problems tab leaves the rail, and the chat's note saying every
  problem is resolved is words alone, because every pane the chat sits beside but the Spec pane
  carries that way on already; a question the Architect raises of its own while it applies an
  answer stands on the page as the thing to answer, headed "A question from the Architect" with
  the counter hidden; "Back to the plan" stays on every state, and nothing offers a way past an
  open problem or past a reading that did not run, which is tried again and then said in a pop-up
  (D-138); the citation check at
  approval, where the contract is frozen and the spec travels with it, refusing a plan that cites
  what its spec no longer states and passing over a spec it cannot read, as the rest of approval
  does; the disagreements between the two listed on the contract page before the button that
  freezes them — a requirement nothing answers, a citation pointing at nothing — beside the impact
  count and in its manner, advice and never a gate;
  `requirement_id` on every criterion an edit writes, including one an undo puts back, so a
  node's page names the requirement rather than telling the executor it was drafted from nothing;
  the criteria whose verification the draft did not propose marked on the page that freezes them —
  on an epic's contract, which shows the graph, named under it —
  because approving is the last place a changed assertion can be read; and the last change the
  chat made to the pair marked where the two are read — the Spec pane's reading, the Graph's node
  cards and, under each criterion's box, its inspector, and a basic ticket's criteria on its
  contract — additions green and removals
  red and struck through, kept on the planning as what the spec's sections and the plan's outcome
  and criteria said before and after and who made the change: the chat, recorded once a chat turn
  ends, or the person, recorded once an edit by hand, a compile, a spec save or a plan drafted
  again lands; only where words differ and never for the first words put into an empty spec
  section or a plan just drafted, which are not an edit; replaced whole by the next change,
  whoever made it; and marked only where the chat made it, since a person's own change was made
  where they read it, so that what a person reads marked is always the one change the chat made
  that they have not yet read; nothing is marked while a section or a criterion is being edited.

### D-129 — Before the loop is the picker's; the loop is Home's

- Owner: Founder
- Decision: Create's picker holds every piece of work before the loop — a planning with only a
  name, a spec written under one, a spec the repository holds that no planning and no ticket
  names, and a plan drafted and not yet approved. Home holds the tickets the loop is carrying.
  Approving is the line between them, because approving is what starts the loop. Every row the
  picker lists can be deleted where it is listed, and so can every ticket the Archive lists, and each
  asks first, in the words of the stage it is at: the Archive's with the picker's confirmation,
  saying what goes and that the branch the ticket ran on and its pull request on GitHub stay.
  Deleting takes all of it: the planning, the ticket it drafted and the spec folder they
  came from, at every stage, the loop included, and the evidence goes with it: the attempts the
  ticket recorded and the bundles those attempts sealed. One stage holds: a ticket whose pull
  request is open — at `pr_open`, or wherever its delivery record says it is open, as an
  escalated run that published leaves it at `changes_requested` (D-065) — is refused, because
  that pull request is a record outside this machine and deleting the ticket would leave it
  standing with nothing here to read it against; it is closed or merged on GitHub first, and the
  delete is offered again after that. Where the delete is not offered for that reason, the page
  says so in one sentence naming the pull request, and, for a ticket not at `pr_open`, whose
  delivery record nothing else reads again, offers **Refresh from GitHub**, which reads it again
  through `perbo sync`: once that reads it closed or merged, the delete and Plan it again are
  offered again. A delete waits only for a
  command running for that ticket itself — its run, a decision on it, its publication — and is
  refused while one is, in the sentence that says so; another ticket's run in the same repository
  holds nothing of it, and the work goes at once, off every list at the click. A run that has been
  stopped is deleted on its own page, which a stop lands on at once, which is the ticket's own for as
  long as it is stopped, and which holds its name, that the run was stopped, the progress wheel at
  the stage the run had reached, why it stopped — one line each, read from the records as the loop
  page's ended card is, the whole of each behind an `i` — and its three ways out — **Delete this
  work**, **Plan it again** and **Continue the task** — as buttons named and nothing else, beside
  **View the paused loop**, which opens the ticket's loop page and has the way back, and which says
  **View the loop** after any stop but the person's own or Perbo closing. The progress
  wheel — the ring on a Home card and the bar on the loop page, which read one fill — has six stages
  in equal slices, in the order the loop runs them: contract, which fills nothing; execution, which
  holds the worktree, the executor, sealing and the deterministic checks; review, the ticket's first
  independent review; refinement, a remediation round; verification, each closure verification and
  each later review, said with its pass from the second ("Verification 2"); and completed, which
  fills the whole: the journey's end waiting on the person — a pull request open or a local run
  finished with its review on record — and a merged or closed ticket, read as "Review ready" while
  the merge decision waits and "Completed" once it is made (D-097). A decision is no stage: where
  the loop asks the person (D-132), or a run waits on their answer about a host (D-137), the stage that
  asked is shown in the decision colour with "Decision required" under it, and the loop goes on from
  refinement after the answer. Within one ticket's journey the wheel never moves back: it shows the
  furthest stage the ticket reached over every run, read from the attempts on record and every run's
  log, so it holds through a restart, and what the loop is doing now is said by the title and the
  steps — a continued run materialising its worktree reads "Materialising the worktree", a second
  refinement round after a verification "Refining the change, round 2" — with the fill where it
  was and a mark on the stage the loop is at, behind the fill where a run went back to an earlier
  stage; a stopped run keeps the stage it reached, in the stopped colour, and only Plan it again, a new
  ticket, starts from contract. The steps follow the ticket's loop too, not a run: each thing that
  happened listed once, whether the records or a run's log says it, refinement rounds and
  verification passes counted over the ticket, and each decision the person took a step where they
  took it, "You answered 3 findings", with the answers behind its `i`.
  **Continue the task** is offered only after the person's own stop or Perbo closing while the run
  was going — quit or crashed, one event, recorded `interrupted` either way — and carries on where
  they left off; after any other stop — a limit, a refusal, an error — it is disabled, saying that
  another attempt at the same plan meets the same reason again and pointing to **Plan it again**,
  which is the way to change the spec or the plan and start the loop over, and where the record of
  how the run ended is gone it says it cannot tell which stop it was. A run that ends on a verdict
  for the person — `perbo run`'s exit 2 with an outcome in `RUN_VERDICTS` — is no stop: it is a
  completed job paused for them, yellow on Home, with no card saying the run ended, and the decision
  opens directly, where its record asks the person something; one whose record asks nothing is a
  stop whose loop ended on a verdict nobody can answer, and there **Plan it again** is offered and
  **Continue the task** is disabled with a hover naming it (D-132). A hover, or the `i` behind a
  reason, names only a button that can be pressed. **Plan it again** asks first, in the confirmation the picker asks before a
  delete, whose own **Plan it again** at the bottom right is the one press that goes on: the work
  the runs built is no longer reachable in Perbo and stays only in git, on the branch named where
  the records name one, the spec is kept and planned again with none of that work carried into the
  new plan, and, where **Continue the task** is offered, that press keeps the work instead. Once
  confirmed it puts the work back before the loop: the stopped ticket is deleted as a delete takes
  it, attempts and evidence included, but for the spec, which stays because the new plan is drafted
  from it; the ticket leaves Home and the picker at the click, and so does its spec until the new
  plan claims it, so no second planning of the same work is started from the picker while the plan
  is drafted; the stopped page says the plan is being drafted until it is; and the planning over
  the new plan opens by itself, where D-138 lands it. Where the
  plan cannot be drafted once the ticket is deleted, the refusal says the ticket was deleted and
  that its spec is in the picker to draft the plan from. It is
  offered only where the record is spent — failed or cancelled, or a verdict with nothing on its
  record to answer — and not where the pull request is open, which both hosts refuse in the
  sentence the delete is refused in. Publishing a branch or pull
  request needs the person's permission for that run, asked on the contract page as it starts;
  **Continue the task** after a stop carries the permission the stopped run was given, and a
  decision's run carries none. The spec is left only where something else still names it:
  another planning writing the same file, or another ticket drafted from it, neither of which this
  delete was asked about, and a plan still standing is read against the spec it names (D-103).
  Opening a spec starts a planning already named to it, so the first save writes the folder that is
  there rather than minting a second from the same title; a spec another planning is writing is not
  offered, because one spec is one piece of work (D-103).
  A planning opened fresh that holds nothing — no spec folder, no ticket, no turn to the chat
  and no edit — is discarded as the person navigates from planning mode to any other page, because
  a row nobody put anything into is not work to offer back. Anything put into it stays, whatever
  the stage; leaving a page is what discards it, and closing Perbo is not leaving a page, so an
  untouched planning is still there after a restart.
- Why: the person's own stop is a pause they take back, and Perbo closing stops nothing about the
  plan, so carrying on from either is the work resuming; every other stop is a reason another
  attempt against the same frozen contract meets again, so carrying on from it only spends; changing
  the spec or the plan is what gets past it, and that is Plan it again. The wheel's stages are the
  founder's: the checks are part of the execution, a re-review is a verification, and the end
  waiting on the person is completed; a wheel that moved back after a decision, or steps that listed
  the review again, read as the loop starting over when it had gone on. A verdict the review put to
  the person is the loop asking them, and reading it as a failure would colour it red and put an error in
  front of the question; red is for an error or the person's stop, and the question opens itself; the contract itself is frozen,
  so a way to it from here would offer nothing to change. A planning deleted without its spec leaves the writing reachable only through a record that
  no longer exists, while the folder still holds its title, so starting the same work again is
  refused for a folder the person has no way to open; the picker is the way back in. Deleting the
  planning and leaving the writing puts the row straight back under the same title, which reads as
  the delete having made a copy of the thing it removed, and keeping the record of a run the person
  has said is over keeps a row on the board that stands for nothing, so a piece of work is one thing
  and is deleted as one. The split follows: a board that mixes work being planned with work being
  run is two jobs on one screen, and the picker is already where planning is resumed. A run writes
  only its own ticket's records, so a delete held by another ticket's run would wait on nothing it
  touches.
- Built: `heldTicket` in `shared/jobs.ts`, the one hold on a delete, read by the host's
  `discardTicket` and `editingDiscard`, the sample host and the pages that offer a delete; the
  Archive's Delete on each row, which asks with the picker's `ConfirmDelete` in the words
  `confirmDeleteFiled` gives an archived ticket and deletes through the same `discard` as the
  ticket's own pages; the host's reading of the spec folder, skipping an entry it cannot parse rather than
  refusing the rest; `specs` on the snapshot and `specSlug` on each open draft, which
  `unclaimedSpecs` subtracts to find what nothing points at; the `spec` editing target, which
  reuses the planning already writing that spec; `specDelete`, which takes a slug and never a path
  and refuses a spec a ticket records or a planning is writing; `PRE_LOOP_STATES` beside the rule
  about what Home files away, which keeps `draft`, `specifying` and `plan_review` off Home; a bin
  on every picker row, each naming what it deletes; `ticketsNoDraftStandsFor`, which covers a
  reviewing ticket by the spec a planning writes as well as by its key, so one spec is one row;
  the adoption on open, which puts a ticket already drafted from this planning's spec onto the
  planning — without claiming it made one it did not; `discardTicket` in `host/tickets/discard.ts`,
  reached only through the host's `discardDrafted`, which takes the ticket,
  its contract, its draft, its approach, the reading of its plan against its spec, the attempts
  record and the bundle manifests those attempts sealed, and leaves the content-addressed objects
  under them, because one of those bytes can be what another ticket's bundle names, and stops every
  chat over the work and waits for its child to exit before anything is removed, because a turn in
  flight writes the spec back and its edit would find the ticket gone; the delete on
  the contract page and on the stopped-run page, each asking first in the words of the stage it is
  at; `replan`, which asks `admit`'s spent-record question itself and then deletes the stopped
  ticket through `discardDrafted` before it admits the new plan from the spec, so the new plan is
  named as the only plan that spec has; the picker's delete marks, which Home reads too, so a
  ticket being planned again, and the spec it names, are off Home and the picker before the host
  has answered, and the ticket's page, which keeps the screen it showed while its ticket is deleted
  from under it (`TaskPage`); `confirmPlanAgain` in `StoppedScreen.tsx`, the words the confirmation
  asks in; `StoppedScreen` and the ladder in `ticket-workspace.ts`, which land a run whose stop is still
  settling on that page as well as one whose record says it stopped; `stoppedByPerson` in
  `ticket-workspace.ts`, the one reading of whether the last run was the person's own stop, which
  `runEnding` in `task-context.ts` reads for the page's reasons, one reading of the records for the
  ended card and the stopped page, and `carriesOn` beside it, which offers Continue after that stop or
  Perbo closing; the host's `shutdown`, which ends what it cuts off `interrupted` with the words a
  crash leaves; the run route's `verdict` read of `perbo run`'s exit, which completes the job with its
  `outcome`, and `ticketRun`'s `paused`, which every colour, wheel and title reads; `WHEEL_STEPS`, `wheelFill`,
  `furthestAt` and `overTheTicket` in `shared/runner-progress.ts`, the stages, the one fill the ring
  and the bar read, the furthest stage and the ticket's own count of rounds and passes;
  `ticketStages` and `stageReached` in `ticket-workspace.ts`, the ticket's loop and the furthest
  stage it reached, which Home, the loop page and the stopped page show; `LoopStages`, which marks
  the stage waiting on the person or stopped; `loopSteps`' decision steps, read from the verdicts
  record;
  `publish` on a run's job, which **Continue the task** carries; `removeSpecFolder` and
  `deleteDraftedFromSpec`, which take the ticket and the folder with the planning and hold the
  slug to one folder name in the configured spec folder (D-103), because an admission record is a file in the repository and this ends
  in a recursive delete; the planning's delete, `editingDiscard`, which, for a planning holding the ticket it
  drafted, is refused before anything is discarded while a command runs for that ticket (`heldTicket`),
  leaving the planning, the ticket and the spec as they were, says a refusal found once the chat has exited — a pull request open — with the
  planning already thrown away and the ticket kept, and takes the spec folder with the planning
  where the ticket is already gone; the same reading in the sample host, and the same refusals of a delete in
  the sentences `shared/discard.ts` holds for both, so it behaves as the host does; `untouchedPlanning` in `contract-editing.ts`, which is what holds nothing means;
  and the route effect in `App.tsx`, which is the one place a leave from planning is seen, and
  reads the session and discards it at the revision it read, so a save still in flight refuses the
  discard rather than losing what it wrote; and the Spec pane's save, as it unmounts, of a title or
  section typed and not yet saved, sent ahead of that read.

### D-130 — Coming back to a planning is coming back to the pane

- Owner: Founder
- Decision: a planning reopens on the pane the person was last on in it, the contract tab
  included, whether they left it for Home, Archive or Settings or closed Perbo with it open. Every
  way back into a planning asks this — the picker's rows, the ticket's own page and a link to the
  planning that names no pane — and it outranks where each of them would otherwise land: the Graph
  for an epic, the contract for a basic ticket, the Spec for a planning with no plan
  (D-138). Open problems outrank it in their turn: while a reading has
  problems open, those land on the Problems pane (D-128). The ticket's own page asks this only of
  the planning curating the ticket, which is one with a graph it was divided into or a spec it was
  drafted from; a session the ticket's own editor opened is not one, so that ticket stays on its
  own page. The Problems pane is not a pane a planning is left at, so it is never remembered: an
  epic's every **Confirm the plan** passes through it, and the pane remembered is the one the
  person confirmed from. Nor is a pane the planning does not offer, reached by an
  address typed by hand. Where the pane left is one the planning no longer offers — a Graph for a
  plan that is no longer divided, or a contract that something has changed since — the way in lands
  where it otherwise would. The contract of a plan waiting for approval is a tab of the planning
  curating it, so a link to that contract, and the ticket's own page, open it there, with the
  planning's tabs beside it, each a way back into the planning on its own pane. Moving between
  panes is not putting anything into a planning: it moves no revision, so a planning opened fresh
  and only looked around in is still thrown away as the person leaves it (D-129). Once the plan is
  approved the ticket's page lands by its state, and a stopped run on its stopped page; no other
  view of a ticket is remembered, since each is where its state already sends the person.
- Why: a person who steps away mid-thought — to check a ticket on Home, or for the night — comes
  back to finish that thought, and a planning that reopens somewhere else makes them find their
  place again every time. The rule each way in lands by is a good guess at where a person is going
  where there is no record of where they were; where there is one, the record is better than the
  guess. The pane is written as the person reaches it rather than as they leave,
  because closing Perbo is not a leave the renderer sees, and a record written on the way out
  would be lost on exactly the exit it is for.
- Built: `lastPane` on the contract editing session, null until a pane has been visited, and on
  each open draft; `PlanningPaneSchema` in the protocol, the one list of pane ids the record, the
  routes and the rail share, the contract among them; the `editingVisited` request, which carries
  the session id and a pane id other than the contract and is recorded by `visit` in
  `contract-editing.ts`, and `editingContractVisited`, which carries the session id and the state
  the contract was reached at and is recorded by `visitContract`, each leaving the revision alone
  and writing nothing for where the person already is or for a discarded planning, the same on the
  native host and the sample host; planning mode sending one of them once per pane it reaches, for
  a pane that `remembered` in `renderer/planning/panes.ts` allows — every pane but Problems —
  and that `flowFor` offers; `leftAt` there, which answers the recorded pane only where `flowFor`
  still offers it, and `reopenPane`, which answers the Problems pane while problems are open, else
  `leftAt`, else the Spec; the picker's rows, `TaskPage`'s redirect and planning mode's own route
  with no pane landing by that order, the route replacing itself in the history with the pane it
  picks once the drafts list names the planning; `TaskPage` sending a contract asked for by name,
  of a plan waiting for approval in the planning curating it, to that planning's contract tab;
  `curates` there, the one test of whether a planning curates its ticket, which `TaskPage` asks
  before `leftAt`; and the Spec pane's first read of the file keeping what was typed before it only
  in a field the file leaves empty, so nothing typed replaces text of the file's the pane never
  showed. A `workspace.json` holding a record that does not match the schema stops Perbo from
  starting, with a message naming the file and each failing field, a failure shared by several
  records named once with every index it holds at, and ending on what to do: correct the field or
  move the file aside.

### D-138 — Planning offers the tabs its plan needs

- Owner: Founder
- Decision: which tabs planning offers follows what is being planned. While the spec is being
  written and there is no plan, the Spec and the Explorer are all there is: Impact, the Graph and
  Problems wait for a plan, because a plan is what each of them is about. A plan the drafter
  divides into a graph is an epic: Spec, Graph, Explorer, Impact, then the contract. A plan it
  leaves flat is a basic ticket: its criteria are drafted from the spec's requirements, each
  citing the one it answers with a verification the drafter adds, and it has no graph to curate,
  so it has no Graph pane and no pane of its own for the criteria, which are read and changed on
  its contract; it offers Spec and Explorer, then Impact only while its last check found paths
  outside the scope, then the contract. Problems is the lowest tab for either shape, below the
  contract, and is there only while a reading of the plan against its spec has a problem open
  (D-128). The contract tab, **Confirm contract**, is shown while the person is on it and
  afterwards while nothing has changed since they were — the spec's sections, a mark in the
  Explorer, an edit of the plan; once something has, the tab goes until the person reaches the
  contract again. The chat is not beside it. A plan the model drafts from the spec — the first by
  Generate plan on the Spec pane, or again by Start over or Plan it again — counts as satisfying
  that spec, because the model generated it from the spec and the person did not: nothing reads
  it as it lands, it never lands on Problems, it is recorded as read at the state it was drafted at
  (D-128), and the problems a reading found in the plan it replaces go with that plan. When
  Generate plan, or Start over, brings back an epic, it lands on its Graph. When it brings back a
  basic ticket, its impact is checked: it lands on Impact where the check found paths outside the
  scope, else on the contract, with a pop-up over that page saying the task is simple, so there is
  no graph, whose one button, **Next**, puts it away. Plan it again lands in the planning over the
  plan it drafts: on its Graph for an epic, on its contract for a basic ticket (D-129). That pane is
  where the planning reopens, by whichever way it is reached, and its contract is a tab from the
  start, reached at the state the plan was drafted at, because the plan it replaces was approved
  from the same spec, so the rail offers every pane of a plan ready to confirm. After that
  the plan is read against the spec only when the person confirms it — an epic's
  **Confirm the plan**, a basic ticket's **Confirm contract**, which is **Approve · start the
  loop** on the contract tab — and only where the spec's sections or the plan's outcome and
  criteria have moved since the last reading, whoever moved them, by hand or through the chat: a
  plan unchanged since confirms straight away, with no reading. While that reading runs the page
  says **Checking for drift**, and where it finds nothing the confirm goes on: an epic to its
  contract, a basic ticket to approving. While any problem is open the confirm is refused, for an
  epic as for a basic ticket, and nothing offers a way past it: each is resolved — answered on
  the Problems page or in the chat, or by changing the plan and confirming again, which reads it
  again. Nor is there a way past a reading that does not run — no credential, the network, a
  crash: the host tries it again after 2, 4 and 8 seconds, and where every try fails a pop-up in
  the centre of the screen says the plan could not be checked against the spec and why, in one
  sentence with the whole error behind an **i**; its one button, **Got it**, puts the person back
  on the screen they confirmed from, the contract or the plan, with the confirm offered again to
  check once more, and nothing is confirmed. A reading whose model provider refused the request
  Perbo sent is not tried again, because the same request is refused again, and its pop-up says
  checking again will not help. An epic's Confirm the plan passes through the Problems page, which shows the problems
  where any are open; a basic ticket's stays on its contract and says so. Problems appears only
  after such a reading finds a problem. Once every problem is resolved the Problems tab goes, and
  a person on it is moved back to where they confirm: an epic's Graph, a basic ticket's contract.
  No page offers to dismiss the problems; the command line does (`perbo drift --dismiss`, and the
  host's `driftDismiss`), and only where nobody has edited the plan by hand since it was drafted:
  no edit at all, or only the chat's, whose edits move the spec with the plan (D-128). An edit by
  hand since the draft — on a basic ticket's contract, in an epic's Graph pane, or with `perbo
  edit` — refuses the dismissal, saying why in one sentence, and its problems are resolved by
  answering them or by editing. On a basic ticket's contract its criteria are edited by
  hand, each change written into the contract as it is made; such an edit starts no reading and
  keeps the tab, since it is made on the tab itself. An epic's criteria are edited by hand in the
  Graph pane's node inspector — each reworded, and how it is proven chosen — and by the chat,
  both through the validated edit path (D-100, D-102); there is no pane for criteria of their
  own. A hand edit carries no change marks, which are the chat's (D-128), while a change the chat
  made is marked where the criteria are read. An epic's contract shows its graph in place of the
  criteria, read-only: panned and zoomed, and changed only on the Graph pane. The ticket's
  contract after approval draws the plan by the same rule, an epic's graph and a basic ticket's
  criteria, both read-only. Every node on a graph, on the Graph pane and on a contract, says under
  its title how many criteria it covers and the paths expected to satisfy them.
- Why: a pane with nothing to show is a stage a person goes looking into. Before a plan there is
  nothing to measure impact against, and a flat plan has no division to curate: its criteria are
  the one thing on it to change, and the contract, the page that freezes them, already shows them.
  The pop-up says why the graph is missing at the moment it would be looked for. A contract kept as
  a tab only while nothing has moved means that going back to it is always going back to a
  contract that was checked. Problems sits lowest because it is where a confirm that was refused
  leads, and it is there only while something is open. The plan is read at its confirm, the last
  moment before the contract that freezes it, rather than at each edit, so edits — the person's
  and the chat's — go uninterrupted, and only where something moved, so an unchanged plan is one
  press from the contract. A plan the model drafted from the spec is not read as it lands, first
  or again, because the drafter wrote it from those very words and nobody has touched it since: a
  reading would spend a model judging the model's own work, and the person would wait on a check
  with nothing of theirs to find. A dismissal passes over problems nobody answered, which is
  sound only while the plan is still what the drafter or the chat wrote from the spec; once a
  person has edited it by hand, the difference is theirs, and it is answered or edited away rather
  than set aside. A problem open holds the confirm because what the contract freezes should promise
  what the spec asks for, and closing one is an answer or an edit away. A reading that did not run
  holds it too, since it found nothing only because it read nothing; it is tried again first
  because a dropped connection or a slow start usually passes within seconds, and the person is
  told only once the tries are spent.
- Built: `flowFor` in `apps/desktop/src/renderer/planning/panes.ts`, the one rule for which tabs a
  planning shows and in which order, which the rail draws and planning mode records against;
  `contractStateOf` in `shared/contract-editing.ts`, which `contractState` there reads through,
  the state a contract is reached at — the spec's sections, which each
  host fingerprints onto the planning's open draft as `spec`, the ticket's `updated_at`, and the
  scope the planning holds — recorded on the session as `confirmed` by `editingContractVisited`
  as the person arrives on the contract tab, and again by the contract page once a change written
  there lands, and compared on every draw; `readingState` and `readingStateOf` in
  `shared/contract-editing.ts`, the state a reading is of — the spec's sections and the plan's
  outcome and criteria's words, sorted — which `driftCheck` carries as `state` and both hosts
  record on the session as `read` once a reading no chat turn overlapped lands of it, the re-read
  after an answer included, and as a plan drafted from the spec lands and as Plan it again opens
  its planning, where the verdict admission wrote still holds for the spec (`draftedReading` in
  `host/plan/spec.ts`, and the sample host's own); both hosts keeping the planning's plan as an
  edit on the Graph pane leaves it, as they keep it after the chat's, so the state compared is the
  plan's own; the session's `impact`, how many paths the last impact check of its draft found
  outside the scope, written by both hosts as the check answers and cleared by a fresh draft;
  `useDraftLanding` and `SimpleTaskNotice` in `renderer/planning/SimpleTask.tsx`, which watch a
  draft settle, land an epic on its Graph at once and read nothing, check a basic ticket's impact
  under **Checking the impact** and land it by `checkedLanding`, and check the impact of a basic
  plan opened with none recorded, where it opened; `reconcile` in `shared/contract-editing.ts`,
  which drops the problems of the plan a fresh draft replaces as it records the draft as read, and
  `redraftedSince` there, by which both hosts record nothing of a reading that a Generate plan or a
  Start over overtook; where the admission's verdict is missing or no longer holds for the spec,
  the draft is not recorded as read and its first confirm reads it, as D-128's record says; `ContractPane`, the contract tab; `contractShows` in
  `renderer/tasks/ContractScreen.tsx`, the one rule both contract pages draw the plan by, and
  there the confirm, which compares `read` with its state as the host gives both at the press
  (`readingNow` in `renderer/planning/turn-hold.ts`): a basic ticket's reads the plan where `read`
  is not its state, showing
  **Checking for drift** while it does, and says a reading that did not run in the pop-up, confirming
  nothing; an epic's, where `read` is not its state, goes
  back by the Problems pane, so the plan is read as at Confirm the plan; and either holds the
  approve while the chat on the planning is still talking (D-102), and while a planning over the ticket records problems open, whether or not the reading
  could be made and whichever route reached the contract, the approve shortcut included, a basic
  ticket's holding too while the drafts list does not yet carry the planning; `problemsHoldApproval` in
  `shared/contract-editing.ts`, by which the desktop host and the sample host each refuse a `run`
  that approves, in one sentence, while a planning over the ticket records problems open; `DriftPane`, which reads only on the arrival a Confirm the plan made (`confirmArrives` in `renderer/planning/panes.ts`, which `confirmRoute` records and the arrival uses up), once any turn of the chat in flight is over, and only where `read` is not the state, both asked of the host as it arrives, reads nothing on an arrival by the rail or a reopened planning and puts the last reading's problems, and shows no
  wait where it reads nothing, offers no way past an open problem, and moves a person back to the Graph or the contract once none is open, and where its reading did not run shows the pop-up, whose Got it goes back to the pane the planning was left at; `ReadingFailedNotice` in `renderer/planning/ReadingFailed.tsx`, that pop-up, in the decision card's frame; `READING_RETRY_PAUSES_MS` and `untilItRuns` in `shared/reading-retry.ts`, by which the desktop host runs `perbo drift` again inside the reading's job, and the sample host its own reading, while a try exits with an error or prints no verdict, and neither a cancelled job nor a command that exits `request_refused` is tried again: a refused one's job carries `refused`, and the pop-up says checking again will not help in place of Confirm again; a reading refused before its job starts (a planning thrown away, no spec, no plan, an approved ticket) is refused at once, and the re-read after an answer says so in the chat in one sentence with why behind the note's **i**;
  `CriteriaEditor`, the criteria editing the ticket's own editor and a basic ticket's contract
  share, which draws the chat's marks; `GraphInspector`, which rewords a node's criteria and
  chooses how each is proven through `set_criterion`, the host recording the edit as the
  person's, with the chat's last change marked under each; `ContractGraph` and `nodeSummary`
  beside the Graph pane; `draftedLanding`, where Plan it again lands, and `landDrafted` in
  `shared/contract-editing.ts`, which both hosts' `replan` records it with, `draftedPane` and the
  contract reached at `contractStateOf`; and the dismissal's
  refusal: `perbo drift --dismiss` in `apps/cli/src/commands/drift.ts` refuses where the draft
  snapshot `<KEY>.draft.json` records an edit by the person (`author: "you"`) that changed the
  plan and that no re-draft has replaced, or where there is no snapshot to say, the desktop host's
  `driftDismiss` passing that refusal on, and the sample host keeping which of its tickets a
  person has edited since the draft (`handEdited`) and refusing in the same words.

### D-131 — A planning starts from its repository's question

- Owner: Founder
- Decision: a repository picked in Create's picker opens that repository's own page, not a
  planning: the whole page beside the rail, and at its centre the question **What do you want to
  build?** over one wide box, which is a line tall and grows as what is typed wraps. Picking it
  creates nothing. The box has no attach control; in its bottom-right corner are the name of the
  repository and the same send the chat's box has, muted while there is nothing to send. What is
  typed and not sent is the repository's: each repository keeps its own, kept as it is typed, so
  the page shows it again when the repository is picked again, after another repository's page and
  after Perbo is closed and opened again. While the page is open Create reads as the current page,
  no planning pane is under it, and the picker opened from it has that repository's row selected.
  Enter or the send opens the planning and sends what is typed as its first turn, exactly as typing
  it into the chat on the Spec pane does, so it names the spec (D-118); the repository's text is
  then cleared, and the page goes on to the planning's Spec pane in its place, where the chat shows
  the turn and the answer. Shift+Enter starts a new line, and a box empty or holding only spaces
  sends nothing. A send the host refuses keeps the text, says why and leaves no planning behind. A
  planning is never opened on the page, so it is never where a planning is left
  (D-130), and a planning opened over a spec or a ticket never
  lands on it.
- Why: what a person picking a repository has in mind is what they want built, and the first thing
  planning needs from them is that, in their own words. A spec form with a chat beside it asks them
  to choose where to begin before they have begun. A piece of work exists once it has been asked
  for: a planning made at the pick is an untitled row in the picker for words that were never
  sent, and words half-typed for one repository are that repository's until they are sent.
- Built: the `ask` route of the renderer (`#ask/<repoId>`), a page of its own beside the planning
  route, which the picker's repository rows open and nothing else does; `AskPage` in
  `renderer/planning/AskPage.tsx`, which keeps the text through `askSave` — a repository id and the
  text, an empty text removing it — a moment after typing rests and as the box loses focus or the
  page is left, and on send opens a `fresh` planning, sends the one `interviewTurn` the chat sends,
  clears the repository's text and replaces the route with the Spec pane, and where the host
  refuses keeps the text, says why and discards the planning it opened; `asks`, the host's
  preference by repository id beside `titles` and `archived`, on the snapshot, removed with its
  repository when that is disconnected, and required in a stored profile, which a new one writes empty; the picker selecting the repository's row when opened from its
  page; the chat's `SendButton`, shared by both boxes; and the rail lighting Create, with
  `aria-current`, and showing no planning panes on it. The sample host keeps `asks` in its
  sample records and answers `askSave` as the host does.

### D-119 — A pause says which pause it is

- Owner: Founder
- Decision: the dock says the Architect is working for as long as it owes the person a word, and
  says nothing once the next word is theirs. Which it is comes from the session's own report that
  its turn has ended — every transport knows this and each says it differently, so it is carried in
  one shape (`idle`) as the session's words are. A turn the person sends starts the waiting; the
  turn ending, the session ending, the child going and the person stopping it each end it, because
  a pause nothing is coming out of is not a pause to sit through. Turns in flight are counted
  rather than flagged: a person who sends a second before the first is answered is owed two, and
  the session's report that a turn has ended says how many of the person's turns it answered,
  because a provider may answer a turn sent mid-way inside the one it is running. However the
  waiting ends, the turn ends with it: what it changed is marked and the spec it wrote is handed
  over.
- Why: a session that says a line and then reads the repository before saying the next looks, from
  the conversation alone, exactly like one that has finished or fallen over. Read from the last
  line's kind the dock went quiet at the very moment the person most needed telling that something
  was still coming, and a person who thinks a tool has hung stops it.
- Built: the `idle` event on the chat's protocol, carrying how many of the person's turns the ending
  answered, emitted by the Claude transport when the SDK reports a turn's result, counting the
  person's turns the result names among the user messages it consumed, so a list naming none of
  them counts none, and every turn handed to the SDK since the last result where the result
  carries no list, as it carries none on a delivery failure, because nothing else will answer
  them, and by the Codex transport, which takes a turn only once the last has ended, when a turn ends
  however it ended; the host counting what each planning is owed and carrying it on the
  `interview` change beside the asking, clearing it and ending the turn when the child closes, the
  session ends or the person stops it; the snapshot listing
  the plannings mid-turn, so a dock opened part way through one knows it; and the dock's one status
  line, which names what the turn is doing from the last line it put in the conversation — reading
  what was said, thinking, changing the plan — and from the host where no line shows it: writing
  the spec, and a line of the session's held back, for which the session's bubble stands with its
  dots in place of the line until the words arrive, and only then: a line the host is not holding
  is drawn as it arrives.

### D-118 — An untitled planning is named by its first turn

- Owner: Founder
- Decision: the Architect writes `specs/<slug>/spec.md`, so a planning with no slug has nowhere to write. Where the person has not titled it in the Spec pane, the host cuts words from their first turn — the first sentence, its opening dropped, clipped to a whole word within the slug's cap — names the spec's folder with them, writes the spec with no title line and records the slug, then starts the chat on that spec and sends the turn. The cut names the folder and nothing else: it is no title, and its words never show as one (D-133). The chat says which folder was named. A turn no folder name can come from is refused, naming the title it could not take. The folder is minted once and is not moved afterwards; the title in it stays editable. The Architect writes the spec's title line when it first writes the spec, where the spec has none, named as a ticket is rather than cut from the message, and shown the other tickets' names as the drafter is (D-127). Where neither it nor the person titles the spec, it has no title line until admission gives the spec the ticket's name, which is then the drafted name or what stands in for it (D-127). Untitled is display only and never in the file: the picker and, on the planning's panes, the top bar call the planning Untitled for as long as its spec has no title, and by its title the moment the Architect or the person writes one. The Spec pane's title field shows the file's title, and is empty while there is none, for the person to name the work there; a name they give is the spec's title, and the ticket's and the plan's when the plan is drafted (D-127), and the field shows the Architect's as soon as the Architect writes one.
- Why: a person opening planning and typing what they want should be talking to the Architect, not stopped by a field they have not found. Their own words name the folder, so nothing a model returned becomes a path ([ADR-0023](adr/0023-untrusted-context-boundary.md) §4). The naming is said rather than silent because a slug outlives the message it came from.
- Built: `specTitleFromMessage` in `@perbo/planning` cutting the words, `writeSpecFile`'s `folderName` naming a new spec's folder from them, `renderSpec` writing no title line for an empty title and `parseSpec` reading a spec with none as untitled, the host naming the spec on the first turn that way and saying so as a note, and the sample host doing the same; `openDrafts` titling each listed planning by its spec's title, none while it has none, which a Spec-pane save announces as an editing change so the list is read again; `UNTITLED` in `apps/desktop/src/renderer/shell/create.tsx`, the word `titleOfDraft`, and so the top bar, and the picker's spec rows show in place of no title; the Spec pane leaving its title field empty over no title while a section saved meanwhile leaves the file with none; `interviewOrientation` asking for a title line at the spec's head where it has none, with every ticket's name but the one drafted from this spec in a `names` block; `ticketName`, which `perbo admit` names a ticket with, passing over a spec with no title, whose admission records no `title_at_admission`.

### D-124 — `@perbo/contracts` holds what two packages share

- Owner: Founder
- Decision: a schema or rule lives in `@perbo/contracts` when two or more packages, the desktop included, read or write it; a record only one package reads and writes lives in that package beside its code. The CLI's baseline stopwatch and E1 ledger, its local verdicts record, its escapes record and the queue's ordering are its own.
- Why: the dependency floor rebuilds every package on each change, and a module with one consumer is read more easily beside its caller.
- Changes if: a second package reads one of those records.

### D-125 — `perbo` reads every command line by one set of rules

- Owner: Founder
- Decision: one grammar reads argv for every command. `--name=value` is split only in flag position, so a value is never read again as a flag; a value flag takes the next token verbatim, whatever it is shaped like; a switch given a value is refused; `--` ends the options; a repeated single-value flag takes the last of them, which the desktop's trailing `--repo` relies on; and `-h` or `--help` is honoured in flag position and nowhere else. A command declares which flags it has, what each takes and how many positionals it accepts; what a value has to be — an enum, a number, a key, a URL, a date — is the command's input schema, which every caller reaches. This is the CLI's contract: a person's text, and the desktop's, reaches a command as the text it is.
- Why: a caller can only know what a line will mean if every command reads it the same way, and what a person types into an outcome, a note or a path is text rather than more flags. Splitting `--name=value` in flag position alone is what keeps it text: a value re-read as a flag is a value that can approve the ticket it was admitted with, record a decision or turn publication on, and the desktop passes person-typed text as flag values. What a value has to be sits in the input schema instead, because a caller in this process reaches the command there and is owed the same check.
- Built: `apps/cli/src/command-line/grammar.ts` with a test per rule, each command's grammar beside the command, and `terminal.flag-injection.test.ts` holding one case per free-text flag value a person or the desktop fills. What the rules are for — a command as a typed function, argv at the edge, and the boundary the lint rules hold — is [ADR-0039](adr/0039-command-line-edge.md).

### D-126 — Every git and gh process goes through one module

- Owner: Founder
- Decision: every `git` and `gh` process Perbo starts comes from `@perbo/workspace`'s `repository/` module. It builds argv, never a shell string, and refuses an operand git would read as an option before anything is spawned; it runs them in the environment the runner builds from an allow-list, with credential prompts off; it puts one timeout on a local read and a longer one on anything crossing the network, and refuses a fragment of an answer rather than reading it as the whole of one; and signing is whatever the person's own configuration says. Callers ask by name — the head, the merge base, the tracked files, the worktrees, a pull request — rather than by spelling a command. The write guard's replay of the agent's own push is the one exception, because it has to repeat the agent's global flags in the agent's environment, which the typed interface deliberately cannot express. `eslint.config.mjs` refuses the call anywhere else in a package's source, and `scripts/lint-boundaries.test.mjs` shows the rule firing and staying silent.
- Why: the facts about running git are one set of facts — which environment it gets, that a prompt is a failure rather than a hang, how long it may take, what a truncated answer means — and every copy of them is a place they can disagree. A call site that inherits the ambient environment makes whether a fetch works behind a proxy depend on which caller asked.
- Changes if: a caller needs a git invocation the module cannot express and the shape cannot be added to it, which makes the exception list longer than the module's own interface.
- ADR: [ADR-0041](adr/0041-git-and-gh-module.md).
