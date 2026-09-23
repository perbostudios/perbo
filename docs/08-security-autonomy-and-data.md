# Security, autonomy and data

Perbo runs coding agents on the person's own machine, as the person's own user, under their own provider logins and GitHub credential. It points them at a repository whose content anyone who can open a pull request or an issue can shape. This document states what Perbo trusts, what the runner prevents and what it only detects, who may do what, what leaves the machine and what stays on it. Run Perbo where you would already let a coding agent run commands.

## Threat model

| Threat | Control |
|---|---|
| Text in the repository, an issue or a check log steers a model | Trust labels; untrusted content is only ever data ([D-035](11-open-decisions.md)) |
| Planted text flips the reviewer's verdict | A structured verdict over the plan's criteria; deterministic checks outrank the model |
| Repository-supplied hooks, tool servers, skills or instruction files run inside the executor | Neutralised at handover ([ADR-0030](adr/0030-neutralise-repository-supplied-agent-configuration.md)) |
| The executor writes outside its scope, or to what judges it | The write guard and the prohibited actions ([D-022](11-open-decisions.md), [D-045](11-open-decisions.md)) |
| The executor uses the person's credentials | An environment built from an allow-list; only the runner holds the GitHub credential |
| The executor sends data to a host of its choosing | No fetch tool, network commands denied, named hosts logged: detection, not prevention |
| A secret the worktree needs lands in a commit or a record | A content-hash index, exclusion at the seal, mechanical redaction ([D-012](11-open-decisions.md), [D-063](11-open-decisions.md)) |
| A web page or another program drives the queue | A loopback endpoint with per-role tokens and no tool that approves, publishes or merges ([D-109](11-open-decisions.md)) |
| A run exhausts the laptop | Host limits, and a stall detector that ends an attempt showing no tool activity ([D-049](11-open-decisions.md), [D-096](11-open-decisions.md)) |

## The untrusted-context boundary

Every context item carries a trust label, `system`, `user`, `repo` or `external`, and only `system` and `user` occupy an instruction position ([D-035](11-open-decisions.md), [ADR-0023](adr/0023-untrusted-context-boundary.md)).

- **The reviewer.** Its one instruction position is the system prompt, which states the approved criteria. The plan and the check results follow as `user` blocks; the diff, the file listing and every file it opens follow as `repo` blocks. Each block is wrapped in a delimiter that names its trust label (`trust="repo"`), under a standing instruction that blocks are data, and the reviewer reports text in them that addresses it as `context.injected_instruction`. The trust label, size and hash of every item are recorded in the review's run bundle. The reviewer never sees the executor's transcript or its account of the change ([D-037](11-open-decisions.md), [D-092](11-open-decisions.md)).
- **The verdict.** The review is structured output whose criterion ids are enumerated from the plan, and an id the plan lacks is a hard error. The decision is derived from the per-criterion answers, the deterministic checks and a fixed matrix; where a check measured something, its result outranks the model's claim. `security.*` and `context.*` findings stop rather than go back to the executor ([D-065](11-open-decisions.md)).
- **The drafter.** An issue's title and body, or a file drafted from, is `external`; the repository tree and the tickets in flight are `repo`; the standing scope policy is `user`. It may read up to eight small files through the reviewer's reader. Nothing runs from a draft until a person approves it ([D-071](11-open-decisions.md), [D-072](11-open-decisions.md)).
- **The executor.** Its brief is built from the approved contract and any selected skills ([D-094](11-open-decisions.md)). Routed findings, the recorded principles and a previous attempt's account arrive in it as delimited `repo` data. The executor reads the repository through its own tools, where no label applies, so what bounds an executor that follows planted text is the write guard, the prohibited actions and the independent review.
- **No model output becomes an action parameter.** Branch names, commit messages, the commands the runner itself runs and pull-request targets come from the contract and the attempt record.

![Context trust boundary](../diagrams/context-trust-boundary.svg)

## Repository agent configuration

No repository-supplied agent configuration reaches an agent the loop runs ([ADR-0030](adr/0030-neutralise-repository-supplied-agent-configuration.md)). Three mechanisms apply, and every attempt records which ran.

