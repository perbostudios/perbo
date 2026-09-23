# `@perbo/evaluation`

Owns the seeded-defect corpus and fixture format, immutable run-bundle capture, evaluation results, and model/prompt/policy promotion state.

The corpus holds seeded defects in seven classes and **clean changes**; without the clean changes a recall number is meaningless, because a reviewer that blocks everything scores perfect recall. Two classes carry the product's specific claims: verification defects (passes a test the executor wrote that does not test the criterion) and adversarial context (an instruction planted in a test log or dependency README).

The fixtures are published as `plantedbugs`, and the harness and scorer are open with the rest of Perbo (D-075). Each run bundle carries a computed `replayability` tier (ADR-0026).

## Running it

```bash
node packages/evaluation/dist/main.js
```

Lists the corpus and stops. `--run` is the flag that spends money:

```bash
ANTHROPIC_API_KEY=… node packages/evaluation/dist/main.js --run --repeats 3 --out .local/corpus
```

`--max-spend 16.00` bounds what it spends: the harness launches no review whose projected cost
would take the transport-reported total past the ceiling, and a run it stops is recorded as
partial, with no threshold reported as met.

It writes `runs.json`, `summary.json`, `report.md` and `rule-authority.json`, and prints the report.
The harness **spawns the real `perbo` binary** once per fixture per repeat rather than calling
`runReview` directly — otherwise the argument parsing, the artifact serialisation and the exit codes
would be untested by the thing that is supposed to be able to trust them.

What it spawns is the run's **own copy** of that binary: before the first fixture, a single-file
bundle of the CLI is built into `<out>/bin/perbo.mjs`, and every fixture and every repeat runs that
file. Rebuilding the tree during a run therefore cannot change what is being measured. The copy's
SHA-256 and byte size go into `run-manifest.json`, the digest is printed in the report header, and a
run that cannot build the bundle stops rather than falling back to the tree's copy.

## Where the corpus directory comes from

A read that names no directory — `loadCorpus()`, the CLI without `--corpus` — takes it in this
order:

1. `PERBO_EVAL_CORPUS_DIR`, when it is set to something other than whitespace. A relative value is
   resolved against the working directory.
2. Otherwise `corpus/fixtures` beside this package, which is what a checkout of this repository has.

**A directory that is not there is refused, not replaced.** `loadCorpus()` throws an `ENOENT` naming
the directory it tried, whether that directory was passed or came from the override; it never falls
back to the packaged corpus. An override with a typo in it would otherwise measure the 108 fixtures
the reader meant to replace and report the number as if it were theirs.

Absence is still not a failure for the suites whose subject is the corpus. They ask whether the
directory exists first and skip, naming what is missing — `test/corpus-present.ts` is the one place
that decides it, `test/corpus-absence.test.ts` proves the skip by pointing the variable at a
directory that is not there, and `test/corpus-read-guard.test.ts` keeps any other test file from
reading the corpus behind the gate's back. It scans every tree vitest collects a suite from, taken
from `vitest.config.ts` — `test/` and `src/`, each with everything under it — so a suite in a
subdirectory, or one sitting beside the loader, is held to the same rule. And it parses the
files it scans rather than searching them for a name: it follows the loader from the module that
exports it — `src/corpus.ts` — through any re-export to whatever local name it arrives under, so an
import under an alias, off a namespace, or out of a dynamic `import()` is the
same offence as the plain call. No test file may hold the loader at all, no helper beside them may
call it without naming a directory, and no file but the gate may hand it on.

## Fixtures that pin a real repository

A clean fixture may name a real repository and two real commits instead of carrying a tree. Nothing
upstream is checked in; `prepare` clones into `.local/corpus-cache` and computes the diff.

```bash
node packages/evaluation/dist/main.js prepare
```

Without it those fixtures are excluded from a run and named in the report. Reviewing a repository
that is not there would produce a confident verdict about nothing.

## Reading the numbers

Every proportion is reported twice, and the difference matters.

- **By fixture** takes a majority across a fixture's repeats and counts fixtures. This is the correct
  n: three runs of one fixture are not three independent observations.
- **By run** counts runs. Larger n, narrower interval, and it means less.

Intervals are Wilson score intervals rather than the normal approximation, which at these sample
sizes produces bounds outside [0, 1]. Latency and cost quantiles carry a seeded percentile bootstrap,
so a reported interval reproduces.

**`resolves` is the number to read first.** If the interval at the staged size cannot
distinguish pass from fail, the corpus is not a gate for that metric and must not be used as one. The
report prints a section listing every metric whose interval straddles its threshold, and the verdict
column says *met, but unresolved* rather than *met*.

`stability` records how many fixtures' repeats disagreed with each other. That is the number that
says whether three repeats were enough.

## Measuring the routing

The report carries two numbers for clean changes. **Passing the gate** counts a clean change as
passing when its review ended `approve` or `remediable`: a routed finding is the executor's work,
because in the loop an executor exists to take it ([D-086](../../docs/11-open-decisions.md)).
**Carrying no blocking finding** counts it as passing when no finding blocks. A change that passes
the gate carries no blocking finding, so this is the looser number. The gap between the two is the
reviews that closed the gate without a blocking finding: those that escalated to a person, and
those that did not finish.

A defective fixture detected *only* through routing is counted separately, because it is a defect a
human never hears about until the rounds run out.

## What the harness cannot do

**Human agreement that a finding is worth fixing** (≥70% of a 40-finding sample) is not measurable
here. It needs a person to score a sample of findings, which the harness does not do.

`rule-authority.json` is the measured false-positive rate per rule, which `perbo review
--rule-authority` consumes to demote a rule that cries wolf. Only a **blocking** finding on a change
with no seeded defect counts against a rule — an advisory one costs the user nothing.

See [`corpus/README.md`](corpus/README.md) for the fixture format and the rules that keep it a
measurement rather than a rehearsal.
