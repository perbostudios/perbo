# ADR-0011: Coordinate agents through typed records and deterministic processes, not an agent organisation

- Status: accepted

## Context

A tempting architecture gives agents roles, such as a planner, a manager or an overseer, that debate and delegate. It makes demos legible, but it establishes no source authority, no independent verification, no policy and no cost control. Several agents can share one error while producing a persuasive consensus.

## Decision

Perbo is typed records and deterministic processes over them. Models perform bounded functions (drafting, executing, reviewing, verifying) and hold no authority because of a role. Ordering and scheduling are computed from records ([ADR-0036](0036-queue.md)), never decided by an overseer agent.

## Consequences

- Records, policies and processes are primary; an agent's identity is runtime metadata.
- Models can be replaced without changing how authority works.
- A conversational surface may present the work, but it is not the system of record.

## Alternatives considered

A hierarchy of agents; one general agent holding every tool; an overseer agent that decides the order of work.
