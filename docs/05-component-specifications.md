# Component Specifications

One entry per real component in this repository. **Owns** is what only this component writes. **Consumes** is what it reads, calls or links against. **Emits** is what it writes, returns or hands off to the next component.

## `apps/cli` — the `perbo` command

One binary carries every command: `doctor`, `baseline`, `review`, `inspect`, `verdict`, `run`, `admit`, `edit`, `approve`, `list`, `sync`, `serve`, `mcp`, `agent`, `interview`, `drift`, `stops`, `escapes`, `principle` and `index`. `tooling/package` bundles it into the design-partner tarball, linking `@perbo/contracts`, `@perbo/model`, `@perbo/planning`, `@perbo/review`, `@perbo/runner` and `@perbo/workspace` ([D-075](11-open-decisions.md), [ADR-0032](adr/0032-open-source-the-local-cli-and-the-reviewer.md)).

**Owns:** the ticket store under `.perbo/` — admission, contracts, drafts, approval and edit history; `perbo serve`, the queue over that store: it fetches the base ref, reads open pull requests through `sync`, decides who waits by set arithmetic over approved scope, re-levels open branches behind the base, starts runs up to the configured concurrency, drafts labelled tracker issues into `plan_review`, and, under `merge: loop`, merges the head pull request once [D-041](11-open-decisions.md)'s conditions hold ([D-108](11-open-decisions.md)); the loopback tool endpoint `perbo serve` hosts and `perbo mcp` / `perbo agent` reach, one capability token per role, scoped to reads plus `admit`, `edit`, `sync` and pause/resume — never approve, publish or merge ([D-109](11-open-decisions.md)); `perbo interview`, the person's own Claude Code session through the Claude Agent SDK or Codex session through `codex app-server`, which writes the spec folder, `CONTEXT.md` and the ADR folder under the runner's write guard, edits the plan drafted from that spec through the validated edit path alone ([D-102](11-open-decisions.md)); `perbo drift`, the reading of a plan against the spec it was drafted from, and its verdict at `<KEY>.drift.json` ([D-128](11-open-decisions.md)); the stops/escapes ledger, the local verdicts record, the baseline stopwatch and the E1 ledger ([D-038](11-open-decisions.md)); `perbo index`, the symbol and import index over a TypeScript and JavaScript repository, read off the tracked tree with TypeScript's own parser and written to `<repo>/.perbo/index.json`, and the stale-spec check that reads it beside the spec's own bytes — stopping a run on a stale spec at `plan_invalid` and flagging one already in flight ([D-015](11-open-decisions.md), [D-103](11-open-decisions.md)).

**Consumes:** `@perbo/contracts`, `@perbo/model`, `@perbo/review`, `@perbo/workspace`, `@perbo/runner` and `@perbo/planning`; local `git` and `gh`; the person's own coding-agent and reviewer credentials — Perbo never reads, stores or forwards one.

**Emits:** `ReviewArtifact` and `ExecutionAttempt` records, ticket state transitions, the stop and verdict ledgers, and, with `--publish`, a branch and a pull request for a person to merge.

**Trust boundary:** a model's drafted contract or proposed scope is data until a person's `approve` confirms it; only then does a scope glob become an action parameter ([ADR-0023](adr/0023-untrusted-context-boundary.md), [D-072](11-open-decisions.md)).

Built: Create, its picker, the Spec pane, which writes the spec folder, the Explorer pane, the Graph pane, the Impact pane, the Problems pane an epic's every way from the plan to the contract goes through, over `perbo drift` ([D-128](11-open-decisions.md)), `perbo interview` itself on both transports and the chat docking it beside every pane but Problems, and the loop committing the spec folder first on the ticket's branch ([D-101](11-open-decisions.md), [D-102](11-open-decisions.md), [D-103](11-open-decisions.md)). Decided, not built: the precondition `merge: loop` needs before use (SCP-229, [D-041](11-open-decisions.md)).

## `apps/desktop` — the Perbo desktop

A local Electron host and a shared React renderer over the bundled CLI ([ADR-0033](adr/0033-focrux-local-desktop-and-subscription-providers.md)) — process composition, not one app importing another's source.

