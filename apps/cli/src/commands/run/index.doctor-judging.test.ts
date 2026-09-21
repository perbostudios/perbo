import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiagnosticResultSchema, type DiagnosticResult } from "@perbo/contracts";
import type { PreflightResult } from "@perbo/runner";
import { afterEach, describe, expect, it } from "vitest";
import { doctorCommandLine } from "./index.js";
import { readJudgingPaths } from "../../store/tickets.js";
import { SPAWN_TEST_TIMEOUT_MS } from "../../test-support/spawn-timeout.js";
import { runCommandLine } from "../../command-line/terminal.js";
import type { Streams } from "../../streams.js";

/**
 * The JUDGING block: what `perbo doctor` says judges an attempt in this store.
 *
 * A scope that overlaps one of these paths is refused at approval, and before
 * this block the only way to learn the list was to write a scope and be
 * refused. So the assertions here are on the block a person reads and on the
 * `--json` field a script reads, against a store on disk — the paths come from
 * a real `config.json` through the same reader approval refuses with, not from
 * a double.
 */

interface JudgingEntry {
  path: string | null;
  source: string;
  set: boolean;
}

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

/** A machine and a checkout that are both fine, so the exit code is about nothing else. */
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
  const dir = mkdtempSync(join(tmpdir(), `perbo-doctor-judging-${name}-`));
  temporary.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  if (config !== null) {
    mkdirSync(join(dir, ".perbo"), { recursive: true });
    writeFileSync(join(dir, ".perbo", "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  }
  return dir;
}

async function doctor(repo: string, json: boolean): Promise<{ text: string; code: number }> {
  const sinks = streams();
  const code = await runCommandLine(doctorCommandLine, {
    argv: doctorArgs(repo, json),
    streams: json ? sinks.machine : sinks.human,
    cwd: process.cwd(),
    deps: { preflight: () => machineReady, diagnose: () => Promise.resolve(materializable) },
  });
  return { text: sinks.out.join(""), code };
}

/**
 * The block as a reader takes it: the entries between the JUDGING heading and
 * the blank line that ends it, each as the label and the key beside it. Read
 * back from the rendered text rather than from the structure that produced it,
 * so a block that renders wrongly fails here.
 */
function judgingBlock(text: string): Array<{ label: string; source: string }> {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("JUDGING"));
  expect(start, `no JUDGING block in:\n${text}`).toBeGreaterThanOrEqual(0);
  const entries: Array<{ label: string; source: string }> = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    const match = /^ {2}(\S.*?) {2,}(\S+)$/.exec(line);
    if (match) entries.push({ label: match[1]!, source: match[2]! });
  }
  return entries;
}

/** The same pairs from the `--json` output, in the shape the block shows them. */
function judgingJson(text: string): { entries: JudgingEntry[]; pairs: Array<{ label: string; source: string }> } {
  const parsed = JSON.parse(text) as { judging_paths: JudgingEntry[] };
  return {
    entries: parsed.judging_paths,
    pairs: parsed.judging_paths.map((entry) => ({
      label: entry.path ?? (entry.set ? "(none)" : "(unset)"),
      source: entry.source,
    })),
  };
}

describe("perbo doctor, on a store that declares judging paths", () => {
  const config = {
    protected_paths: ["packages/policy/**"],
    protected_tests: ["packages/policy/test/rules.test.ts"],
  };

  it("names every judging path with the config key it came from", async () => {
    const repo = repository("declared", config);
    const { text, code } = await doctor(repo, false);

    // The three the reader used at approval, and no others: the block is the
    // list a scope will actually be refused against.
    expect(readJudgingPaths(join(repo, ".perbo"))).toEqual([
      { path: ".perbo/**", source: "store" },
      { path: "packages/policy/**", source: "protected_paths" },
      { path: "packages/policy/test/rules.test.ts", source: "protected_tests" },
    ]);
    expect(judgingBlock(text)).toEqual([
      { label: ".perbo/**", source: "store" },
      { label: "packages/policy/**", source: "protected_paths" },
      { label: "packages/policy/test/rules.test.ts", source: "protected_tests" },
    ]);
    expect(code).toBe(0);
  });

  it("emits the same paths under judging_paths, entry for entry", async () => {
    const repo = repository("declared-json", config);
    const human = await doctor(repo, false);
    const machine = await doctor(repo, true);

    const { entries, pairs } = judgingJson(machine.text);
    expect(pairs).toEqual(judgingBlock(human.text));
    expect(entries).toEqual([
      { path: ".perbo/**", source: "store", set: true },
      { path: "packages/policy/**", source: "protected_paths", set: true },
      { path: "packages/policy/test/rules.test.ts", source: "protected_tests", set: true },
    ]);
    expect(
      entries.flatMap((entry) => (entry.path === null ? [] : [{ path: entry.path, source: entry.source }])),
    ).toEqual(readJudgingPaths(join(repo, ".perbo")));
  });
}, SPAWN_TEST_TIMEOUT_MS);

