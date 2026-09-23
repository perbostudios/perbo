// Flat config, resolved upward from each package's cwd, so `eslint src test`
// inside a workspace package finds this file.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * ADR-0023 §4: nothing the model returns may become a path, a command or a
 * shell argument. Three rules, because a package that never starts a process,
 * one whose two transports do, and everything else have different jobs.
 */
const NO_SHELL_STRING = {
  // `exec` and `execSync` take a command *line*. Everything else in
  // child_process takes argv, where a value that should have been an argument
  // stays one argument whatever it contains.
  selector: "CallExpression[callee.name=/^(exec|execSync)$/]",
  message:
    "No shell-string execution anywhere. Use argv (execFile/spawn) so a value cannot become a command (ADR-0023 §4).",
};

const PROCESS_EXECUTION =
  "CallExpression[callee.name=/^(exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)$/]";

const NO_PROCESS_EXECUTION = {
  selector: PROCESS_EXECUTION,
  message:
    "No process execution in the reviewer. Model output must never reach a command (ADR-0023).",
};

const NO_TRANSPORT_PROCESS_EXECUTION = {
  selector: PROCESS_EXECUTION,
  message:
    "No process execution in the model package, outside its two named CLI transports. " +
    "Model output must never reach a command (ADR-0023).",
};

/**
 * One module starts every git and gh process (D-126,
 * ADR-0041). A call here takes one of two forms — a binary
 * followed by its arguments, or one array of words — so the ban reads the
 * first word of each. A binary a variable names is out of its reach, and the
 * module is where a variable that holds one lives.
 */
const NO_GIT_OR_GH_PROCESS = {
  selector:
    "CallExpression[callee.name=/^(execFile|execFileSync|spawn|spawnSync|run|runOrThrow|runSync)$/]" +
    ":matches([arguments.0.value=/^(git|gh)$/], [arguments.0.elements.0.value=/^(git|gh)$/])",
  message:
    "git and gh go through @perbo/workspace's repository module: argv only, in the runner's " +
    "allow-listed environment, with prompts off (D-126).",
};

/**
 * Where one starts instead: the module itself, and the write guard's replay of
 * the agent's own push, which repeats the agent's global flags in the agent's
 * environment and so cannot be said through the typed interface. The fixture
 * repositories the tests build are a test's own git, and the rule reaches no
 * test or `test-support/` file to begin with.
 */
const STARTS_GIT_OR_GH = [
  "packages/workspace/src/repository/**",
  "packages/runner/src/push-remote.ts",
];

/**
 * A package states its interface by name, and a module keeps an interior
 * (ADR-0040; the layout is in docs/07 "Package layout").
 * `export *` re-exports whatever a file happens to hold, so the interface is
 * whatever the implementation is.
 */
const NO_EXPORT_ALL = {
  selector: "ExportAllDeclaration",
  message: "Name what the module exports (docs/07 Package layout).",
};

/** Only a module's own `index.ts` and its siblings reach `./internal/…`. */
const NO_FOREIGN_INTERIOR = {
  regex: "^(?!\\./internal/).*(^|/)internal/",
  message: "A module's `internal/` is imported only by that module (docs/07 Package layout).",
};

/** A package promises its entry and its subpaths, not the files behind them. */
const NO_DEEP_PACKAGE_IMPORT = {
  regex: "^@perbo/[^/]+/(src|dist)/",
  message:
    "Import a package by its name, not a file under its `src/` or `dist/` (docs/07 Package layout).",
};

/**
 * The endpoint is a session's reach into this build (D-072, ADR-0023 §4). It
 * runs commands in this process over typed input and has no line of its own,
 * so nothing at the argv edge belongs in it: with no parser and no adapter
 * within reach, "a value shaped like a flag" has no meaning there.
 */
const NO_COMMAND_LINE_EDGE = {
  regex: "(^|/)command-line/",
  message:
    "The endpoint reaches a command as a typed function; it reads no command line (ADR-0023 §4).",
};

/**
 * The queue and the interview do read a line of their own — by the one
 * grammar, like every other command. What they may not reach is the adapter
 * that runs a command *from* a line, because both call other commands in this
 * process and those callers pass values, never argv.
 */
const NO_TERMINAL_ADAPTER = {
  regex: "(^|/)command-line/terminal",
  message:
    "Call the command, do not run it from a line: the terminal adapter is the entry point's (ADR-0023 §4).",
};

/**
 * The modules that call other commands in this process, whole: a file added
 * beside the ones that call them today is held to the same rule, which naming
 * each file would have let it escape.
 */
