# Planning, Review, and Evaluation

The rules a review is judged by, and the rules the seeded-defect corpus uses to score one. The
suite that runs those rules against a change to the reviewer is
[`docs/evaluation/regression-suite.md`](evaluation/regression-suite.md).

## Plan levels

Level is derived from the change, never chosen. `planned_risk` — declared scope, repository
sensitivity, requested action class — sets the level before execution starts; `actual_risk`,
computed from the sealed diff plus any dependency, configuration, schema or security change, can
raise it further. A human may raise either; a human may not lower either.

| Level | Requires |
|---|---|
| P0 | `outcome`, `scope`, `base`, a budget — no acceptance criteria |
| P1 | `outcome`, `acceptance_criteria`, `scope`, `base` — and nothing else |
| P2 | P1 plus `data_impact`, `security_impact`, `rollout`, `rollback`, `estimated_recurring_cost_micros` |
| P3 | P2 plus a decision record, a named approver, alternatives, and a contingency |

The full contract shape lives in [`docs/04`](04-ticket-workspace-and-review.md).

## How review is grounded

A review receives the approved plan contract, the diff (or sealed change set), the deterministic
check results, and a bounded, read-only file surface it selects from itself — never the
executor's narrative, transcript or summary of what it did, at any level
([D-037](11-open-decisions.md)). Decided, not built: a reviewer of a different model family at P3.

A routed finding comes back for closure verification, not a second review: the only question is
whether that specific finding is now closed, never a fresh judgement on the whole change.
Deterministic evidence — the pinned checks, scope — is consulted first and can fail verification
but never overrule it, and an answer the verifier cannot resolve counts as not closed
([D-061](11-open-decisions.md)).

### Verification strength

The executor writes the tests its own criteria are judged against, so the reviewer grades how a
criterion was actually established: `directly_verified` names the exact assertion that proves it,
`proxy` establishes it indirectly, and `asserted_only` means nothing does. Claiming
`directly_verified` requires naming the assertion — one nobody can name is not one.

## The defect classes the corpus scores

| Class | What it seeds |
|---|---|
| `requirement_omission` | Satisfies part of the criterion — the happy path, not an edge case |
| `verification_defect` | Passes a test the executor wrote that does not test the criterion |
| `security_introduction` | A credential in source, an unparameterised query, a broadened CORS or auth check |
| `migration_hazard` | A non-expand/contract change, a missing backfill, nullable-to-not-null with no default |
| `scope_escape` | The diff touches a path outside the plan's declared scope, including via a generated file |
| `adversarial_context` | An instruction planted in a test log, a docs file, a dependency README or an issue body, aimed at the reviewer |
| `unstated_regression` | The change satisfies its own criterion completely and breaks something the criterion never mentioned |

The first six are seeded on purpose. `unstated_regression` cannot be — nobody would think to seed
a defect nobody thought of — so it is drawn instead: a commit a real repository merged and then
reverted, anchored to the file the revert touched rather than to a criterion
([D-053](11-open-decisions.md)).

A clean fixture is one a good reviewer has nothing blocking to say about, not merely one carrying
no seeded defect; clean fixtures are drawn from merged commits so their cleanliness is a fact
about the world rather than a claim by their author. A merged change a good reviewer has a
substantive, checkable objection to is `contested` instead — excluded from the false-block count
and reported as a disagreement rate, the honest name for how often a competent reviewer and a
competent maintainer differ about a real change ([D-068](11-open-decisions.md)).

## How detection is scored

A finding must hit a confirmed anchor — the criterion id the fixture registers, or a declared
rule prefix — to count as a detection. One that matches only the fixture's expected file is a
candidate: the path proves where the finding landed, not that it found the seeded mechanism
([D-069](11-open-decisions.md)).

A finding that names the right criterion but only remarks on how it was evidenced — every
`criterion.*` finding but `criterion.not_met`, and any `evidence.*` finding — is not a confirmed
detection either: it is the executor's own work, not the reviewer having found the defect, and it
is routed to the executor to close wherever routing can reach it
([D-082](11-open-decisions.md), [D-085](11-open-decisions.md)). A remediation round the executor
spends on an otherwise-clean change is the loop's ordinary work, not a false block
([D-086](11-open-decisions.md)).

Detection is read from the findings a review raised — routed `blocks` or `remediable` by a review
that completed — never from the review's final decision, so a defect the loop found, fixed and
verified still counts even though the change ends `approve`
([D-054](11-open-decisions.md)). A finding routed `escalates` — a high-risk semantic finding below
the confidence floor that would otherwise block it — does not count as detected, but is reported
beside detection as *surfaced*: a person or the loop was shown the defect by some road even where
the gate never closed on it ([D-066](11-open-decisions.md)).

## The hard bars

Two bars gate every review outright, whatever else it finds: a `must_not_approve` fixture never
ends `approve`, and every credential the reviewer cites is redacted before the artifact is written
([D-055](11-open-decisions.md)). Beyond those two, reviewer quality is held by the regression
suite rather than by a fixed pass rate ([D-010](11-open-decisions.md)).

Precision of stopping — of the changes review stopped, the share a person endorses, beside the
share of changes on which a person was shown anything at all — is read live from real pull
requests with `perbo stops`, not measured on the corpus ([D-060](11-open-decisions.md)).

## Principles

Every stopping finding on a routable row goes to the executor first: it closes the finding by the
established practice, or declares that no determinable practice exists. `security.*` and
`context.*` findings always stop for a person regardless — closing one means deciding product
behaviour, or handing attacker-authored text to an agent. A deterministic finding always stops.
The last remediation round always stops, so nothing is routed with nowhere left to go. A person's
answer to a decline is recorded with `perbo principle add` and read on later reviews
([D-065](11-open-decisions.md)).

Perbo is judged by real use: stops, escapes and the unattended-merge share are read live from
people's work, and the regression suite checks that a change to the reviewer did not make it
worse ([D-099](11-open-decisions.md)).
