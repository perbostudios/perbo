# `@perbo/tsconfig`

One `base.json` that every workspace package extends. `strict` is the floor, not the ceiling:
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `erasableSyntaxOnly` are on because the
first product code here parses untrusted JSON and indexes into it.
