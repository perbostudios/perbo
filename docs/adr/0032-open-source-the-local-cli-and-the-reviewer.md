# ADR-0032: Everything that runs on one machine is open source

- Status: accepted
- Decision: [D-075](../11-open-decisions.md), [D-016](../11-open-decisions.md), [D-076](../11-open-decisions.md)

## Context

Perbo runs on one machine, with the person's own subscriptions or keys. What a team shares across people and machines is what it pays for ([D-016](../11-open-decisions.md)). A reviewer nobody can read is one nobody will trust, and a benchmark scored only by insiders substantiates nothing.

## Decision

**Open**, under Apache-2.0: everything that runs on one machine. That covers:
- `apps/cli` (every command) and `apps/desktop`;
- `packages/contracts`, `packages/model`, `packages/review` (with the reviewer's prompts), `packages/workspace`, `packages/runner` and `packages/planning`;
- the evaluation harness and scorer;
- the queue and its endpoint, and `perbo agent`;
- phone pairing over the local network, which is decided and not built.

**The corpus** is public in `plantedbugs`, all of it from the public release: the fixture format under Apache-2.0 and the fixtures under CC-BY-4.0.

**Commercial:** anything hosted or shared across people, which is the control plane ([D-016](../11-open-decisions.md)).

`perbostudios/perbo` is where Perbo is developed ([D-076](../11-open-decisions.md)); a private repository holds the material that stays private.

## Consequences

- Competitors can read the reviewer and its prompts. The moat is what remembers across machines, not the reviewer's text.
- The open code is maintained in public: issues, disputes and pull requests arrive from outside.
- A published fixture cannot be unpublished.

## Alternatives considered

Keeping the repository closed until a hosted product exists; opening the corpus only; opening everything, including the hosted plane.

## Reversal trigger

An open component turns out to need the hosted plane to work, or a fork ships its own memory layer as a competing hosted product.