**Owns:** the native shell — validated IPC between host and renderer, native dialogs, fixed CLI subprocess argv, provider sign-in through a fixed terminal command per provider; the contract editor, the one durable edit surface the desktop offers, against one workspace projection ([D-095](11-open-decisions.md), [ADR-0034](adr/0034-desktop-editing-and-workspace-projection.md)); the Spec pane's `@Symbol` completion over `perbo index`, which the host runs over the registered repository so that no name, path or file a renderer sent reaches it ([D-015](11-open-decisions.md), [ADR-0023](adr/0023-untrusted-context-boundary.md) §4); the local profile/job journal in Electron's own user-data directory; the two lanes a command runs in — drafting, admission, contract edits and impact checks any number at a time; runs, decisions, findings, delivery refreshes, product decisions and readiness checks one at a time; disconnecting a repository, deleting a contract or changing a manifest waits for every command running in that repository ([D-101](11-open-decisions.md)), and the renderer's primitives and design tokens in `src/renderer/ui`: one surface every screen imports, with no filesystem, IPC, provider or application-state dependency, and the dark palette and transitions.dev motion ([D-097](11-open-decisions.md)).

**Consumes:** the bundled `@perbo/cli` and its write-guard hook, run on the Node inside Electron, each repository's own `.perbo/` store — read, never a second source of truth. Claude Code and Codex authenticate on the person's own subscription login; an API key is optional ([D-093](11-open-decisions.md)).

**Emits:** nothing canonical — tickets and evidence stay in the repository's own store; the desktop writes only its local profile/job journal, and a native package under `apps/desktop/release`.

**Trust boundary:** the desktop reads code and never edits it; diffs are read-only and "open" hands off to the person's own editor ([D-015](11-open-decisions.md), [ADR-0018](adr/0018-defer-custom-ide-until-evidence-gates.md)).

Decided, not built: the phone's surfaces, which follow pairing ([D-097](11-open-decisions.md)).

## `packages/contracts` — `@perbo/contracts`

Versioned Zod schemas and inferred types — files, not tables — for every artifact the loop passes between its own components. The dependency floor: every other package here builds on it, and it depends on none of them.

**Owns:** `PlanContract` (the immutable outcome, criteria, scope, base and — where the work divides — the execution graph's nodes, [ADR-0016](adr/0016-minimal-machine-maintained-planning.md), [D-100](11-open-decisions.md)), `ApproachRecord` (the order between nodes and the spec's No-Gos, which may change after approval), `GraphEdit` (the eight operations the one validated edit path applies), the size estimate (`sizeEstimate` and `planSizeCounts`, [D-104](11-open-decisions.md)), `Ticket`, `ChangeSet`, `CheckResult`, `ReviewArtifact`, `ExecutionAttempt`, `RunBundle`, `MaterializationManifest`, `PermissionProfile`, `LimitsTable`, `SecretIndex` (materialized secrets indexed by the sha256 of file and value, [D-012](11-open-decisions.md)), `SymbolIndex` (the exported names and import edges of a TypeScript and JavaScript repository, stamped with the commit they were read at and whether the working tree was clean, [D-015](11-open-decisions.md)), `issueAuthoredAttempts`, which reports rather than filters every line of an issue that claims the work is already done or addresses the drafter, and risk derivation (`derivePlannedRisk` from declared scope, `deriveActualRisk` from the sealed diff — a level may rise, never fall).

**Consumes:** nothing in this repository.

**Emits:** the typed schemas and inferred types every other package imports; no runtime behaviour of its own. Not published to a package registry — it ships inlined in the CLI bundle.

## `packages/model` — `@perbo/model`

The model call: one port over one turn of the read-or-submit protocol, and three transports onto it — the Anthropic SDK, a local `claude` binary and a local `codex` binary ([D-123](11-open-decisions.md)).

**Owns:** the request each transport builds, byte for byte, pinned by a record beside it; the two wire tool names the protocol uses; the default model per transport; token accounting, the Claude list-price card and which of the two ways of knowing a cost a figure came by. The two CLI transports are the only code in the repository that starts a provider binary: argv never a command line, each in a scratch directory of its own under the executor's environment allow-list, with every customisation, tool, hook and slash command suppressed ([ADR-0023](adr/0023-untrusted-context-boundary.md), [ADR-0030](adr/0030-neutralise-repository-supplied-agent-configuration.md)).

**Consumes:** `@perbo/contracts`, and a provider credential the person already has — read by the SDK or the binary from the environment, never by Perbo.

**Emits:** one turn: the tool calls the model made, the tokens it used, and what the transport says the turn cost where it knows.

**Trust boundary:** the prompt and the system prompt are never command-line arguments — one travels on stdin, the other in a file of that conversation's own — because a file a caller read can hold a NUL byte or more bytes than `ARG_MAX`, and argv can hold neither.

## `packages/review` — `@perbo/review`

Independent review: checks, findings, coverage and structured verdicts, over one model client (`@perbo/model`).

