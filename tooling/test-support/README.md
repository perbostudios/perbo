# @perbo/test-support

The facts more than one package's tests share: where a test puts a temporary
directory and how long it lives, how a fixture repository is initialised and
what git runs under, how long a test that starts processes is given, and what
the process asked to connect to while it ran.

It is a devDependency, never a dependency. Production code does not import it,
`tsc -p tsconfig.build.json` never emits it into anyone's bundle, and ESLint
refuses the import from a non-test `src` file (docs/07 "Package layout").

A package's own port fakes do not belong here — they live beside the module
that owns the port, in its `test-support/`. What belongs here is what would
otherwise be copied into five packages.

## The interface

| Export | What it is |
| --- | --- |
| `SPAWN_TEST_TIMEOUT_MS` | The ceiling a test that starts processes runs under: 30 s, above the measured range of a loaded machine and below a hang held open. |
| `createScratch(prefix?)` | A `Scratch`: call it for a new temporary directory, `removeAll()` to take every one of them back. Registers no hook, so the caller decides the lifetime. |
| `scratchDirectories(prefix?)` | `createScratch` plus an `afterAll` that removes them. |
| `Scratch` | The type of both. |

## Rules

- **Call `scratchDirectories()` once, at the top level of a test file.** The
  hook belongs to whatever vitest is collecting when the call happens, so a
  top-level call gives every directory the lifetime of the file — which is what
  a `beforeAll` fixture needs.
- **Nothing here registers a hook on import.** An `afterAll` at module scope
  would attach itself to every file that imports the package, including the
  protected `packages/runner/test/security.test.ts`, which reaches this package
  through the runner's own support module.
- **`vitest` is a peer dependency.** `vi` and `afterAll` must be the consumer's
  instance: a second copy would register hooks on a runner that is not the one
  running the test, and spies it installed would survive the consumer's
  `vi.restoreAllMocks()`.
