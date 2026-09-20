# Working in this repository

Perbo is an open-source operating plane for getting work done with coding agents ([D-001](docs/11-open-decisions.md)). This repository is where Perbo is developed ([D-076](docs/11-open-decisions.md)) and holds its source of truth: the decision register, the ADRs, the canonical documents and the diagrams. Read this before changing anything. `CLAUDE.md` imports this file, so Claude Code and Codex read the same rules.

## The source of truth

- **The repository is the whole brief.** Everything a person or an agent needs to work here is in this repository, open work apart, and a session's memory, a chat or a bundle beside it is a cache and never a source: what a session learns that a later one needs is written here in the same change ([D-113](docs/11-open-decisions.md)). If something you need is not here, add it.
- **Current truth only.** A document states what is true now. A superseded or deprecated decision, ADR or comment is deleted, not marked, and git holds the history. Write no dates of past events, no "was" or "used to", and no story of how something came to be ([D-111](docs/11-open-decisions.md)).
- **One home per decision.** Decisions live in [`docs/11-open-decisions.md`](docs/11-open-decisions.md). Architecture that crosses components also has an ADR in [`docs/adr/`](docs/adr/README.md). Everything else cites a decision by its id instead of restating it, because a second copy drifts.
- **A contradiction is a defect.** Two documents that disagree, or a document that disagrees with the code, is a bug: whoever implements first picks one and is wrong half the time. A change to a contract, an authority, a trust boundary, a review rule or a public promise updates the code, the decision, the ADR, the canonical document and the diagram in the same change.
- **Identifiers are numbered at merge.** Write new decisions and ADRs as `D-NEW-<label>` and `ADR-NEW-<label>` (in `docs/adr/NEW-<label>.md`). Whoever merges runs `python3 scripts/assign_ids.py --apply` as the last commit; it numbers them after the highest ids `main` and the branch have ever held, so a deleted entry's number is never reused, and rewrites every reference ([D-110](docs/11-open-decisions.md)). Never pick a number by hand.
- **ADRs describe the current architecture.** Edit an ADR in the same change as the architecture it records, and delete one that no longer holds. ADR filenames never change, and numbers are never reused.
- **Open work is tracked privately.** The backlog is kept in a private repository ([D-076](docs/11-open-decisions.md)); an `SCP-` id in the code or the documents names one of its entries, and it is stable and never renumbered.
- **Rename with care.** After any find-and-replace, re-read the diff for sentences that changed meaning rather than wording, and check that no filename moved inside a link.

## The code

The layout is in [docs/07](docs/07-monorepo-and-deployment.md), and each package's `README.md` says what it owns. `packages/model`, `packages/review`, `packages/evaluation` and `packages/runner` each carry an `AGENTS.md` with the rules that bind work inside them: read it before changing anything there, because the rules below are only the ones that hold everywhere. A package's interface is its entry file's named exports and its `package.json` subpaths; a module with an interior is a directory whose `internal/` nothing else imports; unit tests sit beside their module ([ADR-NEW-package-interface](docs/adr/NEW-package-interface.md), the layout in docs/07).

```bash
pnpm check                                   # the gate: every stage, in order
pnpm check --filter @perbo/review           # one package, after building what it depends on
pnpm check --list                            # the stages, to run one on its own
node apps/cli/dist/main.js doctor --repo .   # can this repository be materialized at all
```

Running the corpus spends money: it needs a reviewer credential, and `--run` is the flag that spends it. `perbo run` spends more, because it executes a coding agent. Both use the person's own credential and write it nowhere.

## The rules that bite

