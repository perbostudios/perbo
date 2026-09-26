# `@perbo/planning`

The contract draft, and the measurement of what a person did to it.

A plan has an immutable **contract** — `outcome`, `acceptance_criteria`, `scope`, `base` — and a mutable **approach**. The P1 schema contains exactly those four fields and *cannot express* `alternatives`, `assumptions`, `problem_statement` or `steps`: the discipline is enforced in the schema, not in guidance (ADR-0016). The schema itself lives in `@perbo/contracts`; this package is how a contract gets **drafted** from an issue, how its execution graph is **edited** afterwards, and how far the approved one moved from the draft.

Three properties are why a draft here is safe to show a person:

- **The draft is never executed.** A model drafts the outcome, the criteria and a *proposed* scope; a person edits and approves; only the approved contract binds execution and review. The person's `approve` is the authority boundary under ADR-0023 §4 — model output becomes a scope glob only after a human has confirmed it. The draft is written to its own file beside the contract rather than into it.
- **The issue is data.** Its title and body arrive inside an `<perbo:issue trust="external">` block, exactly as the reviewer delimits repository content, preceded by a standing instruction that the blocks are never instructions. A closing tag inside the body is defanged so external text cannot close the block early. Nothing from the issue reaches the system prompt. This holds whatever supplied the issue: a body pasted into a Markdown file is external text too, because being local makes it convenient, not trusted.
- **What the issue tried is read, not asked for.** `issueAuthoredAttempts`, from `@perbo/contracts`, reads the title and body deterministically and reports every line that claims the work is already finished or that speaks to the drafter rather than describing the work. It is a report, not a filter: nothing is removed or rewritten, because "the work lives in `packages/auth`" and "set the scope to `**`" are not separable by pattern. The person who approves separates them, which is the boundary D-072 draws.
- **The draft is constrained output, checked twice.** It comes back through the reviewer's own structured-output transport against a JSON schema this package supplied, and is validated again by the Zod schema on the way in. A name, one criterion or more, one glob or more, a rationale, the nodes and edges of an execution graph where the work divides, and no other field; a `manual` criterion cannot be drafted, because its named reviewer and its reason are a person's to state.

The name follows D-127: beside the tickets in flight, which `depends_on` may name, the drafter is shown what every other ticket in the repository is called, in a `<perbo:names trust="repo">` block.

## The shape