**Suppressed at invocation.** The Claude Code executor starts with:

```text
--setting-sources user                   project settings and .mcp.json are not read
--strict-mcp-config --mcp-config '{"mcpServers":{}}'   no tool server from any source
--settings <the attempt's settings>      the runner's two hooks, and no hook from anywhere else
--disable-slash-commands                 no skills
CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
--permission-mode manual --tools … --allowedTools … --disallowedTools …
--agents <the roles Perbo defines>      the only subagents the executor may start
never passed: --add-dir, --plugin-dir, --plugin-url, --dangerously-skip-permissions
```

The Codex executor runs under a temporary `CODEX_HOME` holding only a link to the person's `auth.json` and one file per role Perbo defines under `agents/` — the only role definitions it can read ([D-106](11-open-decisions.md), [ADR-0038](adr/0038-subagents.md)) — with web search off and the provider pinned, and refuses to start if Codex reports any instruction source.

**Withheld from the worktree.** Every known configuration path (`.claude`, `.mcp.json`, `.cursor`, `.codex`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and others) is moved into `.perbo/quarantine/` before handover and restored afterwards. The journal is written before the first move, and a journal an interrupted attempt left behind is restored at the next start.

**Asserted.** When Claude Code reports what it loaded, any tool server, connected or attempted, or any plugin or memory path inside the worktree ends the attempt `agent_configuration_present`.

The runner pins the provider base URL. The reviewer runs with the same suppression plus `--safe-mode`, with no tools of its own (`--tools ""`), in a scratch directory. A file it asks for comes through a bounded reader (25 files, 64 KiB each, 400 KiB in all) that refuses agent configuration, secret-shaped paths, Git metadata and anything that resolves outside the repository. A change that touches agent configuration is a deterministic blocking finding, and inside an attempt it ends the attempt at the seal. No repository instruction file reaches the executor ([D-094](11-open-decisions.md)). Configuration in the person's own user scope is `user` content and outside this boundary.

## What the runner prevents, and what it only detects

There is no filesystem or network jail ([ADR-0004](adr/0004-local-first-runner.md)). The executor runs as the person's user with `HOME` set, because its provider login lives there, and can read anything that user can read: the runner judges writes, not reads. The permission profile's `path_jail_root` names the worktree the guard judges against; nothing confines the process to it.

**Refused before the call runs.** The agent's own permission layer admits only `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Agent` and `Task` — the tool that starts a subagent is offered under both names Claude Code answers to for it, current and former — and only commands on the allow-list. The deny list names the mutating Git verbs (`push`, `commit`, `reset`, `rebase`, `branch`, `remote`, `tag`), `gh`, `curl`, `wget`, `ssh`, `scp`, `nc`, `sudo`, `pip install`, `npm`, `pnpm` and `cargo publish`, `WebFetch` and `WebSearch`. The runner's `PreToolUse` hook — one of the two hooks in the attempt's settings file — then judges every `Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Agent` and `Task` call and refuses:

