import { describe, expect, it } from "vitest";
import { UsageError } from "../usage-error.js";
import {
  listFlag,
  parseArgv,
  switchFlag,
  valueFlag,
  type FlagTable,
  type Grammar,
} from "./grammar.js";

/**
 * One case per rule, on a grammar that carries one of everything: a switch, a
 * value flag, a repeating one, a flag that refuses a flag-shaped value, and a
 * range of positionals wide enough to be given too few and too many.
 */

const FLAGS = {
  "--json": switchFlag(),
  "--repo": valueFlag(),
  "--criterion": listFlag(),
  "--endorse": valueFlag({ refuseFlagShaped: "missing key after --endorse" }),
  "--raw-artifact": valueFlag({ hidden: true }),
} satisfies FlagTable;

const GRAMMAR: Grammar<typeof FLAGS> = {
  command: "demo",
  flags: FLAGS,
  positionals: { min: 0, max: 1, refusal: "demo takes at most one key, e.g. perbo demo PRB-1" },
  afterDoubleDash: "positionals",
};

const PASSES_ON: Grammar<typeof FLAGS> = {
  ...GRAMMAR,
  command: "agent",
  afterDoubleDash: "passthrough",
  unknownFlagHint: "arguments for the provider go after --",
};

describe("rule 1: tokens are read left to right", () => {
  it("reads a flag, its value and a positional in the order they were typed", () => {
    const line = parseArgv(GRAMMAR, ["--repo", "/tmp", "PRB-1"]);
    expect(line.flags["--repo"]).toBe("/tmp");
    expect(line.positionals).toEqual(["PRB-1"]);
  });
});

describe("rule 2: `--` ends the options", () => {
  it("makes what follows positional", () => {
    expect(parseArgv(GRAMMAR, ["--", "--repo"]).positionals).toEqual(["--repo"]);
  });

  it("hands what follows to the other program where the command passes it on", () => {
    const line = parseArgv(PASSES_ON, ["--json", "--", "--repo", "-p"]);
    expect(line.flags["--json"]).toBe(true);
    expect(line.passthrough).toEqual(["--repo", "-p"]);
    expect(line.positionals).toEqual([]);
  });
});

describe("rule 3: help is honoured in flag position and nowhere else", () => {
  it("asks for help before anything about the line is read", () => {
    expect(parseArgv(GRAMMAR, ["--help"]).help).toBe(true);
    expect(parseArgv(GRAMMAR, ["-h"]).help).toBe(true);
    expect(parseArgv(GRAMMAR, ["--typo", "--help"]).help).toBe(true);
    expect(parseArgv(GRAMMAR, ["a", "b", "c", "--help"]).help).toBe(true);
  });

  it("leaves a `--help` a flag took as its value alone", () => {
    const line = parseArgv(GRAMMAR, ["--repo", "--help"]);
    expect(line.help).toBe(false);
    expect(line.flags["--repo"]).toBe("--help");
  });

  it("leaves a `--help` after `--` to whatever `--` introduced", () => {
    expect(parseArgv(PASSES_ON, ["--", "--help"]).help).toBe(false);
    expect(parseArgv(PASSES_ON, ["--", "--help"]).passthrough).toEqual(["--help"]);
  });
});

describe("rule 4: `--name=value` is split only in flag position", () => {
  it("splits the token at its first `=`", () => {
    expect(parseArgv(GRAMMAR, ["--repo=/tmp/a=b"]).flags["--repo"]).toBe("/tmp/a=b");
  });

  it("keeps a value that looks like a flag as that value", () => {
    expect(parseArgv(GRAMMAR, ["--repo=--json"]).flags["--repo"]).toBe("--json");
    expect(parseArgv(GRAMMAR, ["--repo=--json"]).flags["--json"]).toBeUndefined();
  });

  it("never re-reads a separate value as a flag", () => {
    const line = parseArgv(GRAMMAR, ["--repo", "--x=--json"]);
    expect(line.flags["--repo"]).toBe("--x=--json");
    expect(line.flags["--json"]).toBeUndefined();
    expect(line.positionals).toEqual([]);
  });
});