const IN_PROCESS_CALLERS = {
  endpoint: ["apps/cli/src/endpoint/**"],
  queueAndInterview: [
    "apps/cli/src/commands/serve/**",
    "apps/cli/src/commands/interview/**",
  ],
};

/**
 * A module's fakes are for its tests, and so is `@perbo/test-support`, the
 * package of fakes every package's tests share; the build never emits either.
 */
const NO_TEST_SUPPORT = {
  regex: "(^|/)test-support(/|$)",
  message: "Production code imports no test code (docs/07 Package layout).",
};

const NO_TEST_MODULE = {
  regex: "\\.test\\.js$",
  message: "Production code imports no test code (docs/07 Package layout).",
};

/**
 * `apps/desktop/src` is three layers: the host, which has Node and the
 * person's credentials; the renderer, which is a browser; and `shared/`, the
 * protocol and the readings both of them hold. The first two reach each other
 * only through the third, and the third reaches neither, so what crosses is
 * what the protocol says and nothing else (docs/07 "Package layout").
 */
const DESKTOP_LAYERS_MEET =
  "The host and the renderer meet in `shared/`, which imports neither (docs/07 Package layout).";

const NO_HOST_LAYER = { regex: "(^|/)host/", message: DESKTOP_LAYERS_MEET };
const NO_RENDERER_LAYER = { regex: "(^|/)renderer/", message: DESKTOP_LAYERS_MEET };

/**
 * What a browser bundles: the renderer and the preview it runs in, `shared/`,
 * which the renderer imports, and the planning modules the renderer reaches.
 * `packages/planning/src/browser.test.ts` and
 * `apps/desktop/src/renderer/browser-imports.test.ts` hold the same invariant
 * by bundling; this says it at the import, where it is written.
 */
const BROWSER_BUNDLED = [
  "apps/desktop/src/renderer/**",
  "apps/desktop/src/shared/**",
  "apps/desktop/src/sample-host/**",
  "packages/planning/src/browser.ts",
  "packages/planning/src/errors.ts",
  "packages/planning/src/graph-edit.ts",
  "packages/planning/src/impact.ts",
  "packages/planning/src/node-page-text.ts",
  "packages/planning/src/spec-text.ts",
];

/** Where a package's interface and its modules live. */
const SOURCE = ["**/src/**"];

/** A source file that is not a test of one, and not a fake for one. */
const PRODUCTION_SOURCE_ONLY = {
  ignores: ["**/*.test.ts", "**/*.test.tsx", "**/test-support/**"],
};

/**
 * The git and gh ban, over one zone's production source. It repeats the bans
 * that zone already carries, because this object replaces the rule's options
 * for the files it names.
 */
