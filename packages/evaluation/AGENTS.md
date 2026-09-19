# Working in packages/evaluation

The corpus, its harness and scorer, and the regression suite. The repository-wide rules are in the root [`AGENTS.md`](../../AGENTS.md); these bind work here. [`README.md`](README.md) says how a run is made, [`SCORING.md`](SCORING.md) how it is scored, and [`corpus/README.md`](corpus/README.md) holds the fixture rules.

- **`--run` spends money.** A corpus or suite run calls a model provider on the person's own credential and writes it nowhere; without `--run` the harness resolves fixtures and spends nothing.
- **A corpus fixture is never weakened because the reviewer missed it.** A miss is a result. `expected_detection` is written before a fixture first runs and never edited afterwards; a fixture that is genuinely wrong is corrected, with the reason recorded in the fixture. The sample fixtures under `sample/**` are what the reviewer is scored on, and a pull request does not change them (`.github/protected-paths.json`).
- **A test that reads `.local/` fails on the next machine.** Authored fixtures carry `change.diff` in the repository; pinned ones only have one after `node packages/evaluation/dist/main.js prepare` clones them, and a fresh checkout has no corpus cache. Floor an assertion on the authored count and treat cached diffs as a bonus.
- **The pinned-repository cache decides what the tests cover, not whether they pass.** Without `.local/corpus-cache` a pinned fixture loads with an empty diff, so a green run has exercised the authored fixtures alone, and a dangling `.local/corpus-cache` symlink reads as no cache at all. Run `prepare` once, about 800 MB, before trusting coverage.
- **Never rebuild while a corpus run is in flight.** The harness starts `apps/cli/dist/main.js` once per fixture per repeat, so a build during a run swaps the binary underneath it.
- **An authored fixture is edited in `before/` and `after/`, never in its diff.** Regenerate the diff with `python3 scripts/validate_fixture_diffs.py --write` and corpus diffs with `node packages/evaluation/scripts/build-diffs.mjs`; the gate fails a tree edited without it. Run the validator on its own with `core.abbrev=7`, which `pnpm check validators` sets: git otherwise abbreviates `index` hashes to eight characters and every fixture reads as mismatched.
- **Ask whether a check can come out either way.** `test/forbidden-strings.test.ts` and `test/expectation-reachability.test.ts` are two that can; a check nobody can fail is indistinguishable from one that works.

```bash
pnpm check --filter @perbo/evaluation
```
