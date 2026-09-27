import { describe, expect, it } from "vitest";
import { interviewGuardState, judgeInterviewCall } from "./index.js";

/**
 * The command the interview's guard refused is named whole, as its target and
 * in its reason (D-NEW-nothing-shown-is-cut): it is tool output the person
 * reads to know what the Architect was refused.
 */

const PAD = `PADDINGTOKEN${"x".repeat(240)}END`;
const state = interviewGuardState({
  repositoryRoot: "/work/tree",
  storeFolder: ".perbo",
  specFolder: "specs",
  workFolder: "specs/the-work",
  adrFolder: "docs/adr",
});
const judged = (command: string) => judgeInterviewCall({ tool_name: "Bash", tool_input: { command } }, state);

describe("a command the interview refused, whole", () => {
  it("is not one of the read-only shapes", () => {
    const command = `pnpm install ${PAD}`;
    const refused = judged(command);
    expect(refused.allow).toBe(false);
    expect(refused.target).toBe(command);
    expect(refused.reason).toContain(`${command} is not one of the read-only shapes`);
  });

  it("carries an option that writes", () => {
    const command = `git log --output=CONTEXT.md ${PAD}`;
    const refused = judged(command);
    expect(refused.allow).toBe(false);
    expect(refused.target).toBe(command);
    expect(refused.reason).toContain(`on ${command} is not one of the read-only shapes`);
  });

  it("runs a shape this reading did not resolve", () => {
    const command = `cat <<EOF\ngit log --output=CONTEXT.md ${PAD}\nEOF`;
    const refused = judged(command);
    expect(refused.allow).toBe(false);
    expect(refused.reason).toContain("did not resolve where it runs");
    expect(refused.target).toBe(command);
    expect(refused.reason).toContain(`on ${command} is not one of the read-only shapes`);
  });
});
