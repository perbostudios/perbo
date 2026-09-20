import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { preflight, type PreflightRequest } from "@perbo/runner";
import { parseReviewArgs } from "../src/commands/review/index.js";
import { FULL_COMMAND_SET, parseExecuteArgs, runDoctorCommand } from "../src/commands/run/index.js";
import { buildCli, removeStagedBundles, spawnBuilt } from "../src/test-support/open-build.js";
import { REPO_ROOT } from "../src/test-support/paths.js";

/**
 * The open README's quick start, run rather than read.
 *
 * The README is the only instruction a person gets on a fresh clone, and a
 * README nobody executes drifts from the program silently: a flag is renamed, a
 * command grows a required argument, and the document goes on describing the
 * version that worked. So the commands are **extracted from the README's own
 * text** — the fenced blocks under its quick-start heading, in the order they
 * appear — and then parsed by the CLI's own parsers and run, in that order,
 * against a scratch repository. A step naming a flag or a subcommand this build
 * does not implement fails here, and the failure names the step.
 *
 * Nothing paid and nothing published: the model is a replay binary on PATH,
 * standing in for the `claude` the quick start's default provider names — it
 * answers the executor's stream with the two files the README's outcome asks
 * for, and the reviewer's turn with a verdict over the criteria it was given —
 * and `gh` is a stub that records every argv it is handed and answers `pr
 * create` with a URL. The push is real, to a bare repository beside the scratch
 * one, because a push that is hooked away cannot fail the way a real one does.
 * Everything between those three is the shipped program.
 *
 * Two of the quick start's steps are not run: `pnpm install` and the workspace
 * build. This suite is already running inside an installed workspace, and a
 * second install would need the network. They are checked instead — the scripts
 * they name must exist in the manifests this tree ships — and the build they ask
 * for is done by `buildCli()`, the same compile every other open-build suite
 * uses, whose output the README's `node apps/cli/dist/<file>.js` path is
 * resolved against. A README naming a built file that compile does not produce
 * fails here too.
 */

/** The repository's README, whose quick start this file checks against the CLI. */
function openReadmePath(): string {
  const readme = join(REPO_ROOT, "README.md");
  if (existsSync(readme)) return readme;
  throw new Error(`no README at ${readme}`);
}

const QUICK_START_HEADING = "## Quick start";

