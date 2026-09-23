# ADR-NEW-package-interface: Every package states its interface and keeps an interior

- Status: accepted
- Decision: [D-NEW-package-interface](../11-open-decisions.md)
- Extends: [ADR-0007](0007-monorepo-trunk-worktrees.md)

## Context

The monorepo's packages are consumed by each other through pnpm workspaces and built one by one with `tsc` ([docs/07](../07-monorepo-and-deployment.md)). What a package promises the rest of the repository is whatever another package can import. A test is where a module's interface is exercised, and the gate is the only verification there is. The layout follows Paseo's package conventions (its design is followed and none of its code is copied, [docs/17](../17-commercial-open-source-and-validation.md)) with the departures under Alternatives.

## Decision

- **A package states its interface twice.** `src/index.ts` names every export another package uses, as `export { … } from` and `export type { … } from`, and nothing else. `package.json` `exports` names one subpath per runtime that consumes the package: `"."` for Node, and `"./browser"` (`src/browser.ts`, named exports only) where the desktop renderer imports modules that must load without `node:` built-ins. Each subpath lists `types` then `default` and points into `dist`. There is no wildcard subpath, no subpath per file, and no import of another package's `src/` or `dist/`.
- **A directory is a module with one surface.** A module with an interior is `<module>/index.ts` plus `internal/`. The `index.ts` carries the module's composition or its public types. A file that only re-exports is deleted. Only the module's own `index.ts` and siblings import from `internal/`. A module without an interior is one file. The path carries the name (`shell/internal/lexer.ts`, not `shell-lexer.ts`), and no file is a `utils`, `helpers` or `manager` bucket.
- **A module's tests live beside it and are typechecked with it.** `thing.ts` has `thing.test.ts`, and a large suite splits into `thing.<aspect>.test.ts`. The fakes for a module's ports go in its `test-support/`, which production code never imports and the build never emits. A test injects a fake through a port rather than replacing a module with `vi.mock`. Each package's `tsconfig.json` typechecks `src`, `test` and its config files; `tsconfig.build.json` emits `src` without tests or `test-support/`. Both extend the presets in `tooling/tsconfig`. `test/` holds what is not one module's test: a test a pull request may not edit and the files it imports, a suite whose subject is the repository rather than one module, and data a test reads.
- **A fact has one home.** A module that one package uses lives in that package, and `@perbo/contracts` holds what two or more packages share. When a fact is written twice, the copies are replaced by one module and deleted in the same change, and every caller moves to it. No re-export is left at the old path.
- **A seam is an interface with two adapters.** An interface with one implementation and no injected fake is not introduced.

The protected tests pin module paths and names (`.github/protected-paths.json`), so the modules they import stay at `src/<name>.ts` as real modules. One that needs an interior keeps `src/<name>.ts` as its surface and puts the interior in `src/<name>/internal/`.

`eslint.config.mjs` holds the import rules, and `scripts/lint-boundaries.test.mjs` shows each rule firing on the form it forbids and staying silent on the form it allows.

## Consequences

- A symbol that is not in the entry is private to its package, so renaming it touches no other package.
- Where the renderer-safe property lives is stated in the package that must keep it, and that package's own test checks it.
- A change that moves a module moves its tests and fakes in the same change.
- A type error in a test fails the gate.
- The lint rules check the shape of imports, not meaning. An `index.ts` that only re-exports passes lint, and review catches it.

## Alternatives considered

- One tsconfig per package that leaves tests out: tests would not be typechecked.
- A wildcard `./*` subpath, or one subpath per file: the first states no interface; the second is a second interface that drifts from the entry.
- `./internal/*` package subpaths for callers mid-migration: no package has a consumer outside this repository, so every caller moves in the same change.
- Separate `test/` trees for unit tests: a module and its tests move apart.
- A `source` export condition: tests run against `dist`, because several suites spawn the built binary.

## Reversal trigger

A package gains a consumer outside this repository that needs a different interface; or holding the boundaries takes more lint overrides than there are modules.
