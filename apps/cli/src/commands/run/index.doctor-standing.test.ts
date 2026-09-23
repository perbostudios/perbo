import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiagnosticResultSchema, type DiagnosticResult, type StandingProhibitedEntry } from "@perbo/contracts";
import type { PreflightResult } from "@perbo/runner";
import { afterEach, describe, expect, it } from "vitest";
import { doctorCommandLine } from "./index.js";
import { runCommandLine } from "../../command-line/terminal.js";
import { recordStreams } from "../../test-support/streams.js";

/** The line this diagnostic is asked for by: a repository, and the record or the reading. */
const doctorArgs = (repo: string, json: boolean): string[] => [
  "--repo",
  repo,
  ...(json ? ["--json"] : []),
];

const machineReady: PreflightResult = {
  ok: true,
  findings: [],
  tools: { node: { present: true, version: process.versions.node } },
  github: null,
};
const materializable: DiagnosticResult = DiagnosticResultSchema.parse({
  materializable: true,
  findings: [],
  proposed: null,
});

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repository(name: string, config: Record<string, unknown> | null): string {
  const dir = mkdtempSync(join(tmpdir(), `perbo-doctor-standing-${name}-`));
  temporary.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  if (config !== null) {
    mkdirSync(join(dir, ".perbo"), { recursive: true });
    writeFileSync(join(dir, ".perbo", "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  }
  return dir;
}

async function doctor(repo: string, json: boolean): Promise<string> {
  const sinks = recordStreams({ isTTY: !json });
  await runCommandLine(doctorCommandLine, {
    argv: doctorArgs(repo, json),
    streams: sinks,
    cwd: process.cwd(),
    deps: { preflight: () => machineReady, diagnose: () => Promise.resolve(materializable) },
  });
  return sinks.out();
}

/** The block a reader takes: the lines between the PROHIBITED heading and the blank line after it. */
function prohibitedBlock(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("PROHIBITED"));
  expect(start, `no PROHIBITED block in:\n${text}`).toBeGreaterThanOrEqual(0);
  const entries: string[] = [];
  for (const line of lines.slice(start + 2)) {
    if (line.trim() === "") break;
    entries.push(line.trim().replace(/\s{2,}/g, " "));
  }
  return entries;
}

describe("perbo doctor reports the standing prohibited list", () => {
  it("names each entry with the draft that added it", async () => {
    const repo = repository("declared", {
      paths_prohibited: [
        {
          path: "packages/app/src/generated/**",
          draft: "b7b0f3e2-0000-4000-8000-000000000001",
          source: "PRB-9",
          added_at: "2026-09-12T10:00:00.000Z",
        },
        "specs/**",
      ],
    });
    expect(prohibitedBlock(await doctor(repo, false))).toEqual([
      "packages/app/src/generated/** PRB-9",
      "specs/** written in .perbo/config.json",
    ]);
  });

  it("says the list is empty rather than leaving the block out", async () => {
    const repo = repository("absent", { protected_tests: [] });
    expect(prohibitedBlock(await doctor(repo, false))).toEqual(["(none)"]);
  });

  it("emits the same entries under standing_prohibited for a script", async () => {
    const repo = repository("json", { paths_prohibited: ["specs/**"] });
    const parsed = JSON.parse(await doctor(repo, true)) as {
      standing_prohibited: StandingProhibitedEntry[];
    };
    expect(parsed.standing_prohibited).toEqual([
      { path: "specs/**", draft: null, source: "written in .perbo/config.json", added_at: null },
    ]);
  });
});