describe("rule 5: an unknown name is refused", () => {
  it("names the flag and the command", () => {
    expect(() => parseArgv(GRAMMAR, ["--nope"])).toThrow(UsageError);
    expect(() => parseArgv(GRAMMAR, ["--nope"])).toThrow(/unknown flag '--nope' for demo/);
  });

  it("adds the command's hint where it has one", () => {
    expect(() => parseArgv(PASSES_ON, ["-p"])).not.toThrow();
    expect(() => parseArgv(PASSES_ON, ["--nope"])).toThrow(
      /unknown flag '--nope' for agent \(arguments for the provider go after --\)/,
    );
  });

  it("matches a name exactly rather than by prefix", () => {
    expect(() => parseArgv(GRAMMAR, ["--rep", "/tmp"])).toThrow(/unknown flag '--rep'/);
  });
});

describe("rule 6: a switch takes no value", () => {
  it("refuses every inline form", () => {
    for (const token of ["--json=x", "--json=", "--json=false"]) {
      expect(() => parseArgv(GRAMMAR, [token])).toThrow(/--json does not take a value/);
    }
  });

  it("accepts the switch itself", () => {
    expect(parseArgv(GRAMMAR, ["--json"]).flags["--json"]).toBe(true);
  });
});

describe("rule 7: a value flag takes the next token verbatim", () => {
  it("takes a dash, a flag-shaped token and `--` as the value they are", () => {
    expect(parseArgv(GRAMMAR, ["--repo", "-"]).flags["--repo"]).toBe("-");
    expect(parseArgv(GRAMMAR, ["--repo", "--json"]).flags["--repo"]).toBe("--json");
    expect(parseArgv(GRAMMAR, ["--repo", "--"]).flags["--repo"]).toBe("--");
  });

  it("refuses a line that ends before the value", () => {
    expect(() => parseArgv(GRAMMAR, ["--repo"])).toThrow(/--repo requires a value/);
  });

  it("refuses a flag-shaped separate value where the flag asked for that", () => {
    expect(() => parseArgv(GRAMMAR, ["--endorse", "--json"])).toThrow(
      /missing key after --endorse/,
    );
    expect(parseArgv(GRAMMAR, ["--endorse=--json"]).flags["--endorse"]).toBe("--json");
  });
});

describe("rule 8: a repeat takes the last value, or accumulates", () => {
  it("lets the last `--repo` win, which is what a trailing one is for", () => {
    expect(parseArgv(GRAMMAR, ["--repo", "a", "--repo=b"]).flags["--repo"]).toBe("b");
  });

  it("accumulates a repeating flag in the order it was given", () => {
    const line = parseArgv(GRAMMAR, ["--criterion", "one", "--criterion=two", "--criterion", "三"]);
    expect(line.flags["--criterion"]).toEqual(["one", "two", "三"]);
  });
});

describe("rule 9: a token without two dashes is a positional", () => {
  it("keeps `-`, `-x` and plain text as positionals", () => {
    expect(parseArgv(GRAMMAR, ["-"]).positionals).toEqual(["-"]);
    expect(parseArgv(GRAMMAR, ["-x"]).positionals).toEqual(["-x"]);
    expect(parseArgv(GRAMMAR, ["stray"]).positionals).toEqual(["stray"]);
  });

  it("refuses a count outside the range, in the grammar's own words", () => {
    expect(() => parseArgv(GRAMMAR, ["one", "two"])).toThrow(
      /demo takes at most one key, e\.g\. perbo demo PRB-1/,
    );
    const exactlyOne: Grammar<typeof FLAGS> = {
      ...GRAMMAR,
      positionals: { min: 1, max: 1, refusal: "demo takes exactly one key" },
    };
    expect(() => parseArgv(exactlyOne, [])).toThrow(/demo takes exactly one key/);
  });

  it("counts what `--` introduced where `--` introduces positionals", () => {
    expect(() => parseArgv(GRAMMAR, ["--", "one", "two"])).toThrow(/demo takes at most one key/);
  });
});

describe("a flag the product does not offer is recorded as hidden", () => {
  it("parses like any other and says it is not to be named", () => {
    expect(parseArgv(GRAMMAR, ["--raw-artifact", "/tmp/a.json"]).flags["--raw-artifact"]).toBe(
      "/tmp/a.json",
    );
    expect(FLAGS["--raw-artifact"].hidden).toBe(true);
    expect(FLAGS["--repo"].hidden).toBe(false);
  });
});
