import { describe, expect, it } from "vitest";
import { admitCommandLine, listCommandLine } from "../commands/admit.js";
import { parseBaselineArgs } from "../commands/baseline/index.js";
import { editCommandLine } from "../commands/edit/index.js";
import { escapesCommandLine } from "../commands/escapes/index.js";
import { inspectCommandLine } from "../commands/inspect.js";
import { parseInterviewArgs } from "../commands/interview/index.js";
import { mcpCommandLine } from "../commands/mcp.js";
import { parseServeArgs } from "../commands/serve/index.js";
import { stopsCommandLine } from "../commands/stops.js";
import { parseSyncAllMergedArgs } from "../commands/sync.js";
import { parseVerdictArgs } from "../commands/verdict/index.js";

/**
 * One home for every case where a value shaped like a flag becomes one.
 *
 * A person's text reaches these commands as a flag's value — an outcome, a
 * note, a path, a repository — and the desktop passes what was typed in a
 * field straight through. A parser that splits `--name=value` wherever it
 * finds it therefore lets that text decide what the command does:
 * `admit --outcome "--x=--approve"` approves, `verdict --note "--x=--endorse" abc`
 * records a decision, `serve --repo "--x=--publish"` publishes.
 *
 * Each case names the value, the field it arrives in and what the command
 * must make of it. E1's case is beside E1, in `baseline/internal/e1/`, which
 * only that module may import.
 */

describe("list, approve and mcp", () => {
  it("keeps a repository path that looks like a flag as the path", () => {
    const { input } = listCommandLine.read(["--repo", "--x=--all"]);
    expect(input.target.repo).toBe("--x=--all");
    expect(input.all).toBe(false);
  });

  it("keeps mcp's repository path whole", () => {
    expect(mcpCommandLine.read(["--repo", "--x=--json"]).input.target.repo).toBe("--x=--json");
  });
});

describe("stops and escapes", () => {
  it("keeps stops' repository path whole", () => {
    const { input } = stopsCommandLine.read(["--repo", "--x=--by-week"]);
    expect(input.target.repo).toBe("--x=--by-week");
    expect(input.byWeek).toBe(false);
  });

  it("keeps escapes' repository path whole", () => {
    const line = escapesCommandLine.read(["--repo", "--x=--json"]);
    expect(line.input.target.repo).toBe("--x=--json");
    expect(line.output.json).toBe(false);
  });
});

describe("inspect", () => {
  it("keeps an attempt id that looks like a flag as the id", () => {
    const line = inspectCommandLine.read(["PRB-1", "--attempt", "--x=--json"]);
    expect(line.input.attempt).toBe("--x=--json");
    expect(line.output.json).toBe(false);
  });

  it("refuses a value on --json rather than inspecting it", () => {
    expect(() => inspectCommandLine.read(["--json=PRB-9"])).toThrow(
      /--json does not take a value/,
    );
  });
});

describe("edit", () => {
  it("keeps an outcome that looks like a flag as the outcome", () => {
    const line = editCommandLine.read(["PRB-1", "--outcome", "--x=--json"]);
    expect(line.input.outcome).toBe("--x=--json");
    expect(line.output.json).toBe(false);
  });
});

describe("admit", () => {
  it("does not let an outcome approve the ticket it admits", () => {
    const args = admitCommandLine.read(["--outcome", "--x=--approve"]).input;
    expect(args.approve).toBe(false);
    expect(args.title).toBe("--x=--approve");
  });
});

describe("sync --all-merged", () => {
  it("keeps a repository path whole rather than forcing a re-read", () => {
    const args = parseSyncAllMergedArgs(["--repo", "--x=--force"]);
    expect(args.repo).toBe("--x=--force");
    expect(args.force).toBe(false);
  });
});

describe("verdict and baseline", () => {
  it("does not let a note take a decision", () => {
    // Two positionals once the note is one value: the reference and `abc`,
    // which is the refusal a person needs rather than a recorded decision.
    expect(() => parseVerdictArgs(["PRB-1", "--note", "--x=--endorse", "abc"])).toThrow(
      /exactly one review/,
    );
  });

  it("keeps a baseline note whole", () => {
    const args = parseBaselineArgs(["stop", "--note", "--x=--json"]);
    expect(args.note).toBe("--x=--json");
    expect(args.json).toBe(false);
  });
});

describe("serve and interview", () => {
  it("does not let a repository path turn publication on", () => {
    const args = parseServeArgs(["--repo", "--x=--publish"]);
    expect(args.repo).toBe("--x=--publish");
    expect(args.publish).toBe(false);
  });

  it("keeps an interview's spec folder whole", () => {
    const args = parseInterviewArgs(["--spec", "--x=--session"]);
    expect(args.spec).toBe("--x=--session");
    expect(args.session).toBe(null);
  });
});