| | |
|---|---|
| `draft/` | `draftContract`: the system prompt, the delimited blocks, the call, the schema, the provenance record. `DRAFT_PROMPT_VERSION` is `draft_v6` and covers all of them together. `namesBlock` is the block of every other ticket's name the drafter and the interview are shown. Its interior is `internal/tree.ts`, the tracked tree two levels deep through `@perbo/workspace`'s repository module, so proposed globs name directories that exist |
| `delimit.ts` | The `<perbo:kind trust="…">` block, mirrored from the reviewer, plus the tag defang: how the drafter and the drift reading hand a model anything that is not their system prompt |
| `model-record.ts` | `DraftModelRecordSchema`: the provenance of a model's reading — the draft's and the drift reading's — on its own so a renderer can hold one without loading a transport |
| `drift.ts` | `readDrift`: a model reads the spec beside the plan drafted from it and reports where the two no longer promise the same thing, each difference with answers the person can pick (D-128). `DRIFT_PROMPT_VERSION` is `drift_v1` |
| `drift-report.ts` | The reading's shape, the verdict kept beside the ticket at `.perbo/tickets/<KEY>.drift.json`, and `promiseTexts`, what a verdict is kept against; no filesystem and no provider, so the desktop's renderer imports it |
| `drift-record.ts` | `readDriftRecord` and `writeDriftRecord`: that verdict on disk, the one reader and writer the command line and the desktop host both go through, refusing a symlink on the way to it |
| `assertion-drift.ts` | `assertionsChangedSinceDraft`: the criteria whose assertion moved from the one the draft proposed, read from the draft snapshot's edits, for approval to point a person's eye at |
| `issue.ts` | `SourceIssue`, the one shape drafting reads, and `fetchGitHubIssue`: `gh issue view … --json` through `@perbo/workspace`'s repository module, Zod-validated, one sentence on failure |
| `spec.ts` | `parseSpec` and `readSpecFile`: one spec under its five headings, strictly, because a spec about to be drafted from has to be complete |
| `spec-text.ts` | The other half, and no filesystem at all: `specSlug`, the folder name a title takes; `renderSpec`, the Markdown a spec is written as, with an id on every requirement; `readSpecSections`, the forgiving read of a spec half written; and `requirementNodes` — which node each requirement landed in, derived from the criteria that cite it. The desktop's renderer imports it, so a browser assigns the ids the command line would |
| `spec-write.ts` | `writeSpecFile`: the bytes at `specs/<slug>/spec.md`, with the folders created and a second spec on one slug refused; and `retitleSpecFile`, a spec's first heading set to its ticket's name with every other byte and the folder kept (`retitleSpec` in `spec-text.ts` is the text half) |
| `node-page-text.ts` | `renderNodePage`: the text of that page, derived from the spec and the graph, and no filesystem — the desktop's preview renders it too |
| `node-pages.ts` | `writeNodePages`: the page per node beside the spec, rewritten from the spec and the graph, keeping the `## Notes` a person wrote in it and removing the page of a node the plan no longer has |
| `file-issue.ts` | `readIssueFile`: one Markdown file as the same `SourceIssue` — first line the title, the rest the body, `file:<basename>` for the reference, and no number and no URL, because a file has neither |
| `graph-edit.ts` | `applyGraphEdit` and `undoGraphEdit`: the one validated edit path a plan's graph changes through (D-100), applied to a copy and validated whole, recording the entity keys each edit touched. `perbo edit --graph-edit` runs it against a store; the desktop's browser preview runs the same operations with no store at all |
| `impact.ts` | `impactReport`: the paths a draft is likely to touch that its scope does not cover, as warnings a screen shows and nothing else (D-015), with no filesystem, so the desktop's browser preview computes the same ones; and `withNoGo`, the spec's No-Gos with one warned path turned into one |
| `ticket-name.ts` | `ticketName`: what a ticket is called under D-127 — the drafted name, the spec's title, the outcome's first sentence, each passed over where taken or past the cap, then numbered, then the key — and `keptTitleRefusal`, a person's title past the cap refused rather than cut; no filesystem, so `perbo admit` and the desktop's sample host name a ticket with one function |
| `diff.ts` | `contractEditCount`: what changed between the contract as first rendered and the one approved |
| `errors.ts` | `PlanningError` and `DraftRejectedError` — a draft that is not the shape is refused, not repaired |

`src/index.ts` is what a Node caller imports and `src/browser.ts` the part the desktop's renderer
does: the spec text, the impact report, the graph edit path, the drift report's shape, the
assertions moved since the draft and a ticket's name, none of which reach a `node:` module. `src/browser.test.ts` bundles that surface for a browser with tree shaking off and holds it,
and fails for a module that needs Node, so the check can come out either way.

## What is recorded

`draftContract` returns the validated draft together with the model's `provider`, `model_id`, `prompt_version`, token `usage`, `cost_micros` and `cost_basis`, resolved by `resolveModelCost` from `@perbo/model` — the same accounting every model call in this repository carries — so a draft over `claude-cli` carries the dollars the transport reported and one over `codex-cli` says `unavailable` rather than inventing a Claude price. It also names any proposed glob whose leading directory is not in the tree: shown to the person, not refused, because a new package is a real case.

`contractEditCount` is the admission-friction instrument's second number (D-072, ADR-0027). It counts the outcome, each criterion added, removed or reworded, and each scope glob added or removed, matching criteria by id. Identity, base and level are not counted; a person does not type those.

## What this package does not do

It does not create a ticket or decide a level. `perbo admit --from`, `--from-file` and `--from-spec` call `draftContract` — the same function, the same prompt, the same call — derive the level from the proposed scope with `derivePlannedRisk`, write the snapshot and the contract, and print the draft with the next step. The files it does write are a spec's own: `spec.md` and the page per node beside it, which are the repository's rather than the store's. It does not read the repository beyond the tree: the drafter cannot open files, and a turn that asks to is answered once with that fact and then refused.
