import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiagnosticResultSchema, type DiagnosticResult } from "@perbo/contracts";
import type { PreflightResult } from "@perbo/runner";
import { afterAll, describe, expect, it } from "vitest";
import { runDoctorCommand, type DoctorOptions } from "./index.js";
import { USAGE } from "../../command-line/usage.js";
import { SPAWN_TEST_TIMEOUT_MS } from "../../test-support/spawn-timeout.js";

/**
 * The CORPUS line: what `perbo doctor` says about the corpus cache this
 * checkout would review against.
 *
 * Every case here builds a real checkout on disk — a real cache directory with
 * real fixture directories and a real pin beside a real recorded score — and
 * reads the line back out of the command's own output. The two injections are
 * the ones every `doctor` test takes (the machine probe and the materialisation
 * walk, which spawn programs); nothing about the cache is doubled, because the
 * whole claim is that the command reads what is on the disk.
 */

const streams = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, human: sink(out, err, true), machine: sink(out, err, false) };
};

const sink = (out: string[], err: string[], isTTY: boolean): DoctorOptions["streams"] => ({
  stdout: (chunk: string) => out.push(chunk),
  stderr: (chunk: string) => err.push(chunk),
  isTTY,
});

const doctorArgs = (repo: string, json: boolean): DoctorOptions["args"] => ({
  ticket: null,
  store: null,
  contract: null,
  config: null,
  repo,
  worktreeRoot: null,
  publish: false,
  json,
  quiet: true,
  writeConfig: false,
  probe: false,
  resumeFrom: null,
  outcome: null,
  criteria: [],
  paths: [],
  pr: null,
  relevel: false,
});

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

const SCORED_COMMIT = "090513ce126699e5c5af08438f153eb0af7ae28a";
const OLDER_COMMIT = "4f97ca8cca99e2c0a42607733b2efbbd5ada062a";
const CACHE = ".local/corpus-cache";
const SCORE = "tooling/package/open-ci/regression-score.json";

/** Every checkout this file built, removed together once it has finished. */
const temporary: string[] = [];

afterAll(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, path: string, contents: string): void {
  const file = join(root, ...path.split("/"));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, contents);
}

/**
 * A checkout whose only variable is its corpus cache: the same recorded score
 * every time, and a cache that is missing, pinned to `pin`, or pinned to
 * nothing. `fixtures` are fixture directories, each carrying the computed
 * change a prepared fixture is read from; `clones/` is the shared clone pool
 * the harness keeps beside them, which is not a fixture.
 *
 * Every checkout is taken away once, after the whole file has run: nothing here
 * is deleted while a test could still be reading it. An `afterEach` over the
 * same shared list would do the same thing today and delete a neighbour's
 * checkout mid-test the day this file is run with concurrent tests, which is a
 * failure that would read as a defect in `doctor`.
 */
function checkout(
  name: string,
  cache: { pin?: string | null; fixtures?: string[] } | null,
  scored: string | null = SCORED_COMMIT,
): string {
  const dir = mkdtempSync(join(tmpdir(), `perbo-doctor-corpus-${name}-`));
  temporary.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  write(dir, SCORE, `${JSON.stringify({ corpus: { commit: scored, fixtures: 30 } }, null, 2)}\n`);
  if (cache !== null) {
    mkdirSync(join(dir, ...CACHE.split("/")), { recursive: true });
    if (cache.pin) {
      write(
        dir,
        `${CACHE}/corpus-pin.json`,
        `${JSON.stringify({ repository: "plantedbugs", commit: cache.pin }, null, 2)}\n`,
      );
    }
    for (const fixture of cache.fixtures ?? []) {
      write(dir, `${CACHE}/${fixture}/change.diff`, "--- a/x\n+++ b/x\n");
    }
    mkdirSync(join(dir, ...CACHE.split("/"), "clones", "github-com-vue"), { recursive: true });
  }
  return dir;
}

async function doctor(repo: string, json = false): Promise<{ text: string; code: number }> {
  const sinks = streams();
  const code = await runDoctorCommand({
    args: doctorArgs(repo, json),
    streams: json ? sinks.machine : sinks.human,
    cwd: process.cwd(),
    commands: ["doctor", "review", "run"],
    preflight: () => machineReady,
    diagnose: () => Promise.resolve(materializable),
  });
  return { text: sinks.out.join(""), code };
}

/**
 * The one line the report gives the corpus cache, read back from the rendered
 * text. Every line naming the cache is collected rather than the first, so a
 * report that says it twice fails here.
 */
function corpusLines(text: string): string[] {
  return text.split("\n").filter((line) => line.includes(CACHE));
}

function corpusLine(text: string): string {
  const lines = corpusLines(text);
  expect(lines, `expected exactly one corpus-cache line in:\n${text}`).toHaveLength(1);
  return lines[0]!;
}

function corpusJson(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as { corpus_cache: Record<string, unknown> };
  return parsed.corpus_cache;
}

describe("perbo doctor, on a checkout with no corpus cache", () => {
  it("says the cache is absent and names the command that fetches it", async () => {
    const { text, code } = await doctor(checkout("absent", null));

    const line = corpusLine(text);
    expect(line).toContain("absent");
    expect(line).toContain("perbo-corpus prepare");
    // The line is a warning: a machine that has never prepared the corpus can
    // still run everything `doctor` is otherwise reporting on.
    expect(code).toBe(0);
  });

  it("reports absent for a cache directory that holds no fixtures", async () => {
    const { text } = await doctor(checkout("empty", { fixtures: [] }));

    // The directory exists and there is nothing in it to review against, which
    // is the same fact and takes the same fix.
    expect(corpusLine(text)).toContain("absent");
    expect(corpusJson((await doctor(checkout("empty-json", { fixtures: [] }), true)).text)).toMatchObject({
      state: "absent",
      fixtures: 0,
    });
  });
}, SPAWN_TEST_TIMEOUT_MS);

