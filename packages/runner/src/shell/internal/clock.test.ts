import { describe, expect, it } from "vitest";
import { clockSetting } from "./clock.js";
import type { Word } from "./lexer.js";

const words = (...values: string[]): Word[] =>
  values.map((value) => ({ raw: value, value, substitutions: [], variable: false }));

/**
 * `date` sets the clock through `-s` in any cluster, any prefix of `--set` GNU
 * accepts, and an operand that is not a `+FORMAT`. Everything else reads it.
 */
describe("the words that make `date` set the clock", () => {
  it("names the word that sets it", () => {
    for (const [line, setting] of [
      [["-s", "2020-01-01"], "-s"],
      [["-us", "2020-01-01"], "-us"],
      [["-su", "2020-01-01"], "-su"],
      [["-ius", "2020-01-01"], "-ius"],
      [["-s2020-01-01"], "-s2020-01-01"],
      [["--set=2020-01-01"], "--set=2020-01-01"],
      [["--se=2020-01-01"], "--se=2020-01-01"],
      [["--se", "2020-01-01"], "--se"],
      [["--s=2020-01-01"], "--s=2020-01-01"],
      [["01021230"], "01021230"],
      [["-u", "010212302020.30"], "010212302020.30"],
      [["--", "01021230"], "01021230"],
      [["--utc", "01021230"], "01021230"],
      [["--u", "01021230"], "01021230"],
      // On BSD `-f` is the operand's format and `-r` the time shown: neither
      // stops the operand being a time to set.
      [["-f", "%s", "0"], "0"],
      [["-r", "0", "0101"], "0101"],
      [["-r", "src/a.ts", "0101"], "0101"],
      [["-uf", "%s", "0"], "0"],
    ] as const) {
      expect(clockSetting(words(...line)), line.join(" ")).toBe(setting);
    }
  });

  it("counts a word built at run time as one that may set it", () => {
    const built: Word = { raw: "$FLAGS", value: "$FLAGS", substitutions: [], variable: true };
    expect(clockSetting([built])).toBe("$FLAGS");
    const format: Word = { raw: '+"$FMT"', value: "+$FMT", substitutions: [], variable: true };
    expect(clockSetting([format])).toBeNull();
  });

  it("leaves every reading of the clock alone", () => {
    for (const line of [
      [],
      ["-u"],
      ["+%s"],
      ["-u", "+%Y-%m-%dT%H:%M:%SZ"],
      ["-d", "yesterday"],
      ["-d", "2020-01-01", "+%s"],
      ["-ds"],
      ["-r", "src/a.ts"],
      ["--iso-8601"],
      ["--iso-8601=seconds"],
      ["-Iseconds"],
      ["--rfc-3339", "seconds"],
      ["--date", "01021230"],
      ["--da=tomorrow", "+%F"],
      ["-j", "-f", "%s", "1600000000", "+%F"],
      ["-jf", "%s", "0", "+%F"],
      ["-r", "0"],
      ["-u", "-d", "@0"],
      ["--file", "dates.txt"],
      ["--reference", "src/a.ts"],
      ["--debug"],
      // An ambiguous prefix is an error to `date`, and sets nothing.
      ["--d"],
    ]) {
      expect(clockSetting(words(...line)), line.join(" ")).toBeNull();
    }
  });
});
