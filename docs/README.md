# Documentation

Start with the [README](../README.md). This index finds the document that answers a question.

| If you want to know | Read |
|---|---|
| What Perbo is, and what it is not | [00 — product thesis](00-product-thesis.md) |
| How it is built | [02 — system architecture](02-system-architecture.md), [05 — components](05-component-specifications.md), [07 — repository layout and release](07-monorepo-and-deployment.md) |
| How a ticket, a contract and a review work | [04 — ticket, workspace and review](04-ticket-workspace-and-review.md), [03 — domain and records](03-domain-and-event-model.md) |
| How large work will be planned | [planning mode and execution graphs](planning-mode-and-execution-graphs.md) |
| What a person sees and does | [15 — product experience](15-product-experience-and-onboarding.md) |
| What is safe, and what leaves the machine | [08 — security, autonomy and data](08-security-autonomy-and-data.md), [install](install.md) |
| How review quality is held | [14 — review and the regression suite](14-planning-review-evaluation-and-learning.md), [the regression suite](evaluation/regression-suite.md) |
| Why something is the way it is | [11 — decisions](11-open-decisions.md), [ADRs](adr/README.md) |
| What is open, and what is sold | [17 — open source and the commercial product](17-commercial-open-source-and-validation.md) |
| What comes next | [09 — roadmap](09-roadmap-and-exit-criteria.md) |

## Diagrams

Each diagram has a Graphviz `.dot` source beside its `.svg` and `.png`.

| | |
|---|---|
| [System context](../diagrams/system-context.svg) | The person, the desktop, the CLI and queue, the runner, the agents, the reviewer, GitHub and the providers |
| [Desktop runtime](../diagrams/desktop-runtime.svg) | The desktop host, its renderer and the bundled CLI |
| [Context trust boundary](../diagrams/context-trust-boundary.svg) | What reaches a model as instruction, and what only as data |
| [Ticket lifecycle](../diagrams/ticket-lifecycle.svg) | Every state a ticket can be in |

## Other directories

| | |
|---|---|
| [`adr/`](adr/README.md) | Architecture decision records |
| [`templates/`](templates) | The component specification template |

## What is enforced

| | |
|---|---|
| `scripts/validate_docs.py` | Links, decision and ADR ids, this index's coverage, lifecycle states agreeing between docs/04 and its diagram, foreign keys against edges in docs/03 |
| `scripts/validate_diagrams.py` | A rendering that no longer matches its source |
| `scripts/validate_fixture_diffs.py` | A corpus fixture whose diff is not what its own trees produce |
| `pnpm exec turbo run typecheck test lint` | The product code |
| `node packages/evaluation/dist/main.js` | A corpus fixture that is not well formed, or an expectation naming something that does not exist |
| `node .github/scripts/protected-paths.mjs` | A pull request that edits a file a change is judged against |
| `node scripts/sync-protected-paths.mjs --check` | A protected-paths list that differs between the runner's, CI's and Claude Code's copies |

`pnpm check` runs them all, as the stages of `scripts/check.mjs`; [`AGENTS.md`](../AGENTS.md) names the stages. None of them checks meaning. Two documents can each pass and still disagree; only reading catches that.
