# Monorepo and Deployment

## Repository layout

One monorepo, trunk-based delivery, ticket branches as short-lived git worktrees ([ADR-0007](adr/0007-monorepo-trunk-worktrees.md)).

```text
apps/
  cli/            the perbo binary
  desktop/        the Perbo desktop — Electron host + React renderer over the bundled CLI
packages/
  contracts/      versioned schemas every other package builds on
  review/         independent review: blocking matrix, structured verdict, trust boundary
  workspace/      worktree provisioning and materialization
  runner/         execution: permission profile, ceilings, agent adapter, sealing, delivery
  planning/       contract drafting from an issue — the model proposes, a person approves
  ui/             shared React primitives and design tokens
  evaluation/     the seeded-defect corpus, its harness and the regression suite
tooling/
  package/        the CLI tarball and the corpus assembly
  skills/         vendored engineering-skill guidance, bundled into execution briefs
  tsconfig/       one strict TypeScript base every package extends
docs/             canonical documents, ADRs, design boards
backlog/          issues.json, the canonical issue list
diagrams/         rendered architecture diagrams
scripts/          repository validators and local setup
```

No app imports another app's source; a provider SDK stays inside its own adapter package.

## Build graph and gates

pnpm workspaces (`apps/*`, `packages/*`, `tooling/*`) with one pinned third-party version catalog. Turborepo runs the task graph: `build` depends on its dependencies' own `build` output (`^build`); `typecheck` and `lint` depend only on `^build`; `test` depends on `^build` **and** the package's own `build`, because several suites spawn the built CLI binary rather than calling functions directly — a stale `dist/` is a real hazard, not just a slow one.

The gate is `pnpm check`: `scripts/check.mjs` runs every stage in order, `pnpm check --filter @perbo/<package>` runs one package after building what it depends on, and `.github/workflows/build.yml` runs the same stages as steps on every pull request, so a check is added to the script and nowhere else. [`AGENTS.md`](../AGENTS.md) names the stages.

Never rebuild the tree while a corpus or regression-suite run is in flight: the harness spawns the built binary once per fixture per repeat, so a build underneath it changes what is being measured mid-run.

## Packaging and release

The **desktop package** (`pnpm desktop:package`, electron-builder) bundles the full CLI and its write-guard hook into an unsigned, per-platform directory build under `apps/desktop/release`. The app runs that CLI on the Node inside Electron (`ELECTRON_RUN_AS_NODE`), so no second interpreter is shipped. Git, the provider CLIs and the repository's own package manager stay host prerequisites; signing and notarization are not part of this build.

The **CLI tarball** is what a design partner installs. `tooling/package/pack.mjs` builds the workspace, bundles the CLI to one file, stages the write-guard hook, a version manifest and a licence notice beside it, and archives the result with a published SHA-256. `.github/workflows/release.yml` is the release written for GitHub Actions: on a version tag or a manual dispatch naming one, it re-gates the exact commit (build, typecheck, test, lint), checks the tag against the CLI's own package manifest, packs the tarball, verifies the write-guard hook is inside it, attests build provenance once the repository is public, and drafts a GitHub release carrying the tarball and its digest. The tarball does not update itself: a new version is a new tarball and a message; the desktop's self-update is decided, not built ([D-046](11-open-decisions.md)).

## Pull requests and merges

`main` is protected: every change arrives by pull request, admins included, and force-push and deletion are refused. An unsigned commit is accepted ([D-091](11-open-decisions.md)). `.github/workflows/build.yml` runs the gate on every pull request and on a push to `main`, and its data lives under `.github/`: `corpus-pin.json` pins the public corpus commit the regression suite runs against, `protected-paths.json` lists the files a pull request may not touch, `regression-score.json` is the recorded score, and `scripts/` holds the protected-paths check and the regression delta. None of its jobs is a required check yet; a pull request merges with them green. `.github/workflows/release.yml` is the release's own workflow, for a version tag or a manual dispatch naming one — see Packaging and release above.

The founder may merge directly. An agent session may merge only after a **separate** agent review run — Claude Fable 5.1, or Opus 5 when Fable is unavailable — reads the whole diff against `AGENTS.md`, and the `AGENTS.md` of each package the diff touches, and posts an unqualified approve as a pull-request review comment naming the model; the reviewing run is never the session that authored the change, and a blocking finding is fixed and re-reviewed rather than argued past ([D-073](11-open-decisions.md)). GitHub cannot enforce this by itself — one account cannot approve its own pull request — so the review comment is the record, and a merge without one is a defect. A change to the reviewer prompt, the blocking matrix or the default model or provider additionally carries a regression-suite summary in the pull request's body.

This governs contributions to this repository, opened by a person or an agent session. It is separate from [D-041](11-open-decisions.md), which governs whether Perbo's own loop may merge a ticket's pull request on a repository it manages — including this one: a documentation or decision ticket against this repository is admissible, and this repository uses Perbo for its own work where that is convenient ([D-078](11-open-decisions.md)).
