# ADR-0036: The queue is a process over the store, not an agent organisation

- Status: accepted
- Decision: [D-108](../11-open-decisions.md)

## Context

Several tickets are in flight at once. Their branches fall behind the base, and their scopes overlap.

## Decision

One deterministic process, `perbo serve`, runs over the ticket store. The loop's own merge step, plus a poll that fetches the base, is the event it reacts to; the runner itself fetches nothing. Re-levelling a branch and reconciling a conflict are rounds of the same loop. There is no orchestrator agent, no webhook and no scheduled agent.

## Consequences

- Throughput comes from pipelining runs up to `concurrent_local_attempts`.
- Which ticket waits is set arithmetic over approved records (`depends_on`, `paths_allowed`, a sealed branch's paths), so the same store always gives the same order.
- Tracker drafting adds at most one draft per tick.

## Alternatives considered

- An overseer agent that reads both tickets and decides who waits: a judgement where set arithmetic suffices ([ADR-0011](0011-control-loop-not-agent-organisation.md)).
- A GitHub App with a merge webhook: hosting and credentials for an event the loop already produces.
- A model predicting which scopes will conflict: again a judgement where set arithmetic suffices.

## Reversal trigger

The queue deadlocks or starves, or a re-level pushes a change nobody reviewed.
