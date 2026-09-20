# `@perbo/contracts`

Versioned schemas for every record the loop writes and reads.

Implemented as Zod schemas with inferred types — **files, not tables**:

| | |
|---|---|
| `PlanContract` | The immutable contract, as a discriminated union over `level`. The P1 body is exactly `outcome`, `acceptance_criteria`, `scope`, `base`; every object is strict, so `steps`, `alternatives`, `assumptions` and `problem_statement` are unrepresentable rather than discouraged. P2 and P3 reuse the P1 body verbatim and add fields. |
| `ChangeSet` | Files parsed from a unified diff, identified by `(base_commit, head_commit)`. `head_commit_source` is `recorded` when a real commit backs the head and `diff_digest` — the sha256 of the diff bytes — when it does not, so the supersession property still holds, because different bytes give a different pair. |
| `CheckResult` | A deterministic check. `skipped` is a first-class status and never counts as evidence: a check that skips itself when a dependency is missing reads green and means nothing. `node` names the execution-graph node the check was run for, with the paths the run was narrowed to and why it was not where it was not ([D-107](../../docs/11-open-decisions.md)); a whole-change result carries none, and `wholeChangeChecks` is what everything that judges the change reads. |
| `ReviewArtifact` | The immutable verdict, pinned to a plan version and a `(base, head)` pair, carrying coverage with verification strength, findings with stable keys, the trust tier of every context item, and every deterministic override. |
| `ExecutionAttempt` | One run pinned to a plan version and a base commit: the invocation that ran (with its shape hash and what it was asserted to have loaded), the permission profile, every command allowed *and denied*, every outbound host, what it consumed of each limited resource, and the reason it stopped. Remediation rounds append attempts; nothing is rewritten. |
| `RunBundle` | The immutable record of one model- or tool-mediated run, with a **computed** `replayability` tier (ADR-0026). A bundle that no longer has the bytes the model saw says `forensic` rather than implying a replay it cannot support. |
| `MaterializationManifest` | What a worktree needs that Git does not carry (ADR-0025), plus the install strategy, the lifecycle-script policy and the per-attempt port range and database schema. |
| `PermissionProfile` | The A2b profile the runner hands to an agent, and the thirteen prohibited actions. Every field is something the runner does, not something a prompt asks for. |
| `LimitsTable` | One `assertWithinLimits(table, resource, n)` gating every countable resource, plus three kill switches. |
| `SecretIndex` | Materialized local secrets, indexed by the sha256 of the file **and of each value inside it**, so exclusion is by content rather than by filename (D-012). It never retains plaintext in anything it serialises. |
| `SymbolIndex` | The exported symbols and import graph of a TypeScript and JavaScript repository, stamped with the commit it was read at and whether the working tree was clean (D-015). Labels only — names, kinds, lines and paths, never a file's contents. A repository with no tracked TypeScript or JavaScript parses as `UnsupportedRepository` instead, because an index holding no files and a repository this cannot describe are different facts. |

`risk.ts` holds both halves of the twice-computed risk: `derivePlannedRisk` from declared scope,
repository sensitivity and action class; `deriveActualRisk` from the sealed diff. `raisePlanLevel`
refuses to lower one. The derivation errs upward — an under-call is the dangerous direction, because
a human may raise a level and may not lower one.

`paths.ts` is the single home for "what counts as a migration / dependency / config / security /
agent-configuration path". Two copies of that answer, one in scope enforcement and one in risk
derivation, would drift.

`credential.ts` is the single home for "what counts as credential-shaped" ([D-063](../../docs/11-open-decisions.md)):
`findCredentials` and `redactCredentials`, deliberately narrow, each rule requiring a positive
signal of secrecy rather than entropy alone. It sits here beside the two neighbouring facts —
`isCredentialEnvName` in `permission.ts`, which says which environment variables are credentials,
and `SecretIndex`, which says which materialized content is one — and every package that has to
redact what it writes already depends on this one. Its false-positive behaviour is measured over the
whole corpus by `packages/evaluation/test/credential-sweep.test.ts`, so a rule change is a
measurement, not an edit.

`review.ts` carries one deliberate asymmetry worth knowing about. A finding's `routing` is derived
from `blocking` when it is absent, rather than defaulted, so an artifact written before D-051 stays
scoreable — a plain default would silently relabel every blocking finding in an older artifact as
advisory. `authored_in_response_to` and `remediation` on the artifact are always `null` (D-061); the
fields stay so older artifacts parse.

This package is not published to npm; its schemas ship as source within the open CLI release (D-075).
