# Working in packages/model

The model call. The repository-wide rules are in the root [`AGENTS.md`](../../AGENTS.md); these bind
work here. [`README.md`](README.md) says what each module owns.

- **Process execution lives in `src/claude-cli.ts` and `src/codex-cli.ts` and nowhere else.** They
  pass argv, never a command line, and nothing a model returns becomes an argument
  ([ADR-0023](../../docs/adr/0023-untrusted-context-boundary.md)). An ESLint rule holds the line,
  and `scripts/lint-boundaries.test.mjs` proves the rule fires.
- **The reviewer and the drafter speak through this package**, so a change to a default model, to
  the request a transport builds, or to the price card is a change to the reviewer: it carries a
  summary of a [regression-suite](../../docs/evaluation/regression-suite.md) run in its pull
  request body ([D-010](../../docs/11-open-decisions.md)), and
  [`packages/review/AGENTS.md`](../review/AGENTS.md) states the bars it is read against.
- **The goldens are the proof, and they are never regenerated to make a run green.** A golden that
  changed says the bytes reaching a provider changed. If that is the intent, say so in the commit
  message and nowhere else; if it is not, the change is wrong.

```bash
pnpm check --filter @perbo/model
```
