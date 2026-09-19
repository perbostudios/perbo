# Contributing

## Before you open a pull request

Run the gate and see it green:

```bash
pnpm check
```

`scripts/check.mjs` runs every stage in order and prints each command as it
goes; `pnpm check --list` names the stages, and `pnpm check --filter
@perbo/<package>` runs one package after building what it depends on.
`.github/workflows/build.yml` runs the same stages as steps on every pull
request, so what passes on your machine is what passes there. The Python
validators need `scripts/requirements-validation.txt` installed; they check the
documentation's links, ADR numbering and lifecycle states.

The working rules the project holds itself to — how a change is proven, what a
comment is for, what never becomes an action parameter — are in
[`AGENTS.md`](AGENTS.md), and the rules that bind one package are in that
package's own `AGENTS.md`. They are written for whoever does the work, person
or agent, and they apply to a contributor exactly as they apply to a maintainer.

## Working with a coding agent

Most pull requests here are written by the maintainer's own agent sessions, and
yours may be too. A commit an agent wrote carries the trailer
`Assisted-by: LLM`, the Linux kernel's convention, and no `Co-Authored-By`
naming a model ([D-114](docs/11-open-decisions.md)); the checked-in
`.claude/settings.json` sets that trailer for Claude Code sessions in this
repository.

Before a session merges an agent-authored pull request, a separate agent run
reads the whole diff against `AGENTS.md` and the `AGENTS.md` of each package it
touches, and leaves an unqualified approve as a review comment
([D-073](docs/11-open-decisions.md)); the founder may merge without it. That
review is maintainer tooling, not a second person: it is never a required
approval on `main`, and a change from outside is read by the maintainer.

## A change to the reviewer carries its regression-suite run

A pull request that changes the reviewer prompt (`packages/review/src/prompt.ts`),
the blocking matrix (`packages/review/src/blocking.ts`) or the default model or
provider carries a summary of a regression-suite run in its body
([D-010](docs/11-open-decisions.md); the rule is in [`AGENTS.md`](AGENTS.md)).
The reviewing run treats the summary's absence as a blocking finding. Nothing in
the tree can check a pull-request body, so this is procedural, like the review
comment itself.

The suite runs the evaluation harness in `packages/evaluation` against the
public corpus. It calls a model provider and it costs money; run it with your
own key, and quote the result rather than the intention. The section below says
what to run and what to paste.

## Some files are not yours to change in this pull request

`.github/protected-paths.json` names a short list: the tests that check the
reviewer's blocking, remediation and decision-order behaviour, the runner's
security test, and the sample fixtures the reviewer is scored on
(`packages/evaluation/sample/**`). The gate's protected-paths check,
`node .github/scripts/protected-paths.mjs <base> <head>` over the pull
request's merge base and head, fails a pull request that edits any of them,
naming the file and why.

The reason is simple even though the mechanism sounds strict: these files are
what a change is judged against, not what a change produces. If the pull
request under review could also loosen the test that would have caught it,
the test proves nothing — and the fixture rule at the bottom of this page is
the same rule, which is why the fixtures are on the list beside the tests. The
one path around this is a maintainer's commit on the default branch, which the
check is never run against, because a maintainer is not the party the check
exists to hold to account.

The reviewer's own prompt and code are deliberately **not** on that list.
Changing the reviewer is the contribution this project is asking for; the
section above is how such a change is held honest — by the score it carries,
not by a refusal to let it be written.

If your change genuinely needs one of these to move — a real bug in the test,
not a test that is inconvenient for the change you are making — open an issue
and say why, rather than routing around the check. If you work with Claude
Code, the checked-in `.claude/settings.json` refuses edits to the same files in
your session; it is generated from the list by
`node scripts/sync-protected-paths.mjs --write`.

## The regression suite, and the delta a reviewer change reports