/** The quick-start section: its heading down to the next `## ` heading. */
function quickStart(text: string): string {
  const start = text.indexOf(QUICK_START_HEADING);
  expect(start, `the open README has no "${QUICK_START_HEADING}" section`).not.toBe(-1);
  const end = text.indexOf("\n## ", start + 1);
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

/** What a reader has read before the first command: the section's prose. */
function beforeTheFirstCommand(section: string): string {
  const fence = section.indexOf("```");
  expect(fence, "the quick start runs no command at all").not.toBe(-1);
  return section.slice(0, fence);
}

interface Step {
  /** Its position in the quick start, counting from one, for a failure to name. */
  position: number;
  /** The command as the README writes it, continuations joined. */
  text: string;
  argv: string[];
}

/**
 * Every command the quick start's fenced blocks hold, in order.
 *
 * A `\`-continued line is one command; a blank line separates two. Nothing here
 * understands pipes, redirection or variables — a quick start that needed one
 * would not be a quick start, and this would rather fail than half-read it.
 */
function steps(section: string): Step[] {
  const found: Step[] = [];
  for (const block of section.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    for (const line of block[1]!.replace(/\\\n\s*/g, " ").split("\n")) {
      const text = line.trim();
      if (text === "" || text.startsWith("#")) continue;
      expect(
        text,
        `quick-start step ${found.length + 1} uses shell syntax this test does not read`,
      ).not.toMatch(/[|&;><$`]/);
      found.push({ position: found.length + 1, text, argv: words(text) });
    }
  }
  expect(found.length, "the quick start runs no command at all").toBeGreaterThan(0);
  return found;
}

/** A command line's words, with `"` and `'` quoting as a shell reads them. */
function words(command: string): string[] {
  const found: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let open = false;
  for (const character of command) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      open = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (current !== "" || open) found.push(current);
      current = "";
      open = false;
      continue;
    }
    current += character;
  }
  if (quote !== null) throw new Error(`unbalanced quote in: ${command}`);
  if (current !== "" || open) found.push(current);
  return found;
}

/** The `apps/cli/dist/<file>.js` a step invokes, or null where it invokes no CLI. */
function invokedBinary(step: Step): string | null {
  if (step.argv[0] !== "node") return null;
  const script = step.argv[1] ?? "";
  return /^apps\/cli\/dist\/[\w.-]+\.js$/.test(script) ? script : null;
}

/**
 * The parsers the CLI itself uses, by command. A quick-start step is checked by
 * the parser its command is dispatched with, so "this flag exists" is answered
 * by the program rather than by a list kept here — and a command with no entry
 * fails rather than being waved through, because a step nothing checked is the
 * drift this file exists to catch.
 */
const PARSERS: Record<string, (argv: string[]) => unknown> = {
  run: parseExecuteArgs,
  doctor: parseExecuteArgs,
  review: parseReviewArgs,
};

/**
 * One step read against the CLI: the command has to be one this build
 * dispatches and every flag one its parser takes. Throws naming the step, so
 * the failure says which line of the README to fix.
 */
function checkAgainstTheCli(step: Step): void {
  const script = invokedBinary(step);
  if (script === null) return;
  const rest = step.argv.slice(2);
  const command = rest[0] ?? "";
  const named = (why: string): Error =>
    new Error(`quick-start step ${step.position} — \`${step.text}\` — ${why}`);
  if (!FULL_COMMAND_SET.includes(command as (typeof FULL_COMMAND_SET)[number])) {
    throw named(
      `names \`${command}\`, which \`perbo\` does not dispatch (it has: ${FULL_COMMAND_SET.join(", ")})`,
    );
  }
  const parse = PARSERS[command];
  if (!parse) {
    throw named(
      `runs \`${command}\`, which this test has no parser registered for; add one to PARSERS so ` +
        "the step is checked rather than assumed",
    );
  }
  try {
    parse(rest.slice(1));
  } catch (error) {
    throw named(`is refused by \`${command}\`'s own parser: ${(error as Error).message}`);
  }
}

/**
 * The whole of what this file's first assertion does, as one function over a
 * README's text: take the quick start's steps out of the document and read each
 * one against the CLI.
 *
 * The controls below run *this* over a mutated copy of the same document, so
 * what they prove refuses is the check the README is really held to, extraction
 * included — not a step built by hand that never went through the README.
 */
function checkQuickStart(text: string): Step[] {
  const found = steps(quickStart(text));
  for (const step of found) checkAgainstTheCli(step);
  return found;
}

/** The message {@link checkQuickStart} refused a README with, or a failure saying it did not. */
function refusalOf(text: string): string {
  try {
    checkQuickStart(text);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("the quick start was read against the CLI and nothing was refused");
}

/**
 * The open README with one quick-start step changed, and the step it changed.
 *
 * The edit is made in the document — `find` is replaced where the quick-start
 * section holds it — and the steps are then extracted from the mutated text the
 * ordinary way, so the step handed back is one the README really produced. The
 * changed step is found by comparing against the unmutated extraction position
 * by position, which needs nothing planted in the replacement to recognise it.
 */
function withOneStepMutated(find: string, replace: string): { text: string; step: Step } {
  const at = section.indexOf(find);
  expect(at, `the quick start holds no \`${find}\` to mutate`).not.toBe(-1);
  const from = readme.indexOf(QUICK_START_HEADING) + at;
  const text = readme.slice(0, from) + replace + readme.slice(from + find.length);
  const after = steps(quickStart(text));
  expect(after.length, "the mutation changed how many commands the quick start runs").toBe(
    quickStartSteps.length,
  );
  const changed = after.filter((step, index) => step.text !== quickStartSteps[index]!.text);
  expect(changed.length, `replacing \`${find}\` with \`${replace}\` changed no step`).toBe(1);
  return { text, step: changed[0]! };
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "perbo-readme-")));

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const git = (dir: string, ...argv: string[]): string =>
  execFileSync("git", ["-C", dir, ...argv], { encoding: "utf8", env: gitEnv });

/**
 * The repository the quick start is pointed at: one commit, a `test` script the
 * loop will pin as its check, `src/` and `test/` for the scope the README
 * names, no `.perbo/` at all — and a bare repository as `origin`, so the
 * publish step's push is a push and not a stub.
 */
function repository(name: string): string {
  const dir = realpathSync(mkdtempSync(join(scratch, `${name}-`)));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: gitEnv });
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@t.invalid");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      { name: "quickstart-fixture", private: true, scripts: { test: 'node -e "process.exit(0)"' } },
      null,
      2,
    )}\n`,
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "src", "index.js"), "export const version = 1;\n");
  writeFileSync(join(dir, "test", "index.test.js"), "// the suite this repository already has\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  const bare = mkdtempSync(join(scratch, `${name}-remote-`));
  execFileSync("git", ["init", "-q", "--bare", bare], { env: gitEnv });
  git(dir, "remote", "add", "origin", bare);
  git(dir, "push", "-q", "origin", "main");
  return dir;
}

/**
 * The replay model: one binary standing in for the `claude` the quick start's
 * default provider names, answering both roles it plays.
 *
 * The executor invocation is the one asking for `stream-json`, and it answers
 * with the two files the README's outcome and criterion describe, written where
 * the runner will seal them. The reviewer invocation is the one asking for
 * `json`, and it answers with a verdict over exactly the criteria it was given
 * — read out of the system prompt it was handed rather than assumed, so a
 * contract minted with different ids is covered rather than rejected.
 */
function replayModel(): string {
  const dir = mkdtempSync(join(scratch, "model-"));
  const binary = join(dir, "claude");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
"use strict";
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("replay-model 1.0.0 (Claude Code)\\n");
  process.exit(0);
}

const format = argv[argv.indexOf("--output-format") + 1];

if (format === "stream-json") {
  const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  emit({
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    mcp_servers: [],
    plugins: [],
    skills: [],
    agents: [],
    memory_paths: null,
  });
  const written = [
    {
      file_path: "src/unslug.js",
      content: "export const unslug = (slug) => slug.split('-').join(' ');\\n",
    },
    {
      file_path: "test/unslug.test.js",
      content:
        "import { unslug } from '../src/unslug.js';\\n" +
        "if (unslug('hello-world') !== 'hello world') throw new Error('unslug');\\n",
    },
  ];
  written.forEach((input, index) => {
    emit({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "toolu_replay_" + index, name: "Write", input }],
        usage: { input_tokens: 9, output_tokens: 3 },
      },
    });
    const path = join(process.cwd(), input.file_path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, input.content);
  });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: 0.004,
    permission_denials: [],
  });
  process.exit(0);
}

// The reviewer's turn. The prompt arrives on stdin and the criteria are in the
// system prompt this invocation names; both are read, and the verdict covers
// every criterion id they hold.
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  const systemPromptFile = argv[argv.indexOf("--system-prompt-file") + 1];
  let system = "";
  try {
    system = readFileSync(systemPromptFile, "utf8");
  } catch {
    system = "";
  }
  const ids = [...new Set([...(stdin + system).matchAll(/\\bac_[0-9A-Za-z_-]+\\b/g)].map((m) => m[0]))];
  const coverage = ids.map((id) => ({
    criterion_id: id,
    status: "met",
    verification_strength: "directly_verified",
    evidence_type: "test_result",
    evidence_ref: null,
    evidence_assertion: "unslug('hello-world') !== 'hello world' throws",
    evidence_file: "test/unslug.test.js",
    evidence_line: 2,
    evidence_symbol: null,
    note: null,
    closure: "none",
  }));
  process.stdout.write(
    JSON.stringify({
      is_error: false,
      session_id: "replay",
      stop_reason: "tool_use",
      total_cost_usd: 0.02,
      usage: {
        input_tokens: 11,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      structured_output: {
        next: "submit_review",
        read_paths: [],
        review: {
          coverage,
          findings: [],
          check_assertions: [],
          overall_confidence: 0.9,
        },
      },
    }) + "\\n",
  );
  process.exit(0);
});
`,
    { mode: 0o755 },
  );
  chmodSync(binary, 0o755);
  return dir;
}

