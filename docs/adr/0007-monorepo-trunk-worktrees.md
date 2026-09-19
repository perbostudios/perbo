# ADR-0007: Use one product monorepo, trunk-based delivery, and ticket worktrees

- Status: accepted

## Decision

Perbo is developed in one monorepo, with short-lived branches in their own worktrees and pull requests to `main`, each passing the gate, `pnpm check`, before it merges. The loop's own attempts run in worktrees too.

## Consequences

Parallel agent work stays isolated while integration stays continuous. An agent's merge to `main` follows [D-073](../11-open-decisions.md).
