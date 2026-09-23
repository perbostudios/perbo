# Monorepo and Deployment

## Repository layout

One monorepo, trunk-based delivery, ticket branches as short-lived git worktrees ([ADR-0007](adr/0007-monorepo-trunk-worktrees.md)).

```text
apps/
  cli/            the perbo binary
  desktop/        the Perbo desktop — Electron host + React renderer over the bundled CLI
packages/
  contracts/      versioned schemas every other package builds on
  model/          the model call: one turn protocol, three transports, token accounting
  review/         independent review: blocking matrix, structured verdict, trust boundary
  workspace/      worktree provisioning and materialization
  runner/         execution: permission profile, ceilings, agent adapter, sealing, delivery
  planning/       contract drafting from an issue — the model proposes, a person approves
  evaluation/     the seeded-defect corpus, its harness and the regression suite
tooling/
  package/        the CLI tarball and the corpus assembly
  skills/         vendored engineering-skill guidance, bundled into execution briefs
  tsconfig/       the strict base every package extends, and the presets it typechecks and builds with
docs/             canonical documents, ADRs, design boards
diagrams/         rendered architecture diagrams
scripts/          repository validators and local setup
```

No app imports another app's source; a provider SDK stays inside its own adapter package.

## Package layout

Every package states its interface and keeps an interior ([ADR-0040](adr/0040-package-interface.md)):

```text
packages/<name>/
  package.json          exports "." and, where the desktop renderer imports the package, "./browser"
  tsconfig.json         typecheck: src, test and config files; emits nothing
  tsconfig.build.json   build: src, without tests or test-support
  README.md             what each module owns, and what the interface offers
  src/
    index.ts            the interface: named exports only
    browser.ts          the part of it that loads in a browser
    <module>.ts         a module with no interior
    <module>.test.ts    its tests
    <module>/           a module with an interior
      index.ts          its surface
      internal/         what only this module imports
      test-support/     fakes for its ports; never built, never imported by src
  test/                 only what cannot sit beside a module
```

