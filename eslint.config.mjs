// Flat config, resolved upward from each package's cwd, so `eslint src test`
// inside a workspace package finds this file.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * ADR-0023 §4: nothing the model returns may become a path, a command or a
 * shell argument. Two rules, because two packages have different jobs.
 */
const NO_SHELL_STRING = {
  // `exec` and `execSync` take a command *line*. Everything else in
  // child_process takes argv, where a value that should have been an argument
  // stays one argument whatever it contains.
  selector: "CallExpression[callee.name=/^(exec|execSync)$/]",
  message:
    "No shell-string execution anywhere. Use argv (execFile/spawn) so a value cannot become a command (ADR-0023 §4).",
};

const NO_PROCESS_EXECUTION = {
  selector:
    "CallExpression[callee.name=/^(exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)$/]",
  message:
    "No process execution in the reviewer. Model output must never reach a command (ADR-0023).",
};

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
    // The semantic reviewer has no process execution surface by default.
    files: ["packages/review/**"],
    rules: {
      "no-restricted-syntax": ["error", NO_PROCESS_EXECUTION],
    },
  },
  {
    // The two named CLI transports are the reviewer's only exception. They
    // start a fixed provider binary while model/repository content travels as
    // data and never selects a command. Both retain the shell-string ban.
    files: [
      "packages/review/src/provider-cli.ts",
      "packages/review/src/provider-codex-cli.ts",
    ],
    rules: {
      "no-restricted-syntax": ["error", NO_SHELL_STRING],
    },
  },
);