describe("perbo doctor, on a cache pinned to the commit the score was measured against", () => {
  const fixtures = ["cln-011-trim-with-number-modifier", "reg-001-pause-tracking", "adv-002-hostile-agent"];

  it("names that commit and counts the fixtures the cache holds", async () => {
    const { text, code } = await doctor(checkout("present", { pin: SCORED_COMMIT, fixtures }));

    const line = corpusLine(text);
    expect(line).toContain(SCORED_COMMIT);
    // Three fixture directories, and the shared clone pool beside them is not
    // one of them.
    expect(line).toContain("3 fixtures");
    expect(line).not.toContain("absent");
    expect(line).not.toContain("behind");
    expect(code).toBe(0);
  });

  it("emits the same commit and count under corpus_cache", async () => {
    const { text } = await doctor(checkout("present-json", { pin: SCORED_COMMIT, fixtures }), true);

    expect(corpusJson(text)).toMatchObject({
      state: "present",
      cached_commit: SCORED_COMMIT,
      scored_commit: SCORED_COMMIT,
      fixtures: 3,
    });
  });
}, SPAWN_TEST_TIMEOUT_MS);

describe("perbo doctor, on a cache pinned to some other commit", () => {
  it("says behind, names both commits, and gives the same fix", async () => {
    const { text, code } = await doctor(
      checkout("behind", { pin: OLDER_COMMIT, fixtures: ["cln-011-trim-with-number-modifier"] }),
    );

    const line = corpusLine(text);
    expect(line).toContain("behind");
    expect(line).toContain(OLDER_COMMIT);
    expect(line).toContain(SCORED_COMMIT);
    expect(line).toContain("perbo-corpus prepare");
    expect(code).toBe(0);
  });
}, SPAWN_TEST_TIMEOUT_MS);

describe("the corpus-cache line is a warning and nothing else", () => {
  const fixtures = ["cln-011-trim-with-number-modifier"];

  it("leaves the exit code identical across absent, present and behind", async () => {
    const absent = await doctor(checkout("code-absent", null));
    const present = await doctor(checkout("code-present", { pin: SCORED_COMMIT, fixtures }));
    const behind = await doctor(checkout("code-behind", { pin: OLDER_COMMIT, fixtures }));

    // The three checkouts differ in nothing but their cache, so an exit code
    // that moved would have been moved by this line.
    expect([absent.code, present.code, behind.code]).toEqual([0, 0, 0]);
    expect(corpusLine(absent.text)).toContain("absent");
    expect(corpusLine(present.text)).toContain(SCORED_COMMIT);
    expect(corpusLine(behind.text)).toContain("behind");
  });

  it("carries the same three states as a field of the --json output", async () => {
    const cases = [
      ["absent", null],
      ["present", { pin: SCORED_COMMIT, fixtures }],
      ["behind", { pin: OLDER_COMMIT, fixtures }],
    ] as const;

    // One after another rather than in parallel: three `doctor` runs over three
    // checkouts prove nothing about each other, and running them at once only
    // buys a way for a failure to be about the ordering.
    const states: { state: unknown; code: number }[] = [];
    for (const [name, cache] of cases) {
      const { text, code } = await doctor(checkout(`json-${name}`, cache), true);
      states.push({ state: corpusJson(text)["state"], code });
    }

    expect(states).toEqual([
      { state: "absent", code: 0 },
      { state: "present", code: 0 },
      { state: "behind", code: 0 },
    ]);
  });
}, SPAWN_TEST_TIMEOUT_MS);

/**
 * `doctor` prints the line, so the help has to describe it. Asserted over
 * `USAGE` itself, the same way the help's account of standard input is.
 */
describe("what the help says about the corpus cache", () => {
  it("describes it", () => {
    const flat = USAGE.replace(/\\/g, "").replace(/\s+/g, " ");
    expect(flat).toContain(".local/corpus-cache");
    expect(flat).toContain("perbo-corpus");
    for (const state of ["absent", "behind", "commit"]) expect(flat).toContain(state);
    expect(flat).toContain("never moves the exit code");
  });
});

describe("perbo doctor, on a cache whose pin cannot be compared", () => {
  const fixtures = ["cln-011-trim-with-number-modifier"];

  it("reports a cache that records no commit as present, saying so", async () => {
    const { text } = await doctor(checkout("unpinned", { fixtures }));

    // Nothing here says the cache is behind, so the report does not say it is;
    // what it says instead is that the cache holds no commit to compare.
    const line = corpusLine(text);
    expect(line).not.toContain("behind");
    expect(line).toContain("1 fixture");
    expect(corpusJson((await doctor(checkout("unpinned-json", { fixtures }), true)).text)).toMatchObject({
      state: "present",
      cached_commit: null,
      scored_commit: SCORED_COMMIT,
    });
  });

  it("reports a cache as present where the score records no commit either", async () => {
    const repo = checkout("unscored", { pin: OLDER_COMMIT, fixtures }, null);

    expect(corpusJson((await doctor(repo, true)).text)).toMatchObject({
      state: "present",
      cached_commit: OLDER_COMMIT,
      scored_commit: null,
    });
  });
}, SPAWN_TEST_TIMEOUT_MS);