- a deny-list entry, matched against every command the line runs, through wrappers and nested shells;
- a write whose destination resolves outside the worktree (`write_outside_worktree`): a redirect, the target of a writer such as `cp`, `mv`, `rm`, `tee`, `dd of=`, `sed -i` or `tar`, or a file tool's path. The resolver follows quotes, `cd`, `$TMPDIR` (the worktree's `.perbo-tmp/`) and symlinks, and refuses a destination it cannot place;
- a write to a path the contract prohibits, which is the contract's `paths_prohibited` beside the repository's standing list under the same key in `.perbo/config.json`, read with the review's own match, inside the write globs as much as outside them and judged before them (`write_prohibited_path`, [D-105](11-open-decisions.md)). The standing list is read when a run starts rather than copied onto the contract at admission, so an entry added after a ticket was admitted binds its later runs. The repository's spec folder is on that list whether or not the contract names it, together with `specs/`, because a spec is the intent the contract was drafted from and an attempt that edited one would be rewriting the statement it is judged against ([D-103](11-open-decisions.md)). Every file the branch's spec commit holds is on it too — the spec's folder, and the `CONTEXT.md` and ADRs admission recorded with it: the loop made that commit itself before the executor started, and the change set the review reads leaves those files out, so a write to one would reach the pull request with nothing judging it. The review's `scope.prohibited_path` finding stays behind it as the backstop, for the write no command named;
- a write inside the worktree but outside the contract's write globs, which are `paths_allowed`, the generated paths, and the declared packages while the expansion budget lasts (`write_outside_scope`);
- a program named at run time (a substitution, a variable, `eval`), and inline interpreter code (`node -e`, `python3 -c`, a heredoc or pipe into an interpreter) unless every statement in it is a read-only shape or a plain read or write of a literal path inside the worktree;
- a change to Git's credential wiring (`credential.*`, `core.sshCommand`, `url.*.insteadOf`, `include*`);
- an `Agent` or `Task` call naming a subagent role Perbo does not define (`subagent_role_undefined`, [D-106](11-open-decisions.md)). The invocation passes the roles as `--agents` and the guard reads that same list out of the attempt's state, so a name Claude Code offers from somewhere else — one of its own built-in agents, one a plugin supplies, one under the person's `~/.claude/agents` — is refused before the subagent starts. The names are matched exactly: a role is a member of a closed set or it is a different name. A personal definition that takes one of Perbo's own names does not become the one that runs: measured on Claude Code 2.1.247, a role passed with `--agents` displaces a same-named definition under `~/.claude/agents`, and only the machine-wide managed settings directory outranks the flag ([ADR-0038](adr/0038-subagents.md)).
- an `Agent` or `Task` call a subagent made, whatever role it names (`subagent_nesting_refused`, [D-106](11-open-decisions.md)). No role carries either name, so Claude Code's own tool list refuses it first; a role's `tools` list is a request the binary honours, and this is the holder that does not depend on that. Nesting is refused at one generation rather than counted to a depth, because every generation below the first sits outside the set of roles a person approved.
- a call the guard refuses because it cannot keep track of where an agent's shell stands (`agent_directory_unknown`, [D-106](11-open-decisions.md)), which two things reach: a recorded directory that is there and will not read back, which refuses every call from that agent, and a call that would move the agent to a directory the guard cannot record, which refuses that call. The guard keeps one file per agent holding where that agent's shell stands, and writes it only when the agent moves. No file at all is an agent that has not moved, judged from the root the attempt started it at; a file that is there and does not read back is an agent that did move, to somewhere the guard can no longer name, and judging its relative targets from the root would admit `echo x > out.txt` as a path inside the worktree while the bytes land wherever the shell actually is. A move the guard cannot write down is refused for the same reason: admitted, the next call would be judged from the directory recorded before it while the shell stood somewhere else; refused, the agent stays where its file says. Both rest on nothing deleting an agent's file while the attempt runs: the runner removes the directory only once the attempt ends, and a file removed by something else after a move stands that agent back at the root.

The other hook is `SessionStart` under the `compact` matcher, which gives the brief back after a compaction ([D-096](11-open-decisions.md)); it runs the same program, it decides nothing, and what it prints comes from the attempt's own records. Both are installed by the one `--settings` file, which is also what keeps every other hook out.

A hook that cannot read its state or judge a call answers `deny`. Where every write on a line lands inside and every other command is effect-free or listed, the hook admits the line over the allow-list; otherwise it says nothing and the agent's layer decides. Each agent's calls are judged from that agent's own directory: on Claude, the executor and every subagent of it have their own shell, so the guard keeps one small state file per agent and two agents' calls arriving at once lose nothing of each other's; on Codex, a spawned agent is its own thread, so the guard keeps one state per thread in memory instead, keyed the same way every approval for that thread already is ([D-106](11-open-decisions.md)). The Codex executor runs in Codex's own read-only sandbox with network access off, each command or file change it asks approval for gets the same judgement with usage summed per thread rather than overwritten, and a subagent starting one of its own is refused once the runner sees it, since Codex offers no request to refuse a spawn before it happens; a request for more permissions or for network is refused. The runner never delegates the credential, the commit, the push, the pull request or the merge.

