import { describe, expect, it } from "vitest";
import { IssueReferenceSchema, ModelIdSchema } from "./admit.js";

describe("the model id a person types", () => {
  it("takes every id a provider answers to, however it is spelt", () => {
    for (const id of [
      "claude-opus-5",
      "claude-opus-5-5[1m]",
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5-v1:0",
      "gpt-5.6-terra",
    ]) {
      expect(ModelIdSchema.safeParse(id).success, id).toBe(true);
    }
  });

  it("refuses what could be read as a flag or break the line it is put on", () => {
    for (const id of ["", "-x", "--model", "a b", "a\nb", " x"]) {
      expect(ModelIdSchema.safeParse(id).success, JSON.stringify(id)).toBe(false);
    }
  });
});

describe("the issue a person names", () => {
  it("takes a repository whose name starts with a dot", () => {
    expect(IssueReferenceSchema.safeParse("org/.github#5").success).toBe(true);
    expect(IssueReferenceSchema.safeParse("owner/repo#12").success).toBe(true);
  });

  it("still refuses what is not owner/repo#N", () => {
    for (const ref of ["repo#5", "owner/repo#0", "owner/repo", "owner/repo#5x", "-o/repo#5"]) {
      expect(IssueReferenceSchema.safeParse(ref).success, ref).toBe(false);
    }
  });
});