/**
 * A PATH directory offering one name: `node`, this one, as a symlink.
 *
 * The replay model above is a `#!/usr/bin/env node` script, so its interpreter
 * has to be findable — but `dirname(process.execPath)` is also where npm keeps
 * its global binaries, and on a machine where Claude Code is installed that way
 * a real `claude` sits beside `node` and would answer, for a case that is
 * asking about a machine with no coding agent on it at all. A directory holding
 * only the symlink offers the one name that is wanted and nothing else.
 */
function nodeInterpreterDir(): string {
  const dir = mkdtempSync(join(scratch, "node-"));
  symlinkSync(process.execPath, join(dir, "node"));
  return dir;
}

/**
 * A PATH directory offering one name: `npm`, the one that ships beside this
 * Node, as a symlink — for the same reason as above, rather than the directory
 * it sits in. The scratch repository is an npm package, so npm is what its
 * worktree installs with.
 */
function packageManagerDir(): string {
  const npm = join(dirname(process.execPath), "npm");
  expect(existsSync(npm), `no npm beside ${process.execPath}`).toBe(true);
  const dir = mkdtempSync(join(scratch, "npm-"));
  symlinkSync(npm, join(dir, "npm"));
  return dir;
}

/** The URL the stubbed `gh` answers `pr create` with. */
const PULL_REQUEST_URL = "https://github.com/owner/repository/pull/41";

