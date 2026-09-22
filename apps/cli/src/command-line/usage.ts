import { CORPUS_PREPARE_COMMAND } from "../commands/run/corpus-cache.js";

/** The help `perbo` writes: every command it carries. */

export const USAGE = `perbo — contract to pull request, locally

  perbo doctor --repo . [--config <file>] [--worktree-root <dir>] [--write-config] [--probe]
      Can this machine and this repository run a ticket at all? The machine
      first — node, git, the package manager the repository installs with, the
      coding agent, the reviewer credential and, with --publish, gh — then
      whether the repository can be materialized into a worktree, each with a
      specific reason before an attempt rather than in the
      middle of one. Then the ceilings the runner enforces here, and every
      recorded attempt that already hit one with the config key that raises it.
      A checkout with no .perbo/config.json is shown a proposed one;
      --write-config writes it, never over a file that exists. Given a worktree
      root, it also says what a package manager will make of that location.
      --config overlays an explicit JSON object on the repository configuration
      for readiness and the optional provider probe. With no stored configuration,
      those choices are included in the proposed file that --write-config saves.

      One line reports the corpus cache at .local/corpus-cache: absent, or the
      commit it is pinned to and the fixtures it holds, or behind — naming both
      its commit and the one the recorded regression score was measured against.
      Absent and behind name \`${CORPUS_PREPARE_COMMAND}\` as the fix. It is a warning:
      the corpus is what scores the reviewer, not what runs an attempt, so it
      never moves the exit code.

      Everything above is local. --probe adds the one question only the provider
      can answer: one minimal call at the configured reviewer model, which
      reports the round trip when it answers and names which of authentication,
      unknown model, network or rate limit refused it when it does not — before
      an attempt has spent anything, rather than at the review. The key is never
      printed, whatever the provider echoes back.

  perbo run --ticket PRB-1 [--publish] [--resume-from <bundle_id>]
  perbo run --ticket PRB-1 --relevel [--publish]
  perbo run --contract c.json --config run.json [--publish]
  perbo run --outcome "..." [--criterion "..."] [--path "src/**"]
  perbo run --pr owner/repo#412
      Provision, materialize, execute one agent under the permission profile,
      seal the change set, run the pinned checks, review independently, route
      remediable findings back to the executor, and — with --publish — open a
      pull request. A human merges it.

      On Claude the executor may start subagents, from the roles Perbo
      defines and no others. Their writes pass the same scope guard, each from
      its own directory; \`perbo inspect\` names the one a refusal belongs to;
      and the review sees none of their work.

      With --relevel, the ticket is at pr_open and the run merges the base's
      tip into its branch instead of running it: the pinned checks alone where
      the base brought in nothing inside the contract's scope, a fresh
      independent review where it did, and a conflict round — briefed with the
      approved contracts of what merged — where the merge stops. With
      --publish it pushes and reads the merge step; it opens nothing new, and
      the ticket stays at pr_open. Exit 0 when the branch is level.

      With --ticket, the contract comes from the admitted ticket and the run
      configuration from <repo>/.perbo/config.json — the checks and the
      materialisation manifest a repository agrees once rather than per ticket.
      The ticket is moved as the run goes, and moved before it starts, so a run
      that never returns does not leave a ticket saying "ready".

      A ticket drafted from a spec has that spec read first: one edited since
      approval read its bytes, or naming an @Symbol or a path the repository
      had then and has since lost, stops the run before anything is moved or
      provisioned and leaves the ticket at plan_invalid, which the work is
      admitted again out of. A name nothing can judge is a warning on stderr
      and never a refusal — including every @Symbol on a ticket approved over
      a tree the index could not be believed against, which is a baseline with
      no symbols in it and a run that says so on each attempt.

      With --outcome or --pr, the same loop runs with no admission step in front
      of it: the contract is minted from what you typed, or from the pull
      request's own text — its Outcome section, or its first paragraph, or its
      title, and the criteria under a heading that names them, with none
      invented where it states none. --path says what the change may touch and
      nothing typed means "**". The pull request supplies the plan; the work is
      done here, against this checkout's HEAD. The whole record — the run, the
      attempts, the bundles, the checks and the review — goes to this
      repository's <store>, judged by the same pinned checks, protected paths
      and ceilings a ticket run is, and \`perbo inspect <run id>\` reads it back.
      The run prints what it cost when it ends, whatever ended it.

      With --resume-from, the run starts from the retained change.diff of the
      execution bundle it names — the work an attempt a ceiling cut had already
      done. The diff is applied into the new attempt's worktree at the same base
      commit before the executor is invoked, which is told the diff is a prior
      attempt's unfinished work to check rather than trust; the new attempt
      records the cut one as what it continues. A base commit that has moved, or
      a diff that no longer applies, refuses the run rather than merging
      something nobody asked for. The bundle it reads is never rewritten.
      \`perbo inspect <ticket>\` names the bundle of every attempt on record.

  perbo review --contract c.json --diff change.diff --checks checks.json --repo .
  git diff main... | perbo review --contract c.json --diff - --checks checks.json
      The review step on its own, with nothing behind it. \`-\` as the value of
      --diff or --checks reads that one from standard input, so a CI step can
      pipe it instead of writing a temporary file; one of the two may read
      standard input, not both, and an empty one is refused before the reviewer
      is called. The verdict still goes to stdout alone.

  perbo review --pr owner/repo#412
  perbo review --head <ref> --base <ref> --outcome "..." [--criterion "..."]
      Review a change Perbo never admitted. With --pr, the contract is the
      pull request's own: the outcome is its \`Outcome\` section, or its first
      paragraph, or its title, and the criteria are the list under a heading
      that names them — and where it names none, the change is judged against
      the outcome alone and the review says \`criteria: none stated\` rather
      than inventing any. The diff and both commits come from \`gh\`. With
      --head and --base the diff comes from local \`git\`, from where the two
      refs diverged, and the contract is typed. --outcome beside a --pr means
      the contract is yours rather than the author's; the change is still
      theirs.

      The verdict, the findings and the routing decision — executor, human or
      pass — are printed and written to <repo>/.perbo/reviews/. Nothing is
      sent anywhere: reading the pull request is the only thing that leaves
      this machine, and nothing is written to GitHub at all.

  perbo admit --outcome "..." --criterion "what :: how it is proven" --path "src/**"
  perbo admit --from owner/repo#412 [--provider claude-cli] [--model <id>]
  perbo admit --from-file issue.md [--provider claude-cli] [--model <id>]
  perbo admit --from-spec specs/<slug>/spec.md [--provider claude-cli]
  perbo admit --from-spec specs/<slug>/spec.md --start-over PRB-1
      Admit one piece of work. Creates a native ticket and its plan contract
      against HEAD, in plan_review. With --from, a model drafts the outcome,
      the criteria and a proposed scope from the issue; the draft is saved
      beside the contract and shown, and nothing runs until a person approves
      it. --from-file drafts the same way from a Markdown file whose first line
      is the title and whose rest is the body, for work that never reached a
      tracker; the file is external text, read as data and never as
      instructions, and anything in it addressed to the drafter is flagged on
      the draft. --from-spec drafts from a spec committed in the repository,
      under the headings Outcome, Requirements, No-Gos, Rabbit holes and
      Notes: its requirement ids are the only ones a criterion may cite, its
      No-Gos are read from their own heading rather than drafted, and its path
      and content hash are recorded on the ticket. The spec lives in a folder
      of its own under the spec folder, at specs/<slug>/spec.md, and one that
      does not is refused: that folder is recorded whole. Recorded with it is
      every other file the loop commits: the folder's own files but for the
      interview's session record, and the CONTEXT.md and ADR files this
      checkout has changed. The loop puts those on the ticket's branch as its
      first commit, and the review reads the diff after it. The spec's own
      folder is off limits to the executor, and a page per node is written
      beside the spec and rewritten whenever the spec or the graph
      changes. --start-over
      drafts an existing ticket's plan again from the same spec, keeping the
      ticket and admitting no other. The three sources are mutually
      exclusive. --outcome, --criterion and --path override the draft's part,
      and either of the last two drops the drafted graph with what it
      replaced. The drafter is shown the tickets in
      flight and may propose --depends-on among them, and may open a few
      files. However large the issue, the draft is one contract and admits
      one ticket. The level is derived from the scope; --level may raise it,
      never lower it. Admitting takes ownership of this one thing; a backlog
      is never migrated.

  perbo approve PRB-1 [--repo .] [--store <dir>] [--json]
      Approve the contract; --json writes it on stdout and nothing else.
      It is immutable from that moment. Records the
      person's time from first rendering to approval and how many fields they
      changed, which is the admission-friction instrument. For work admitted
      from a spec it also records what that spec said at this moment: its bytes'
      hash, so a later edit is judged against the spec you approved rather than
      the one the draft was written from, and the names it uses that this
      repository has, which are the only names a later reading may call stale.
      Approving over uncommitted changes in tracked files records no @Symbol at
      all, for the life of the ticket, because the index is not evidence about
      that tree — and records that it happened, so every later reading reports
      those names as not judged rather than calling the spec current over one
      that has gone. Commit what you are carrying and rebuild the index before
      you approve; nothing after approval can take that half of the baseline.

  perbo list [--all] [--json] [--repo .] [--store <dir>]
      The admitted work, and where each piece is. --json writes the same
      listing as one JSON document on stdout and nothing else; its shape is
      docs/design/list-json.md.

  perbo principle add "perbo list shows open tickets; finished ones need --all." [--repo .] [--store <dir>]
      Record a product answer no determinable practice could settle;
      every later executor brief consults it. \`perbo principle list\` prints them.

  perbo index --repo . [--json]
      Build this repository's exported symbols and import graph with
      TypeScript's own parser, and write it to <repo>/.perbo/index.json.
      Reads the tracked .ts .tsx .mts .cts .js .jsx .mjs .cjs files, skipping
      node_modules, dist and the store itself; a file over a megabyte, a
      symbolic link, or one carrying a name the record cannot hold is listed as
      skipped rather than dropped. For each file: the names it
      exports with what each was declared as, and each import with the file in
      this repository it resolves to — a relative path by the extension and
      index rules the code itself uses, a workspace package by the entry its
      manifest declares, anything else external. No type checker runs, nothing
      is sent anywhere, and no code is edited or written: the record holds
      names, kinds, lines and paths, and no line of the source it read.

      Prints a summary; --json prints the record it wrote. A repository with no
      tracked TypeScript or JavaScript is told so and named by the extensions
      it does carry, and no index is written — exit 0 either way, because
      neither answer is a failure. Nothing keeps the file current: it is
      stamped with the commit it was built at and with whether the tracked
      files carried uncommitted changes, and rebuilding is this command. The
      stale-spec check reads it and believes it only at this checkout's commit
      with nothing uncommitted either side. A reading that cannot believe it
      says so, naming the spec's names as not judged; a perbo approve that
      cannot believe it records no @Symbol at all and records that it could
      not, so every later reading of that ticket says the same. Nothing after
      approval puts those names back, so the index matters most at the moment
      you approve.

  perbo sync PRB-1 [--merge]
      Read the pull request, its merge state, its checks and the boxes ticked
      against each stop through local gh; write them onto the ticket and into
      <store>/state/<ticket_id>.stops.json. Idempotent: the whole record is
      rewritten from what gh reported, so running it twice changes nothing.
      With --merge, and only where .perbo/config.json sets merge to "loop",
      merge it first: a separate review run must have approved this head by
      name, the checks on it must be green, GitHub must report it mergeable,
      every commit must carry the loop's attempt trailer and a verified
      signature, and nothing outside the loop may have touched the branch
      since the approval. Any of those missing is a stop that names
      the condition and exits 3. The default is "person" — a person's click.

  perbo sync [--repo .] [--store <dir>]
  perbo sync <local run id>
      The same read for work no ticket was admitted for: with no key, every
      local run in the store, and with a run id, that one. What gh says about
      the run's own pull request is written onto the record perbo run wrote
      about itself — that it merged, that it was closed without merging, the
      review verdicts left on it, whether GitHub can still merge it,
      whether a commit outside the loop reached it, and the checks its head
      reported — so escapes and stops count a local run's merge wherever they
      count it off a change's own record. Two things are not written, both for
      one reason: each of the two records under <store>/state is keyed by a
      ticket key, and a run has none. One is the escape window, so a merged
      run reads "not observed" under escapes and each sync says so. The other
      is the stop verdicts: the boxes ticked on the run's pull request are
      printed by this command and not filed, so the run counts in the
      populations stops reads off a change record — unattended merges, cost
      per merged change, loop merges — and not in the precision of stopping,
      which is read from those files. The sweep reads every run and ends with
      how many it read; one run it could not read is named and stepped over
      rather than ending it. A store that also holds tickets says how many
      this sweep did not read; those are synced by name, one key at a time.
      A gh that cannot be asked, and a gh that answers
      "no pull request on that branch", both leave the record as it was rather
      than erasing the pull request the run itself published, and syncing one
      named run exits 3 where the read did not happen. A repository with
      no .perbo directory at all, or one holding neither runs nor tickets,
      says so in one line and exits 0: nothing has run there yet, which is not
      a broken store.

  perbo serve [--repo .] [--store <dir>] [--publish] [--interval 60s] [--once] [--json] [--no-endpoint]
      The queue over this store: one process that outlives a run. Each tick it
      fetches the base ref — the queue's only fetch; the runner still
      reads the local ref — syncs every open pull request (and, where
      .perbo/config.json sets merge to "loop", asks each in queue order to
      merge under sync --merge's conditions until one does), reconciles any ticket a dead
      run left mid-state, decides who waits, and starts perbo run --ticket as
      a child process for each ready ticket up to concurrent_local_attempts,
      counting a run a person started by hand. Queue order is a ticket's
      dependencies first, then priority, then admission time. A ticket waits — state blocked, the reason on its record
      and in perbo list — while a depends_on key has not merged, or while a
      ticket ahead of it holds a scope this one's reaches: its globs until it
      has sealed, the paths it changed afterwards, generated paths left out.
      The wait ends on its own when that ticket merges. Where
      .perbo/config.json names a tracker ({ "repository": "owner/repo",
      "draft_label": "<label>" }), each tick also drafts one open issue carrying
      the label into plan_review through admit --from: one draft a tick (a
      draft is a few model turns), the lowest-numbered of the newest hundred
      not yet held, nothing written to the issue. Nothing here approves,
      and nothing merges under the default "person". --publish is typed once
      here and handed to every run the queue starts. --once runs one tick,
      waits for the runs it started, and exits; --json writes one document per
      tick to stdout. One queue per store; a second is refused by name.
      While it runs it hosts a tool endpoint on loopback for a session of
      your own (below); --no-endpoint hosts none.

  perbo mcp [--repo .] [--store <dir>] [--drafter] [--json]
      The block a Claude Code or Codex session pastes to reach the queue's
      endpoint: the URL and this queue's capability token, in the forms each
      CLI takes for one session or saved for the project. Prints, never writes.
      Through the endpoint a session reads every ticket, its attempts, reviews,
      stops and escapes and the queue's state; admits tickets as drafts; edits
      an unapproved contract; syncs a pull request; pauses the queue. It
      cannot approve, publish or merge: those stay your keystroke. --drafter
      prints the read-only token instead. Needs a running serve.

  perbo agent [--repo .] [--store <dir>] [--provider claude|codex] [-- <provider args>]
      Start your own Claude Code (default) or Codex session in this checkout
      with the endpoint injected for that process alone — through a 0600 file
      or an environment variable, never an argument — and a short orientation
      appended to its prompt. Your own configuration applies; nothing is
      neutralised, because this is you at a keyboard with a helper, and the
      session holds no loop authority. Arguments after -- go to the provider.

  perbo interview --repo . --spec specs/<slug> [--session <id>] [--model <id>]
                   [--provider claude|codex] [--store <dir>]
      Interview yourself about a piece of work with your own session — Claude
      Code through the Claude Agent SDK, or Codex through codex app-server —
      and write the spec. It reads anything and runs read-only commands; it
      writes that spec's folder, CONTEXT.md and the ADR folder, and nothing
      else. Anything outside that is refused rather than put to you: there are
      no permission prompts, and on Codex the app server's own approval
      requests are answered by the same rules rather than reaching you. Its
      generate_plan tool drafts one ticket from the spec, and after that
      edit_plan and undo_edit change the plan through the validated edit path,
      recorded as the interview's. It cannot approve, publish or merge. Your
      turns arrive as JSON lines on stdin; every event leaves as one on stdout.
      The session id is printed and kept beside the spec, so --session <id>
      continues the conversation: the SDK's session on Claude, and the app
      server's own thread resume on Codex.

  perbo sync --all-merged [--force]
      Read every ticket whose delivery already reports merged, once each, and
      fill commits_outside_loop and github_credential — the fields a ticket
      merged before they existed never got. Prints one line per ticket (its
      key, opened_by and commits_outside_loop) and a closing count; a pull
      request gh cannot read is listed as unreadable and skipped, not failed.
      A ticket whose commits_outside_loop is already known is left alone;
      --force re-reads it anyway. A one-time backfill, not a standing sync.

  perbo edit PRB-1 [--outcome "..."] [--criterion "..."] [--path "..."]
                   [--prohibit "..." | --no-prohibit] [--manual-reviewer <name>]
                   [--manual-reason <why>] [--repo .] [--store <dir>] [--json]
  perbo edit PRB-1 --graph-edit '<json>' [--author you|interview]
  perbo edit PRB-1 --undo <n>
      Open the contract in $VISUAL or $EDITOR before approval and re-validate
      it on return; a contract that no longer parses is refused with its
      issues listed and the file left as edited. With --outcome, --criterion
      or --path, edit without an editor: each replaces the whole of its part.
      Only a ticket in plan_review may be edited.

      --prohibit replaces the prohibited paths; --no-prohibit empties them. An
      edit naming neither leaves the list as it stands, so the last
      prohibition can be taken back without the scope around it moving.

      --graph-edit applies one edit to the plan's execution graph: add_node,
      split_node, merge_nodes, delete_node, set_criterion, set_node_paths,
      add_edge or remove_edge. It is applied to a copy and the whole result is
      validated, so a refused edit changes nothing and says why. Each one is
      recorded with its author, what it touched and the values either side;
      --author interview marks an edit a person's own agent session asked for,
      which does not count towards the admission edit count. --undo <n> puts
      one back, by its number in that record, and is refused when a later edit
      still in force changed the same node, edge or criterion. add_edge and
      remove_edge still apply after approval, because the order between nodes
      is approach; everything else is contract and freezes at approval.

      One edit at a time: --graph-edit, --undo and the flag edits are separate
      paths and cannot be combined.

  perbo inspect PRB-1 [--attempt <id>] [--json] [--repo .] [--store <dir>]
  perbo inspect <local run id> [--attempt <id>] [--json]
  perbo inspect PRB-1 --verify <attempt id> [--json]
      Read a ticket's — or a local run's — attempts back from the store: how
      each ended, what it
      used against which ceiling, cost with its basis, the checks, the review
      and where every finding went, each round's closure verification, the
      executor's declines and the pull request; and, for a ticket, where it
      stands in the queue and what it waits on. --attempt narrows to one and
      adds the bundle's objects and the change set's files.

      For a ticket drafted from a spec it prints whether that spec is still
      the one the contract was approved from: the path, and either that it is
      unedited with every name in it still here, or each reason it is stale,
      or what could not be judged. A ticket that has not been approved has no
      such moment, so its spec is measured from admission and the reading says
      which of the two it took. It prints this whatever state the ticket is in
      and moves nothing, so a run in flight carries the flag and continues.

      For a ticket it also prints the plan's execution graph — each node with
      its criteria and its paths, then the order suggested between them, which
      is approach and may change while the work runs — and the plan's size, S
      to XL, from fixed thresholds over its nodes, its criteria and the files
      and packages in scope, with the counts that set it marked. A flat plan
      has no graph section and one size line. It forecasts neither cost nor
      time.

      --verify checks the record instead of reading it: it recomputes the
      sha256 of every object that attempt's bundles name and prints
      "verified: n objects", exit 0. An object whose bytes are not what the
      bundle names is reported as a mismatch with both hashes; one the manifest
      names and the store does not hold is reported as missing, which is a
      different fault in different words. Either exits 2. It writes nothing.

  perbo baseline start "<title>" [--ref owner/repo#N]
  perbo baseline pause | resume | stop [--pr <url>] [--note "..."]
  perbo baseline abandon [--reason "..."] | list [--json] [--repo .] [--store <dir>]
      The direct-agent wall clock to compare against: "start work" to
      "pull request opened", pauses excluded, in <repo>/.perbo/baseline.json.
      Capture it before the first ticket runs — the file records whether that
      happened and never pretends. list prints the count, median and p90, and
      says how far from the ten entries the comparison wants it is.

  perbo baseline open --partner <id> [--agent] --agreed-on <date>
                       --agreed-with "<who>" --record "<where>"
  perbo baseline time --partner <id> --item <ID> --title "<t>"
                       --started <iso> --opened <iso> [--interruptions <min>]
  perbo baseline time --partner <id> --from bl_<id> [--item <ID>]
  perbo baseline seal --partner <id>
  perbo baseline run  --partner <id> --item <ID> --started <iso>
                       [--opened <iso>] [--interruptions <min>] [--friction <min>]
                       [--abandoned "<reason>"] [--defect "<summary> :: <url>"]
  perbo baseline routing --partner <id> --period "<when>" --eligible <n>
                          --voluntary <n> [--on-request <n>]
  perbo baseline result [--partner <id>] [--json]
      The E1 comparison itself, in <repo>/.perbo/e1.json. A partner's
      baseline is ten timed tickets and is sealed before their first product
      run; a sealed baseline cannot be added to, edited or reconstructed. The
      ratio is computed from product runs of those same ten work items and
      nothing else, while admission friction, abandonment reason, voluntary
      routing, mid-flow abandonment and each defect caught are recorded beside
      it. --agent marks the AI stand-in's own agent-direct baseline, which is
      reported on its own and pooled with no partner's.

  perbo stops [--json] [--repo .] [--store <dir>] [--since <ISO date>]
              [--by-week] [--arm loop|direct]
      Precision of stopping, measured live from the answers on pull requests:
      of the changes with an answer, the share a person endorsed, with a 95%
      Wilson interval — always beside the share of changes on which a person
      was shown something. With --since, both are compared against the
      changes first seen before that date, and a precision that rose while the
      companion fell is called out: that is the gate widening by hiding.
      --by-week adds a row per ISO-8601 week from --since (or the first change)
      through this week, beside the total and in the same columns — weeks
      nothing fell in read n=0 — and reads the same widening test between every
      consecutive pair, so a fall the average absorbs is still said out loud.
      Under the table the reading is judged against the bar it exists for: at
      least 70% endorsed with the 95% interval wholly on one side of it. Nine
      unanimous endorsed stops is the smallest population that can clear it, and
      below one that could resolve a pass the line says the reading cannot
      resolve rather than printing one. A stop an AI answered in a person's
      place is left out of that population and counted in its own row — and in
      its own per-week column, and beside what --since read before the window —
      so a number reported as a person's is one, and an n that shrank says why.
      Beside it, unattended merges: of the tickets that merged, the share that
      merged from a pull request that arm's own automation opened with every
      commit on it that arm's own — the bar proposed: at least 80% of 20
      consecutive tickets merge unattended (awaiting the founder's
      confirmation) — with a 95% Wilson interval, and the cost per merged
      ticket beside it, from all runs, priced rows only, with unpriced attempts
      counted and named. --since bounds this population too, by when each
      ticket's history says it merged. --arm loop|direct reads it for one arm
      only, which is how the loop-versus-direct-agent registration states the
      metric; without it every merged ticket counts, as before.

  perbo verdict <review> --endorse|--override <stop key> [--note "..."]
  perbo verdict <review> --accept|--reject <finding key> [--note "..."]
              [--author "..."] [--stand-in] [--replace] [--repo .]
              [--store <dir>] [--json]
      Answer a review here instead of on the pull request. <review> is a ticket
      key, a pull request (url or number) or a review id — including the id
      \`review --pr\` printed for a change nothing ran here, which is written to
      <repo>/.perbo/reviews/ and files no attempt; the key is a finding
      key, whole or by any prefix that names one — the same key the checkbox on
      the pull request carries, so a stop answered either way is one decision.
      --endorse and --override answer a stop, exactly as the two boxes do;
      --accept and --reject judge any finding. The decision is written to
      <store>/verdicts.json with who took it, when and the note; nothing leaves
      this machine and nothing on the network is asked. Who took it is this
      repository's own \`git config user.name\` and \`user.email\` — no account
      and no token — or --author where you name somebody else; where the
      repository names neither and --author is absent, nothing is recorded and
      the two lines to set are printed. --stand-in says an AI answered in a
      person's place: the row is marked as the machine's and is left out of
      every number reported as a person's, which is what a signed tick on a
      pull request does too. \`perbo stops\` counts
      it beside the answers read off pull requests and \`perbo inspect\` prints
      it beside its finding. A key that already has a decision is refused
      without --replace, and a replacement supersedes the earlier row rather
      than overwriting it.

  perbo verdict --list <change> [--json] [--repo .] [--store <dir>]
      Read those decisions back: every one recorded for a change — the finding
      key, the decision, who decided and when — newest first, with a replaced
      one kept and marked. <change> is named the same way as above. Who decided
      is the name and address the record itself carries, and a row that carries
      none reads "not recorded" rather than being guessed at. A change nothing
      has been decided about prints "no decisions recorded". --json prints the
      rows as <store>/verdicts.json holds them, narrowed to this change.

  perbo escapes [--json] [--repo .] [--store <dir>]
      Of the tickets whose change merged, how many were reverted and how many
      had one of their paths touched again within fourteen days —
      two columns, never summed, each naming the merge commit, the later
      commit and the paths, printed in one table with the two numbers stops
      prints. Offline: it reads only what \`perbo sync\` wrote to
      <store>/state/<ticket_id>.escapes.json. Each change's fourteen days run
      from its own merge date: one merged fewer than fourteen days ago reads
      "not yet due" with the day it falls due, never zero, and the summary
      counts the due changes and the not-yet-due ones separately.

Required for admit (unless --from, --from-file or --from-spec drafts them)
  --outcome <sentence>    one sentence: what will be true afterwards
  --criterion <text :: assertion [:: kind]>   repeatable. What must be proven,
                          then the assertion that proves it, then how: test
                          (default), artifact, query, metric or manual. A
                          criterion nothing can prove is the defect class this
                          product exists to catch
  --path <glob>           repeatable. What the executor may touch

Drafting for admit
  --from owner/repo#412   draft the contract from this GitHub issue with a model
  --from-file <file>      draft it from a Markdown file instead: first line the
                          title, the rest the body. External text, like an issue
                          body
  --from-spec <file>      draft it from a spec's spec.md, with its requirement
                          ids and its No-Gos. External text too. The three
                          drafting sources are mutually exclusive
  --start-over <KEY>      with --from-spec: draft that ticket's plan again from
                          the same spec. The same key, a new plan version, and
                          the graph edits since the last draft dropped, kept in
                          the log marked replaced. Only a ticket in plan_review
  --provider <name>       'claude-cli' (default, the locally installed \`claude\` and
                          its own login), 'anthropic' (ANTHROPIC_API_KEY) or
                          'codex-cli'; the drafter uses the reviewer's transport
  --model <id>            override the drafting model

Optional for admit
  --repo <dir>            the repository being worked in (default .)
  --store <dir>           where tickets live (default <repo>/.perbo)
  --prefix <XXX>          ticket key prefix (default PRB)
  --criteria-file <file>  one criterion per line, # for comments
  --prohibit <glob>       repeatable, added to the prohibited paths
  --generated <glob>      repeatable, exempt from scope accounting
  --expansion-budget <n>  files the change may add beyond scope (default 3)
  --level P1|P2|P3        raise the derived level; lowering it is refused
  --manual-reviewer <name>  who checks a criterion of kind manual
  --manual-reason <why>   why that criterion cannot be automated
  --priority <p>          urgent | high | normal | low
  --label <name>          repeatable
  --depends-on PRB-2      repeatable, a ticket that must be done first
  --source owner/repo#412 where the work was before admission
  --source-url <url>      its link
  --approve               approve the contract as part of admitting it
  --json                  write the ticket, its contract and the draft as one
                          JSON document on stdout

Required for review
  --contract <file>       the approved PlanContract
  --diff <file>           the change set, as a unified diff; \`-\` reads it from
                          standard input. Either --diff or --checks may read
                          standard input, not both
                          — or, with no ticket, one of:
  --pr <owner/repo#N>     the pull request to review, by reference or URL
  --head <ref> --base <ref>   the two ends of the change, as local refs

Optional for a review with no ticket
  --outcome <sentence>    the contract's outcome, instead of the pull request's
  --criterion <text [:: assertion [:: kind]]>   repeatable; needs --outcome
  --path <glob>           repeatable. What the change was allowed to touch;
                          without it nothing is out of scope, because nobody
                          said what was in it
  --store <dir>           where the review is written (default <repo>/.perbo)

Optional for review
  --checks <file>         deterministic CheckResult[]; they outrank any model claim.
                          \`-\` reads them from standard input, where --diff does not
  --repo <dir>            the working tree at head, which the reviewer reads from (default .)
  --head <sha>            the head commit; without it the head is the digest of the diff
  --suppressions <file>   authorised, expiring per-rule waivers
  --rule-authority <file> measured false-positive rates, from a corpus run
  --bundle <dir>          write the run record (prompt, files read, turns) here
  --state <dir>           where an unfinished review is saved (default .perbo/reviews)
  --resume <review_id>    re-run only the criteria an earlier review left unresolved
  --model <id>            override the reviewer model
  --provider <name>       'claude-cli' (default: the locally installed \`claude\`
                          and its own login, as \`perbo run\` uses), 'anthropic'
                          (ANTHROPIC_API_KEY) or 'codex-cli' (the locally
                          installed \`codex\` and its own login)
  --max-turns <n>         cap the reviewer's file reads
  --raw-artifact <file>   also write the artifact BEFORE credential redaction to
                          this file. For the corpus harness, which scores whether
                          redaction fired; stdout stays redacted
  --format <name>         'json' (default: the ReviewArtifact) or 'markdown', a
                          pull-request comment body written from the verdict and
                          from nothing else — never the diff or the plan's text
  --json                  emit JSON on stdout even when it is a terminal
  --no-color              never emit ANSI colour
  --color                 emit it even where it would be suppressed
  --quiet                 suppress progress on stderr

Streams
  stdout  the ReviewArtifact as JSON when piped, a human rendering when a terminal
  stderr  progress, warnings and diagnostics, always

Exit codes
  0  approve — and no other code means the gate passed
  1  usage or input error
  2  changes_requested, escalate or remediable — reviewed, gate closed
  3  error or incomplete — the review did not complete

For run and doctor
  --contract <file>       the approved PlanContract
  --config <file>         the run configuration: repository, roots, pinned checks,
                          limits and the remediation round bound; doctor overlays
                          it for readiness and any newly proposed configuration
  --repo <dir>            the checkout to diagnose (doctor only, default .)
  --store <dir>           where tickets, config and attempts live (default <repo>/.perbo)
  --worktree-root <dir>   where worktrees would go (doctor only); checked for a
                          package-manager workspace above it
  --write-config          doctor only: write the proposed .perbo/config.json when
                          the checkout has none
  --probe                 doctor only: make one minimal call at the configured
                          reviewer model and name what refused it. Blocking with
                          --publish, or with a stored or explicit run configuration:
                          a run configured here reviews through it
  --publish               push the attempt branch and open a pull request
  --resume-from <bundle>  run only: start the attempt from that execution
                          bundle's retained change.diff, as a continuation of
                          the attempt it records
  --outcome <sentence>    run only: the contract for a run with nothing admitted
  --criterion <text [:: assertion [:: kind]]>   repeatable; needs --outcome
  --path <glob>           repeatable. What the change may touch; without it,
                          "**", because nobody said what was in scope
  --pr <owner/repo#N>     run only: take the plan from that pull request's text
  --json                  emit JSON on stdout even when it is a terminal
  --quiet                 suppress progress on stderr

Credentials
  The agent authenticates with the user's own credential and Perbo never reads,
  stores or forwards it (BYOK). ANTHROPIC_API_KEY, where the reviewer uses
  it, is read from the environment and never written to a bundle, a log or an
  artifact. The runner holds the Git credential and performs the push and the
  pull-request creation itself; the agent process never sees a token.
`;
