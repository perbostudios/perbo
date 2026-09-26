# ADR-0038: An executor may delegate to subagents inside its attempt

- Status: accepted; built on both transports. The live test D-106 asked for before building is recorded below (2026-09-12).
- Decision: [D-106](../11-open-decisions.md)
- Extends: [ADR-0030](0030-neutralise-repository-supplied-agent-configuration.md)

## Context

A runner that assumes one session making calls in order keeps its working-directory state in one file without a lock, records commands with no agent on them, and takes the last message on the stream as the executor's account. Claude Code runs settings-file hooks inside subagents; in Codex, a spawned agent is its own thread, whose approvals reach the app-server client tagged with that thread.

## Decision

On both transports, the executor may start subagents from roles Perbo defines. The runner enforces only the trust boundaries:

- every subagent write passes the ticket's scope guard;
- repository and personal agent definitions stay unreachable;
- every subagent's activity is recorded against it;
- the reviewer receives none of it.

## Consequences

- The write guard keeps state per agent, and records name the agent.
- The executor's account is the top-level session's alone.
- Codex usage is summed per thread.
- Each subagent receives the brief again after a compaction.
- Codex needs version 0.145.0 or later.

## How the Claude half holds it

The roles are `perbo-explorer`, `perbo-implementer` and `perbo-verifier`, in `packages/runner/src/agents.ts`. None carries `Agent` or `Task` — the two names Claude Code answers to for the tool that starts one, current and former (SCP-326) — and the guard refuses a call under either name whose payload came from a subagent whatever role it names (`subagent_nesting_refused`): nesting is refused at one generation rather than counted to a depth, because a subagent that could start subagents would put a generation of them outside the set a person approved. Both halves are there for the reason the role names are checked at all — a role's `tools` list is a request the binary honours, and the guard is what Perbo enforces. The names carry the `perbo-` prefix because `--agents` and `~/.claude/agents` share one namespace.

The two roles that write nothing say so as what they are asked, not as what they are given: both carry `Bash`, a verifier that could not run a check would be worth nothing, and what enforces where a write lands is the ticket's scope guard rather than the tool list.

- **Only Perbo's roles.** The invocation passes the roles as `--agents` and writes the same names into the guard's state file, and the hook — whose matcher now carries `Agent` and `Task` beside the five writing tools — refuses a `subagent_type` that is not one of them, with the rule `subagent_role_undefined`. The match is exact: a near-miss of a role is a different name, and a state file carrying no roles refuses every one. Behind it, a call under either name the hook never answered ends the attempt `enable_own_tooling` — the call happened, so the record keeps it as a call that ran rather than claiming a refusal the executor never saw.
- **State per agent.** The attempt's state is written once and never rewritten; where each agent's shell stands is its own file, named by a SHA-256 digest of the `agent_id` the hook payload carries, and by `session` for the top-level session, which carries none. Two agents' hook processes therefore never write the same bytes, so there is no read-modify-write of a shared value for an interleaved pair to lose, and no lock. The digest is what keeps an id off standard input from becoming a path (ADR-0023). A file that is **not there** is an agent that has not moved, and it is judged from the root the attempt started every agent at; a file that is there and will not read back is refused instead (`agent_directory_unknown`), because those bytes were written by a call that moved the agent and where it went is gone with them — standing it back at the root would judge its next relative target from a directory its shell has left, admitting `echo x > out.txt` as a path inside the worktree while the bytes land wherever the shell is. A move the guard cannot **write down** is refused for the same reason and under the same rule: reading an agent's file as where its shell stands is only sound while every move is recorded, so a `cd` whose new directory will not write is denied, which keeps that agent where its file already says. Both doors are the one fact, which is why the rule is named for the fact rather than for a file being unreadable, and each door's refusal says what is true at that door: at the read door the guard cannot say where the agent is, and at the write door it can, and could not record where the call would take it. A single state file for the attempt would carry the same hole, since it holds the worktree root from before the first call. The reading rests on two things the guard does not check. Nothing may delete an agent's file while the attempt runs: the runner removes the directory only once the attempt ends, and a file removed after a move would stand that agent back at the root. And a call the guard leaves to the agent's own permission layer is recorded as having moved the shell, because that layer's answer reaches the runner only with the result envelope; a move that layer then refuses leaves the file naming a directory the shell never entered. The transcript reading keeps a shell per agent too, keyed by the subagent-starting call's id, so one agent's `cd` cannot place another agent's write outside the scope and end the attempt for it.
- **Records name the agent.** A command record carries the role: from the stream, by way of the `parent_tool_use_id` a child's events carry and the `subagent_type` of the subagent-starting call it names; and from the guard's own payload, which is handed `agent_type` directly. `perbo inspect` prints it beside each refusal. Two records do not carry it, because nothing in what the runner is handed says which agent they belong to: a refusal the runner learns of only from the result envelope, which names the tool and its input and no agent, is recorded with none; and the amendment that refusal makes is keyed by tool and command text alone, so where two agents ran the same line it can land on the other one's record. Both are refusals the agent's own permission layer made, and both are on the record as refusals — what is missing is only the name beside them.
- **The account is the parent's.** Only an `assistant` event with no `parent_tool_use_id` moves the executor's final message, so an attempt whose last words were a subagent's records no account rather than a child's.