interface Gh {
  /** The directory to put on PATH. */
  dir: string;
  /** Every argv it was given, in order. */
  calls: () => string[][];
}

/**
 * A `gh` on PATH that records every argv, answers `auth status` (the login the
 * README asks for), answers `pr create` with {@link PULL_REQUEST_URL}, and
 * fails `pr view`: there is no pull request on the branch yet, which is what
 * sends delivery to `create`.
 */
function stubbedGh(name: string, options: { loggedIn?: boolean } = {}): Gh {
  const dir = join(scratch, `gh-${name}`);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "argv");
  writeFileSync(log, "");
  const script = join(dir, "gh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `{ for a in "$@"; do printf '%s\\n' "$a"; done; printf 'END\\n'; } >> ${log}`,
      'if [ "$1" = "--version" ]; then echo "gh version 2.63.0 (stub)"; exit 0; fi',
      'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
      options.loggedIn === false
        ? '  echo "You are not logged into any GitHub hosts." >&2; exit 1'
        : '  echo "github.com: logged in"; exit 0',
      "fi",
      'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
      `  echo "${PULL_REQUEST_URL}"`,
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return {
    dir,
    calls: () =>
      readFileSync(log, "utf8")
        .split("END\n")
        .filter((block) => block.length > 0)
        .map((block) => block.split("\n").slice(0, -1)),
  };
}

/** What `--base` (or any flag) was given in an argv. */
const valueOf = (argv: readonly string[], flag: string): string | null => {
  const at = argv.indexOf(flag);
  return at === -1 ? null : (argv[at + 1] ?? null);
};

