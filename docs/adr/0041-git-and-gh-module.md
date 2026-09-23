# ADR-0041: One module starts every git and gh process

- Status: accepted
- Decision: [D-126](../11-open-decisions.md)
- Extends: [ADR-0023](0023-untrusted-context-boundary.md)

## Context

Perbo is a program that drives git. It provisions a worktree, reads a head and a merge base, lists tracked files, stages and commits a seal, pushes a branch and opens a pull request, and asks `gh` for a pull request, its checks and its comments. Every package does some of that: the CLI for `inspect`, `sync`, `escapes` and the verdicts record, the runner for the guard, the seal and delivery, the workspace for the worktree, the evaluation harness for its clones, and the desktop host for the repository it shows.

Running git is not one call. It is a set of facts that have to agree: which environment the runner's git gets, that a credential prompt has to become a failure rather than a hang on a machine with nobody watching, how long a local read may take and how long one that crosses the network may, what happens when the answer is larger than the reader can hold, and whether an operand a person or a record supplied could be read as an option instead. A caller that spells its own command line decides all of that by omission, and each omission is invisible until the machine it runs on is different — behind a proxy, with a private certificate authority, with SSH commit signing, on Windows.

## Decision

- **One module.** `packages/workspace/src/repository/` starts every `git` and `gh` process this repository runs. Its interior holds the environment, the operand check, the process port and the worktree parser; nothing outside the module imports them.
- **Callers ask a question, not a command line.** The module answers `head`, `mergeBase`, `changedPaths`, `trackedFiles`, `worktrees`, `config`, `topLevel`, `viewPullRequest` and the rest by name, with a value or a typed refusal. `run`, `runOrThrow` and `runSync` carry the commands with a single caller, where the exit status is the answer.
- **Argv, always.** No shell string anywhere, and an operand git would read as an option is refused before a process starts ([ADR-0023](0023-untrusted-context-boundary.md) §4).
- **One environment.** The runner's git and `gh` run in an allow-list built by the module: `PATH`, `HOME` and `LANG`; the signing and configuration names the person's own setup decides with (`SSH_AUTH_SOCK`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `XDG_CONFIG_HOME`, `GNUPGHOME`); how the machine reaches the network (the proxy and certificate-authority names); Windows' own state directories; and, for `gh` alone, `GH_CONFIG_DIR`, `GH_HOST` and the token pair the runner holds. Prompts are off in both directions — `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never` for git, `GH_PROMPT_DISABLED` for `gh`. The agent's environment is a different thing entirely, and is scrubbed.
- **One answer for time and size.** A local read has one ceiling and anything crossing the network a longer one; an answer cut short is a refusal, never a fragment read as the whole.
- **One exception, named in lint.** The write guard replays the agent's own push, with the agent's global flags in the agent's environment, to work out what that push would address. The typed interface cannot say either, so `packages/runner/src/push-remote.ts` starts that process itself.
- **The boundary is enforced, not remembered.** `eslint.config.mjs` refuses a `git` or `gh` process in any package's production source outside the module and that one file, and `scripts/lint-boundaries.test.mjs` shows the rule firing on both call shapes and staying silent on the exception, on a test's own fixture repository and on an array of words no call takes.

## Consequences

- A person behind a proxy or a private certificate authority gets the same answer from every command, because one allow-list decides what git sees.
- A hang becomes a failure: nothing Perbo starts can sit on a credential prompt.
- A timeout is now a refusal where several callers used to read it as "no" — a merge base that could not be computed says so instead of quietly meaning "not an ancestor".
- A new git question is added to the module's interface rather than to a caller, so the next caller finds it by name.
- The module is a seam: `GitProcess` is a port, so the desktop host runs git through its own executor and a test runs it through a fake without spawning anything.
- `gh` needs a token or a machine login, and a command that needs GitHub refuses to start with neither; records name which path served, never the value.

## Alternatives considered

- **A shared helper each caller imports and configures.** The configuration is the thing that has to be the same, so a helper whose options each caller fills is the divergence with more steps.
- **A lint rule alone, with the call sites left where they are.** The rule would have to read every argument of every call to say anything about the environment or the timeout, which is what a module expresses by construction.
- **A module per package.** The facts would be duplicated four times and the desktop's copy would be the one nobody runs on Windows.

## Reversal trigger

A caller needs a git invocation the module cannot express, and the shape cannot be added to its interface, so the named exceptions grow longer than the interface itself.
