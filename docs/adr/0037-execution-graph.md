# ADR-0037: Large work is one ticket whose plan carries an execution graph

- Status: accepted
- Decision: [D-100](../11-open-decisions.md)
- Extends: [ADR-0016](0016-minimal-machine-maintained-planning.md)

## Context

Large work sliced into sibling tickets costs several approvals and several pull requests, and nothing holds the whole work's intent. [ADR-0016](0016-minimal-machine-maintained-planning.md) keeps a plan's contract fixed and its approach mutable.

## Decision

Large work is one ticket. Its plan may group acceptance criteria into nodes, each with the paths expected to satisfy them. The nodes' criteria and paths are contract; the suggested order between nodes is approach. A person curates the drafter's suggested graph and approves it once. The spec that states the work's intent lives in the repository ([D-103](../11-open-decisions.md)).

## Consequences

- One larger pull request per piece of work.
- Review partitions by node and runs once overall, and the pinned checks run per node ([D-107](../11-open-decisions.md)).
- A page per node is generated beside the spec, so that a node reads on its own ([D-103](../11-open-decisions.md)).
- The executor may parallelise inside one attempt ([ADR-0038](0038-subagents.md)).
- The drafter's cap on criteria goes.
- The queue orders tickets as before.
- The order between nodes, with the spec's No-Gos, is a record of its own beside the ticket, because it may change after approval and the contract may not.

## Alternatives considered

- Sibling tickets, one contract each.
- Sibling tickets and graphs side by side, chosen by the drafter.
- A graph that is entirely contract, every edge fixed.
- A graph that is entirely approach, its criteria unbound.

## Reversal trigger

People split graph tickets by hand to get work reviewed or merged. Promoting a node to its own ticket is the fallback.