- **A test green on the machine that wrote it and red on the next is making an assumption about its environment.** Nothing under `.local/` exists on a fresh checkout; floor an assertion on what is always present.
- **A fresh worktree needs `pnpm --filter @perbo/desktop rebuild node`** after an `--ignore-scripts` install, or `@perbo/desktop#build` fails with "Cannot find module 'node/bin/node'" and interrupts every package's tests.
- **turbo drops `TMPDIR`.** A test whose precondition depends on the temporary path's length passes under `turbo run test`, which falls back to `/tmp`, and fails under a package's own vitest on `/var/folders/…`, or the reverse. Run both when a change touches paths, wrapping or rendering.
- **One review and one gate at a time.** Two review runs beside a gate on one machine push the load average past 200 and time tests out.
- **Run the new variant; do not just read it.** Adding a case to shared machinery, such as a fixture class or a routing policy, means finding every place that branches on it. Prove it with an end-to-end test per variant, and check that test by mutation.
- **Ask whether a check can come out either way.** A check nobody can fail is indistinguishable from one that works.
- **The protected tests pin module paths.** `packages/review/test/{blocking,remediation,decision-order}.test.ts` and `packages/runner/test/security.test.ts` import `packages/review/src/{blocking,prompt,verdict,review}.ts`, `packages/runner/src/{adapter,ceilings,egress,profile,prohibited,quarantine}.ts`, `packages/runner/test/support.ts` and four names from the `@perbo/contracts` root; those files stay where they are, as real modules, whatever else moves.
- **Structural validators do not check meaning.** They check links, ids, lifecycle agreement, foreign-key and edge duplication, rendering freshness and fixture diffs, and they pass happily on two documents asserting opposite decisions. So does `turbo run test`.
- **Nothing a model returns becomes an action parameter** ([ADR-0023](docs/adr/0023-untrusted-context-boundary.md)): no branch name, path, command or pull-request target comes from model output, and a process starts with argv, never a shell string.
- **A check the product runs is changed by a person** ([D-079](docs/11-open-decisions.md)): the validators, the reviewer's prompt and policy, the scorer and the corpus. The files a pull request may not touch at all are in `.github/protected-paths.json`; `.claude/settings.json` carries the same list as deny rules, generated by `node scripts/sync-protected-paths.mjs --write` and checked by the gate; it binds a person's own sessions, and the runner binds the executor ([ADR-0030](docs/adr/0030-neutralise-repository-supplied-agent-configuration.md)).

## Rendered and generated files

- Diagrams: edit the `.dot`, then regenerate its `.svg` and `.png` with Graphviz. `validate_diagrams.py` compares label text, so it survives a Graphviz version change but still catches a stale rendering.
- Authored corpus fixtures: [`packages/evaluation/AGENTS.md`](packages/evaluation/AGENTS.md) says how they are edited and regenerated.

## Before you finish

`pnpm check` is the gate. `scripts/check.mjs` runs every stage in order: install, build, the desktop runtime, typecheck, test and lint, the corpus's shape and diffs, the validators, the protected-paths check against `origin/main`, and the regression suite's dry run against the pinned corpus. `.github/workflows/build.yml` runs the same stages as steps on every pull request, so a check is added to the script and nowhere else. A change to the reviewer prompt, the blocking matrix, or the default model or provider also runs the suite for real and carries its summary in the pull request ([`packages/review/AGENTS.md`](packages/review/AGENTS.md)). A change to the desktop's runtime packaging also passes `build.yml`'s `desktop-windows` job, which runs on every pull request.

## Merging

`main` takes changes only through pull requests, with `build.yml` green and every review thread resolved. Never merge with `--admin`, and never merge around a red check.

An agent may merge a pull request only after an independent review run on Claude Fable 5.1, or Claude Opus 5 when Fable is unavailable, has read the whole diff against this file and the `AGENTS.md` of every package the diff touches, and left an unqualified approve as a review comment naming the model ([D-073](docs/11-open-decisions.md)). The reviewing run is never the session that wrote the change. The founder may merge without it. That review is maintainer tooling: it is recorded as a comment and is never a required approval on `main`, and since GitHub cannot enforce it, a merge without the comment is a defect. Whoever merges runs `scripts/assign_ids.py --apply` first.

A commit an agent wrote carries `Assisted-by: LLM` and no `Co-Authored-By` naming a model ([D-114](docs/11-open-decisions.md)). `.claude/settings.json` sets that trailer for Claude Code.

## Agent skills

Matt Pocock's published skill bundle is vendored at `tooling/skills/mattpocock`, with its pinned source and licence, as product content: the runner offers it to the executor ([D-094](docs/11-open-decisions.md)). A skill a session applies while working here does not authorize external messages, publication or extra tools, and the rules above take precedence over a skill's default workflow.

- Issue tracker: the backlog is private ([D-076](docs/11-open-decisions.md)), and this repository's GitHub issues are for problems the people using Perbo report. Do not create a second tracker or invent triage labels.
- Domain context: start with `README.md`, then [`docs/04`](docs/04-ticket-workspace-and-review.md) and the relevant canonical document.
- Product agents: [D-094](docs/11-open-decisions.md) governs explicit skill selection. Regenerate bundled guidance with `node tooling/skills/build.mjs` and check it with `--check`.
