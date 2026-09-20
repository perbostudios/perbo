import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { claudeCliModel } from "./claude-cli.js";
import { fakeClaudeBinary } from "./test-support/fake-claude.js";
import { expectGolden } from "./test-support/golden.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./test-support/spawn-timeout.js";

/**
 * What the claude-cli transport hands the binary: its argv, the prompt on
 * stdin and the system prompt in the file the invocation names, over two turns
 * of one session.
 *
 * The session id and the scratch path are minted per run, so they are recorded
 * as placeholders; everything else is the invocation as it stands.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-claude-golden-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const submitSchema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

const first = {
  system: "system prompt",
  messages: [{ role: "user" as const, content: "the context" }],
  forceSubmit: false,
};

const second = {
  system: "system prompt",
  messages: [
    ...first.messages,
    {
      role: "assistant" as const,
      content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a/b.ts" } }],
    },
    {
      role: "user" as const,
      content: [{ type: "tool_result", tool_use_id: "t1", content: "the file" }],
    },
  ],
  forceSubmit: true,
};

/** The two values that are minted per run, as fixed text. */
function normalise(argv: readonly string[]): string[] {
  const out = [...argv];
  for (const flag of ["--session-id", "--resume", "--system-prompt-file"]) {
    const at = out.indexOf(flag);
    if (at !== -1) out[at + 1] = flag === "--system-prompt-file" ? "<system-file>" : "<session>";
  }
  return out;
}

describe("the invocation the claude-cli transport builds", () => {
  it(
    "is the one recorded",
    async () => {
      const home = mkdtempSync(join(scratch, "home-"));
      const fake = fakeClaudeBinary({
        dir: scratch,
        structured: [
          { next: "read_files", read_paths: ["a/b.ts"], review: null },
          { next: "submit_review", read_paths: [], review: { ok: true } },
        ],
      });
      const model = claudeCliModel({
        submitSchema,
        binary: fake.path,
        env: { PATH: process.env.PATH ?? "", HOME: home },
      });
      await model.turn(first);
      await model.turn(second);
      await model.dispose();

      expectGolden(
        new URL("./claude-cli.golden.json", import.meta.url),
        fake.invocations().map((call) => ({
          argv: normalise(call.argv),
          stdin: call.stdin,
          system: call.system,
        })),
      );
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
