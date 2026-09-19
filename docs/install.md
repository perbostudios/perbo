# Installing Perbo

Perbo runs your coding agents against your own repository, from an admitted ticket to a reviewed
pull request. This page covers what you need, how to get it running, the first commands, and what
leaves your machine.

## Prerequisites

| | Why |
|---|---|
| Node.js 22 or later, and Git | the setup script and the CLI need both; nothing else is compiled on your machine |
| The package manager the repository you point Perbo at installs with (`npm`, or the `pnpm`, `yarn` or `bun` it names) | each worktree is installed with it, so it must be on PATH |
| Claude Code and/or Codex CLI, signed in (`claude auth login` / `codex login`) | Perbo runs whichever you choose, on your own subscription login; API keys are optional |
| `gh`, signed in (`gh auth login`) | pull requests are opened and read through your own GitHub credential |

`perbo doctor` checks all of this against a repository and names whatever is missing.

## Get Perbo running

Clone this repository and run:

```bash
./scripts/setup-local.mjs        # node scripts/setup-local.mjs on Windows
```

It checks Node and Git, fetches the pinned pnpm through npm's cache with no global install,
installs the locked dependencies, builds the CLI and the desktop, and opens Perbo. Rerunning it
preserves your profile, repositories and provider logins; add `--no-launch` to build without
opening a window.

Without a checkout, a tagged release packs the CLI alone into a versioned archive:

```bash
npm install -g ./perbo-<version>.tgz   # or extract it and run bin/perbo.mjs directly
perbo --version
```

Its SHA-256 is published beside it; `shasum -a 256 -c perbo-<version>.tgz.sha256` must print `OK`
before you run anything you were sent.

## The first commands, in order

```bash
perbo doctor --repo .               # can this repository be materialized at all
perbo baseline start "<title>"      # a design partner's baseline, before admitting anything
perbo admit --from owner/repo#N     # draft a contract from an issue
perbo approve PRB-1                 # freeze it
perbo run --ticket PRB-1 --publish  # execute, check, review, open the pull request
```

A design partner captures the baseline first: it times their own direct-agent work, start to pull
request opened, and once Perbo has run on the repository there is no unassisted period left to
measure. `perbo --help` lists every command, including `serve` (the queue that runs approved
tickets) and `agent` (your own Claude Code or Codex session, with the queue's endpoint injected).

## Records, and removing Perbo

Everything Perbo writes about a repository (tickets, contracts, runs, reviews, the baseline)
lives under `.perbo/` in that repository, and its worktrees under `~/.perbo/worktrees/`.
Deleting your clone, and the desktop's own application-data folder if you ran it, removes the
program; `.perbo/` in any repository you used it on is yours, and stays until you delete it.

## What leaves your machine

Nothing reaches Perbo: there is no Perbo account, database or cloud service, and neither the CLI
nor the desktop sends telemetry. Two destinations receive anything, each under your own credential:

1. **Your model provider.** The executor and the reviewer each call a model under your own login,
   and what they send is what they read: the plan, the change, the checks, and the files in the
   worktree they open. Materialized secrets are excluded from every artifact by content hash, but
   a model that reads a worktree containing one has read it.
2. **GitHub**, through your own `git` and `gh`. `perbo run --publish` pushes the branch and opens
   the pull request; `perbo sync` and the queue read pull requests, checks and comments.

Your GitHub credential, and an API key where one is used, are read from your environment and never
written to a bundle, a log or an artifact.

A write guard decides every command and file write before it runs, and refuses a command on the
deny-list or one that reaches outside the worktree, outside the contract's allowed paths or into a
path the contract prohibits; the seal, the transcript and the review check the same acts again as a
backstop. The environment is scrubbed and a command allow-list applies. What is not prevented:
network egress cannot be intercepted on this machine, so it is logged instead, and a host an
attempt names that is not on the allow-list ends it; one reached without being named is not seen.
There is no
filesystem jail: the worktree root is a recorded field, not a boundary a process cannot cross. Run
Perbo where you would already let a coding agent run commands.
[docs/08](08-security-autonomy-and-data.md) states exactly what is prevented and what is detected.

<!-- pack.mjs: the tarball copy ends here -->

## For readers of the repository

The clone-and-run path above builds from [`scripts/setup-local.mjs`](../scripts/setup-local.mjs).
The standalone archive is the CLI alone: [`tooling/package/pack.mjs`](../tooling/package/pack.mjs)
builds it (`pnpm release:pack`), and
[`.github/workflows/release.yml`](../.github/workflows/release.yml) is the release written for
GitHub Actions: on a signed tag it packs, verifies and drafts it onto a release, with a published SHA-256 and a build-provenance attestation once
the repository is public. The archive does not update itself: a newer version is a new
archive. Capturing the baseline first is
[D-038](11-open-decisions.md); the destinations above are [D-012](11-open-decisions.md)'s, and
[docs/08](08-security-autonomy-and-data.md) specifies the exclusions in full.
[ADR-0004](adr/0004-local-first-runner.md) is the compensating-controls list this page states
plainly. The disclosure above is what a partner's agreement points them to
([D-047](11-open-decisions.md)).
