import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DiagnosticResultSchema, type DiagnosticResult } from "@perbo/contracts";
import { doctorCommandLine } from "./index.js";
import { runCommandLine } from "../../command-line/terminal.js";
import { recordStreams } from "../../test-support/streams.js";
import { gitEnvironment } from "@perbo/test-support";
import { emptyRepository } from "../../test-support/repository.js";

/**
 * SCP-200 criterion 2: `perbo doctor` says which credential path GitHub is
 * read through and whether it answers — and never the token.
 *
 * The machine is real here: the `gh` on PATH is a fake binary and the preflight
 * that finds it is the shipped one, because what is being checked is that
 * `doctor` asks at all on a run that is not publishing. Every test spawns, so
 * each declares its own deadline.
 */

const SPAWN_DEADLINE_MS = 20_000;

const scratch = mkdtempSync(join(tmpdir(), "perbo-doctor-github-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SENTINEL = "ghp_scp200doctorsentinelvalue";

/**
 * A `gh` on PATH that answers `--version`, and `auth status` by exit code —
 * and writes down every argument list it was called with, so a test can say
 * what was asked of GitHub as well as what came back.
 */
function fakeGh(name: string, authExit: number): { bin: string; calls: () => string[] } {
  const bin = join(scratch, `bin-${name}`);
  mkdirSync(bin, { recursive: true });
  const log = join(bin, "calls.log");
  const script = join(bin, "gh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      `if [ "$1" = "--version" ]; then echo "gh version 2.62.0 (fake)"; exit 0; fi`,
      `if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit ${authExit}; fi`,
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return {
    bin,
    calls: () => {
      try {
        return readFileSync(log, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

const materializable: DiagnosticResult = DiagnosticResultSchema.parse({
  materializable: true,
  findings: [],
  proposed: null,
});

/** The line this diagnostic is asked for by: a repository, and the record or the reading. */
const doctorArgs = (repo: string, json: boolean): string[] => [
  "--repo",
  repo,
  ...(json ? ["--json"] : []),
];

const originalPath = process.env.PATH;
const originalToken = process.env.GH_TOKEN;
const originalGithubToken = process.env.GITHUB_TOKEN;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = originalToken;
  if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalGithubToken;
});

const git = (dir: string, ...argv: string[]): string =>
  execFileSync("git", ["-C", dir, ...argv], { encoding: "utf8", env: gitEnvironment() });

/**
 * A checkout on `main` with one commit in it.
 *
 * A repository rather than a directory, because what is being read is a
 * repository: `doctor` reports the base a run here would land on, and SCP-279
 * reads the workflows **that ref carries** rather than whatever is lying in the
 * working tree. Nothing is committed here that the cases below do not commit.
 */
function repository(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  emptyRepository(dir);
  return dir;
}

/**
 * SCP-279: a `gh` that answers the two questions "does this repository run
 * anything on a pull request" is made of — the workflow list, and what the base
 * branch requires — beside the credential answers above.
 */
function fakeGhWithWorkflows(
  name: string,
  workflows: Array<{ name: string; path: string }>,
  /**
   * Where true, `workflow list` writes nothing at all and exits 0 — what
   * `gh --all` prints on a repository that has no workflow to list.
   */
  listsNothing = false,
): string {
  const bin = join(scratch, `bin-${name}`);
  mkdirSync(bin, { recursive: true });
  const listed = join(bin, "workflows.json");
  writeFileSync(
    listed,
    listsNothing ? "" : JSON.stringify(workflows.map((entry) => ({ ...entry, state: "active" }))),
  );
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `if [ "$1" = "--version" ]; then echo "gh version 2.62.0 (fake)"; exit 0; fi`,
      `if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi`,
      `if [ "$1" = "workflow" ] && [ "$2" = "list" ]; then cat ${JSON.stringify(listed)}; exit 0; fi`,
      'if [ "$1" = "api" ]; then',
      "  case \"$*\" in",
      "    *rules/branches*) printf '[]'; exit 0;;",
      '    *protection*) printf "gh: Not Found (HTTP 404)\\n" >&2; exit 1;;',
      "  esac",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

/** A workflow file on `main`, at the path the fake `gh` lists it under. */
function workflowFile(repo: string, path: string, on: string): void {
  workflowSource(repo, path, `name: CI\non:\n  ${on}:\n    branches: [main]\njobs: {}\n`);
}

/** The same, with the file's `on:` written however the case wants it. */
function workflowSource(repo: string, path: string, source: string): void {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), source);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", `workflow ${path}`);
}

/** The CHECKS block, from its heading to the blank line that ends it. */
function checksBlock(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("CHECKS"));
  if (start === -1) return [];
  const block = [lines[start]!];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    block.push(line);
  }
  return block;
}

describe("what `perbo doctor` reports about the checks on a pull request", () => {
  it(
    "says no, beside the pinned checks it proposes, where nothing triggers on one",
    async () => {
      const repo = repository("no-pr-workflow");
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ name: "fixture", packageManager: "pnpm@9.0.0", scripts: { test: "vitest run" } }),
      );
      workflowFile(repo, ".github/workflows/release.yml", "push");

      const text = await doctor(repo, {
        json: false,
        bin: fakeGhWithWorkflows("doctor-no-pr", [{ name: "Release", path: ".github/workflows/release.yml" }]),
        token: SENTINEL,
      });
      const block = checksBlock(text);

      // The answer, and the pinned checks it is printed beside.
      expect(block.join("\n")).toContain("pull requests");
      expect(block.find((line) => line.includes("pull requests"))).toContain("no —");
      expect(block.find((line) => line.includes("pinned"))).toContain("check_unit");
      expect(block.join("\n")).toContain("does not wait");
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "says no where the repository has no workflow and `gh` lists nothing",
    async () => {
      // Nothing is committed under `.github/workflows` here, so `gh workflow
      // list --all` writes nothing rather than `[]`. That is still an answer,
      // and `doctor` on this repository has to give it.
      const repo = repository("no-workflow-at-all");
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ name: "fixture", packageManager: "pnpm@9.0.0", scripts: { test: "vitest run" } }),
      );

      const text = await doctor(repo, {
        json: false,
        bin: fakeGhWithWorkflows("doctor-lists-nothing", [], true),
        token: SENTINEL,
      });
      const line = checksBlock(text).find((entry) => entry.includes("pull requests"));

      expect(line).toContain("no —");
      expect(line).toContain("does not wait");
      expect(line).not.toContain("unknown");
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "says yes where a workflow triggers on a pull request",
    async () => {
      const repo = repository("pr-workflow");
      workflowFile(repo, ".github/workflows/ci.yml", "pull_request");

      const text = await doctor(repo, {
        json: false,
        bin: fakeGhWithWorkflows("doctor-pr", [{ name: "CI", path: ".github/workflows/ci.yml" }]),
        token: SENTINEL,
      });
      const line = checksBlock(text).find((entry) => entry.includes("pull requests"));

      expect(line).toContain("yes —");
      expect(line).toContain(".github/workflows/ci.yml");
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "reads the `on:` a workflow actually wrote, in each spelling of it",
    async () => {
      // The quoted key with a flow sequence — the spelling a YAML linter pushes
      // people to, because YAML 1.1 reads a bare `on` as a boolean.
      const quoted = repository("quoted-on");
      workflowSource(
        quoted,
        ".github/workflows/ci.yml",
        `name: CI\n"on": [push, pull_request]  # both\njobs: {}\n`,
      );
      const quotedLine = checksBlock(
        await doctor(quoted, {
          json: false,
          bin: fakeGhWithWorkflows("doctor-quoted", [
            { name: "CI", path: ".github/workflows/ci.yml" },
          ]),
          token: SENTINEL,
        }),
      ).find((line) => line.includes("pull requests"));
      expect(quotedLine).toContain("yes —");

      // And the trap: a workflow that runs on a push to a branch *called*
      // `pull_request`. The event is `push`, and nothing here reports on a pull
      // request — a reader that scanned for the word would say the opposite.
      const trap = repository("branch-named-pr");
      workflowSource(
        trap,
        ".github/workflows/release.yml",
        `name: Release\non:\n  push:\n    branches: [pull_request]\njobs: {}\n`,
      );
      const trapLine = checksBlock(
        await doctor(trap, {
          json: false,
          bin: fakeGhWithWorkflows("doctor-trap", [
            { name: "Release", path: ".github/workflows/release.yml" },
          ]),
          token: SENTINEL,
        }),
      ).find((line) => line.includes("pull requests"));
      expect(trapLine).toContain("no —");
      expect(trapLine).toContain("does not wait");
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "carries the same answer in --json",
    async () => {
      const repo = repository("pr-workflow-json");
      workflowFile(repo, ".github/workflows/ci.yml", "pull_request");

      const text = await doctor(repo, {
        json: true,
        bin: fakeGhWithWorkflows("doctor-pr-json", [{ name: "CI", path: ".github/workflows/ci.yml" }]),
        token: SENTINEL,
      });
      const parsed = JSON.parse(text) as {
        checks: { pinned: string[]; pull_requests: { answered: boolean; runs_checks: boolean } };
      };

      expect(parsed.checks.pull_requests.answered).toBe(true);
      expect(parsed.checks.pull_requests.runs_checks).toBe(true);
    },
    SPAWN_DEADLINE_MS,
  );
});

async function doctor(
  repo: string,
  options: { json: boolean; bin: string; token: string | null },
): Promise<string> {
  process.env.PATH = `${options.bin}:${originalPath ?? ""}`;
  delete process.env.GITHUB_TOKEN;
  if (options.token === null) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = options.token;

  const streams = recordStreams({ isTTY: !options.json });
  await runCommandLine(doctorCommandLine, {
    argv: doctorArgs(repo, options.json),
    streams,
    cwd: process.cwd(),
    deps: { diagnose: () => Promise.resolve(materializable) },
  });
  return streams.out();
}

describe("what `perbo doctor` reports about the GitHub credential", () => {
  it(
    "names GH_TOKEN as the path and says it answers, without printing it",
    async () => {
      const text = await doctor(repository("token"), {
        json: false,
        bin: fakeGh("doctor-token", 0).bin,
        token: SENTINEL,
      });

      expect(text).toContain("GH_TOKEN");
      expect(text).toContain("answers");
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain(SENTINEL.slice(0, 8));
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "names `gh`'s stored login where there is no token",
    async () => {
      const text = await doctor(repository("login"), {
        json: false,
        bin: fakeGh("doctor-login", 0).bin,
        token: null,
      });

      expect(text).toContain("gh login");
      expect(text).toContain("answers");
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "says so when nothing answers, in the words a person can search for",
    async () => {
      const gh = fakeGh("doctor-none", 1);
      const repo = repository("none");
      workflowFile(repo, ".github/workflows/ci.yml", "pull_request");

      const text = await doctor(repo, { json: false, bin: gh.bin, token: null });

      expect(text).toContain("gh is not logged in");

      // And GitHub was asked nothing else. `doctor` is a local diagnostic with
      // one credential probe in it; a machine with no credential must not sit
      // through three more calls that can only end in the same `unknown`.
      const asked = gh.calls();
      expect(asked.some((call) => call.startsWith("auth status"))).toBe(true);
      expect(asked.filter((call) => call.startsWith("workflow list"))).toEqual([]);
      expect(asked.filter((call) => call.startsWith("api"))).toEqual([]);

      // The report says which of the two unknowns it is: not asked, rather
      // than asked and refused. A workflow that does trigger on a pull request
      // is in this checkout, and the answer is still `unknown` — because this
      // reading is `gh`'s and `gh` was not asked.
      const line = checksBlock(text).find((entry) => entry.includes("pull requests"));
      expect(line).toContain("unknown");
      expect(line).toContain("GitHub was not asked");
      expect(line).not.toContain("yes —");
      expect(line).not.toContain("no —");
    },
    SPAWN_DEADLINE_MS,
  );

  it(
    "carries the same answer in --json, and no token with it",
    async () => {
      const text = await doctor(repository("json"), {
        json: true,
        bin: fakeGh("doctor-json", 0).bin,
        token: SENTINEL,
      });
      const parsed = JSON.parse(text) as {
        preflight: { github: { credential: string; answers: boolean } | null };
      };

      expect(parsed.preflight.github).toEqual({ credential: "GH_TOKEN", answers: true });
      expect(text).not.toContain(SENTINEL);
    },
    SPAWN_DEADLINE_MS,
  );
});