- `packages/evaluation` is a program, not a library: nothing imports it, so it has no `exports` and no `src/index.ts`, and its `package.json` names the `perbo-corpus` binary in `bin` instead.
- Another package is imported by its name or one of its subpaths, never by a file under its `src/` or `dist/`.
- An entry point that something outside its package names by path stays at `src/<name>.ts`, because its `dist` path is part of a contract: `apps/cli/src/main.ts`, `packages/evaluation/src/main.ts` and `packages/workspace/src/main.ts` (`bin` entries and the harness's spawn), and `packages/runner/src/guard-hook.ts` (`tooling/package/bundle.mjs`).
- A generated module sits where its module wants it and moves with the one line that writes it: `tooling/skills/build.mjs` writes `packages/runner/src/skills/internal/content.ts`.
- An app's `src/` follows the same rules ([D-122](11-open-decisions.md)): `apps/cli` groups one module per command under `src/commands/` and keeps only the suites over its built package in `test/`, and `apps/desktop/src` is three layers — `host/`, `renderer/` and `shared/` — where the first two import across only through the third.
- A package's `test/` holds a test a pull request may not edit and what it imports, a suite whose subject is the repository rather than one module, data a test reads, and `packages/evaluation/test/`, whose suites reach the corpus and the sample through helpers beside them. `scripts/test-placement.test.mjs` holds `@perbo/contracts`, `@perbo/planning`, `@perbo/runner` and `@perbo/workspace` to that, naming every file their `test/` keeps with the reason it is not beside a module, and refuses a test under `src/` with no module beside it. An app's `test/` holds the suites that drive its built package.
- A package the desktop's renderer imports names that part of itself in `src/browser.ts` and holds it where the constraint is: `packages/planning/src/browser.test.ts` bundles that surface for a browser with tree shaking off, so a module reaching a `node:` one fails in the package that offered it.
- `apps/desktop` bundles with Vite and esbuild and typechecks its tests through its own `tsconfig.json`; its renderer keeps PascalCase filenames for React components. `apps/desktop/src/renderer/browser-imports.test.ts` bundles the renderer for the browser, which fails on a `node:` import it cannot resolve.
- `eslint.config.mjs` refuses `export *` in `src/`, an import of another module's `internal/`, a deep import of another package, production code importing test code, a value taken from `@perbo/contracts` or `@perbo/planning` where a browser bundles the file, an import across the desktop's host and renderer layers, and a `git` or `gh` process outside the module that runs them ([D-126](11-open-decisions.md)); `scripts/lint-boundaries.test.mjs` shows each rule firing and staying silent.

## Build graph and gates

pnpm workspaces (`apps/*`, `packages/*`, `tooling/*`) with one pinned third-party version catalog. Turborepo runs the task graph: `build` depends on its dependencies' own `build` output (`^build`); `typecheck` and `lint` depend only on `^build`; `test` depends on `^build` **and** the package's own `build`, because several suites spawn the built CLI binary rather than calling functions directly — a stale `dist/` is a real hazard, not just a slow one. A package's `typecheck` reads its tests and its own configuration files as well as `src`, and its `build` emits `src` without them; `scripts/tsconfig-split.test.mjs` holds every package to that.

The gate is `pnpm check`: `scripts/check.mjs` runs every stage in order, `pnpm check --filter @perbo/<package>` runs one package after building what it depends on, and `.github/workflows/build.yml` runs the same stages as steps on every pull request, so a check is added to the script and nowhere else. [`AGENTS.md`](../AGENTS.md) names the stages.

Never rebuild the tree while a corpus or regression-suite run is in flight: the harness spawns the built binary once per fixture per repeat, so a build underneath it changes what is being measured mid-run.

## Packaging and release

The **desktop package** (`pnpm desktop:package`, electron-builder) bundles the full CLI and its write-guard hook into an unsigned, per-platform directory build under `apps/desktop/release`. The app runs that CLI on the Node inside Electron (`ELECTRON_RUN_AS_NODE`), so no second interpreter is shipped. Git, the provider CLIs and the repository's own package manager stay host prerequisites; signing and notarization are not part of this build.

The **CLI tarball** is what a design partner installs. `tooling/package/pack.mjs` builds the workspace, bundles the CLI to one file, stages the write-guard hook, a version manifest and a licence notice beside it, and archives the result with a published SHA-256. `.github/workflows/release.yml` is the release written for GitHub Actions: on a version tag or a manual dispatch naming one, it re-gates the exact commit (build, typecheck, test, lint), checks the tag against the CLI's own package manifest, packs the tarball, verifies the write-guard hook is inside it, attests build provenance once the repository is public, and drafts a GitHub release carrying the tarball and its digest. The tarball does not update itself: a new version is a new tarball and a message; the desktop's self-update is decided, not built ([D-046](11-open-decisions.md)).

## Pull requests and merges

`main` is protected: every change arrives by pull request, admins included, and force-push and deletion are refused. An unsigned commit is accepted ([D-091](11-open-decisions.md)). `.github/workflows/build.yml` runs the gate on every pull request and on a push to `main`, and its data lives under `.github/`: `corpus-pin.json` pins the public corpus commit the regression suite runs against, `protected-paths.json` lists the files a pull request may not touch, `regression-score.json` is the recorded score, and `scripts/` holds the protected-paths check and the regression delta. None of its jobs is a required check yet; a pull request merges with them green. `.github/workflows/release.yml` is the release's own workflow, for a version tag or a manual dispatch naming one — see Packaging and release above.

The founder may merge directly. An agent session may merge only after a **separate** agent review run — Claude Fable 5.1, or Opus 5 when Fable is unavailable — reads the whole diff against `AGENTS.md`, and the `AGENTS.md` of each package the diff touches, and posts an unqualified approve as a pull-request review comment naming the model; the reviewing run is never the session that authored the change, and a blocking finding is fixed and re-reviewed rather than argued past ([D-073](11-open-decisions.md)). GitHub cannot enforce this by itself — one account cannot approve its own pull request — so the review comment is the record, and a merge without one is a defect. A change to the reviewer prompt, the blocking matrix or the default model or provider additionally carries a regression-suite summary in the pull request's body.

This governs contributions to this repository, opened by a person or an agent session. It is separate from [D-041](11-open-decisions.md), which governs whether Perbo's own loop may merge a ticket's pull request on a repository it manages — including this one: a documentation or decision ticket against this repository is admissible, and this repository uses Perbo for its own work where that is convenient ([D-078](11-open-decisions.md)).