**Detected afterwards, ending the attempt.**

- *The transcript* (Claude Code). Every tool call is read again. A prohibited command the hook did not refuse (force-push, history rewrite, branch deletion, a push anywhere but a fixture inside the worktree, registry publication or a release tag, a non-local database URL, mail or a chat webhook, a new registry dependency, `claude mcp` or `claude plugin`), or a write outside the worktree, ends the attempt `prohibited_action`. So does an `Agent` or `Task` call the hook did not answer — one that started a subagent from a role Perbo does not define, and equally one a subagent made whatever role it names: the call happened, so the record keeps it as a call that ran and the attempt ends as `enable_own_tooling` ([D-106](11-open-decisions.md)).
- *Egress.* Every host a tool call or a Codex command names, as a URL or as `user@host:`, is logged against the allow-list (the model provider, GitHub and the package registries), and an unlisted one ends the attempt `unlisted_egress_host`. Names under `.test`, `.example` and `.invalid` cannot resolve and are not egress.
- *The seal.* Every path in `base..HEAD` is inspected but for the files the branch's spec commit holds, which the loop put there before the executor ran ([D-103](11-open-decisions.md)). `.github/**`, `CODEOWNERS`, `.perbo/**`, agent configuration and the artifacts that judge the attempt ([D-045](11-open-decisions.md)) end it `prohibited_action`. A path outside the contract's write globs ends it `runner_defect`, because the guard should have refused it.

**Not seen.** What an admitted program does once it runs (`node build.js`, `pnpm test`, `make`, a compiled binary, a process that outlives its line) is invisible to the guard. Its writes inside the worktree reach the seal; its writes elsewhere and its network connections reach nothing. Nor does a host no tool call names, or anything the executor reads, which goes to its model provider.

### The prohibited actions

These are refused whatever the contract, the person or a session asks ([D-022](11-open-decisions.md)).

| Prohibited action | Refused before it runs | Caught afterwards |
|---|---|---|
| Write outside the worktree | the hook | transcript, seal |
| Write outside the contract's write globs | the hook | seal, as `runner_defect` |
| Write to a path the contract prohibits, to the spec folder, or to a file the branch's spec commit holds ([D-103](11-open-decisions.md)) | the hook | review, as `scope.prohibited_path` |
| Write to `.github/**`, `CODEOWNERS` or `.perbo/**` | the hook, where the approved scope excludes the path | seal |
| Modify what judges the attempt ([D-045](11-open-decisions.md)) | the hook, since approval refuses a scope that reaches it | seal |
| Enable its own tooling | Claude: configuration withheld; `claude` is not on the allow-list; an `Agent` or `Task` call naming a role Perbo does not define is refused by the hook. Codex: `CODEX_HOME/agents` holds only Perbo's roles ([D-106](11-open-decisions.md)) | load report, transcript, seal; a subagent that made a call the hook never answered, on Claude, or that started one of its own, on Codex |
| Destructive Git, or a push | deny list | transcript |
| Merge its own pull request | `gh` denied; no credential | transcript |
| Publish to a registry, or tag a release | deny list | transcript |
| Migrate a non-local database | none | transcript |
| Send mail, post to a webhook, comment on an issue | deny list | transcript |
| Add a registry dependency | deny list and allow-list | transcript |
| Reach an unlisted host | no fetch tool; network commands denied | hosts named in tool calls |

The allow-list admits `node`, `python3`, `npx`, `make` and `pnpm run`, so a refusal here refuses the spelling it names; what an admitted program then does is the unseen category above.

## Secrets and credentials

