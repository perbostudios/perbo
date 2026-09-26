import { describe, expect, it } from "vitest";
import { judgeCommand } from "./admission.js";

/**
 * What a refusal names as its target is the command it refused, whole
 * (D-NEW-nothing-shown-is-cut).
 */

const PAD = `PADDINGTOKEN${"x".repeat(240)}END`;

const judged = (detail: string) =>
  judgeCommand({
    tool: "Bash",
    detail,
    allow_list: [],
    deny_list: ["Bash(sudo:*)"],
    scope: { root: "/work/tree", home: "/Users/nobody" },
  }).admission;

describe("a refusal's target is the whole command", () => {
  it("on the deny-list", () => {
    const admission = judged(`sudo ${PAD}`);
    expect(admission.decision).toBe("denied");
    expect(admission.target).toContain(PAD);
  });

  it("carrying inline code this guard cannot read", () => {
    const admission = judged(`node -e \\\\ ${PAD}`);
    expect(admission.decision).toBe("denied");
    expect(admission.target).toContain(PAD);
  });

  it("where the write named no target of its own", () => {
    const admission = judged(`cd - # ${PAD}`);
    expect(admission.decision).toBe("denied");
    expect(admission.target).toContain(PAD);
  });
});
