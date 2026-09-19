# ADR-0016: Keep planning structured, risk-sized, and machine-maintained

- Status: accepted
- Decision: [D-072](../11-open-decisions.md)

## Context

Generated planning documents regrow into a second bureaucracy that people have to keep in step with tickets and code.

## Decision

A plan is a typed, versioned artifact with two parts:

- **The contract, immutable after approval:** outcome, acceptance criteria, scope and base. Execution is bound by it, and review is judged against it.
- **The approach, mutable during execution:** steps, notes and discovered work, which the executor owns and nothing records; and, where the plan has a graph, the order between its nodes with the spec's No-Gos, which are recorded beside the ticket. Freezing any of it guarantees drift.

Required detail scales with risk, through the plan level. The schema cannot express prose fields such as alternatives or a problem statement. A spec that is no longer the one a contract was drafted from takes the ticket the run was about to start to `plan_invalid` ([D-103](../11-open-decisions.md)); nothing takes it out again, because the contract it holds is approved and so immutable.

A plan may also group its criteria into nodes, whose criteria and paths are contract and whose order is approach ([ADR-0037](0037-execution-graph.md)). The order, with the spec's No-Gos, is kept beside the ticket rather than in the contract, so that it can change while the work runs.

## Consequences

- Small tasks stay light.
- The plan is enough for scope enforcement, review and replay.
- Edits change canonical fields, not generated narrative.

## Alternatives considered

No explicit plan; a Markdown specification maintained per ticket; an unrestricted agent scratchpad; one fixed plan template for every task.
