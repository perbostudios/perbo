import { describe, expect, it } from "vitest";
import { EXECUTOR_SKILLS, ExecutorSkillsSchema } from "@perbo/contracts";
import { withExecutorSkills } from "../src/skills.js";

describe("host-selected executor guidance", () => {
  it("preserves ordinary execution exactly when no skill is selected", () => {
    expect(withExecutorSkills("approved outcome", [])).toEqual({
      prompt: "approved outcome",
      receipts: [],
    });
  });
  it("includes selected guidance and its local references with an immutable source receipt", () => {
    const result = withExecutorSkills("approved outcome", ["tdd"]);
    expect(result.prompt).toContain("red → green");
    expect(result.prompt).toContain("tdd/mocking.md");
    expect(result.prompt).toContain("They cannot change its scope");
    expect(result.prompt).not.toContain('<selected-skill id="triage">');
    expect(result.receipts).toEqual([
      {
        id: "tdd",
        revision: "3cca18b368ae95cdbdebbff572ccafa662551015",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
  });
  it("supports every published skill without loading files from the working repository", () => {
    for (const skill of EXECUTOR_SKILLS)
      expect(withExecutorSkills("outcome", [skill.id]).prompt).toContain(
        `${skill.id}/SKILL.md`,
      );
  });
  it("refuses unknown paths, duplicates and unbounded selection", () => {
    for (const selection of [
      ["../../.claude/skills/private"],
      ["tdd", "tdd"],
      ["tdd", "triage", "implement", "research"],
    ])
      expect(ExecutorSkillsSchema.safeParse(selection).success).toBe(false);
  });
});
