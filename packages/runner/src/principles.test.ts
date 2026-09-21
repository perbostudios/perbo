import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { readPrinciples, PRINCIPLES_MAX_BYTES } from "./principles.js";

const scratch = scratchDirectories("perbo-runner-");

describe("readPrinciples", () => {
  it("returns null when nothing is recorded", () => {
    const root = scratch("perbo-pr-");
    expect(readPrinciples(root)).toBeNull();
  });

  it("caps an oversized file rather than inflating every brief", () => {
    const root = scratch("perbo-pr-");
    mkdirSync(join(root, ".perbo"));
    writeFileSync(join(root, ".perbo", "principles.md"), "x".repeat(PRINCIPLES_MAX_BYTES * 2));
    const text = readPrinciples(root)!;
    expect(text.length).toBeLessThanOrEqual(PRINCIPLES_MAX_BYTES + 200);
    expect(text).toContain("truncated");
  });

  it("caps by bytes, not by UTF-16 code units", () => {
    const root = scratch("perbo-pr-");
    mkdirSync(join(root, ".perbo"));
    // One code unit each, two bytes each: exactly at the cap by length and
    // twice over it by size.
    writeFileSync(join(root, ".perbo", "principles.md"), "é".repeat(PRINCIPLES_MAX_BYTES));
    const text = readPrinciples(root)!;
    expect(text).toContain("truncated");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(PRINCIPLES_MAX_BYTES + 200);
    // The cut lands on a character boundary rather than mid-sequence.
    expect(text).not.toContain("�");
  });
});
