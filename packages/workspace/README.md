# @perbo/workspace

The local worktree provider, and the half of it that is actually hard: making
the worktree **runnable**.

- `worktree.ts` — one isolated worktree and branch per attempt chain, from an
  exact base commit, with leases, stale reclaim and typed refusals.
- `diagnostic.ts` — proposes a materialization manifest from the checkout the
  user already has, and refuses a repository that cannot be materialized with a
  named reason **before** an attempt starts. A repository with no test script a
  worktree can run is not one of those: it is verified with
  `git status --porcelain`, and an advisory says why.
- `materialize.ts` — copies the untracked files, installs under a declared
  strategy with lifecycle scripts off, allocates ports and a database schema,
  and runs the command that proves the result works.
- `exec.ts` — every process this package starts, by argv and never a shell
  string.
- `naming.ts` — `prb/<ticket id>/<short-slug>`, derived from the id and the
  approved outcome through an allow-list,
  and never from anything a model said during execution.
- `ports.ts` — a contiguous port range per attempt, checked by binding.
- `disk.ts` — what a worktree costs, as a free-space delta and as a directory
  size, because hardlinks and copy-on-write make those different numbers.
- `suspend.ts` — a closed laptop, detected as lateness on a timer, so an attempt
  does not carry on as though nothing happened.
- `main.ts` — the `perbo-materialisation` binary, ADR-0025's measurement
  harness. It writes its full record to the path passed via `--out`, and
  `experiment.ts` behind it is reachable only from there: the measurement is not
  part of what this package offers its callers.

A run pointed at one package of a monorepo has **two** roots, and they are kept
apart in `diagnostic.ts`: the package it was given, whose scripts are the checks
that judge the attempt, and the workspace whose lockfile the install reproduces.
`workspaceMembership` answers both, `proposedInstallStep` says where the install
runs and with which member filtered, and a directory the workspace does not list
as a member is its own checkout rather than one of its packages.

`materialize.ts` carries both directories across to the worktree by where they
sit relative to the **repository** the worktree is a checkout of — Git checks out
repositories rather than directories inside them — so the install runs at the
workspace root's counterpart and the verification at the package's, which for a
monorepo checked out whole is `services/api` inside the worktree rather than its
root. A command and the directory it runs in are one answer: `pnpm install
--filter @scope/api` outside a workspace root is a different thing that happens
to be spelled the same, and `pnpm run test` at the workspace root is a different
suite from the member's script the derivation named. Where the worktree cannot
offer the directory a command was derived for, materialization refuses by name
before a port is taken or a file is copied — `install_root_outside_worktree`
where a filtered install's workspace root is above the repository, and
`verify_root_outside_worktree` where the scripts the verification was read from
are not in the checkout at all.

Git refuses to check one branch out in two worktrees, so a remediation round
that continues an attempt shares its predecessor's worktree and takes over the
lease. That is why the unit is the attempt *chain*.

Everything here runs processes through `exec.ts`, which takes argv and never a
shell string.
