# ADR-0030: Neutralise repository-supplied agent configuration at handover

- Status: accepted
- Extends: [ADR-0023](0023-untrusted-context-boundary.md)

## Context

Coding agents discover configuration from their working directory: hooks, tool servers, memory files, skills, subagents and plugins. That configuration is committed to the repository, so it is attacker-controlled under the threat model of [ADR-0023](0023-untrusted-context-boundary.md). A hook is arbitrary code execution, and a tool server is an unmediated egress channel. Neither passes through the runner's allow-list, because both run inside the agent process the runner started.

## Decision

**No repository-supplied agent configuration reaches the executor or the reviewer.** Every adapter meets three requirements:

1. **Suppress at invocation.** The agent is invoked so that it does not read project-scoped configuration at all.
2. **Withhold from the worktree.** Every known configuration path is moved out of the worktree before handover and restored afterwards, journalled before the first move, so an interrupted attempt is recoverable at the next start. This covers conventions an adapter does not know about.
3. **Assert what loaded.** No tool server may be connected or attempted, and nothing may load from a path inside the worktree; otherwise the attempt ends with `agent_configuration_present`. User-scoped configuration on the person's own machine is `trust: user` and outside this record.

Agent configuration is immutable during an attempt ([D-045](../11-open-decisions.md)). The runner pins the provider base URL; repository configuration cannot set it. No repository instruction file reaches the executor ([D-094](../11-open-decisions.md)).

### Claude Code

The executor is invoked with:

```text
--setting-sources user          project settings and .mcp.json are not read; subscription login survives
--strict-mcp-config --mcp-config {"mcpServers":{}}
--settings <the attempt's write-guard hook, and no other hook>
--disable-slash-commands        no skills
env CLAUDE_CODE_DISABLE_CLAUDE_MDS=1, CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
--permission-mode manual --allowedTools … --disallowedTools …
--agents <the roles Perbo defines>   the only subagents the executor may start (ADR-0038)
never passed: --add-dir, --plugin-dir, --plugin-url, --dangerously-skip-permissions
```

The reviewer's Claude transport also passes `--safe-mode`. The executor cannot, because it turns off the hook that delivers the write guard.

### Codex

Codex runs with a temporary, mode-0700 `CODEX_HOME` that links the existing `auth.json` and holds one `agents/<name>.toml` per role Perbo defines — the only role definitions it can read ([ADR-0038](0038-subagents.md)) — and with inherited `CODEX_*` and `OPENAI_*` variables removed. Shell tools and unified exec are off at process start; multi-agent support is on, with those files the only roles written for it. Startup is refused when the thread reports any instruction source. The reviewer runs in an ephemeral thread in a scratch directory with a read-only sandbox and no repository tool; a file it asks for goes through the same reader, with the same refusals, as every other transport. The executor's native tools are answered by the runner's guard ([ADR-0033](0033-focrux-local-desktop-and-subscription-providers.md)).

### The person's own sessions

`perbo agent` starts the person's own session, which runs under the person's own configuration and is not neutralised, and reaches the queue's endpoint ([D-109](../11-open-decisions.md)); the executor never does. `perbo interview` is the person's session too, on either transport, but it loads no configuration of theirs, and of the repository's only what cannot decide a call, because a rule in one decides a tool call before the interview's guard is consulted and that guard is what D-102's write boundary is made of. What that costs and what it buys are the same on both: the person's own hooks and rules in this one session, for a boundary no rule can widen.

On Claude that is `settingSources: []`, which leaves only the administrator's managed-settings tier, read whatever a session asks for; Claude Code still decides a `Bash` command its own classifier reads as read-only, which reaches no write ([D-102](../11-open-decisions.md)). For the same reason it runs in the `default` permission mode rather than `dontAsk`: a call nothing has decided has to reach the guard, and `dontAsk` denies it first.

On Codex it is a temporary, mode-0700 `CODEX_HOME` linking only the existing `auth.json` — as temporary and as closed as the executor's, which holds Perbo's role files besides — so the person's `config.toml` reaches neither its tool servers nor its approval rules into the session. The thread runs with `sandbox: "read-only"` and `approvalPolicy: "untrusted"`, so no write happens without an approval request and neither does any command outside the set Codex itself trusts as read-only — `ls`, `cat`, `sed` and the like run unasked, as a read-only `Bash` line runs under Claude Code's classifier — and `approvalsReviewer: "user"` routes every one of those requests to this client, where the interview's rules answer it. Nothing is ever accepted for the session — not `acceptForSession`, not `approved_for_session`, and no execpolicy or network amendment — so the next call of the same shape is judged again. The repository's own instruction files load into the thread, which the Claude transport's `settingSources: []` keeps out of its session: the SDK's own words for that option are "Pass `[]` to disable filesystem settings (SDK isolation mode). Must include `'project'` to load CLAUDE.md files." The two transports differ here, and this is the reading each admits on its own terms: an instruction file the repository carries is read as data by a session that may read anything, and it cannot widen what that session may do. Startup is not refused over them here, which is what separates this session from the executor's. Subagents stay inside these boundaries: on Claude the executor starts them only from roles Perbo passes on the invocation, and the write guard refuses an `Agent` (or `Task`) call naming anything else before the subagent starts, so repository and personal agent definitions remain unreachable even where Claude Code offers them; on Codex the roles are the only definitions in the temporary home, and a subagent that starts one of its own ends the attempt once the runner sees it, since nothing about a spawn crosses the wire first ([ADR-0038](0038-subagents.md)). The interview starts none at all — on Claude the tool is not among the ones it holds and both its names are on its own `disallowedTools`, and on Codex the thread runs with `agents.enabled=false` — because the roles are the executor's and this session writes one spec.

## Consequences

- The largest unmediated execution and egress channel is closed, and the closure is tested rather than asserted.
- An agent that can neither suppress nor report its configuration cannot be an adapter.
- A repository's own agent conventions never reach the executor ([D-094](../11-open-decisions.md)).

## Alternatives considered

Trusting repository agent configuration because the repository is the person's own: rejected, because a contributor's pull request is the obvious vector. Sandboxing the agent process instead: complementary, and not available at the needed strength on the local provider ([ADR-0004](0004-local-first-runner.md)). Linting repository configuration instead of suppressing it: a parser per convention per vendor, failing open on anything unrecognised.

## Validation

Adversarial fixtures commit a hostile hook, a hostile tool-server definition, a provider base-URL override, and an instruction file that tries to widen scope. Each must fail closed, and the run must be observably free of repository-supplied configuration.