const startsNoGitOrGh = (files, ...syntax) => ({
  files,
  ignores: [...PRODUCTION_SOURCE_ONLY.ignores, ...STARTS_GIT_OR_GH],
  rules: { "no-restricted-syntax": ["error", ...syntax, NO_GIT_OR_GH_PROCESS] },
});

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/.turbo/**",
      // The `perbo index` fixtures are an authored repository the indexer
      // reads, not code this repository runs: their imports resolve to
      // packages that are not installed here, and what the parser has to get
      // right includes shapes a linter is there to discourage.
      "apps/cli/test/fixtures/symbol-index/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-restricted-syntax": ["error", NO_SHELL_STRING],
    },
  },
  {
    // A source file names what it exports. A later config object replaces the
    // rule's options whole, so every array that reaches a source file repeats
    // both bans.
    files: SOURCE,
    rules: {
      "no-restricted-syntax": ["error", NO_SHELL_STRING, NO_EXPORT_ALL],
    },
  },
  {
    // The semantic reviewer has no process execution surface by default.
    files: ["packages/review/**"],
    rules: {
      "no-restricted-syntax": ["error", NO_PROCESS_EXECUTION],
    },
  },
  {
    // The reviewer's source, which the object above no longer reaches.
    files: ["packages/review/src/**"],
    rules: {
      "no-restricted-syntax": ["error", NO_PROCESS_EXECUTION, NO_EXPORT_ALL],
    },
  },
  {
    // The model call has no process-execution surface by default either.
    files: ["packages/model/**"],
    rules: {
      "no-restricted-syntax": ["error", NO_TRANSPORT_PROCESS_EXECUTION],
    },
  },
  {
    // Its source, which the object above no longer reaches.
    files: ["packages/model/src/**"],
    rules: {
      "no-restricted-syntax": ["error", NO_TRANSPORT_PROCESS_EXECUTION, NO_EXPORT_ALL],
    },
  },
  {
    // The two named CLI transports are the only exception in the repository.
    // They start a fixed provider binary while model and repository content
    // travels as data and never selects a command. Both retain the
    // shell-string ban.
    files: ["packages/model/src/claude-cli.ts", "packages/model/src/codex-cli.ts"],
    rules: {
      "no-restricted-syntax": ["error", NO_SHELL_STRING, NO_EXPORT_ALL],
    },
  },
  // One module starts every git and gh process, in every zone: the source at
  // large, the reviewer's, the model's and the two transports', each keeping
  // what it already refused.
  startsNoGitOrGh(SOURCE, NO_SHELL_STRING, NO_EXPORT_ALL),
  startsNoGitOrGh(["packages/review/src/**"], NO_PROCESS_EXECUTION, NO_EXPORT_ALL),
  startsNoGitOrGh(["packages/model/src/**"], NO_TRANSPORT_PROCESS_EXECUTION, NO_EXPORT_ALL),
  startsNoGitOrGh(
    ["packages/model/src/claude-cli.ts", "packages/model/src/codex-cli.ts"],
    NO_SHELL_STRING,
    NO_EXPORT_ALL,
  ),
  {
    // A package is imported by its name, and a module's interior is its own.
    files: SOURCE,
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [NO_FOREIGN_INTERIOR, NO_DEEP_PACKAGE_IMPORT] },
      ],
    },
  },
  {
    // What ships imports nothing that only a test needs. The two patterns
    // above are repeated because this object replaces the rule's options.
    files: SOURCE,
    ...PRODUCTION_SOURCE_ONLY,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            NO_FOREIGN_INTERIOR,
            NO_DEEP_PACKAGE_IMPORT,
            NO_TEST_SUPPORT,
            NO_TEST_MODULE,
          ],
        },
      ],
    },
  },
  {
    // The endpoint, which every object above still reaches: each repeats what
    // it does not mean to drop.
    files: IN_PROCESS_CALLERS.endpoint,
    ...PRODUCTION_SOURCE_ONLY,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            NO_FOREIGN_INTERIOR,
            NO_DEEP_PACKAGE_IMPORT,
            NO_TEST_SUPPORT,
            NO_TEST_MODULE,
            NO_COMMAND_LINE_EDGE,
          ],
        },
      ],
    },
  },
  {
    // A browser bundle takes values from a package's `./browser` surface: the
    // root entry reaches `node:` modules and would pull them in. A type is
    // erased, so it crosses. Its own rule, so what every source file is held
    // to stands unchanged beside it.
    files: BROWSER_BUNDLED,
    ...PRODUCTION_SOURCE_ONLY,
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: ["@perbo/contracts", "@perbo/planning"].map((name) => ({
            name,
            allowTypeImports: true,
            message: `A browser bundle takes values from ${name}/browser; the root imports node: modules.`,
          })),
        },
      ],
    },
  },
  // The desktop's three layers. Each repeats what every source file is held
  // to, because this object replaces the rule's options for the files it
  // names, and each ignores the tests and fakes that drive one layer from
  // another.
  {
    files: ["apps/desktop/src/renderer/**"],
    ...PRODUCTION_SOURCE_ONLY,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            NO_FOREIGN_INTERIOR,
            NO_DEEP_PACKAGE_IMPORT,
            NO_TEST_SUPPORT,
            NO_TEST_MODULE,
            NO_HOST_LAYER,
          ],
        },
      ],
    },
  },
  {
    files: ["apps/desktop/src/host/**"],
    ...PRODUCTION_SOURCE_ONLY,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            NO_FOREIGN_INTERIOR,
            NO_DEEP_PACKAGE_IMPORT,
            NO_TEST_SUPPORT,
            NO_TEST_MODULE,
            NO_RENDERER_LAYER,
          ],
        },
      ],
    },
  },
  {
    files: ["apps/desktop/src/shared/**"],
    ...PRODUCTION_SOURCE_ONLY,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            NO_FOREIGN_INTERIOR,
            NO_DEEP_PACKAGE_IMPORT,
            NO_TEST_SUPPORT,
            NO_TEST_MODULE,
            NO_HOST_LAYER,
            NO_RENDERER_LAYER,
          ],
        },
      ],
    },
  },
  {
    // The queue and the interview, which read their own line and run no
    // command from one.
    files: IN_PROCESS_CALLERS.queueAndInterview,
    ...PRODUCTION_SOURCE_ONLY,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            NO_FOREIGN_INTERIOR,
            NO_DEEP_PACKAGE_IMPORT,
            NO_TEST_SUPPORT,
            NO_TEST_MODULE,
            NO_TERMINAL_ADAPTER,
          ],
        },
      ],
    },
  },
);
