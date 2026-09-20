import { describe, expect, it } from "vitest";
import { operand, operands } from "./operand.js";

describe("an operand git is to read as a thing", () => {
  it("passes an ordinary ref, sha or name through unchanged", () => {
    expect(operand("main", "ref")).toBe("main");
    expect(operand("0".repeat(40), "commit")).toBe("0".repeat(40));
    expect(operand("origin/feature-1", "ref")).toBe("origin/feature-1");
    expect(operands(["a", "b"], "ref")).toEqual(["a", "b"]);
  });

  it("refuses one that would be read as an option, and names the role", () => {
    expect(() => operand("--output=/tmp/x", "ref")).toThrowError(RangeError);
    expect(() => operand("--output=/tmp/x", "ref")).toThrowError(/ref --output=\/tmp\/x would be read as an option/);
    expect(() => operand("-f", "commit")).toThrowError(/commit -f would be read as an option/);
    expect(() => operands(["main", "--exec=rm"], "ref")).toThrowError(RangeError);
  });

  it("refuses an empty one, which git reads as the argument after it", () => {
    expect(() => operand("", "ref")).toThrowError(RangeError);
  });
});
