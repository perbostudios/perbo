import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { readClaudeModels } from "./catalog.js";

// The package's setup stubs this reader for every other test; here it is the subject.
vi.unmock("./catalog.js");

/**
 * Claude Code's catalog as `doctor` reads it: one `initialize` control
 * request, answered with the models Claude Code offers, each by the model it
 * resolves to. A fake binary stands in for `claude`; what is under test is the
 * exchange, not the model.
 */
const scratch = mkdtempSync(join(tmpdir(), "perbo-catalog-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A `claude` that records the argv and the first line it is sent, then answers as `answer` says. */
function fakeClaude(name: string, answer: "catalog" | "silent"): { bin: string; sent: () => { argv: string[]; line: unknown } } {
  const bin = join(scratch, name);
  const record = join(scratch, `${name}.json`);
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf("\\n");
  if (newline === -1) return;
  writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), line: JSON.parse(buffer.slice(0, newline)) }));
  if (${JSON.stringify(answer)} === "silent") return;
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "catalog", response: { models: [
    { value: "default", resolvedModel: "claude-opus-5-5" },
    { value: "opus", resolvedModel: "claude-opus-5-5" },
    { value: "claude-fable-5-1", resolvedModel: "claude-fable-5-1" },
    { value: "claude-opus-5" },
  ] } } }) + "\\n");
});
setInterval(() => {}, 1000);
`,
  );
  chmodSync(bin, 0o755);
  return { bin, sent: () => JSON.parse(readFileSync(record, "utf8")) as { argv: string[]; line: unknown } };
}

describe("reading Claude Code's catalog", () => {
  it("asks with one initialize and nothing else, and reads each row by the model it resolves to", async () => {
    const fake = fakeClaude("answers", "catalog");
    expect(await readClaudeModels(fake.bin)).toEqual(["claude-opus-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-opus-5"]);
    const { argv, line } = fake.sent();
    expect(line).toEqual({
      type: "control_request",
      request_id: "catalog",
      request: { subtype: "initialize", hooks: {}, agents: {}, skills: [] },
    });
    // Nothing a repository or a user configured runs, and no tool is offered.
    for (const flag of ["--safe-mode", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"])
      expect(argv).toContain(flag);
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
  });

  it("gives up on a CLI that never answers", async () => {
    const fake = fakeClaude("silent", "silent");
    await expect(readClaudeModels(fake.bin, 1500)).rejects.toThrow(/did not report its models in time/);
  });

  it("refuses a binary that is not there", async () => {
    await expect(readClaudeModels(join(scratch, "missing"))).rejects.toThrow();
  });
});