## How the Codex half holds it

The same three roles, reusing `packages/runner/src/agents.ts`'s `description` and `prompt` text, are written as `agents/<name>.toml` files — `name`, `description`, `developer_instructions` — into the isolated `CODEX_HOME` `CodexExecutorSession` already builds fresh per attempt, the one role directory 0.145.0 reads. Because that home is a disposable temporary directory rather than a real, already-populated one, there is no built-in role set to displace and no personal or repository definition this attempt can ever reach — the isolation is structural, not the precedence contest `--agents` against `~/.claude/agents` is on Claude. `agents.enabled=true` is the flag that lets a role be chosen at all; web search stays off and the provider stays pinned.

- **State per thread, not per agent.** A spawned agent is its own thread, and every approval and item notification already carries the thread it is for, so the write guard keeps one state per thread instead of Claude's one file per agent: an in-process `Map` needs no disk persistence, because one adapter judges every thread's calls in one process and each `commandExecution` approval already reports its own absolute `cwd` — the fact Claude's file-per-agent scheme exists to reconstruct from a stream that never carries it.
- **Usage summed per thread.** `thread/tokenUsage/updated` is cumulative per thread, so the attempt holds each thread's latest figure and sums every thread's current figure for the ceilings and the final `usage`, rather than the last report overwriting an earlier thread's.
- **Records name the agent.** A child's own start is a `subAgentActivity` item on its parent, never a `thread/started` of its own, so nothing hands the runner a child's role unprompted. The runner asks once, with `thread/read`, on the child's first `subAgentActivity`, and caches the answer against every command record made for that thread from then on — correcting one already made if the lookup answers after it, since the two can arrive in the same read from the process.
- **A subagent may not start a subagent, reactively.** Codex offers no request a client answers before a spawn happens — nothing about one crosses the wire for the client to refuse — so this is caught after the fact rather than before: a `subAgentActivity` reported by a thread that is not the attempt's own root is a second generation, and ends the attempt `prohibited_action` (`enable_own_tooling`), the rule the Claude half's hook backstop uses for a call it never answered.
- **`doctor` refuses a Codex older than 0.145.0**, naming both versions, wherever the binary is checked — as the executor and as the reviewer.

What this does not hold, because only a live run settles it: Codex reads roles only from `CODEX_HOME/agents`, so a personal or repository definition is unreachable by construction, but whether Codex refuses a spawn naming no role or a role outside the set (the strings carry an "unknown agent_type" error) is settled only by a live run, which the record names.

## Alternatives considered

- No subagents.
- The runner running each node as its own attempt.
- A per-node write limit enforced by the guard.
- Product-set limits on concurrency and nesting.

## Reversal trigger

A subagent write escapes the scope guard, or a subagent's account reaches review.

## Live test, 2026-09-12 (SCP-325)

Both executors were run once, on this machine's subscription logins, with subagents enabled under the runner's own boundaries, by the scripts in `packages/runner/scripts/live-subagents/` ([`claude-subagents.mjs`](../../packages/runner/scripts/live-subagents/claude-subagents.mjs) with [`tee-hook.mjs`](../../packages/runner/scripts/live-subagents/tee-hook.mjs), and [`codex-subagents.mjs`](../../packages/runner/scripts/live-subagents/codex-subagents.mjs)): Claude Code 2.1.247 (`claude-sonnet-5`) through the runner's `PreToolUse` write guard with the `Task` tool allowed and two roles passed with `--agents`, and Codex 0.145.0 (`gpt-5.6-terra`) through the runner's app-server sequence with `agents.enabled=true`, `approvalPolicy: untrusted` and `sandbox: read-only`. Each was asked to start two subagents: one writing `src/a.ts`, one writing `src/b.ts` and then trying `src/secret/token.txt` (a prohibited path) and `../outside.txt`. The scope admitted `src/**`. Excerpts are from the recorded streams.

