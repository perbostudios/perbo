# ADR-0004: Execute locally, behind a provider-neutral workspace contract

- Status: accepted

## Decision

Attempts run in local git worktrees on the person's machine, under the person's own provider credentials. The workspace contract is provider-neutral, so another provider could be added without changing ticket semantics.

## Consequences

Source code stays on the machine. The local provider cannot enforce what a sandbox could, and the architecture does not pretend otherwise:

| Property | Local worktree |
|---|---|
| Network egress denied by default | Cannot enforce. Every host a tool call names is logged, and one outside the allow-list ends the attempt; a host reached by a process that never named it is not seen. |
| Clean base environment | No. The worktree shares the person's machine. |
| Ephemeral filesystem | No. |
| Short-lived credentials | Held by the runner; the agent's environment is scrubbed. |
| Snapshot and restore | No. |

The compensating controls are a command allow-list, a write guard that decides a tool call before it runs — including a write to a path the contract prohibits ([D-105](../11-open-decisions.md)) — prohibited-path detection at the seal and over the transcript, a scrubbed environment, and egress logging. There is no filesystem jail: the worktree root is a recorded field, not a boundary a process cannot cross. [docs/08](../08-security-autonomy-and-data.md) states exactly what is prevented and what is detected.
