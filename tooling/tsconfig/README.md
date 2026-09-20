# `@perbo/tsconfig`

Three files. `base.json` holds the compiler options; the two presets beside it say which files a
program contains, so a package needs a `tsconfig.json` and a `tsconfig.build.json` of one line each.

`base.json` — `strict` is the floor, not the ceiling: `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes` and `erasableSyntaxOnly` are on because the first product code here
parses untrusted JSON and indexes into it.

`library.json` — what `typecheck` runs. It reads `src`, `test` and the package's `*.config.ts`, and
emits nothing, so a test that has drifted from the interface it exercises is an error here rather
than a surprise at runtime. `test/fixtures` is left out: it holds authored repositories the product
reads as input, whose imports resolve to packages that are not installed here. Declaration
diagnostics belong to `build`, which `pnpm check` runs first, so this preset turns `declaration` off
and spares the test helpers a class of error the emitted code never meets.

`library.build.json` — what `build` runs. It emits `src` to `dist`, excluding `*.test.ts(x)` and
`test-support/` so no test is published. A module that colocates its test needs no config change:
the typecheck preset already reads all of `src`, and this one already leaves the test out.

Both presets write their paths as `${configDir}/…`, which resolves to the directory of the leaf
config that extends them rather than this one. A leaf that sets its own `exclude` replaces the
preset's entirely and so repeats the preset's entries; a leaf that needs extra compiler options
(`jsx`, a wider `lib`) sets them in both of its files, because the two are separate programs.
