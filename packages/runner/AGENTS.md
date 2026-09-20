# Working in packages/runner

The half of execution that is not the agent: the permission profile, the adapters, the write guard, sealing, checks, the remediation loop, delivery and the merge step. The repository-wide rules are in the root [`AGENTS.md`](../../AGENTS.md); these bind work here. [`README.md`](README.md) says what each file owns and names the traps.

- **Processes start with argv only, never a shell string** ([ADR-0023](../../docs/adr/0023-untrusted-context-boundary.md)). Nothing a model returns becomes a branch name, a path, a command or a pull-request target; the write guard (`src/guard-hook.ts`, `src/pretool.ts`) answers each of the executor's tool calls before it runs, and `src/shell/` is how it reads what a command would touch.
- **No repository-supplied agent configuration reaches the executor or the reviewer** ([ADR-0030](../../docs/adr/0030-neutralise-repository-supplied-agent-configuration.md)). `src/quarantine.ts` moves every known configuration path out of the worktree before handover, and each adapter asserts what loaded. A new adapter meets all three of the ADR's requirements or does not ship.
- **`.perbo/**` is prohibited to the executor, always.** That is what lets `.perbo/principles.md` reach the brief as person-authored data ([D-065](../../docs/11-open-decisions.md)); the rest of the store is equally out of its reach.
- **`test/security.test.ts` judges an attempt, and a pull request does not change it** (`.github/protected-paths.json`).

```bash
pnpm check --filter @perbo/runner
```
