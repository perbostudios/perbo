<p align="center">
  <img src="apps/desktop/public/brand/perbo-app-icon.png" width="72" height="72" alt="Perbo">
</p>

# Perbo

Perbo runs a loop from an issue to a reviewed pull request: an executor — Claude Code or Codex — writes the change in a worktree of its own, an independent reviewer checks it against the plan you approved, fixing what it can and sending back only what needs a person, and a pull request carries what's left for you to merge.

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-Apache--2.0-555" alt="Apache-2.0"></a>
</p>

- **Runs on your machine.** It uses your checkout, your tools and your Claude Code or Codex login. There is no Perbo server and no account to create.
- **You approve the plan first.** Every ticket carries its outcome, how each part is proven and which files are in scope. Once you approve it, it can't change under you.
- **The reviewer is independent.** It sees the approved plan, the diff and your repository's own checks. It never sees the agent's transcript or its account of what it did. Its prompts are [published in full](packages/review/PROMPTS.md).
- **It fixes what it can.** A finding the agent can close goes back to the agent on the same branch, round after round. You see what's left.
- **You merge.** Perbo opens the pull request. Merging it stays yours.
- **Desktop app and CLI.** Both work over the same local store, `.perbo/` in your repository.

## Getting started

### Prerequisites

- Node.js 22 or later, pnpm 9 (`corepack enable pnpm`) and Git
- Claude Code or Codex, installed and signed in
- The GitHub CLI, signed in (`gh auth login`), for opening pull requests

Perbo isn't published to a registry yet, so you build it from this repository.

### Desktop app

```bash
git clone https://github.com/perbostudios/perbo.git
cd perbo
node scripts/setup-local.mjs
```

This checks your prerequisites, installs pinned dependencies, builds Perbo and opens the app. Add `--no-launch` to build without opening a window. Choose a repository and you're at its tickets.

### CLI

```bash
git clone https://github.com/perbostudios/perbo.git
cd perbo
```

Then follow the quick start below to install, build and run it.

## Quick start

`doctor` checks that your machine and the repository you point it at are ready before anything else runs.

```bash
pnpm install
pnpm run build
```

```bash
node apps/cli/dist/main.js run \
  --repo /path/to/your/repository \
  --outcome "Add an unslug helper that turns a hyphenated slug into words" \
  --criterion "unslug('hello-world') returns 'hello world' :: a unit test asserts it" \
  --publish
```

One command: it writes the change in a worktree, runs your checks, has it reviewed against the outcome and criterion you typed, fixes what it can, and opens the pull request. `perbo inspect` reads back what it did.

## How it works

1. **Plan.** `admit` drafts an outcome, acceptance criteria and a scope from your issue. You edit and approve it.
2. **Write.** The agent works in a fresh worktree under a permission profile. Every command it runs is checked before it runs, and it can't write outside the scope you approved.
3. **Check.** Your repository's own checks run against the change.
4. **Review.** A separate model call judges the change against the plan and the check results, and nothing else.
5. **Fix.** Findings the agent can close go back to it. Findings that need a decision go to you.
6. **Deliver.** Perbo opens the pull request with the review attached. You merge.

Every step leaves a record in `.perbo/`, so `perbo inspect PRB-1` can show what was run and why.

## How the reviewer is measured

Every change to the reviewer is scored against a public corpus of seeded defects and clean changes, [plantedbugs](https://github.com/lianmatsuo/plantedbugs), before it ships. How the scoring works is in [`packages/evaluation/SCORING.md`](packages/evaluation/SCORING.md), and the current score is in [`.github/regression-score.json`](.github/regression-score.json).

## Documentation

- [CLI reference](apps/cli/README.md)
- [Documentation index](docs/README.md)
- [Security, autonomy and your data](docs/08-security-autonomy-and-data.md)
- [The reviewer's prompts](packages/review/PROMPTS.md)

## Contributing

Contributions are welcome, under Apache-2.0 and with no contributor licence agreement. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

Perbo is licensed under [Apache-2.0](LICENSE). The fixtures in [`packages/evaluation/corpus/fixtures`](packages/evaluation/corpus/fixtures) and [`packages/evaluation/sample/fixtures`](packages/evaluation/sample/fixtures) are licensed under [CC-BY-4.0](packages/evaluation/corpus/LICENSE); the fixture format itself is Apache-2.0 like the rest of the repository.