let readme: string;
let section: string;
/** apps/cli/README.md's own "## Quick start" section, where the doctor prerequisites are documented. */
let cliReadmeSection: string;
let quickStartSteps: Step[];
let compiled: string;
let repo: string;
let home: string;
let model: string;
let nodeOnPath: string;
let npmOnPath: string;

beforeAll(() => {
  readme = readFileSync(openReadmePath(), "utf8");
  section = quickStart(readme);
  cliReadmeSection = quickStart(readFileSync(join(REPO_ROOT, "apps", "cli", "README.md"), "utf8"));
  quickStartSteps = steps(section);
  // The build the quick start's second step asks for, done the way every other
  // open-build suite does it (see open-build.ts on why never `apps/cli/dist`).
  compiled = buildCli();
  repo = repository("checkout");
  home = mkdtempSync(join(scratch, "home-"));
  model = replayModel();
  nodeOnPath = nodeInterpreterDir();
  npmOnPath = packageManagerDir();
}, 300_000);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  removeStagedBundles();
});

/** The Node major this workspace requires, from the `engines` the README cites. */
function requiredNodeMajor(): number {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    engines?: { node?: string };
  };
  const declared = manifest.engines?.node ?? "";
  const major = /(\d+)/.exec(declared)?.[1];
  expect(major, `the workspace manifest declares no Node version (engines.node: ${declared})`).toBeDefined();
  return Number(major);
}

