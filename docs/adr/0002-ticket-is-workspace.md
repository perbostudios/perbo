# ADR-0002: Present the ticket as the workspace while storing execution attempts separately

- Status: accepted

## Context

A person should not have to reconcile a board card with a disconnected agent workspace. Yet one ticket can have several attempts: retries, remediation rounds and failures.

## Decision

The desktop and the CLI present one ticket as the workspace. The store keeps a stable `Ticket` and one-to-many `ExecutionAttempt` records under `.perbo/`.

## Consequences

History, retries, remediation rounds, independent review and cost stay correct per attempt. Views compose a ticket-workspace projection ([ADR-0034](0034-desktop-editing-and-workspace-projection.md)).