**Owns:** the blocking matrix and routing, which sends a finding the executor can close back to it as `remediable` within a round limit ([docs/04](04-ticket-workspace-and-review.md#the-blocking-matrix), [D-051](11-open-decisions.md)); stable finding keys (`hash(rule_id | criterion_id | file | symbol)`); waivers and measured rule authority; review independence, with the executor's narrative hidden at every level ([D-037](11-open-decisions.md)).

**Consumes:** `@perbo/model`; the approved plan, the sealed change set, deterministic check results, and files it selects itself from a bounded read-only surface that excludes materialized secrets and repository-supplied agent configuration. Never the executor's narrative or transcript, at any level — repository and issue content arrives only inside trust-tagged blocks, data rather than instruction ([ADR-0023](adr/0023-untrusted-context-boundary.md), [D-035](11-open-decisions.md)).

**Emits:** the `ReviewArtifact` — structured per-criterion verdicts and findings, never parsed prose; deterministic check results outrank a model's claim about them.

Decided, not built: routing findings other review tools leave on the pull request, and a reviewer of a different model family at P3 ([D-088](11-open-decisions.md), [D-037](11-open-decisions.md)).

## `packages/workspace` — `@perbo/workspace`

The local worktree provider, and the harder half of it: making the worktree runnable.

**Owns:** one isolated worktree and branch per attempt chain from an exact base commit, with leases and stale reclaim; the materialization diagnostic, which proposes a manifest from the checkout and refuses by name, before an attempt starts, a repository that cannot be materialized ([ADR-0025](adr/0025-worktree-environment-contract.md)); the install/verify strategy for a monorepo member, keeping the workspace root — where the lockfile and the install live — and the package root — whose scripts are the checks — apart. It installs pnpm, npm, yarn and bun repositories and monorepos against a declared manifest, and materializes any other GitHub repository a standard git worktree can check out with nothing installed; a repository with no test script a worktree can run is verified with `git status --porcelain` and reported, not refused ([D-013](11-open-decisions.md)); and every `git` and `gh` process any package starts, asked by name — the head, the merge base, the tracked files, the worktrees, a pull request — in the runner's allow-listed environment with prompts off, under a ceiling on time and on how much of an answer may be read, and signed as the person's own configuration says ([D-126](11-open-decisions.md), [ADR-0041](adr/0041-git-and-gh-module.md)).

**Consumes:** the checkout it is pointed at. `exec.ts` runs every process as argv, never a shell string, and `repository/` refuses an operand git would read as an option before one is spawned ([ADR-0023](adr/0023-untrusted-context-boundary.md) §4).

**Emits:** a materialized worktree and a first-run diagnostic report; `perbo-materialisation` runs the [ADR-0025](adr/0025-worktree-environment-contract.md) diagnostic on its own as a standalone measurement.

A remediation round shares its predecessor's worktree and lease rather than provisioning a second one — Git refuses to check one branch out in two worktrees — so the unit is the attempt chain, not the attempt.

## `packages/runner` — `@perbo/runner`

The half of execution that is not the agent.

**Owns:** the permission profile (command allow-list, deny-list, an environment built from an allow-list, a pinned provider base URL); one coding-agent adapter per provider, each asserting the agent loaded nothing originating in the repository; quarantine of every known agent-configuration path out of the worktree before handover and back after ([ADR-0030](adr/0030-neutralise-repository-supplied-agent-configuration.md)); the stall detector and the ceilings the runner enforces rather than requests of the model — no tool activity for `attempt_stall_ms`, a cost cap where the executor is billed per token, and whatever wall clock, commands, iterations or tokens a repository sets, each with a typed stop reason ([D-096](11-open-decisions.md)); the prohibited-action list, checked against commands and against the sealed paths; the sealed change set, with materialized secrets removed by content hash; immutable, content-addressed run bundles with a computed replayability tier ([ADR-0026](adr/0026-replay-claim-tiering.md)); delivery — push and pull request through local `git`/`gh`, holding the credential so the agent never sees a token; the remediation loop: contract, worktree, agent, seal, checks, review, routing, pull request.

**Consumes:** the approved plan, the materialized worktree, the executor's own tool calls.

**Emits:** the `ExecutionAttempt` record, the run bundle, the pull request.

On both transports the executor starts subagents from the roles Perbo defines, scope-guarded and invisible to review ([D-106](11-open-decisions.md)). Decided, not built: a merge step that accepts unsigned commits and leaves signing to the repository's own rule ([D-091](11-open-decisions.md), SCP-280).

## `packages/planning` — `@perbo/planning`

The contract draft, and the measurement of what a person did to it.

**Owns:** `draftContract` — one model call that turns an issue or a spec into a name told apart from every other ticket's ([D-127](11-open-decisions.md)), a proposed outcome, the criteria the work has, a scope of one glob or more, as many as the work lands in, and, where it divides, the nodes and suggested edges of an execution graph, never executed and never approved by drafting alone ([D-071](11-open-decisions.md), [D-072](11-open-decisions.md), [D-100](11-open-decisions.md)); `parseSpec`, which reads a spec's Outcome, Requirements, No-Gos, Rabbit holes and Notes and the requirement ids a criterion may cite, and the writing that is its other half — the slug a title takes, `writeSpecFile`, which gives each requirement an id and hands out none twice, `requirementNodes`, which says which node each requirement landed in, and `writeNodePages`, the page per node beside the spec ([D-103](11-open-decisions.md)); `contractEditCount`, which counts the fields a person changed between the contract as first rendered and the one approved ([D-072](11-open-decisions.md)); `impactReport`, which derives a draft's impact warnings from the tracked tree, the draft's allowed scope, the spec's text and the symbol index — files outside the scope importing what the draft changes or what the spec names, and the path classes `risk.ts` recognises in a package the scope or the spec reaches — reading no file and starting no process, so the desktop's browser preview derives what its host does ([D-015](11-open-decisions.md)).

**Consumes:** an issue or a Markdown file, read as external, trust-tagged data — never as instruction — and the repository's own file tree, two levels deep, for proposed globs to be checked against; for impact warnings, its caller's tracked-path list and symbol index, and the spec's own text, matched against that list and never opened; nothing else of the repository ([ADR-0023](adr/0023-untrusted-context-boundary.md)). The drafting call goes through `@perbo/model`, and the file tree is read through `@perbo/workspace`.

**Emits:** the validated draft and its provenance (model, cost, prompt version); the approved contract is written by `apps/cli`, not this package.

## `packages/evaluation` — the corpus and the regression suite

Scoped here to the seeded-defect corpus and the fixed regression suite drawn from it; the rest of this package's harness is outside this document.

**Owns:** the corpus — fixtures under `corpus/fixtures`, each a directory of `fixture.json`, `contract.json`, `checks.json`, `before/`/`after/` trees or a pinned real repository and commit pair, and a generated `change.diff`; `expected_detection`, fixed before a fixture is ever run and never edited after; the regression suite, a fixed subset of the corpus that runs when the reviewer prompt, the blocking matrix or the default model or provider changes, gating on two bars — no `must_not_approve` fixture ends `approve`, and every cited credential is redacted — with every other reading taken against the previous suite run on the same model ([D-010](11-open-decisions.md)). The fixture format is Apache-2.0 and the fixtures CC-BY-4.0, published as `plantedbugs` ([D-075](11-open-decisions.md)).

**Consumes:** a directory named by `PERBO_EVAL_CORPUS_DIR`, or the packaged corpus beside this package — refused, never silently substituted, when the named directory is absent; for pinned fixtures, a prepared clone under `.local/corpus-cache`.

**Emits:** `runs.json`, `summary.json`, `report.md` and `rule-authority.json`, and, spawning the built CLI binary itself once per fixture per repeat, the same review artifacts a real run produces.

## `tooling/package` — the tarball and the corpus

**Owns:** the CLI tarball a design partner installs — one bundled file, the runner's write-guard hook beside it, a version manifest and a licence notice, archived with a published SHA-256 (`pack.mjs`); the public corpus assembly from a named commit ([D-075](11-open-decisions.md), `assemble-corpus.mjs`); tarball verification and draft-release scripting consumed by `.github/workflows/release.yml`; the gate's protected-paths check and regression delta under `.github/scripts/`.

**Consumes:** the built workspace; a named commit — assembly is reproducible from a sha, never from an uncommitted edit.

**Emits:** `release/perbo-<version>.tgz` and its digest; the assembled public corpus tree.

## `tooling/skills` — executor skill guidance

**Owns:** a vendored, pinned engineering-skill bundle with its own licence and source manifest; `build.mjs`, which compiles the selected skill directories into generated, hashed guidance text.

**Consumes:** nothing at runtime — it is a build-time step.

**Emits:** `packages/runner/src/skills/internal/content.ts`, the generated module the runner appends to an execution brief for up to three explicitly selected skills, pinned and hashed on the attempt record — never native skill discovery, never repository-supplied instructions ([D-094](11-open-decisions.md)).
