# Revert candidates for the `unstated_regression` class

[D-053](../../../docs/11-open-decisions.md)
created this class and named its constraint: **reverts with a recoverable stated reason are scarce.**
This is the search, so that the scarce half is not redone every time somebody wants another fixture.

## Why this class matters more than its size suggests

Fifty-four of the sixty seeded fixtures were written by the person who wrote the reviewer. These were
not — a real project merged the change, users found what it broke, and the project reverted it with a
reason. Reality wrote the ground truth.

It is also the worst score on the board: **50% [19–81] n=6**, against 98–100% on every class authored
in-house (round 2). Six fixtures cannot carry a
verdict either way, and that is exactly the problem — the only place reality gets a vote is the place
with too few votes to count.

**The class is now ten.** Four were built on 2026-08-29 — `reg-007` to `reg-010` in the table below.
Be exact about what that buys, because the temptation is to overstate it: at these proportions a
Wilson interval on ten is about **16%** narrower than on six ([19–81] → [24–76] at p=0.5).

**Scored on 2026-08-29** (round 3): the class
reads **80% [49–94] n=10** — all four new fixtures detected in a majority of repeats, with findings
that name the actual mechanisms (pytest's indirect-parametrization gap, svelte's stale-CLEAN
derived), and on `reg-007` a real unseeded defect in the merged commit. The result document carries
the caveat that belongs beside that number: reverts with recoverable reasons are selected for
legible breakage, so the buildable part of this class may be the part the reviewer reads best.
`reg-001` and `reg-003` — the two whose defects live furthest from the changed lines — are still
missed unanimously.

## The bar a candidate has to clear

1. **Permissively licensed.** MIT, BSD or Apache-2.0. No code is copied into this repository; the
   fixture pins commits and the diff is computed from a clone.
2. **A substantive behaviour change**, not a dependency bump, a CI fix, a docs edit or a release-process
   revert.
3. **A recoverable stated reason**, in the revert commit, its pull request, or an issue it closes.
   *"Reverts #1234"* with nothing else is not enough: without a reason there is no ground truth, only
   the fact that somebody changed their mind.
4. **The original change satisfied its own stated intent.** That is what makes the class what it is —
   the defect is in something the change never claimed to be about.

Reason 3 is what most candidates fail on. Of roughly sixty reverts examined across sixteen
repositories, **nine** cleared all four on the first pass, and re-reading them at build time demoted
one — see candidate 6.

## Verified candidates

Every `head` below is the merge commit of the original change; `base` is its first parent. Both are
reachable at the time of writing.

The **built** column names the fixture if one exists. Building is the cheap half; see the section
after the table for what it takes.