- **Materialised secrets** ([D-012](11-open-decisions.md), [ADR-0025](adr/0025-worktree-environment-contract.md)). The runner copies the files a repository's materialisation manifest declares into the worktree. Entries marked `secret` are indexed by the hash of each file and of each value in it, and the index keeps no plaintext. The seal leaves out any staged file whose bytes match an indexed file or contain an indexed value, and records the paths it left out. Transcripts, command records, check output and every run-bundle artifact are redacted against the index before they are written. The guard's decision file, which holds unredacted targets, lives outside the worktree and is deleted when the attempt ends.
- **What a model can read.** The executor can read whatever materialisation put in its worktree, and its provider receives what it reads, so what must not reach a provider stays out of the manifest. The reviewer's reader refuses secret-shaped paths (`.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `secrets/**`, `.npmrc`, `.netrc`) by name.
- **Credentials in what Perbo writes** ([D-063](11-open-decisions.md)). The reviewer cites a credential by location and shape, and the artifact writer replaces every credential-shaped value (a vendor key prefix, credentials in a URL, a PEM block, a JWT, a long value bound to a secret-named identifier) in the review artifact and in the pull-request body.
- **The executor's environment** is built from an allow-list: `PATH`, `HOME`, `SHELL`, `LANG`, `LC_ALL`, `TERM`, `USER`, `TZ`, and `TMPDIR`, `TMP` and `TEMP` pointed at the scratch directory. A credential-shaped name (`GH_*`, `GITHUB_*`, `SSH_AUTH_SOCK`, `AWS_*`, `*TOKEN`, `*SECRET`, `*PASSWORD`, `ANTHROPIC_BASE_URL` and others) is dropped even when allow-listed. The install and verify commands run in a built environment carrying no credential, with lifecycle scripts off unless the manifest enables them.
- **Every git and `gh` process** ([D-126](11-open-decisions.md)) runs in an environment `@perbo/workspace`'s `repository/` module builds from an allow-list: `PATH`, `HOME` and `LANG`; the names the person's own setup signs and configures with (`SSH_AUTH_SOCK`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `XDG_CONFIG_HOME`, `GNUPGHOME`); how this machine reaches the network (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` and their lowercase spellings, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `GIT_SSL_CAINFO`); Windows' own state directories (`APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `SystemRoot`, `TEMP`, `TMP`); and, for `gh` alone, `GH_CONFIG_DIR`, `GH_HOST` and the tokens. Prompts are off in both directions, so a missing credential is a failure rather than a hang. This is the runner's environment, not the executor's.
- **GitHub.** The runner's own `git` and `gh` use `GH_TOKEN` from its environment where set, and the machine's `gh` login otherwise; a command that needs GitHub refuses to start with neither. Records name which path served, never the value.

## What leaves the machine

- **The person's model providers** ([D-093](11-open-decisions.md)). The executor, the reviewer and the drafter call Anthropic (Claude Code) or OpenAI (Codex) under the person's own login or key. Each sends what it reads: the executor its brief and whatever it opens; the reviewer the plan, the diff, the check results, the file listing and the files it selects; the drafter the issue or file, the tree, the tickets in flight and up to eight files. The desktop also asks the providers for their model lists and usage windows. Perbo never reads, stores or forwards a subscription credential.
- **GitHub**, through the person's own `git` and `gh`. The branch is pushed and the pull request opened or edited only when the person passes `--publish` to `perbo run` or `perbo serve`. `perbo sync` and the queue read pull requests, checks and comments; the queue fetches the base and lists labelled tracker issues; the runner merges where `merge: loop` is set.
- **Nothing reaches Perbo.** The CLI and the desktop send no telemetry. The install page's [What leaves your machine](install.md#what-leaves-your-machine) is the disclosure a person reads ([D-047](11-open-decisions.md)).

## Who may do what

| Act | Who | What gates it |
|---|---|---|
| Draft a contract by hand, or from a spec, an issue or a file | a model or a person | nothing runs from a draft ([D-071](11-open-decisions.md), [D-072](11-open-decisions.md)) |
| Approve a contract | a person only | `perbo approve` or the desktop; no endpoint tool |
| Run it: worktree, executor, seal, checks, review, remediation | the loop | the permission profile, the guard, the stall detector |
| Push the branch and open the pull request | the runner, with the person's credential | `--publish`, typed per run or per queue |
| Merge | the person; the loop where `merge: loop` | the conditions below ([D-041](11-open-decisions.md), [ADR-0010](adr/0010-progressive-autonomy.md)) |
| A prohibited action | nobody | refused, or it ends the attempt ([D-022](11-open-decisions.md)) |

