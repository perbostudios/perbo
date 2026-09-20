import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * This package's execution surface, as the lint configuration actually
 * enforces it: process execution is banned everywhere under `packages/model`
 * except in the two named CLI transports, and the shell-string ban holds even
 * there. Checked by linting a fixture rather than by reading the config, so a
 * widened glob fails a test instead of a review.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const eslint = new ESLint({ cwd: root });

async function messagesFor(relativePath: string, source: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath: join(root, relativePath) });
  return (result?.messages ?? []).map((message) => message.message);
}

const EXEC_FILE = 'import { execFile } from "node:child_process";\nexecFile("claude", ["-p"]);\n';
const SHELL_STRING = 'import { exec } from "node:child_process";\nexec("claude -p");\n';

const TRANSPORTS = ["packages/model/src/claude-cli.ts", "packages/model/src/codex-cli.ts"];

describe("the model package's execution boundary", () => {
  it("bans process execution in every other file", async () => {
    for (const path of [
      "packages/model/src/anthropic.ts",
      "packages/model/src/some-new-file.ts",
      "packages/model/src/test-support/fake-claude.ts",
      // A name is not the exemption: the override names two paths, not two
      // basenames, so the same file one directory down is refused.
      "packages/model/src/nested/claude-cli.ts",
    ]) {
      expect(await messagesFor(path, EXEC_FILE), path).toContainEqual(
        expect.stringContaining("No process execution in the model package"),
      );
    }
  }, 30_000);

  it("exempts exactly the two named transports from the execution ban", async () => {
    for (const path of TRANSPORTS) {
      expect(await messagesFor(path, EXEC_FILE), path).not.toContainEqual(
        expect.stringContaining("No process execution"),
      );
    }
  }, 30_000);

  it("keeps the shell-string ban inside the transports", async () => {
    for (const path of TRANSPORTS) {
      expect(await messagesFor(path, SHELL_STRING), path).toContainEqual(
        expect.stringContaining("No shell-string execution"),
      );
    }
  }, 30_000);
});
