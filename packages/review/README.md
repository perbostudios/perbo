# `@perbo/review`

Checks, findings, coverage and independent verification.

Every prompt version this package sends — the reviewer's and the closure verifier's, what changed
at each, the rule ids each carries and which evaluation round scored it — is catalogued in
[`PROMPTS.md`](PROMPTS.md).

Three properties are why a verdict here can be trusted:

- **`verification_strength`** per criterion — the executor writes the tests the criteria refer to, so `directly_verified`, `proxy` and `asserted_only` are distinguished and the reviewer must name the assertion.
- **Stable finding keys** — `hash(rule_id | criterion_id | file | symbol)`, so resolution and waivers survive a re-run.
- **`blocking` decided by a policy matrix, not arithmetic** — deterministic security/scope/check failures always block; high-risk semantic findings block above a confidence floor; ordinary semantic findings are advisory. Model confidence is not a multiplicand in a hard gate.
- **A fifth outcome since D-051** — a finding the executor can close without a decision only a human can make is `remediable`: it goes back to the executor as a new attempt, and the gate stays closed while it does. Routing is one structured question — *who can close this* — answered `executor`, `human` or `unclear`, and only an affirmative `executor` routes. `context.*` and `security.*` never route at all.

The verdict is structured output over criteria supplied by the plan, never parsed prose, and deterministic check results outrank model claims about them (ADR-0023).

## The shape

Seventeen modules, three transports onto one model call surface, no abstraction that does not yet
have two users. `index.ts` re-exports all but `provider-structured.ts`, which only the two CLI
transports import, and `redact.test.ts` sits in `src/` beside its subject.

| | |
|---|---|
| `scope.ts` | Scope enforcement. Deterministic, must be perfect, never a model task |
| `blocking.ts` | The matrix. A `switch` over five named rows, producing five outcomes |
| `verdict.ts` | The `submit_review` schema, built from **this plan's** criteria list |
| `prompt.ts` | Context assembly and the one instruction position |
| `repo.ts` | The bounded, read-only file surface the reviewer selects from |
| `provider.ts` | The Anthropic call, plus token accounting |
| `provider-cli.ts` | The same review over a locally installed `claude` binary |
| `provider-codex-cli.ts` | The same review over a locally installed `codex` binary |
| `provider-structured.ts` | The one turn schema both structured-output CLI transports read |
| `suppression.ts` | Waivers and measured rule authority |
| `closure-verify.ts` | The single question a remediation round asks of each routed finding |
| `credential.ts` | What counts as credential-shaped (D-063) |
| `redact.ts` | Redaction of everything the reviewer writes, at the artifact boundary |
| `legibility.ts` | Whether the change set is one a person can read (SCP-114) |
| `agent-config.ts` | Repository-supplied agent configuration, failed closed (ADR-0030) |
| `review.ts` | The orchestrator |
| `graph.ts` | Each node of an execution graph reviewed beside the whole change, combined for the gate (D-107) |

## The blocking matrix

Rows are tried in order; a waiver short-circuits all of them.

| Row | Fires on | Outcome |
|---|---|---|
| `deterministic` | A failed, errored or **skipped** check; a prohibited path; a scope escape | Always blocks. No confidence term |
| `contract` | A criterion the plan requires is `not_met` | Always blocks — coverage must be complete (merge gate 2) |
| `verification_strength` | A criterion `met` only `asserted_only` | Blocks at P2 and above; advisory at P1 |
| `semantic_high_risk` | Any other semantic finding, at P2 or above | Blocks at confidence ≥ **0.70**; escalates below it |
| `semantic_ordinary` | Any other semantic finding | Advisory |

The level used is `max(planned_risk, actual_risk)`. A human may raise a level and may not lower one,
so the declared level is a floor; `actual_risk`, derived from the sealed diff, raises it further when
the change turned out to be more than was declared.

`RULE_DEMOTION_FALSE_POSITIVE_RATE` demotes a rule the evaluation harness has measured crying wolf —
it never demotes a deterministic row, because a measurement has no false-positive history to lose.

A test in `test/blocking.test.ts` greps this package's own source for a `*` next to `confidence` or
`severity`. The rule is about what the code does, not what its comments say.

## Two places where the implementation is stricter than the specification

**There is no `decision` field in the verdict schema.** docs/04 requires `decision` to be structured
output over the plan's criteria list, never parsed from prose. This derives it instead, from the
structured per-criterion answers, the deterministic checks and the matrix. That satisfies the rule
and removes the field an instruction planted in repository content would aim at. `deriveDecision` is
twelve lines and is the only thing that produces a verdict.

**`incomplete` outranks `changes_requested`.** A reviewer that could not reach a verdict on a
criterion has not completed, whatever else it found, and exit 3 is the safer signal.

## What the reviewer cannot see

`ReviewInput` has no field for the executor's narrative or transcript at any risk level. There is
exactly one instruction position — the system prompt — and everything else arrives inside
`<perbo:… trust="user|repo">` blocks preceded by a standing instruction identifying it as data.
`assertReviewerContextKind` rejects any context kind outside the admissible list at runtime, and a
test asserts the assembled prompt is free of the words.

`repo.ts` refuses to read a materialized local secret (`.env*`, `*.pem`, `secrets/**`) or
repository-supplied agent configuration (ADR-0030) into a model call. Both remain visible in the file
listing, so a change that ships a hostile hook is still reportable — it is the contents that are
withheld, not the fact.
