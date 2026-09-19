# ADR-0025: A worktree is not an environment — materialize one explicitly

- Status: accepted
- Decision: [D-036](../11-open-decisions.md)

## Context

A git worktree is the unit of execution ([ADR-0004](0004-local-first-runner.md), [ADR-0007](0007-monorepo-trunk-worktrees.md)). A fresh worktree has no installed dependencies, no `.env` files, no gitignored local configuration, no seeded database and no running services. With pnpm, `node_modules` is rooted at the workspace root, so each worktree needs its own install, and two parallel attempts collide on ports.

## Decision

A worktree is provisioned and then **materialized** from an explicit contract.

1. **Materialization manifest.** The repository declares the files and directories every worktree needs that git does not track: the `.env` family, local certificates, seed data, tool caches. `perbo doctor` proposes the manifest by inspecting the person's checkout, and the person confirms it.
2. **Secrets stay local.** Materialized secrets are copied by the runner on the person's machine and are excluded from every change set, run bundle, log and artifact by content hash, not by filename alone ([D-012](../11-open-decisions.md)).
3. **The install strategy is declared.** A shared package-manager store with offline-preferred installs is the default.
4. **Parallel attempts are isolated or serialized.** Each attempt records its allocated port range in its lease, where a concurrent attempt can see it. Where a repository cannot be isolated, its attempts run one at a time.

## Consequences

- Onboarding has a real diagnostic step that fails informatively, instead of an execution that fails mysteriously.
- Materialization copies files; it does not start services. A test script that starts one is never what `doctor` proposes, as the verification or as a check: it verifies with the next test script a worktree can run, or, where there is none, reports it (`verification_requires_service`) and verifies with `git status --porcelain`; it reports a repository that merely depends on containers (`undeclared_service_dependency`). A repository whose test script starts its own database is run with that suite unrun and judged by the review ([D-013](../11-open-decisions.md)).
- Local execution is not "just a worktree".

## Alternatives considered

Assuming a repository runs from a clean checkout; requiring a devcontainer or Docker Compose; executing in the person's existing checkout on a branch; requiring hosted sandboxes.

## Reversal trigger

If a cold start, including the repository's own suite, exceeds ten minutes on a representative repository, execute on a branch in the person's existing checkout, one attempt at a time.
