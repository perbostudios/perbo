import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiagnosticResultSchema, type DiagnosticResult } from "@perbo/contracts";
import type { PreflightResult } from "@perbo/runner";
import { afterAll, describe, expect, it } from "vitest";
import { doctorCommandLine } from "./index.js";
import { SPAWN_TEST_TIMEOUT_MS } from "../../test-support/spawn-timeout.js";
import { runCommandLine } from "../../command-line/terminal.js";
import type { Streams } from "../../streams.js";

/**
 * The CHECKS block: the pinned checks `perbo doctor` can see would read a
 * build tool's cache instead of the tree they are judging.
 *
 * turbo answers a task from its cache when the inputs the package declares have
 * not changed, so a check that runs turbo without `--force` can report a pass
 * for a run that never happened. The runner sets the flag on the argv it runs
 * and puts `TURBO_FORCE` in the environment; this block is the other half — a
 * configured check that says neither is named in the file a person maintains,
 * so it can be fixed there rather than only in the runner's memory.
 *
 * Advisory: it names something to change, and it never reaches the exit code.
 * Every case builds a real `.perbo/config.json` on disk and reads the answer
 * back out of the command's own output.
 */

const streams = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, human: sink(out, err, true), machine: sink(out, err, false) };
};

const sink = (out: string[], err: string[], isTTY: boolean): Streams => ({
  stdout: (chunk: string) => out.push(chunk),
  stderr: (chunk: string) => err.push(chunk),
  isTTY,
});

/** The line this diagnostic is asked for by: a repository, and the record or the reading. */
const doctorArgs = (repo: string, json: boolean): string[] => [
  "--repo",
  repo,
  ...(json ? ["--json"] : []),
];

/** A machine and a checkout that are both fine, so nothing else is in the report. */
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