describe("perbo doctor, on a store whose checks pin their definitions", () => {
  const check = (id: string, definition: string | null) => ({
    check_id: id,
    name: id.replace("check_", ""),
    kind: "other",
    command: ["python3", `scripts/${id}.py`],
    timeout_ms: 300_000,
    definition_path: definition,
  });

  const config = {
    checks: [
      check("check_typecheck", "turbo.json"),
      check("check_unit", "turbo.json"),
      check("check_docs", "scripts/validate_docs.py"),
      check("check_review", null),
    ],
    protected_paths: ["packages/policy/**"],
    protected_tests: ["packages/policy/test/rules.test.ts"],
  };

  it("lists each pinned check definition beside the check it belongs to", async () => {
    const repo = repository("checks", config);
    const { text, code } = await doctor(repo, false);

    // What approval refuses against: the pinned definitions alongside the
    // paths this store already protected, each still naming its owner.
    expect(readJudgingPaths(join(repo, ".perbo"))).toEqual([
      { path: ".perbo/**", source: "store" },
      { path: "packages/policy/**", source: "protected_paths" },
      { path: "packages/policy/test/rules.test.ts", source: "protected_tests" },
      // One file two checks are run from is one entry naming both; a check
      // that pins no definition contributes nothing to protect.
      { path: "turbo.json", source: "checks[check_typecheck,check_unit].definition_path" },
      { path: "scripts/validate_docs.py", source: "checks[check_docs].definition_path" },
    ]);
    expect(judgingBlock(text)).toEqual([
      { label: ".perbo/**", source: "store" },
      { label: "packages/policy/**", source: "protected_paths" },
      { label: "packages/policy/test/rules.test.ts", source: "protected_tests" },
      { label: "turbo.json", source: "checks[check_typecheck,check_unit].definition_path" },
      { label: "scripts/validate_docs.py", source: "checks[check_docs].definition_path" },
    ]);
    expect(code).toBe(0);
  });

  it("emits the pinned definitions under judging_paths too", async () => {
    const repo = repository("checks-json", config);
    const { entries } = judgingJson((await doctor(repo, true)).text);

    expect(entries).toEqual([
      { path: ".perbo/**", source: "store", set: true },
      { path: "packages/policy/**", source: "protected_paths", set: true },
      { path: "packages/policy/test/rules.test.ts", source: "protected_tests", set: true },
      { path: "turbo.json", source: "checks[check_typecheck,check_unit].definition_path", set: true },
      { path: "scripts/validate_docs.py", source: "checks[check_docs].definition_path", set: true },
    ]);
  });

  it("names a check with no usable id by its position, so its path is still listed", async () => {
    const repo = repository("checks-anonymous", {
      checks: [{ name: "docs", definition_path: "scripts/validate_docs.py" }],
    });
    const { entries } = judgingJson((await doctor(repo, true)).text);

    expect(entries).toContainEqual({
      path: "scripts/validate_docs.py",
      source: "checks[#0].definition_path",
      set: true,
    });
  });
}, SPAWN_TEST_TIMEOUT_MS);

describe("perbo doctor, on a store with no config.json", () => {
  it("reports the store alone and says both keys are unset, without erroring", async () => {
    const repo = repository("bare", null);
    const human = await doctor(repo, false);
    const machine = await doctor(repo, true);

    expect(human.code).toBe(0);
    expect(machine.code).toBe(0);
    expect(readJudgingPaths(join(repo, ".perbo"))).toEqual([{ path: ".perbo/**", source: "store" }]);

    // `.perbo/**` is the only path, and the two keys are present in the block
    // as unset rather than absent from it.
    expect(judgingBlock(human.text)).toEqual([
      { label: ".perbo/**", source: "store" },
      { label: "(unset)", source: "protected_paths" },
      { label: "(unset)", source: "protected_tests" },
    ]);
    const { entries, pairs } = judgingJson(machine.text);
    expect(pairs).toEqual(judgingBlock(human.text));
    expect(entries).toEqual([
      { path: ".perbo/**", source: "store", set: true },
      { path: null, source: "protected_paths", set: false },
      { path: null, source: "protected_tests", set: false },
    ]);
  });

  it("distinguishes a key that is set and lists nothing from one that is unset", async () => {
    const repo = repository("empty-key", { protected_paths: [] });
    const { text } = await doctor(repo, true);

    // An empty list is a decision; a missing key is not. Reporting both as
    // "unset" would tell a person to go and set what they already set.
    expect(judgingJson(text).entries).toEqual([
      { path: ".perbo/**", source: "store", set: true },
      { path: null, source: "protected_paths", set: true },
      { path: null, source: "protected_tests", set: false },
    ]);
    expect(judgingBlock((await doctor(repo, false)).text)).toEqual([
      { label: ".perbo/**", source: "store" },
      { label: "(none)", source: "protected_paths" },
      { label: "(unset)", source: "protected_tests" },
    ]);
  });
}, SPAWN_TEST_TIMEOUT_MS);
