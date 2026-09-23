import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The reviewer's execution surface, as the lint configuration actually
 * enforces it: process execution is banned everywhere under `packages/review`,
 * with no exception. The transports that start a provider binary are
 * `@perbo/model`'s, and its own boundary test covers them. Checked by linting
 * a fixture rather than by reading the config, so a widened glob fails a test
 * instead of a review.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const eslint = new ESLint({ cwd: root });

async function messagesFor(relativePath: string, source: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath: join(root, relativePath) });
  return (result?.messages ?? []).map((message) => message.message);
}

const EXEC_FILE = 'import { execFile } from "node:child_process";\nexecFile("claude", ["-p"]);\n';

describe("the reviewer's execution boundary", () => {
  it("bans process execution in every reviewer file, with no exception", async () => {
    for (const path of [
      "packages/review/src/review.ts",
      "packages/review/src/some-new-file.ts",
      "packages/review/src/nested/provider-cli.ts",
      "packages/review/test/m.test.ts",
      // The rule covers a path, not a file: the names a provider transport
      // takes are refused like any other, so one cannot live here.
      "packages/review/src/provider-cli.ts",
      "packages/review/src/provider-codex-cli.ts",
    ]) {
      expect(await messagesFor(path, EXEC_FILE), path).toContainEqual(
        expect.stringContaining("No process execution in the reviewer"),
      );
    }
  }, 30_000);
});
