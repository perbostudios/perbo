# Architecture decision records

An ADR records architecture that crosses components, and cites its decision in the [register](../11-open-decisions.md). It states what is true now: when the architecture changes, the ADR is edited in the same change, and when a record stops holding, it is deleted. Git holds the history. Filenames are stable, and numbers are never reused.

A new ADR is written on its branch as `NEW-<label>.md`, with the heading `# ADR-NEW-<label>: Title`. `scripts/assign_ids.py` numbers it when the pull request merges.

## Index

| ADR | Decision |
|---|---|
| [0002](0002-ticket-is-workspace.md) | The ticket is the workspace; attempts are stored separately |
| [0004](0004-local-first-runner.md) | Local execution behind a provider-neutral workspace contract |
| [0005](0005-typed-artifacts.md) | Typed artifacts, not chat, are the record |
| [0007](0007-monorepo-trunk-worktrees.md) | One monorepo, trunk-based delivery, worktrees |
| [0010](0010-progressive-autonomy.md) | Authority by action class; the person grants the merge |
| [0011](0011-control-loop-not-agent-organisation.md) | Typed records and deterministic processes, not an agent organisation |
| [0013](0013-model-agnostic-replayable-runtime.md) | A model-agnostic runtime; every run recorded |
| [0016](0016-minimal-machine-maintained-planning.md) | Immutable contract, mutable approach, sized by risk |
| [0017](0017-risk-based-independent-probes.md) | One implementation plus an independent review sized by risk |
| [0018](0018-defer-custom-ide-until-evidence-gates.md) | Perbo reads code; editing stays in the person's editor |
| [0020](0020-monorepo-first-not-monorepo-locked.md) | One repository at a time, never hard-coded |
| [0023](0023-untrusted-context-boundary.md) | Untrusted context is data; verdict integrity is structural |
| [0025](0025-worktree-environment-contract.md) | A worktree is materialized from a declared contract |
| [0026](0026-replay-claim-tiering.md) | Replay claims are tiered per bundle |
| [0027](0027-own-the-ticket-natively.md) | Perbo owns admitted tickets; one authoritative source per field |
| [0030](0030-neutralise-repository-supplied-agent-configuration.md) | Repository-supplied agent configuration never reaches an agent |
| [0032](0032-open-source-the-local-cli-and-the-reviewer.md) | Everything that runs on one machine is open source |
| [0033](0033-focrux-local-desktop-and-subscription-providers.md) | The desktop projects the CLI and runs Claude Code and Codex |
| [0034](0034-desktop-editing-and-workspace-projection.md) | Desktop editing sessions and one workspace projection |
| [0035](0035-rename-the-product-to-focrux.md) | The product is Perbo everywhere |
| [0036](0036-queue.md) | The queue is a process over the store |
| [0037](0037-execution-graph.md) | Large work is one ticket with an execution graph (not built) |
| [0038](0038-subagents.md) | The executor may delegate to subagents (not built) |

## Template

```markdown
# ADR-NEW-<label>: Title

- Status: accepted
- Decision: D-nnn

## Context
## Decision
## Consequences
## Alternatives considered
## Reversal trigger
```
