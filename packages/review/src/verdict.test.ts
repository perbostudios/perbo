import { describe, expect, it } from "vitest";
import { MalformedVerdictError, UnknownCriterionError, verdictSchemas } from "./verdict.js";

/**
 * A rejection reason quotes the submission it rejects, and a person reads it on
 * the review record, so the quoted fragment is whole (D-NEW-nothing-shown-is-cut):
 * reduced to one printable line, never cut short.
 */

const verdict = (parts: Record<string, unknown>) => ({
  coverage: [],
  findings: [],
  check_assertions: [],
  overall_confidence: 0.9,
  ...parts,
});

function rejection(input: unknown): Error {
  try {
    verdictSchemas(["ac_1"], ["typecheck"]).parse(input);
  } catch (caught) {
    return caught as Error;
  }
  throw new Error("the verdict was accepted");
}

describe("a rejection reason quotes the verdict whole", () => {
  it("names an unknown criterion id whole, however long", () => {
    const id = `ac_${"9".repeat(300)}`;
    const caught = rejection(
      verdict({
        coverage: [
          {
            criterion_id: id,
            status: "met",
            verification_strength: "proxy",
            evidence_type: "none",
          },
        ],
      }),
    );
    expect(caught).toBeInstanceOf(UnknownCriterionError);
    expect(caught.message).toContain(`'${id}'`);
    expect(caught.message).not.toContain("...");
  });

  it("names an unknown check whole, however long", () => {
    const id = `check_${"x".repeat(300)}`;
    const caught = rejection(
      verdict({ check_assertions: [{ check_id: id, asserted_status: "passed" }] }),
    );
    expect(caught).toBeInstanceOf(MalformedVerdictError);
    expect(caught.message).toContain(`'${id}'`);
  });

  it("carries every schema issue whole", () => {
    const caught = rejection(verdict({ findings: Array.from({ length: 20 }, () => ({})) }));
    expect(caught).toBeInstanceOf(MalformedVerdictError);
    expect(caught.message.length).toBeGreaterThan(400);
    expect(caught.message).toContain("findings.19.statement");
    expect(caught.message.endsWith("...")).toBe(false);
  });

  it("still folds the fragment onto one printable line", () => {
    const caught = rejection(
      verdict({ check_assertions: [{ check_id: "a\nb\u0000c", asserted_status: "passed" }] }),
    );
    expect(caught.message).toContain("'a b c'");
  });
});
