# @perbo/runner

The half of execution that is not the agent.

- `profile.ts` — the A2b permission profile: the command allow-list, the deny list, the environment
  built from an allow-list rather than scrubbed by a deny-list, and the pinned provider base URL.
- `adapter.ts` — the Claude Code adapter (`codex/` is the Codex one). It builds an argv rather than assembling one,
  records it on the attempt with the prompt removed from the hash, and **asserts** that the agent
  loaded nothing originating in the repository (ADR-0030).
- `codex/` — the Codex adapter: `index.ts` is the surface (`runCodexAgent` and the three decisions
  the thread's items are answered with); `internal/rpc.ts` holds the thread session, its argv and
  the agent role files it writes.
- `quarantine.ts` — the other half of ADR-0030: every known agent-configuration path moved out of
  the worktree before handover and restored afterwards, journalled before the first move so an
  interrupted attempt is recoverable.
- `ceilings.ts` — the stall detector, the cost cap where the executor is billed per token, and
  whatever wall clock, commands, iterations or tokens a repository sets, enforced by the runner rather
  than requested of the model, each terminating with a typed reason.
- `pretool.ts` and `guard-hook.ts` — the attempt's own settings file and the one program its two
  hooks run: `PreToolUse` before every tool that can write, which is the guard, and `SessionStart`
  under the `compact` matcher, which prints the round's brief and a state block composed from its
  records so a compacted session gets it back ([D-096](../../docs/11-open-decisions.md)). That file
  is the only settings source the invocation names, so it is also what keeps every other hook out.
- `brief.ts` — the state block, composed from the records rather than written with the brief, and
  shared by the hook and the Codex adapter so the two cannot say different things. On Codex the
  same text answers a `contextCompaction` item with `thread/inject_items` on the thread it
  completed on.
- `prohibited.ts` — the prohibited-action list, detected on commands *and* on the sealed paths,
  because a file write is not a command.
- `shell/` — how the guard reads a command line or a path to find where it writes: `index.ts` is the
  surface (`readCommandLine`, `inspectWritePath`, the scope types); `internal/` holds the lexer, the
  writer, wrapper, git and interpreter tables, the inline-program reader and the line assembly.
- `spec-commit.ts` — the spec the change is judged against, put on the branch as its first commit
  past the contract's base before the executor is invoked, from the files approval recorded and
  their hashes ([D-103](../../docs/11-open-decisions.md)). A file that has changed or gone since
  approval refuses the run; a branch that already has commits must carry the spec commit first —
  the one the record names, or one the loop's trailer marks as its own that changes recorded
  files only.
- `seal.ts` — the change set, with materialized secrets removed by content hash rather than by name.
  Every file the spec commit holds is excluded from it, so the checks, the review, the verification
  and the pull request read one range and the review reads the diff after the spec.
- `bundle.ts` — immutable, content-addressed run bundles with a computed replayability tier.
- `delivery.ts` — push and pull request through `@perbo/workspace`'s repository module, which
  starts every `git` and `gh` this package runs. The runner holds the credential; the agent never
  sees a token; nothing here merges.
- `checks/` — the pinned set, run in the worktree after the seal: uncached, one at a time, with
  a failed unit check re-run on its own failing files. A ticket whose plan carries an execution
  graph runs the set again once per node afterwards, narrowed to the change's test files inside
  that node's paths ([D-107](../../docs/11-open-decisions.md)); a node's result is evidence for
  that node's review and never the gate, which stays the whole-change result. `index.ts` runs the
  set; `internal/rerun.ts` reads a failed run's output and plans what is run again.
- `loop.ts` — the entry and the sequencer: contract → worktree → spec commit → agent → seal →
  checks → review → route → pull request. It holds the run's public types, `runTicket`, the run's
  limits and the order the phases run in; `loop/` is its interior, and nothing outside `loop.ts`
  imports from it.
  - `loop/config.ts` — `TicketRunConfigSchema` and the two path lists a run is judged by.
  - `loop/context.ts` — the ports a run reaches the world through, and what it is bounded by.
  - `loop/state.ts` — what one round hands the next, the step a round's routing comes to, and the
    state that step leaves.
  - `loop/ledger.ts` — this run's attempts, rounds and declines, what the ticket has spent, and the
    append to the ticket's record.
  - `loop/start.ts` — everything a run can be refused for before it has cost anything.
  - `loop/provision.ts` — the worktree a round's attempt runs in.
  - `loop/continuation.ts` — the remediation a re-run continues, and whether the branch is still
    the one that review judged.
  - `loop/relevel.ts` — a re-level: the branch put back to what the pull request has, and the
    judgement of the merged result where no executor ran.
  - `loop/level.ts` — the three points the base branch's tip is merged into the attempt's branch.
  - `loop/brief.ts` — what a round hands its executor.
  - `loop/execute.ts` — the handover, with the repository's own agent configuration quarantined
    around it.
  - `loop/seal.ts` — the change set the round is judged on.
  - `loop/check.ts` — the pinned set over that change set, and the worktree swept after it.
  - `loop/attempt.ts` — what the attempt ended as, and the record and bundle it leaves.
  - `loop/route.ts` — what an attempt that stopped, or a base conflict, comes to.
  - `loop/verify.ts` — D-061's closure verification and the routing that reads it.
  - `loop/review.ts` — the independent review, its bundle, and the routing that reads its verdict.
  - `loop/deliver.ts` — the push, the pull request and SCP-202's merge step.

One hazard worth knowing before you choose a `worktree_root`: **a worktree nested inside another
package manager's workspace inherits it.** `pnpm` resolves its workspace root by walking up, so a
worktree created under a directory that has a `pnpm-workspace.yaml` above it will fail every install
and every `pnpm exec` with exit 254, and the failure names neither the worktree nor the workspace.
Put the root somewhere with no package manager above it.

The remediation round is the part worth reading twice. It is a **new attempt**: a new record, a new
commit, a new `(base, head)` pair and a new review, and the reviewer grading the answer is never
told that anything it is reading was written in answer to a finding.