`merge` in `.perbo/config.json` defaults to `person`. With `loop`, the loop and the queue merge a pull request the loop opened only when an APPROVE verdict comment from a separate review run names its head (in [D-073](11-open-decisions.md)'s form), at least one check is reported and every check is green, GitHub reports it mergeable, every commit carries the loop's attempt trailer, and every commit has a verified signature. An approval of an earlier head carries across a re-level only where the change's content is unchanged and the base brought in nothing inside its scope. Merges into one base are serial under a lock, the pull request is read again immediately before the merge, and each missing condition is a stop that names its rule.

Decided, not built: the merge trusts only the verdict comment the review run itself left. Until then a verdict in any comment counts, which is why it lands before any repository opts in ([D-041](11-open-decisions.md), SCP-229).

Decided, not built: the merge gate stops requiring signed commits and leaves that to the repository's own rule on GitHub ([D-091](11-open-decisions.md), SCP-280).

## The queue's endpoint and `perbo agent`

`perbo serve` hosts a tool endpoint for a session of the person's own ([D-109](11-open-decisions.md), [ADR-0036](adr/0036-queue.md)); `--no-endpoint` turns it off.

- It listens on `127.0.0.1` only, answers `POST /mcp` and nothing else, refuses a request whose browser `Origin` is not this machine, and caps a body at 1 MiB.
- Each start of the queue mints two 256-bit bearer tokens. The person's reaches every tool; the drafter's reaches the reads. Both are written, with the URL and the queue's pid, to `.perbo/state/endpoint.json` at mode 0600, which is removed when the queue stops; a record whose pid is gone reads as none.
- The reads are `list_tickets`, `inspect_ticket`, `stops`, `escapes` and `queue_state`. The writes are `admit_ticket`, `edit_ticket` (unapproved contracts only), `sync_ticket` (which never merges), `queue_pause` and `queue_resume`. No tool approves, publishes, runs or merges, and `admit_ticket` refuses a request to approve.
- Every tool is the CLI's own command, run in-process with arguments built from schema-checked values rather than parsed from a line, so a value cannot become a flag.
- The executor is given neither a token nor the URL, and its MCP configuration stays empty. It runs as the person's user, though, and its reads are not judged: a program it runs could read the record and call the tools. A tool call that names the address ends the attempt as unlisted egress; a program that reads it at run time is not seen, and can do only what a token holder can.

`perbo mcp [--drafter]` prints the client configuration and writes nothing. `perbo agent [--provider claude|codex]` starts the person's own Claude Code or Codex in the primary checkout with the person's token: for Claude Code in a 0600 launch file under `.perbo/state/`, removed when the session ends, and for Codex in `PERBO_ENDPOINT_TOKEN`, never on a command line another process can list. The session runs under the person's own configuration, and nothing in it is neutralised: [ADR-0030](adr/0030-neutralise-repository-supplied-agent-configuration.md) protects the loop's executor, not this session. It holds no loop authority, so text planted in what it reads can, through the endpoint, at most draft or edit unapproved contracts, sync a ticket, and pause or resume the queue.

### `perbo interview`

`perbo interview --spec specs/<slug>` runs the person's own session in the primary checkout to write that spec ([D-102](11-open-decisions.md)): `--provider claude` runs Claude Code through the Claude Agent SDK, and `--provider codex` runs Codex through `codex app-server`. Behind either, the interview's rules judge every call, and the transport owns only how its provider is asked and what it streams back. It reads no configuration of the repository's or the person's own, because a rule in one decides a tool call before those rules are consulted, and they are what D-102's boundary is made of: on Claude no settings file is read, leaving the administrator's managed-settings tier as the one thing outside that; on Codex the session runs on a home of its own holding the person's `auth.json` and nothing else, so their tool servers and approval rules are out of reach. That is narrower than `perbo agent`, which is the person's session under the whole of their own configuration: the interview trades their hooks and permission rules, in this one session, for a boundary nothing can widen ([ADR-0030](adr/0030-neutralise-repository-supplied-agent-configuration.md)).

- **Every write is judged before it runs, by the same guard the executor runs under.** The interview consults it with its own boundary: the checkout as the root, `specs/<slug>/**` — this piece of work's own folder — `CONTEXT.md` and the ADR folder as the only paths a write may land in, the store prohibited, and a list of read-only command shapes for `Bash`. A flag able to turn one of those shapes into a writer or into a way to run another program is refused by name, read through every wrapper, subshell, command substitution, process substitution and unquoted here-document body the command carries; what that reading cannot resolve — a quoting, a command, a variable's value, or a program name a closure check finds unaccounted for — is refused the same way rather than assumed safe (SCP-355). A write anywhere else and a write to the ticket store are each refused with the rule that refused them. What reaches the guard is the same on both transports and arrives differently: on Claude through the SDK's `canUseTool` callback, and on Codex as the app server's own approval requests, which it makes because the thread runs with a read-only sandbox that performs no write without one and an `untrusted` approval policy that asks about every command outside the small set Codex itself trusts as read-only (`ls`, `cat`, `sed` and the like). Each provider also decides some calls itself: a `Bash` command Claude Code's own classifier reads as read-only runs without reaching the guard, as does a command Codex trusts and a read on either, which widens what the session may run past that list and never past reading.
- **A refusal is never a question.** Every call nothing has already decided reaches the interview's rules, which answer allow or deny and never ask, so nothing is put to the person; a refusal is written to stderr and streamed as a `refused` event for planning mode's chat to show (SCP-313). On Codex that covers every request the app server makes of a client: an approval is answered by those rules, a request of a shape the interview is not built to answer is refused under the name the server used for it, and a request that would also widen the boundary for the rest of the session — a root to write under, a rule that would let matching commands run unasked, a host to reach — is refused whatever the act it rides on. A file change is judged on every path it lands on, the destination of a move included.
- **Its own tools are in-process, build their arguments as values, and name no plan**: the ticket they act on is the one this spec was drafted into, derived rather than taken from the session, so an interview about one piece of work cannot reach another's plan. `edit_plan` and `undo_edit` change it through `perbo edit`'s own validated path, recorded with the interview as their author, which is also what holds an approved contract immutable while its order may still change (ADR-0016); `read_plan` reads it back, approved or not; `ask_options` puts questions to the person and returns without waiting, its options reaching them as answers to pick from and their pick arriving as an ordinary turn, so nothing it wrote becomes an argument. Those four are all it holds: there is no tool that admits, approves, publishes, runs or merges, and drafting the plan from the spec is the person's own press, which runs `admit --from-spec` outside the session.
- The session id is printed when the session starts and kept in `specs/<slug>/.interview.json`, a file of the repository beside the spec, so `--session <id>` continues the conversation and planning mode can find it. It is whatever the transport gives back — the SDK's session on Claude, the thread on Codex, which `--session` continues through the app server's own `thread/resume` rather than by replaying turns. The person's turns arrive as JSON lines on stdin and every event leaves as one on stdout; the session's own words arrive as an assistant message with text blocks whichever transport spoke them, so one reader serves both.
- **The desktop relays that protocol and never takes a path or a command from the screen.** Planning mode's chat sends three requests — start this planning's interview, send one turn, stop it. The first carries a repository id and the planning session's own id; the other two carry that session's id alone, because its record names the repository, and a turn carries the text the person typed. The host spawns the bundled CLI as a long-lived child with stdin open, through the same environment every other command runs in, and builds the argv itself: `--repo` from the registered repository, `--spec` from the repository's spec folder and the slug the session recorded, judged where it resolves, `--session` from the id a previous interview reported, and only where that interview ran on the provider this one will — the two keep separate namespaces — and `--model` and `--provider` from this planning's drafting choice. Each line of stdout is parsed against the protocol's own schemas, and a line that does not parse is reported as one that did not rather than passed through. The turn is validated as a `turn` before it is written. A stop ends stdin, and signals the process group only for a child still there after that.
- The interview on Claude runs the person's own Claude Code: the `claude` on `PATH` outside the repository, named to the Claude Agent SDK by path, so the per-platform copy the published SDK carries is never run and the desktop does not ship it. The SDK stays beside the CLI's binary rather than inside it and is loaded when a session starts; a build without it, or a machine without Claude Code, says so and starts nothing. Codex needs no such dependency — the `codex` binary is started as a child — and a machine with no Codex login says so and starts nothing.

## Host resources

- `concurrent_local_attempts` defaults to 1 ([D-049](11-open-decisions.md)). Provisioning refuses a worktree beyond the live leases, the queue starts runs up to it, and a lock under `.perbo/state/` holds each ticket to one run at a time.
- `local_workspace_bytes`, 20 GiB by default, is checked against an attempt's measured disk use as it is materialised.
- Worktrees live outside the repository, in `~/.perbo/worktrees/<name>-<digest>/`, each under a six-hour lease. A lease whose time is up or whose process is gone is reclaimed at the next provision.
- A host that sleeps (a five-second timer firing more than a minute late) ends the attempt `host_suspended`. Ending an attempt signals the executor's process group, then ends any process still running from inside its worktree.
- An attempt stops after 20 minutes with no tool call and no tool result on the executor's stream, and at nothing else ([D-096](11-open-decisions.md)). Cost, wall clock, fresh tokens, iterations and commands are counted and bind nothing unless a repository sets a limit, and every limit is set under `limits.limits` in `.perbo/config.json`. Where the executor authenticates with an API key rather than a subscription, an attempt also stops at $5 and a ticket at $60, or at the repository's own figures, by the runner's own counter over the charge the transport reports; no `--max-budget-usd` reaches Claude Code, because that flag would be chosen before the credential is known. A ticket stops after six remediation rounds. A Codex attempt reports no dollar cost ([D-070](11-open-decisions.md)), so no cost cap binds it.

Decided, not built: the workspace-bytes budget also reclaims leases on total size ([D-049](11-open-decisions.md)).

## Local records

Nothing is uploaded, and nothing expires on its own.

| Where | What |
|---|---|
| `.perbo/config.json` | the run configuration: checks, protected paths, the standing prohibited paths, limits, `merge`, the tracker, the spec folder, the ADR folder |
| `.perbo/tickets/` | admitted tickets and the contracts that bound them |
| `.perbo/principles.md` | a person's recorded answers to declined findings |
| `.perbo/state/` | attempt records, locks, the endpoint record and `perbo agent` launch files |
| `.perbo/bundles/` | run bundles: each model call's context manifest with trust labels, usage, and content-addressed transcripts, diffs and reviews, redacted against the secret index |
| `.perbo/reviews/`, `verdicts.json`, `baseline.json` | reviews of changes no attempt ran, a person's verdicts on stops, the direct-agent baseline |
| `.perbo/quarantine/` | agent configuration withheld during an attempt |
| `~/.perbo/worktrees/` | attempt worktrees and their leases |
| the desktop's data directory | `workspace.json` (mode 0600): settings, registered repositories, redacted job logs and unfinished edits; draft sources |

A bundle keeps the bytes a model saw while `retain_context` is true, the default; set to false in the run configuration, bundles keep hashes only. There is no command that deletes records: delete the files. Deleting `.perbo/` deletes a repository's tickets, contracts and run history with it. A worktree goes when its lease is reclaimed, or with `git worktree remove`.

## Decided, not built

- **Other tools' reviews** ([D-088](11-open-decisions.md)). Reviews other tools leave on Perbo's pull requests will be read as external data ([D-035](11-open-decisions.md)) and their findings routed like its own. Until then the loop reads only its own reviewer.
- **Phone pairing** ([D-097](11-open-decisions.md), [D-075](11-open-decisions.md)). Pairing will run over the local network; until it lands the desktop has no phone surface.