afterAll(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A checkout with a lockfile and test scripts, and the configuration given. */
function repository(name: string, config: Record<string, unknown> | null): string {
  const dir = mkdtempSync(join(tmpdir(), `perbo-doctor-turbo-${name}-`));
  temporary.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      { name: "fixture", scripts: { typecheck: "turbo run typecheck", test: "turbo run test" } },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  if (config !== null) {
    mkdirSync(join(dir, ".perbo"), { recursive: true });
    writeFileSync(join(dir, ".perbo", "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  }
  return dir;
}

async function doctor(repo: string, json = false): Promise<{ text: string; code: number }> {
  const sinks = streams();
  const code = await runCommandLine(doctorCommandLine, {
    argv: doctorArgs(repo, json),
    streams: json ? sinks.machine : sinks.human,
    cwd: process.cwd(),
    deps: { preflight: () => machineReady, diagnose: () => Promise.resolve(materializable) },
  });
  return { text: sinks.out.join(""), code };
}

/** Every line under the CHECKS heading, or none where there is no block. */
function checksBlock(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("CHECKS"));
  if (start === -1) return [];
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    block.push(line.trim());
  }
  return block;
}

/**
 * The two lines the block always opens with (SCP-279): what judges a run here,
 * and what this repository runs on the pull request afterwards.
 *
 * `unknown` for the second in every case here, and asserted rather than
 * skipped over: the preflight these tests supply reports no GitHub credential,
 * so `doctor` does not ask GitHub and says which of the two unknowns that is.
 * A block that grew a line, or lost one, is a difference these cases see.
 */
const opening = (pinned: string, source: "proposed" | "configured"): string[] => [
  `pinned         ${pinned} (${source})`,
  "pull requests  unknown — `gh` reported no credential here, so GitHub was not asked",
];

/** The advisory lines under those, which is what these cases are about. */
const checkAdvisories = (text: string): string[] =>
  checksBlock(text).filter((line) => line.startsWith("advisory"));

interface CheckAdvisoryJson {
  check_id: string | null;
  name: string | null;
  command: string;
  flag: string;
  reason: string;
}

const advisoryJson = (text: string): CheckAdvisoryJson[] =>
  (JSON.parse(text) as { check_advisories: CheckAdvisoryJson[] }).check_advisories;

const turboCheck = (force: boolean) => ({
  check_id: "check_unit",
  name: "unit",
  kind: "unit",
  command: ["pnpm", "exec", "turbo", "run", "test", ...(force ? ["--force"] : [])],
  timeout_ms: 900_000,
  definition_path: "turbo.json",
});

const pythonCheck = {
  check_id: "check_docs",
  name: "docs",
  kind: "other",
  command: ["python3", "scripts/validate_docs.py"],
  timeout_ms: 300_000,
  definition_path: "scripts/validate_docs.py",
};

describe("perbo doctor, on a config whose turbo check does not say --force", () => {
  it("names the check and the flag, and says where to add it", async () => {
    const repo = repository("missing", { checks: [turboCheck(false), pythonCheck] });
    const { text, code } = await doctor(repo);

    // The whole block, so that a line appearing in it — or a malformed one —
    // is a difference this case sees rather than one it filters away.
    expect(checksBlock(text).slice(0, 2)).toEqual(opening("check_unit, check_docs", "configured"));
    expect(checksBlock(text)).toHaveLength(3);

    const advisories = checkAdvisories(text);
    expect(advisories, `no CHECKS advisory in:\n${text}`).toHaveLength(1);
    expect(advisories[0]).toContain("advisory");
    expect(advisories[0]).toContain("check_unit");
    expect(advisories[0]).toContain("--force");
    expect(advisories[0]).toContain("pnpm exec turbo run test");
    expect(advisories[0]).toContain(join(repo, ".perbo", "config.json"));
    // Advisory: the report says to change something and the command still
    // answers that this checkout is fine.
    expect(code).toBe(0);
  });

  it("emits the same finding under check_advisories, for a script to read", async () => {
    const repo = repository("missing-json", { checks: [turboCheck(false), pythonCheck] });
    const machine = await doctor(repo, true);

    const advisories = advisoryJson(machine.text);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]!.check_id).toBe("check_unit");
    expect(advisories[0]!.name).toBe("unit");
    expect(advisories[0]!.command).toBe("pnpm exec turbo run test");
    expect(advisories[0]!.flag).toBe("--force");
    expect(machine.code).toBe(0);
  });
}, SPAWN_TEST_TIMEOUT_MS);

describe("perbo doctor, on a config whose turbo check does say --force", () => {
  it("says nothing: there is nothing to change", async () => {
    const repo = repository("present", { checks: [turboCheck(true), pythonCheck] });
    const human = await doctor(repo);
    const machine = await doctor(repo, true);

    // The block holds the two lines it always holds, and nothing else: there
    // is no advisory here, and nothing has appeared in its place.
    expect(checksBlock(human.text)).toEqual(opening("check_unit, check_docs", "configured"));
    expect(advisoryJson(machine.text)).toEqual([]);
    expect(human.code).toBe(0);
  });
}, SPAWN_TEST_TIMEOUT_MS);

describe("perbo doctor, on a checkout with no configuration at all", () => {
  it("proposes no check the same report would then advise against", async () => {
    const repo = repository("proposed", null);
    const human = await doctor(repo);
    const machine = await doctor(repo, true);

    // The proposal is what a first run on this repository is judged by, so a
    // proposal this block would name would be the diagnostic contradicting
    // itself in one report.
    const proposed = (
      JSON.parse(machine.text) as { config: { proposed: { checks: Array<{ name: string }> } } }
    ).config.proposed.checks;
    expect(proposed.map((check) => check.name)).toEqual(["typecheck", "test"]);
    expect(advisoryJson(machine.text)).toEqual([]);
    expect(checksBlock(human.text)).toEqual(opening("check_typecheck, check_unit", "proposed"));
  });
}, SPAWN_TEST_TIMEOUT_MS);