describe("the open README's quick start, read against the CLI", () => {
  it("names only commands and flags this build implements", () => {
    checkQuickStart(readme);
    // Vacuous with nothing to read: at least one step has to be a CLI call.
    expect(quickStartSteps.filter((step) => invokedBinary(step) !== null).length).toBeGreaterThan(0);
  });

  it("fails, naming the step, on a quick-start step given a flag the CLI does not have", () => {
    // The control for the assertion above, and it is the README that is
    // mutated: the loop's own step is given a flag `run` does not take, the
    // steps are extracted from that document, and the same check has to refuse
    // — naming the step by its position and quoting the command a person would
    // go and fix.
    const { text, step } = withOneStepMutated("main.js run", "main.js run --publish-now");
    const message = refusalOf(text);
    expect(message).toContain(`quick-start step ${step.position}`);
    expect(message).toContain(step.text);
    expect(message).toContain("--publish-now");
    // And the document it was mutated from is still read without a refusal, so
    // the failure above is the flag rather than anything else in the README.
    expect(() => checkQuickStart(readme)).not.toThrow();
  });

  it("fails, naming the step, on a quick-start step naming a subcommand the CLI does not dispatch", () => {
    const { text, step } = withOneStepMutated("main.js run", "main.js frobnicate");
    const message = refusalOf(text);
    expect(message).toContain(`quick-start step ${step.position}`);
    expect(message).toContain(step.text);
    expect(message).toMatch(/frobnicate.*does not dispatch/s);
  });

  it("builds the file its own invocations name", () => {
    for (const step of quickStartSteps) {
      const script = invokedBinary(step);
      if (script === null) continue;
      const built = join(compiled, script.slice("apps/cli/dist/".length));
      expect(existsSync(built), `${step.text}: the build produces no ${script}`).toBe(true);
    }
  });

  it("asks only for workspace scripts this tree declares", () => {
    for (const step of quickStartSteps) {
      if (step.argv[0] !== "pnpm") continue;
      // `pnpm exec turbo run <task>` and `pnpm run <script>` both name
      // something the workspace has to declare; `pnpm install` names nothing.
      const task =
        step.argv[1] === "exec" && step.argv[2] === "turbo" && step.argv[3] === "run"
          ? step.argv[4]
          : step.argv[1] === "run"
            ? step.argv[2]
            : null;
      if (task === null) {
        expect(step.argv[1], `${step.text}: this test reads only install, run and exec turbo run`).toBe(
          "install",
        );
        continue;
      }
      const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      const cli = JSON.parse(readFileSync(join(REPO_ROOT, "apps", "cli", "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      expect(Object.keys(root.scripts ?? {}), `${step.text}: the workspace declares no ${task}`).toContain(
        task,
      );
      expect(Object.keys(cli.scripts ?? {}), `${step.text}: apps/cli declares no ${task}`).toContain(task);
    }
  });
});

describe("the prerequisites the quick start states before its first command", () => {
  it("names the Node version, the package manager, the provider credential and the gh login", () => {
    // apps/cli/README.md's own quick start carries this prose; the root
    // README's quick start is the short, customer-facing one and only runs
    // the commands themselves (checked above).
    const stated = beforeTheFirstCommand(cliReadmeSection);
    expect(stated).toMatch(new RegExp(`Node\\s+${requiredNodeMajor()}\\b`));
    // What a worktree is installed with, and the reason `doctor` gives when it
    // cannot be run.
    expect(stated).toMatch(/package manager/);
    expect(stated).toMatch(/install_binary_missing/);
    expect(stated).toMatch(/gh auth login/);
    // The default provider is the locally installed agent; the other is a key.
    expect(stated).toMatch(/claude/);
    expect(stated).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("doctor exits zero on a machine that has all four", () => {
    // The control the cases below are read against: the same command, on the
    // same kind of scratch repository, with the coding agent and npm on PATH and
    // a `gh` that answers its login, exits zero and blocks on nothing. So a
    // non-zero exit there is the prerequisite that was taken away, not the
    // fixture.
    const ran = doctor(repository("ready"), stubbedGh("ready").dir);
    expect(
      ran.findings.filter((finding) => finding.severity === "blocking"),
      ran.stdout,
    ).toEqual([]);
    expect(ran.status, ran.stdout).toBe(0);
  }, 120_000);

  it("doctor refuses, naming the Node floor and the version it found", async () => {
    // The running Node cannot be made older, so the floor is what moves: the
    // shipped preflight, told a floor this machine does not meet, through the
    // shipped `doctor`. What the README states the floor *is* is checked
    // against the workspace's own `engines` above.
    const out: string[] = [];
    const status = await runDoctorCommand({
      args: parseExecuteArgs(["--repo", repo]),
      streams: { stdout: (chunk) => out.push(chunk), stderr: () => undefined, isTTY: true },
      cwd: repo,
      preflight: (request: PreflightRequest) =>
        preflight({ ...request, minNodeMajor: Number(process.versions.node.split(".")[0]) + 1 }),
    });
    // eslint-disable-next-line no-control-regex
    const shown = out.join("").replace(/\u001b\[[0-9;]*m/g, "");
    expect(shown).toContain("node_too_old");
    expect(shown).toContain(process.versions.node);
    expect(shown).toContain("install Node");
    // The exit code a script reads, and not only the words a person does.
    expect(status, shown).not.toBe(0);
  }, 120_000);

  it("doctor refuses, naming the gh login, when nothing answers for it", () => {
    const gh = stubbedGh("logged-out", { loggedIn: false });
    const ran = doctor(repository("logged-out"), gh.dir);
    const said = ran.reason("gh_not_authenticated");
    expect(said?.severity, ran.stdout).toBe("blocking");
    expect(said?.fix).toContain("gh auth login");
    expect(ran.status, ran.stdout).not.toBe(0);
  }, 120_000);

  it("doctor refuses, naming the provider credential, when the configured provider has none", () => {
    const configured = repository("no-key");
    mkdirSync(join(configured, ".perbo"), { recursive: true });
    writeFileSync(
      join(configured, ".perbo", "config.json"),
      `${JSON.stringify({ reviewer_provider: "anthropic" }, null, 2)}\n`,
    );
    const ran = doctor(configured, stubbedGh("no-key").dir);
    const said = ran.reason("reviewer_credential_missing");
    expect(said?.detail, ran.stdout).toContain("ANTHROPIC_API_KEY");
    expect(said?.severity, ran.stdout).toBe("blocking");
    expect(ran.status, ran.stdout).not.toBe(0);
  }, 120_000);

  it("doctor refuses, naming the coding agent, when the machine has none", () => {
    // The default provider is the agent binary itself, so one absence is both
    // the executor and the reviewer's credential — and the report says which.
    const ran = doctor(repository("no-agent"), stubbedGh("no-agent").dir, { model: null });
    const said = ran.reason("agent_binary_missing");
    expect(said?.detail, ran.stdout).toContain("claude");
    expect(said?.severity, ran.stdout).toBe("blocking");
    expect(ran.status, ran.stdout).not.toBe(0);
  }, 120_000);

  it("doctor refuses, naming the package manager, when the one the repository installs with cannot be run", () => {
    // The scratch repository is an npm package, so npm is the first thing a run
    // would start in the worktree it provisions.
    const ran = doctor(repository("no-npm"), stubbedGh("no-npm").dir, { npm: null });
    const said = ran.reason("install_binary_missing");
    expect(said?.detail, ran.stdout).toContain("npm");
    expect(said?.severity, ran.stdout).toBe("blocking");
    expect(ran.status, ran.stdout).not.toBe(0);
  }, 120_000);
});

interface DoctorFinding {
  severity: string;
  reason: string;
  detail: string;
  fix: string;
}

interface DoctorReport {
  preflight: { findings: DoctorFinding[] };
}

interface DoctorRun {
  /** What the command exited with: zero only where nothing blocks a run here. */
  status: number | null;
  /** Everything it printed, which is the JSON it was asked for. */
  stdout: string;
  findings: DoctorFinding[];
  /** One finding by the reason it reports, or undefined where it reported none. */
  reason: (name: string) => DoctorFinding | undefined;
}

/**
 * `perbo doctor --repo <dir> --publish --json`, as the built binary runs it,
 * on a PATH this test states in full: the stubs, then the system directories
 * `git` is on. Never the caller's PATH — a developer's own `claude` or `gh`
 * would answer a question this is asking about a machine that has neither.
 *
 * `--publish` because that is what the quick start's own command does. `gh` is
 * checked either way, but only a run that publishes is stopped by a login that
 * does not answer, and the prerequisite the README states is the one the quick
 * start needs — so the diagnostic is asked in the form the quick start is.
 */
function doctor(
  dir: string,
  ghDir: string,
  options: { model?: string | null; npm?: string | null } = {},
): DoctorRun {
  // The stubs, and a directory holding nothing but this Node: the replay model
  // is a `#!/usr/bin/env node` script, so a PATH with no node on it makes the
  // agent this machine *has* look missing — the one prerequisite the quick
  // start can take for granted here, since it is what is running the test. The
  // interpreter arrives by itself (see nodeInterpreterDir), so the case that
  // withholds the model still describes a machine with no agent. npm arrives by
  // itself too (see packageManagerDir), so the case that withholds it describes
  // a machine with nothing to install the repository with.
  const onPath = [
    ghDir,
    ...(options.model === null ? [] : [options.model ?? model]),
    ...(options.npm === null ? [] : [options.npm ?? npmOnPath]),
    nodeOnPath,
  ];
  const result = spawnBuilt(
    [join(compiled, "main.js"), "doctor", "--repo", dir, "--publish", "--json"],
    {
      cwd: REPO_ROOT,
      timeout: 120_000,
      env: {
        ...process.env,
        PATH: [...onPath, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
        HOME: home,
        ANTHROPIC_API_KEY: "",
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
      },
    },
  );
  expect(result.stdout, result.stderr).not.toBe("");
  const report = JSON.parse(result.stdout) as DoctorReport;
  const findings = report.preflight.findings;
  return {
    status: result.status,
    stdout: result.stdout,
    findings,
    reason: (name) => findings.find((finding) => finding.reason === name),
  };
}

/** What a run reports about itself on stdout, which is JSON off a terminal. */
interface RunReport {
  ticket_id: string;
  outcome: string;
  branch: string;
  pull_request: { url: string; number: number | null } | null;
}

describe("the quick start, run in order on a scratch repository", () => {
  it("ends at the pull request the README describes", () => {
    const gh = stubbedGh("quickstart");
    const ran: Array<{ step: Step; stdout: string; stderr: string; status: number | null }> = [];

    for (const step of quickStartSteps) {
      const script = invokedBinary(step);
      if (script === null) {
        // `pnpm install` and the build: checked above, and satisfied by the
        // installed workspace this suite runs in and by `buildCli()`.
        expect(
          step.argv[0],
          `quick-start step ${step.position} — ${step.text} — is not one this suite knows how to run`,
        ).toBe("pnpm");
        continue;
      }
      const argv = step.argv.slice(2).map((word) => (word === "/path/to/your/repository" ? repo : word));
      for (const word of argv) {
        expect(word, `quick-start step ${step.position} names a placeholder this test does not fill`).not.toMatch(
          /^\/path\/to\//,
        );
      }
      const result = spawnBuilt(
        [join(compiled, script.slice("apps/cli/dist/".length)), ...argv],
        {
          cwd: REPO_ROOT,
          timeout: 600_000,
          env: {
            ...process.env,
            // The stubs first, then the caller's own PATH: the loop shells out
            // to `git` and to the package manager the fixture's manifest names,
            // and those are wherever this machine keeps them.
            PATH: [gh.dir, model, process.env.PATH ?? ""].join(":"),
            HOME: home,
            ANTHROPIC_API_KEY: "",
            GH_TOKEN: "",
            GITHUB_TOKEN: "",
          },
        },
      );
      ran.push({ step, ...result });
      expect(
        result.status,
        `quick-start step ${step.position} — ${step.text} — exited ${result.status}\n` +
          `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      ).toBe(0);
    }

    const last = ran.at(-1)!;
    expect(invokedBinary(last.step), "the quick start's last command is not a CLI invocation").not.toBeNull();

    // The pull request, as the run reports it and as `gh` was really asked for
    // it: against the branch the checkout is on, from the attempt's own branch,
    // titled with the outcome the README typed.
    const report = JSON.parse(last.stdout) as RunReport;
    // Named with what the run said about itself: a run that ended somewhere
    // else has to say where in the failure, not only that no URL arrived.
    expect(
      report.pull_request?.url,
      `the run ended ${report.outcome}\n--- stderr ---\n${last.stderr}`,
    ).toBe(PULL_REQUEST_URL);
    const created = gh.calls().filter((argv) => argv[0] === "pr" && argv[1] === "create");
    expect(created, `gh calls: ${JSON.stringify(gh.calls())}`).toHaveLength(1);
    expect(valueOf(created[0]!, "--base")).toBe("main");
    expect(valueOf(created[0]!, "--head")).toBe(report.branch);
    expect(valueOf(created[0]!, "--title")).toContain("unslug");

    // And the branch it named is on the remote, because the push was a push.
    const bare = git(repo, "remote", "get-url", "origin").trim();
    expect(git(bare, "branch", "--list", report.branch).trim()).not.toBe("");

    // What the loop did on the way there, in the record it wrote: the agent's
    // two files sealed, the repository's own check run, the review passed.
    const attempts = JSON.parse(
      readFileSync(join(repo, ".perbo", "state", `${report.ticket_id}.attempts.json`), "utf8"),
    ) as { attempts: Array<{ head_commit: string | null; base_commit: string }> };
    const one = attempts.attempts[0]!;
    expect(
      git(repo, "diff", "--name-only", one.base_commit, one.head_commit!).split("\n").filter(Boolean),
    ).toEqual(["src/unslug.js", "test/unslug.test.js"]);
  }, 900_000);
});