### Does the guard see each subagent's tool calls, and which agent made them?

- **Claude: yes, and yes.** Every one of the children's five tool calls reached the hook (the sixth payload was the top-level session's own `git status --short`), and the guard's decisions file shows the child's `src/secret/token.txt` refused as `write_prohibited_path`, `../outside.txt` refused as `write_outside_worktree`, and a `mkdir -p` of the worktree's own `src` directory refused as `write_outside_scope`, the rule the guard of that run named. The guard as it stands names `write_prohibited_path` for the same call: it judges a `mkdir` target as a write to the whole directory, and a directory is inside the write globs only where a glob covers all of it and no prohibited glob can reach inside it, so `src/secret/**` reaching inside `src` refuses it as prohibited. In that run, `git status --short` showed only `src/a.ts` and `src/b.ts`, and nothing was written outside the worktree. The hook payload of a subagent's call carries `agent_id` and `agent_type` (the role name) that the top-level session's own calls lack: `{"session_id": "922fba1c-…", "agent_id": "a1068d4ecef4890c3", "agent_type": "writer-b", "hook_event_name": "PreToolUse", "tool_name": "Write", …}`. The guard reads both: `agent_type` names the role on each decision, and `agent_id` keys the working-directory state, so each agent has its own.
- **Codex: yes, and yes.** Each child ran as its own thread, and every child command arrived as `item/commandExecution/requestApproval` tagged with that thread: `{"threadId": "01a0955f-3dc1-…", "turnId": "01a0955f-3dda-…", "itemId": "exec-aadd8254-…", "command": "/bin/zsh -lc \"printf 'y\\nPINEAPPLE\\n' > ../outside.txt\"", …}`. The harness accepted the two writes under `src/` and declined the other two; the declined items completed as `status: "declined"` and the child reported `Rejected("rejected by user")`. Item notifications carry `threadId` too.

### How are subagent events and usage reported?

- **Claude.** `assistant` and `user` events of a subagent carry `parent_tool_use_id`, the id of the `Agent` tool call that started it (the tool is listed as `Task` in the init event and appears as `Agent` in the tool-use block; twelve such events). `system` events follow the task: `task_started` (`task_id`, which is the `agent_id` the hook sees, `subagent_type`, `spawn_depth: 1`, the prompt), `task_progress` (`usage.total_tokens`, `tool_uses`, `last_tool_name`), `task_updated` and `task_notification` (`status`, `summary`, `output_file`).
- **Codex.** A child's start is a `subAgentActivity` item on the parent (`kind: "started"`, `agentThreadId`, `agentPath: "/root/write_a"`), the parent's waiting is a `collabAgentToolCall` item (`tool: "wait"`, `senderThreadId`), the child's turn is a `turn/started` on its own thread id, and no `thread/started` notification announces a child (one was seen, for the root). The root's `thread/start` reply carries `multiAgentMode: "explicitRequestOnly"`. Usage arrives as `thread/tokenUsage/updated` per thread id, cumulative per thread (on the wire, `params.threadId` beside `params.tokenUsage.total`: `{"threadId": "01a0955e-fd1d-…", "tokenUsage": {"total": {"totalTokens": 25464, …}}}` for a child at its end; `90847` for the root at its end), so it is summed per thread, as this ADR's consequence says.

### Does reported cost include subagents?

- **Claude: yes.** The `result` event's `total_cost_usd` (0.1502) and its `modelUsage` for `claude-sonnet-5` (3,306 output tokens, 86,816 cache reads) cover far more than the top-level turns' own usage (43 output tokens on the stream); the children's turns are inside it, and per-child totals are on `task_progress` (writer-a 6,682 tokens, writer-b 7,479). `modelUsage` also lists `claude-haiku-4-5` for a side call, so the split is per model, not per agent.
- **Codex: no dollar figure at all** ([D-070](../11-open-decisions.md)); token usage is per thread, above.

### Do Codex children keep the read-only sandbox and untrusted approvals?

