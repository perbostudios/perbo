import { describe, expect, it } from "vitest";
import { inspectCommand } from "./prohibited.js";

/**
 * A prohibited action names the line it was read from, whole
 * (D-NEW-nothing-shown-is-cut): the executor's command is tool output, and a
 * person reads it to know what ended the attempt.
 */

const PAD = `PADDINGTOKEN${"x".repeat(240)}END`;
const scope = { root: "/work/tree", home: "/Users/nobody" };

const cases: ReadonlyArray<[string, string]> = [
  ["a push, and the line it was on", `git push ${PAD}`],
  ["a program that sends mail", `sh mail.sh ${PAD}`],
  ["what runs before a push on its line", `PADDING=${PAD} ls && git push origin develop`],
];

describe("a prohibited action quotes the line it read, whole", () => {
  for (const [label, command] of cases) {
    it(label, () => {
      const details = inspectCommand(command, scope).map((hit) => hit.detail);
      const quoting = details.filter((detail) => detail.includes("PADDINGTOKEN"));
      expect(quoting.length, details.join("\n")).toBeGreaterThan(0);
      for (const detail of quoting) expect(detail).toContain(PAD);
    });
  }
});
