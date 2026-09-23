# ADR-0033: Perbo desktop projects the local CLI and supports both subscription providers

- Status: accepted
- Decision: [D-093](../11-open-decisions.md)

## Decision

`apps/desktop` is an Electron host with a React renderer built by Vite:

- **Structure.** `src/renderer/ui` owns the renderer's primitives and visual tokens, behind one surface every feature module imports. Feature modules own presentation, and one typed, runtime-validated request protocol separates them from native capabilities. TanStack Query manages local projections and refreshes without becoming a second ticket store.
- **Sample host.** `src/sample-host/` answers the same request protocol from clearly labelled sample records and cannot reach a repository or start a provider. It is what the renderer's tests run against, and `preview.html` is a development page that runs the renderer against it in a browser; the packaged renderer contains neither ([D-120](../11-open-decisions.md)).
- **The host and the CLI.** The host bundles the full CLI and its guard hook, runs the CLI on the Node inside Electron (`ELECTRON_RUN_AS_NODE`), and calls fixed CLI entry points with argv, never a shell string.
  - Native folder selection registers a canonical git checkout. Later requests carry repository ids, and a repository-relative path only where a surface reads one file; the host resolves it under the registered repository and refuses an absolute path, one that leaves the repository, one reached through a symlink and one nothing reads at all.
  - Contract edits and approval carry the digest of the bytes the person viewed.
  - The CLI still enforces immutable approval, scope, worktree materialization, checks, review, remediation, bundles and publication.
  - One host mutation runs at a time. Stop terminates the process group, and an interrupted command is recorded as interrupted after a restart.
- **No infrastructure.** No hosted plane, database, account or pairing is required.

**Providers.** Claude Code and Codex can each be chosen for planning, execution and review, and the review's inputs do not change. The Codex executor uses native app-server tools:
- It runs with an isolated `CODEX_HOME`, a provider-owned authentication link, a pinned provider, empty external capabilities, and an assertion that no instruction sources loaded.
- Its native sandbox starts read-only. Perbo answers each command or file approval request with the runner's guard, never with a session-wide approval, and never executes a command or path a model returned.
- A missing patch change list, a model reroute, or an unexpected tool capability is refused.
- Command records distinguish native permission decisions from the runner's own admission decisions.

**Cost and limits.** Codex reports no dollar measure, so its cost is `unavailable`, never free ([D-070](../11-open-decisions.md)). Limits follow [D-096](../11-open-decisions.md): a stall detector stops an attempt that shows no tool activity for the window, the cost caps bind only an executor billed per token, and any ceiling a repository sets in its own configuration still applies.

**Credentials** stay owned by the provider CLIs, and the renderer never asks for them.

**Merge and publication.** The person merges by default ([D-041](../11-open-decisions.md)), and publishing a branch or pull request needs the person's permission for that run.

## Consequences and limits

- The front end can change without rewriting runner policy.
- A native host adds packaging, inter-process communication and platform testing.
- Local execution is still not a filesystem jail ([ADR-0004](0004-local-first-runner.md)).
- Provider approval protocols can change.
- The desktop's local job journal is not durable cross-machine orchestration or a transactional database.
