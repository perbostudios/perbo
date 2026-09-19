# symbol-index fixture

An authored monorepo for `perbo index`. Two workspace packages that import each
other, an application that imports both, and one file per case the indexer has
to get right: a `.tsx` default export, a `.cjs` module with `module.exports`, a
`.d.ts` reached through a `.js` specifier, a dynamic import, a `require()` that
resolves to nothing, and imports of packages that are not in this tree.

`../symbol-index.expected.json` is the hand-written expectation the test
compares the built index against, exactly. Edit the two together.

`@fixture/core` declares its entry as source; `@fixture/ui` declares
`./dist/index.js`, a build output no checkout carries, so it resolves through
its own `src/index.ts` instead.
