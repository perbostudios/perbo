# ADR-0027: Own the ticket natively

- Status: accepted
- Decision: [D-003](../11-open-decisions.md)

## Context

A product that does not own the ticket cannot own its contract, its dependencies or its order. Migrating a backlog is also the largest adoption tax a product like this could impose. Ownership therefore begins at one named event: **admission**.

## Decision

Work is admitted to Perbo one ticket at a time, and admission is the moment ownership transfers.

| | Before admission | After admission |
|---|---|---|
| Where the work lives | The team's tracker, or nowhere | A Perbo `Ticket` |
| Authoritative for intent, priority, status | The tracker | Perbo |
| Perbo's role | A reference for discovery and import | Canonical owner of the contract, execution state, review and outcome |
| The tracker's role | Everything | Keeps its own fields |

Decided, not built: the tracker receives a one-way status projection ([D-003](../11-open-decisions.md)).

A team never migrates a backlog; it admits the ticket it is about to work on. Admitted tickets carry dependencies, labels and priorities over a flat list; there is no project or cycle hierarchy, and no epic kind. Large work is one ticket ([ADR-0037](0037-execution-graph.md)).

Every field has exactly one authoritative source. GitHub is authoritative for refs, commits, pull requests and checks. Nothing is synced both ways, and there is no last-write-wins: a conflict or a stale field is a visible state.

## Consequences

- The cost is admission friction and possible dual maintenance of an admitted ticket. The number that shows the boundary failing is how often a ticket is maintained in both places after admission.
- Native ticket quality has to be genuinely good, because it competes with tools people already like.

## Alternatives considered

Attaching to external issues without owning the ticket; full two-way synchronisation; the external tracker canonical for every field.

## Reversal trigger

People routinely maintain the same admitted ticket in both places, or cite admission friction as their reason for using Perbo less.
