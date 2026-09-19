# ADR-0035: The product is Perbo everywhere

- Status: accepted

## Context

A person meets the product in the desktop, the terminal, the local store and the code. One name across all of them means nothing needs translating between them ([D-098](../11-open-decisions.md)).

## Decision

- The package scope is `@perbo/*`.
- The binary is `perbo`, and its bundle is `bin/perbo.mjs`.
- The local store is `.perbo/` in a repository and `~/.perbo/` on a machine.
- Environment variables are `PERBO_*`.
- Worktree, bundle and hook names carry the `perbo-` prefix.
- The reviewer's prompt delimiters are `<perbo:…>`.
- Tickets take the key `PRB` unless `perbo admit --prefix` names another.
- New branches take the prefix `prb/`; a ticket or run that already has a branch keeps it, whatever its prefix.

Recorded identifiers keep their bytes: branch names and pull request links, `SCP-`, `D-` and ADR numbers and filenames.

## Consequences

Nothing reads or migrates a machine's existing `~/.focrux` directory, or the desktop's profile under its old name.

## Alternatives considered

Keeping the old executable, package and store names under a new display name.
