# ADR-0020: Optimise the initial experience for monorepos without hard-coding one repository

- Status: accepted
- Decision: [D-013](../11-open-decisions.md)

## Decision

Perbo optimises discovery, scope, checks and worktrees for one repository at a time, which is often a monorepo. Every contract carries repository identity, so a ticket could later span repositories. Cross-repository execution does not exist.

## Consequences

- The product stays focused, without a schema dead end.
- Multi-repository atomicity and dependencies would need their own design.

## Alternatives considered

Monorepos only, forever; general multi-repository support from the start.

## Reversal trigger

People's critical work is blocked by the one-repository limit.
