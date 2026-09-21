import { describe, expect, it } from "vitest";
import { UsageError } from "../usage-error.js";
import type { Streams } from "../streams.js";
import { parseArgv, switchFlag, valueFlag, type FlagTable, type Grammar } from "./grammar.js";
import { USAGE } from "./usage.js";
import { runCommandLine } from "./terminal.js";
import type { NarratedCommand, ReportCommand, TerminalCommand } from "./table.js";

/**
 * The adapter between a command line and a command, on two commands built for
 * the purpose: one that answers with a record and one that answers while it
 * works. What it has to get right is the same for every real command — what
 * reaches stdout, what reaches stderr, the exit code, whether the record or
 * the reading is written, and that a synchronous command stays synchronous.
 */

const FLAGS = {
  "--json": switchFlag(),
  "--repo": valueFlag(),
} satisfies FlagTable;

const GRAMMAR: Grammar<typeof FLAGS> = {
  command: "demo",
  flags: FLAGS,
  positionals: { min: 0, max: 1, refusal: "demo takes at most one key" },
  afterDoubleDash: "positionals",
};

interface DemoInput {
  readonly repo: string;
  readonly key: string | null;
}
interface DemoOutput {
  readonly json: boolean;
}
interface DemoReport {
  readonly repo: string;
  readonly seen: string;
}
interface DemoDeps {
  readonly seen: string;
}

const read = (argv: readonly string[]): { input: DemoInput; output: DemoOutput } => {
  const line = parseArgv(GRAMMAR, argv);
  return {
    input: { repo: line.flags["--repo"] ?? ".", key: line.positionals[0] ?? null },
    output: { json: line.flags["--json"] === true },
  };
};

/** Synchronous, like a typed admission: the 88 callers that read a number keep reading one. */
const reporting: ReportCommand<DemoInput, DemoOutput, DemoReport, DemoDeps> = {
  kind: "report",
  name: "list",
  grammars: [GRAMMAR],
  jsonWhenPiped: false,
  grammarFor: () => GRAMMAR,
  read,
  run(input, context) {
    context.diagnostics.stderr("looking\n");
    return { repo: input.repo, seen: context.seen ?? "nothing" };
  },
  toJson: (report) => ({ repo: report.repo }),
  render(report, _output, target) {
    return target.json
      ? { stdout: `${JSON.stringify({ repo: report.repo })}\n`, stderr: "", exitCode: 0 }
      : { stdout: `REPO ${report.repo} (${report.seen})\n`, stderr: "one row\n", exitCode: 2 };
  },
};

const narrating: NarratedCommand<DemoInput, DemoOutput, DemoDeps> = {
  kind: "narrated",
  name: "sync",
  grammars: [GRAMMAR],
  grammarFor: () => GRAMMAR,
  read,
  run(input, output, context) {
    context.diagnostics.stderr(`syncing ${input.repo}\n`);
    context.stdout(`${output.json ? "{}" : "done"}\n`);
    return Promise.resolve(context.isTTY ? 0 : 3);
  },
};

function streams(isTTY: boolean): { streams: Streams; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    streams: { stdout: (chunk) => out.push(chunk), stderr: (chunk) => err.push(chunk), isTTY },
    out,
    err,
  };
}

describe("a command that answers with a record", () => {
  it("writes the reading, what it said while it worked, and its own exit code", () => {
    const { streams: s, out, err } = streams(true);
    const code = runCommandLine(reporting, { argv: ["--repo", "/tmp"], streams: s, cwd: "/" });
    expect(code).toBe(2);
    expect(out.join("")).toBe("REPO /tmp (nothing)\n");
    // What it said while it worked comes before what the rendering adds.
    expect(err.join("")).toBe("looking\none row\n");
  });

  it("answers synchronously, so a caller that reads a number reads one", () => {
    const { streams: s } = streams(true);
    expect(runCommandLine(reporting, { argv: [], streams: s, cwd: "/" })).not.toBeInstanceOf(
      Promise,
    );
  });

  it("writes the record when `--json` is given", () => {
    const { streams: s, out } = streams(true);
    expect(runCommandLine(reporting, { argv: ["--json"], streams: s, cwd: "/" })).toBe(0);
    expect(out.join("")).toBe('{"repo":"."}\n');
  });

  it("writes the reading on a pipe where the command does not promise the record", () => {
    const { streams: s, out } = streams(false);
    expect(runCommandLine(reporting, { argv: [], streams: s, cwd: "/" })).toBe(2);
    expect(out.join("")).toBe("REPO . (nothing)\n");
  });

  it("writes the record on a pipe where the command does promise it", () => {
    const { streams: s, out } = streams(false);
    const promises: ReportCommand<DemoInput, DemoOutput, DemoReport, DemoDeps> = {
      ...reporting,
      jsonWhenPiped: true,
    };
    expect(runCommandLine(promises, { argv: [], streams: s, cwd: "/" })).toBe(0);
    expect(out.join("")).toBe('{"repo":"."}\n');
  });

  it("hands the command what a caller injected", () => {
    const { streams: s, out } = streams(true);
    runCommandLine(reporting, { argv: [], streams: s, cwd: "/", deps: { seen: "a fake" } });
    expect(out.join("")).toBe("REPO . (a fake)\n");
  });
});

describe("a command that answers while it works", () => {
  it("writes through the streams it was given and returns its own code", async () => {
    const { streams: s, out, err } = streams(false);
    await expect(
      runCommandLine(narrating, { argv: ["--repo", "/tmp"], streams: s, cwd: "/" }),
    ).resolves.toBe(3);
    expect(out.join("")).toBe("done\n");
    expect(err.join("")).toBe("syncing /tmp\n");
  });
});

describe("whatever the command is", () => {
  it("prints the help for a line that asks for it, and runs nothing", () => {
    const { streams: s, out, err } = streams(true);
    expect(runCommandLine(reporting, { argv: ["--help"], streams: s, cwd: "/" })).toBe(0);
    expect(err.join("")).toBe(USAGE);
    expect(out).toEqual([]);
  });

  it("lets a refusal out to the entry point, which decides what it exits as", () => {
    const { streams: s } = streams(true);
    expect(() =>
      runCommandLine(reporting, { argv: ["--nope"], streams: s, cwd: "/" }),
    ).toThrow(UsageError);
    expect(() =>
      runCommandLine(reporting, { argv: ["one", "two"], streams: s, cwd: "/" }),
    ).toThrow(/demo takes at most one key/);
  });

  it("is held by the table whichever kind it is", () => {
    const table: readonly TerminalCommand[] = [reporting, narrating];
    expect(table.map((command) => command.name)).toEqual(["list", "sync"]);
  });
});
