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
 * A package states its interface by name, and a module keeps an interior
 * (ADR-NEW-package-interface; the layout is in docs/07 "Package layout").
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

/** A module's fakes are for its tests; the build never emits them. */
const NO_TEST_SUPPORT = {
  regex: "(^|/)test-support/",
  message: "Production code imports no test code (docs/07 Package layout).",
};

const NO_TEST_MODULE = {
  regex: "\\.test\\.js$",
  message: "Production code imports no test code (docs/07 Package layout).",
};

/** Where a package's interface and its modules live. */
const SOURCE = ["**/src/**"];

/** A source file that is not a test of one, and not a fake for one. */
const PRODUCTION_SOURCE_ONLY = {
  ignores: ["**/*.test.ts", "**/*.test.tsx", "**/test-support/**"],
};

/**
 * Entry files that still re-export with `*`. A burn-down list: a file may only
 * leave it, and the exception goes away with its last entry. The change that
 * curates a package's entry into named exports takes that entry off this list.
 */
export const EXPORT_ALL_BURN_DOWN = [
  "packages/review/src/index.ts",
  "packages/runner/src/index.ts",
];

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
    // both bans. A file on the burn-down list falls back to the array above,
    // which is how it keeps the shell-string ban while it still uses `*`.
    files: SOURCE,
    ignores: EXPORT_ALL_BURN_DOWN,
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
    ignores: EXPORT_ALL_BURN_DOWN,
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
    ignores: EXPORT_ALL_BURN_DOWN,
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
);