| # | Repository | Original | head → base | Why it was reverted | built |
|---|---|---|---|---|---|
| 1 | `sveltejs/svelte` | [#17852](https://github.com/sveltejs/svelte/pull/17852) skip derived re-evaluation inside inert effect blocks | `e3f06f9fc7` → `25a1c5368b` | Reverted by #17869: *"because it isn't a real fix"*, with [#17868](https://github.com/sveltejs/svelte/pull/17868) as the actual one | `reg-010` |
| 2 | `prettier/prettier` | [#19273](https://github.com/prettier/prettier/pull/19273) fix unstable comments around parenthesized expressions | `794ca266a9` → `75c46513c9` | Reverted by #19274: *"It causes bug for `prettier-ignore`d node"*, with a reproducing playground link | `reg-008` |
| 3 | `vuejs/core` | [#14302](https://github.com/vuejs/core/pull/14302) resolve kebab-case slot names from in-DOM templates | `7e554bf897` → `0596a5f591` | Reverted by #14331, citing a failing ecosystem-ci run across downstream projects | `reg-007` |
| 4 | `chartjs/Chart.js` | [#11377](https://github.com/chartjs/Chart.js/pull/11377) fix curve path if scale limits are set for line chart | `cc7ee8ade1` → `05608b0ceb` | Reverted by #11432, which closes [#11426](https://github.com/chartjs/Chart.js/issues/11426) — the regression it caused | **blocked** |
| 5 | `prettier/prettier` | [#18852](https://github.com/prettier/prettier/pull/18852) print `;` for module declaration and declare function | `0eda012bcb` → `c06314c988` | Reverted by #19333: *"Too many changes for such an edge case"*, reopening issue #14149 | — |
| 6 | `axios/axios` | [#10866](https://github.com/axios/axios/pull/10866) support URL object as `config.url` input | `847d89b436` → `4094886367` | Reverted by #10874 to restore string-only URLs and prior behaviour in v1.x | **withdrawn** |
| 7 | `pytest-dev/pytest` | `d56b1af525` remove no longer needed special case in `pytest_generate_tests` | `d56b1af525` → `9652bc714d` | Reverted by `3a85b5ead0`: *"Seems this is still needed for the indirect case"* | `reg-009` |
| 8 | `prettier/prettier` | [#17587](https://github.com/prettier/prettier/pull/17587) support type cast comments for the `espree` parser | `3b0f33539f` → `0c574a17b9` | Reverted by #17614 because upstream declined the support it depended on | — |
| 9 | `remix-run/react-router` | [#14759](https://github.com/remix-run/react-router/pull/14759) default web-streams based server entry | `2cc25c701b` → `f8bff7a846` | Reverted by #15289: *"We're going to add this behind a future flag to be safe"* | — |

Candidates 8 and 9 are weaker and marked as such: the reason is a policy or rollout judgement rather
than a defect users hit. They are worth building **after** the first seven, and worth labelling in
their `notes` so a reader of a per-class number knows what is in it.

Two of the nine did not become fixtures, and both reasons are worth keeping:

**Candidate 6 (`axios`) is withdrawn.** On a second reading it fails bar 3. The revert's only stated
reason is an auto-generated summary restating what the revert does — *"v1.x now accepts string URLs
only to match prior behavior"* — with no human comment and no linked issue. That is a bot describing
a diff, not a project saying what broke, and the bar exists precisely to exclude it. It survived the
first pass because the generated prose reads like a rationale.

**Candidate 4 (`chartjs`) is verified and unbuildable — investigated to a conclusion 2026-08-30.**
Pinning Node 18 does fix
the install and the transform, and the suite still cannot be measured green: it needs Firefox, and
its image-comparison tests drift 0.46% against a 0.1% tolerance on a modern Chrome. A fixture
verified by pixel comparison is not portable across time. Do not re-attempt without a period-correct
browser. The original diagnosis, kept because it was right as far as it went: Its ground truth is the strongest in
the set — the revert closes [#11426](https://github.com/chartjs/Chart.js/issues/11426), a user report
with a working and a broken codepen. The repository pins `pnpm@7.9.0`, which cannot install under a
current Node (`ERR_INVALID_THIS`), and installing with pnpm 9 instead resolves an swc newer than the
lockfile intends, so karma dies in the transform before a single test runs. Making it measurable means
pinning a contemporary Node for that fixture, which the harness has no way to express.
The fixture was written and then withheld rather than shipped with an unmeasured
`checks.json`, which would have asserted the one thing it exists to demonstrate.

## Rejected, and why — so the same ones are not re-examined

| Repository | Revert | Rejected because |
|---|---|---|
| `pydantic/pydantic` | Box large fields in CombinedValidator (#12998) | *"We need to retry the v2.13.0b3 release first"* — release process, not a defect |
| `sveltejs/svelte` | use Set instead of Array for constant lookups (#18294) | Body is *"Reverts #18250"* and nothing else; comments are bot output |
| `vuejs/core` | handle invalid static arg in v-bind shorthand (#15362) | Same — no reason anywhere recoverable |
| `rollup/rollup` | improve function return value tracking (#6490) | Template boilerplate only; the one human comment is `cc @cyyynthia` |
| `vitejs/vite` | escape ids with multiple null bytes; resolve pnpm `.modules.yaml` | Direct commits with no pull request and no stated reason |
| `jestjs/jest` | haste.backend option (#16186); core ESM mock prefix | Unfilled PR template; no reason given |
| `nodejs/undici` | scheme-less proxy env vars (#4914) | Reverted, reapplied and re-reverted with no reason at any step |
| Many | dependency bumps, CI fixes, docs, release scripts | Not behaviour changes |

## What a built fixture still needs

Discovery is the scarce half; it is not the whole job. Each candidate becomes a fixture only with:

- `contract.json` — the plan the original change would have been given, reconstructed from what it
  claimed to do. Its criteria must be ones the change **satisfies**, or the fixture is testing the
  wrong thing.
- `fixture.json` — with `expected_detection` anchored to a **file** rather than a criterion, because
  having no violated criterion is the definition of this class, and written before the fixture is
  ever run.
- `checks.json` — **measured, not declared.** The claim that matters is that the repository's own
  suite was green at the head commit: the defect was found by users, not by the tests. Writing
  `passed` without running it would make the fixture assert the one thing it exists to demonstrate.

`perbo-corpus prepare` clones the pinned commits and `perbo-corpus baseline --write` records
whether the change's own tests fail at its base commit.

Measuring the head suite is where the time goes, and it is mostly environment archaeology rather than
judgement. What the four builds on 2026-08-29 cost, recorded so the next estimate is not optimistic:
`pytest` needed its tags fetched before install, because setuptools_scm derives the version from them
and without them the project's own `minversion` check rejects the build — then five undeclared test
dependencies. `svelte`'s test script is at the workspace root, not in the `svelte` package, so the
obvious `pnpm --filter svelte test` **exits 0 having run nothing**; it also needs a build first and a
playwright browser. `vuejs/core` had one test fail on the first run and pass on the three after it.
Only `prettier` installed and ran as documented. Budget an hour per fixture and expect one in five to
be unbuildable.