**Yes.** Both children wrote through shell commands that needed approval (`printf … > src/a.ts`; `mkdir -p src && printf … > src/b.ts`), and the two writes outside the scope were declined by the client and completed as declined; nothing was written that the client had not accepted. The child threads inherited the root's policy without being asked for one.

### Do children load instruction sources?

- **Claude.** With `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `--setting-sources user`, neither child quoted the repository's `CLAUDE.md` marker, and the repository's `.claude/agents/repo-helper.md` did not appear in the init event's `agents`. **Agents from outside the repository did**: the init event's `agents` listed `agent-sdk-dev:agent-sdk-verifier-py`, `agent-sdk-dev:agent-sdk-verifier-ts`, `claude`, `Explore`, `general-purpose`, `Plan` and `statusline-setup` beside the two roles passed with `--agents` — Claude Code's built-in ones and ones the user's plugins supply — so they are offered to the executor as startable once `Task` is allowed; the test did not try starting one. So "roles Perbo defines" needs enforcing before the call runs, which is what the hook's matcher and its `subagent_role_undefined` refusal do, above.
- **Codex.** The root's `thread/start` reply listed the fixture's `AGENTS.md` under `instructionSources` (the harness does not withhold it, as the runner's materialisation does), and both children quoted its marker, so children load the same instruction sources as the root: withholding the file from the worktree covers them. Each thread also received a `warning` that skill descriptions were shortened to fit the budget, so the user's skills are visible to children as to the root.

### Which definition runs when a name collides, 2026-09-15 (SCP-326)

`--agents` and `~/.claude/agents` share one namespace, so a personal definition named `perbo-implementer` is a definition of a role the guard admits. Which of the two actually runs was recorded here as an assumption — that the personal one substitutes itself — and it is the wrong way round. Measured by reading the shipped binary rather than by running one, because a live answer costs a session and the code that decides is a single function:

- The `--agents` value is parsed and turned into definitions tagged with the source `flagSettings`, which are then merged with everything else loaded.
- The merge resolves a repeated name by applying the sources in the order built-in, plugin, `userSettings`, `projectSettings`, `flagSettings`, `policySettings`, each write replacing the last. `flagSettings` is applied after `userSettings`, so **a role passed with `--agents` displaces a same-named definition under `~/.claude/agents`**, and it is the personal one that is dropped.
- A call to the tool resolves its `subagent_type` against that merged set, so the definition that runs is whichever one the merge kept.
- `--setting-sources user` narrows the enabled sources to `userSettings` plus `flagSettings` and `policySettings`, which are always on. `projectSettings` is off, which is the same reading as the live test's: the repository's `.claude/agents/repo-helper.md` did not appear.

So the closed-set check on `subagent_type` is not resting on the name alone after all: a name outside the set is refused by the guard, and a name inside it resolves to Perbo's own definition. What sits above `--agents` is `policySettings`, read from the machine-wide managed directory (`/Library/Application Support/ClaudeCode/.claude/agents` on macOS) — not a personal directory, not writable without admin rights, and a channel that can already override far more than one role.

Two limits on this, stated rather than left implied. It is a reading of one build, 2.1.247, and the precedence is not in a contract anyone owes us, the same caveat the `--agents` shape carries. Nothing pins the build: the runner spawns whatever `claude` is on PATH, and preflight asks it for `--version` only to check that it is there — that result is read for its `ok` and then dropped, so it is not where a build is recorded. What names the build an attempt actually ran is the attempt's own agent record, which carries `binary_path`, `binary_version` and `binary_sha256` from `binaryFingerprint()`; the digest is the part that identifies a build rather than a version string. This reading is worth redoing whenever that digest has moved. And nothing the runner is handed would show the difference if it changed: the init event's `agents` carries names, not sources or definitions, so a displaced role and a displacing one look identical in the record. What bounds a role whose instructions were not Perbo's is what bounds the executor itself — every write through the ticket's scope guard, the deny-list, and the tool refused to a subagent whatever role it names.

### Left open

- The executor named its Codex children itself (the `subAgentActivity` item carries a free `agentPath`, `/root/write_a`; the tool call that spawned them does not appear on the stream), with no roles configured. SCP-327 gives it Perbo's roles to choose from instead; whether Codex actually restricts the choice to them is left to a live run, above.
- The Claude stream's `rate_limit_event` carried the subscription's windows (`seven_day` utilisation 0.97 at the time); an executor on a subscription near its limit stops mid-attempt, which the stall detector or a `transport_unavailable` park sees, not this ADR.