The suite is thirty fixtures from the public corpus, reviewed once each, read
against the score this repository recorded for the reviewer as it stands,
`.github/regression-score.json`. The commands are on
[the regression-suite page](docs/evaluation/regression-suite.md); this is what
they produce and what goes in the pull request.

**The corpus.** The score was recorded against one commit of the published
corpus, named in `.github/corpus-pin.json`, so the suite runs against a clone
of that commit, passed as `--corpus <clone>/fixtures`. Without `--corpus` the
harness scores the working tree's own copy under
`packages/evaluation/corpus/fixtures` and says nothing about it, and a score
against that copy is not comparable with the recorded one.

**Every pull request: the dry run.** `--suite regression` without `--run`
resolves the thirty fixture ids against the clone, calls no model and costs
nothing. It fails only when a fixture id the suite names is missing from the
pinned commit, which means the pin and the suite have drifted apart. It is not
the suite's score.

**A pull request that changes the reviewer prompt, the blocking matrix, or the
default model or provider: the live run and the delta.** The live run is thirty
reviews at one repeat, about fifteen dollars on your own key. `node .github/scripts/regression-delta.mjs <out> .github/regression-score.json`
reads the run against the recorded score and prints a table of metric, `n`,
recorded, now, movement and whether the gate is met, then names every fixture
whose answer changed; a gated metric that no longer meets its threshold exits 1.
That table carries metrics only. The `unstated_regression` row the pull request
leads with is a class, not a metric: it is the `unstated_regression` line of the
Recall by class table in `<out>/report.md`.

**What goes in the pull request body**, in this order: the `unstated_regression`
line from the Recall by class table; the two hard bars as the delta prints them
(Verdict not flipped on a verdict-flipping fixture, and Every cited credential
was redacted); the rest of the delta table; and the run's measured total cost,
which the harness prints when it finishes, with the corpus commit and the model
it ran on. If you have no key, say so, and a maintainer runs it on the branch
before merging.

**Re-recording the score.** The recorded score is a fact about one reviewer
against one corpus commit, so it goes stale the moment either moves. A
maintainer re-records it by running the suite on the merged reviewer and
replacing the file:

```bash
node packages/evaluation/dist/main.js prepare --suite regression --corpus <corpus>/fixtures
node packages/evaluation/dist/main.js --suite regression --corpus <corpus>/fixtures \
  --run --repeats 1 --out <out>
node .github/scripts/regression-delta.mjs <out> --record > .github/regression-score.json
```

`--record` writes every metric row's public name, value, `n`, threshold and
whether it is met, and a row per fixture — its id, its class, whether the run
caught it, what the review cost and whether the harness cut it short — read from
`<out>/runs.json`, which is why it takes the whole output directory and refuses
one with no `runs.json` in it. What it cannot know it leaves null: fill in the
corpus commit, the reviewer's model and provider, the date and the run's own
measured total cost by hand. The `_comment` in the file says what each field is.
Bump `.github/corpus-pin.json` in the same commit if the corpus moved too — a
score recorded against one commit and compared against another is not a
comparison.

## The rest of the bar

- **A test that reads a machine-local scratch directory fails on the next
  machine.** Floor an assertion on what is always present.
- **Run the new variant; do not read it.** Adding a case to shared machinery
  means every place that branches on the discriminator has to be found, and
  reading the code finds most of them. An end-to-end test per variant is what
  catches the rest.
- **Ask whether a check can come out either way.** A check nobody can fail is
  indistinguishable from a check that works right up until it matters.
- **A corpus fixture is never weakened because the reviewer missed it.** A
  missed fixture is a result.
- **Nothing the model returns becomes an action parameter.** No branch name,
  path, command or pull-request target comes from model output. The reviewer has
  no process-execution surface at all except two named provider transports, and
  the runner and the workspace pass argv, never a shell string.

## Licence

Apache-2.0; see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). A contribution you
submit is under that licence by its section 5, and there is no contributor
licence agreement.
