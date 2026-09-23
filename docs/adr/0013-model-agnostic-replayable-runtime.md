# ADR-0013: Treat the core runtime as model-agnostic and replayable

- Status: accepted

## Context

Model quality, cost, interfaces and providers keep changing. Building authority around one provider's conversations or opaque agent state would make evaluation, incident analysis and migration unreliable.

## Decision

Every planning, execution, review and verification run emits an immutable `RunBundle` with its bounded inputs, provenance, configuration, tool calls, artifacts and usage. Models and agents sit behind adapters with stable contracts; the adapters are Claude Code and Codex. The model-call adapters live in `@perbo/model`, one port with one transport per wire, and nothing else in the repository reaches a provider ([D-123](../11-open-decisions.md)). Prompts, tools, policies and model versions are versioned inputs. What a bundle can be replayed for is tiered per bundle ([ADR-0026](0026-replay-claim-tiering.md)).

## Consequences

- Replacing a provider is a routing decision, not a data migration.
- Capture costs local storage, and the bundle holds only redacted content.
- Byte-identical replay is not promised for stochastic or mutable inputs.

## Alternatives considered

Provider-native conversation history; storing only final artifacts; standardising on one coding agent.
