# Domain and Event Model

Perbo keeps one local domain: a directory of JSON records under `.perbo/`, validated by the Zod schemas in `@perbo/contracts`, which are the truth about the shape of every record below. Attempts, bundles and verdicts are appended and never rewritten, and a ticket's `history` records every transition, so there is no separate event bus or outbox.

```text
Ticket → PlanContract → ExecutionAttempt → ChangeSet + CheckResult[] → ReviewArtifact → pull request → MERGED
```

Each planning, execution, review or delivery step along that trace also writes an immutable [run bundle](#run-bundle).

## Ticket

The unit of intent, keyed `PRB-<n>`. A ticket exists only because someone **admitted** it with `perbo admit`, typically from an existing GitHub, Jira or Linear issue, a pasted file, or nothing (`kind: none`). There is no importer and no bulk create, so "no backlog migration" is a property of the schema, not a promise ([ADR-0027](adr/0027-own-the-ticket-natively.md), [D-003](11-open-decisions.md)). Before admission Perbo holds no claim; from admission it is authoritative for the ticket's intent, priority, status and acceptance-criteria contract. GitHub stays authoritative for refs, commits, pull requests and checks.

States, in the order the primary flow reaches them:

```text
DRAFT → SPECIFYING → PLAN_REVIEW → READY → PROVISIONING → EXECUTING → VERIFYING
  → INDEPENDENT_REVIEW → PR_OPEN → MERGED → DONE
```

The schema also carries `MERGED → DEPLOYED → OBSERVING → DONE`. Side states: `CHANGES_REQUESTED`, `PLAN_INVALID`, `BLOCKED`, `FAILED`, `CANCELLED`, `INCONCLUSIVE`, `ROLLED_BACK`, `CLOSED`. The transition table, and which states a command reaches, are in [docs/04](04-ticket-workspace-and-review.md#ticket-lifecycle), with [the lifecycle diagram](../diagrams/ticket-lifecycle.svg). A ticket closes at `MERGED`, or at `CLOSED`; nothing else gates closure ([D-011](11-open-decisions.md)). `BLOCKED` is `perbo serve` holding a `READY` ticket on an unmet `depends_on` key or a scope a ticket ahead of it holds, recorded on the ticket's own `scheduling`, and releasing it once that clears.

**Admission and the draft.** `perbo admit` writes the ticket together with a draft: a model proposes `outcome`, the `acceptance_criteria` the work has, a `proposed_scope` and, where it divides the work, the nodes of an execution graph with the order it suggests between them — all from the issue or spec text, read as data, never obeyed, whatever it asks for — or a person types the contract by hand. The draft and its model provenance (`provider`, `model_id`, cost and token usage) are kept beside the contract; the ticket's `admission` record carries `criteria_source` (`typed | imported | file | drafted | spec`), `criteria_count`, the spec's path and content hash where one was drafted from, how long approval took a person, and `edit_count` — how many fields the person's own `perbo edit` changed before approval. `admit` and `edit` write the contract and its draft snapshot together as a counter-seal, and `perbo approve` and `perbo run` refuse a ticket whose pair disagrees.

## Plan contract

A ticket owns one plan, versioned. `perbo approve` makes a version's **contract** immutable and binds execution and review to it ([ADR-0016](adr/0016-minimal-machine-maintained-planning.md)); a change creates a new version, and execution pins to one approved version. The executor owns its own steps, and what it actually did is captured afterwards as the attempt's own account, not planned in advance. The one part of the approach that is written down is the order between a graph's nodes and the spec's No-Gos, in `<KEY>.approach.json` beside the ticket: it may change after approval, through `perbo edit`, and the reviewer never receives it ([D-100](11-open-decisions.md)).

The P1 contract is exactly four fields:

| Field | Carries |
|---|---|
| `outcome` | one sentence: what will be true afterwards |
| `acceptance_criteria` | what must be **proven**, each with a `kind` (`test \| query \| metric \| artifact \| manual`) and an `assertion` — never where the proof will live |
| `scope` | `paths_allowed`, `paths_prohibited`, `generated_paths` (exempt from scope accounting; a declared source in `generated_sources` with no matching change in the same diff is a deterministic blocking finding, [D-062](11-open-decisions.md)), `expansion_budget_files` |
| `base` | `base_commit`, `context_manifest_hash`, `captured_at` — the only source of a `re_executable` replay claim |

`steps`, `alternatives`, `rollback_plan` and the like are unrepresentable in the schema, not merely discouraged. The level is derived twice: `planned_risk` — declared scope, repository sensitivity, action class — selects the contract shape at approval:

| Level | Adds to the four fields above |
|---|---|
| P0 | drops `acceptance_criteria`; requires `outcome`, `scope`, `base` and a budget |
| P1 | nothing — the default |
| P2 | `data_impact`, `security_impact`, `rollout`, `rollback`, `estimated_recurring_cost_micros` |
| P3 | + `decision_record`, `named_approver`, `alternatives`, `contingency` |

`actual_risk` is then recomputed from the sealed diff; where it exceeds `planned_risk` the attempt is escalated, never discarded. A person may raise a level, never lower one.

Work too large for one flat contract still admits as a single Ticket, whose plan groups criteria into nodes of an execution graph: node criteria and paths are contract and live in the plan, the order between nodes and the spec's No-Gos are approach and live in `<KEY>.approach.json`, and a person curates the graph through one validated edit path and approves once ([D-100](11-open-decisions.md), [ADR-0037](adr/0037-execution-graph.md)).

## Execution attempt

One run pinned to a plan version and a base commit. Retries and remediation rounds append attempts; none is ever rewritten. Each records the provider, branch and worktree, the agent invocation and its permission profile, every command and outbound host asked for (allowed or denied), usage with its `cost_basis`, the change set it sealed, and a `termination.reason` (`completed`, `no_changes`, `stalled`, a named ceiling, `prohibited_action`, `scope_escape`, `runner_defect`, …).

An attempt is bounded by nothing but a stall — `limits.attempt_stall_ms`, 20 minutes with no tool activity on the executor's stream — plus any cost, wall-clock, token, command or iteration ceiling the repository sets ([D-096](11-open-decisions.md)). Where the executor is billed per token, `limits.attempt_cost_micros` ($5) and `limits.ticket_cost_micros` ($60) apply as well; on a subscription neither does. An attempt cut by its cost ceiling after sealing work of its own is continued over those commits while the ticket is under that budget; a stalled attempt ends the run. The limits and their defaults are in [docs/04](04-ticket-workspace-and-review.md#limits).

A **remediation round** is a new attempt continuing a prior one (`continues_attempt_id`, `remediation_round`), briefed with the predecessor's own account of what it changed and why ([D-092](11-open-decisions.md)) and with exactly the findings that were routed to it. A round that closes none of them ends the run `remediation_stalled`, naming the keys still open; `max_remediation_rounds` (default six) is the hard cap above that rule. Before the executor's first round, after every round's seal, and again before the pull request opens, the loop merges the base branch's current tip into the attempt's branch (`merged_base`); a conflict earns one further round briefed with only the conflicting paths, and a conflict that survives it ends the run `base_conflict` with the files named.

## Change set

Identified by `(base_commit, head_commit)` — a rebase produces a new pair, so any verdict targeting the old one is superseded. Its file list comes from `git diff --name-status`, always complete; the patches come from the diff itself and are withheld, with the set marked `truncated`, past 8MB — because scope must still be decided over every changed path even when the bytes are too large to hand a reviewer whole.

## Check result

One entry per test, type check, lint, secret scan, dependency, licence, migration, policy or scope pass, plus a `regression-baseline` kind whose status is deliberately inverted — `passed` means the change's own test **failed** without the change, which is the proof it discriminates at all. `skipped` is never evidence. Scope is always `computed` here, never accepted as asserted, because it must be perfect and is not a model's job. A check that fails alone gets exactly one re-run, narrowed to its own failing files where they can be named; one that fails and then passes on that re-run is recorded `flaky`, not green.

## Review artifact

Immutable and versioned, targeting one change set and plan version, produced by a process that never sees the executor's narrative or transcript at any risk level ([D-037](11-open-decisions.md)). Two records carry the judgement:

- **`coverage[]`** — per criterion, `status` (`met | not_met | cannot_determine`) and `verification_strength` (`directly_verified | proxy | asserted_only`), because the executor writes its own tests and a mock satisfying its own assertion must be distinguishable from real evidence.
- **`findings[]`** — each keyed by `hash(rule_id | criterion_id | file | symbol)` so it survives re-runs, with `blocking` (what the merge gate reads) and `routing` (what the loop reads: `blocks | escalates | remediable | advisory | waived`) both decided by [the blocking matrix](04-ticket-workspace-and-review.md#the-blocking-matrix), never by multiplying severity and confidence.

`decision` (`approve | changes_requested | escalate | remediable | error | incomplete`) is **derived** from `coverage`, the checks and the matrix — never emitted by the model and never parsed from prose; where a model asserts something a deterministic check already measured, the check wins and the assertion is discarded and recorded as an override. A round that follows a routed fix is **closure verification, not a second review** ([D-061](11-open-decisions.md)): one question per routed finding — is it closed — with the pinned checks and the scope computation consulted first and able only to fail it, and `cannot_tell` counting as not closed. There is exactly one independent review per change, at round zero.

## Run bundle

Every planning, execution, review or delivery step writes an immutable, content-addressed `RunBundle`: its inputs, a context manifest naming each item's trust tier (`system | user | repo | external`), tool/model/policy versions, usage, artifacts by `sha256`, transitions and a redaction record. Its `replayability` tier is computed, never asserted: `exact` needs a deterministic component with pinned code and pinned inputs; `re_executable` needs the context bytes the model actually saw retained against a pinned model; anything less is `forensic` — reconstructable, not re-runnable ([ADR-0026](adr/0026-replay-claim-tiering.md)).

## Stops and local verdicts

A `StopVerdicts` record per ticket carries the change's `blocks`/`escalates`/declined findings and the answer read off the pull request's own tick-boxes — *I wanted to be asked* or *the agent should have fixed this alone* — refreshed on every `perbo sync`. `perbo verdict --endorse|--override|--accept|--reject` records the same kind of answer locally, keyed by the same finding hash, for a change with no pull request yet or one reviewed with `perbo review` on a repository Perbo never admitted; the two merge into one population. Precision of stopping — endorsed over endorsed-plus-overridden, read as a Wilson interval against a 70% bar — is computed live from that merged population, never asserted ([D-060](11-open-decisions.md)).

## Principles

`.perbo/principles.md` accumulates a person's answer whenever an executor's brief declares `NO_PRACTICE` for a finding it could not close. `perbo principle add` is the only writer; the agent's write guard refuses every other path under `.perbo/**`; every later brief reads the file as data that resolves unspecified behaviour and never widens scope, weakens security or excuses a failing check.

## Store layout

```text
.perbo/
  config.json                 repository policy: scope defaults, checks, protected and prohibited paths/tests, limits, the spec and ADR folders
  principles.md                the ratchet above
  verdicts.json                 LocalVerdict[]
  tickets/
    sequence.json               per-prefix high-water mark for minted keys
    PRB-118.json                 the Ticket: state, history, delivery, scheduling
    PRB-118.contract.json        the PlanContract — immutable once approved
    PRB-118.draft.json           the draft: proposal, model provenance, edit history
    PRB-118.approach.json        the approach: the order between the plan's nodes and the spec's No-Gos
    PRB-118.drift.json           the drift: where the plan's promises and the spec's words part, against their two hashes
  state/
    <ticket_id>.attempts.json    ExecutionAttempt[], appended on every run
    <ticket_id>.stops.json       StopVerdicts
  bundles/
    bundles/…                   the run-bundle index
    objects/<sha256>            content-addressed artifact bytes
  reviews/
    <review_id>.review.json      a review with no admitted ticket behind it
```

`packages/contracts/src/store-layout.ts` is the code's one declaration of these paths: what a second process reads out of the store is named there and nowhere else.

`admit` writes the ticket, its contract and its draft together, the approach beside them where the plan has nodes or the spec states a No-Go, and for a ticket drafted from a spec an empty `<KEY>.drift.json`, which the interview carries forward and `drift` rewrites and dismisses ([D-128](11-open-decisions.md)); the record's one reader and writer is `@perbo/planning`'s `drift-record.ts`, which the desktop host goes through too. `edit` rewrites `.contract.json` and `.draft.json` as a pair; `approve` seals the contract and sets `approved_at`. `run` appends to `attempts.json`, writes a bundle per planning, execution, review and delivery step under `bundles/`, and seals the change set and check results onto the attempt that produced them. `sync` rewrites the ticket's `delivery` record and `stops.json` from what `gh` reports, and walks the ticket's state from that evidence. `verdict` appends to `verdicts.json`; `principle add` appends to `principles.md`. `review` run against a change nobody admitted writes only under `reviews/`, keyed by its own review id rather than a ticket.
