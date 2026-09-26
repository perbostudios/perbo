import { describe, expect, it } from "vitest";
import { PlanningError } from "./errors.js";
import { SPEC_HEADINGS } from "./spec-text.js";
import { parseSpec } from "./spec.js";

const spec = `# Activation email

## Outcome

New users receive an activation email within 60 seconds of signing up.

## Requirements

- R1: A signup POST queues exactly one activation email.
- R2: A duplicate signup inside five minutes queues nothing.
- R4: The queue retries a transport failure three times.

## No-Gos

- Nothing is sent to an address that has unsubscribed.
- No second email when the first is still in flight.

## Rabbit holes

- Templating: the existing template stays.

## Notes

The queue package already has a sender.
`;

describe("parseSpec", () => {
  it("reads the title from the first heading and the outcome from its section", () => {
    const parsed = parseSpec(spec);
    expect(parsed.title).toBe("Activation email");
    expect(parsed.outcome).toBe(
      "New users receive an activation email within 60 seconds of signing up.",
    );
  });

  it("reads each requirement with the id it was written with", () => {
    expect(parseSpec(spec).requirements).toEqual([
      { id: "R1", text: "A signup POST queues exactly one activation email." },
      { id: "R2", text: "A duplicate signup inside five minutes queues nothing." },
      { id: "R4", text: "The queue retries a transport failure three times." },
    ]);
  });

  it("reads the No-Gos from their own heading, as written", () => {
    expect(parseSpec(spec).no_gos).toEqual([
      "Nothing is sent to an address that has unsubscribed.",
      "No second email when the first is still in flight.",
    ]);
    expect(parseSpec(spec).rabbit_holes).toEqual(["Templating: the existing template stays."]);
  });

  it("has no No-Gos where the spec states none", () => {
    const without = spec.slice(0, spec.indexOf("## No-Gos")) + spec.slice(spec.indexOf("## Notes"));
    expect(parseSpec(without).no_gos).toEqual([]);
  });

  it("names the heading that is missing", () => {
    const noOutcome = spec.replace("## Outcome\n\nNew users receive an activation email within 60 seconds of signing up.\n\n", "");
    expect(() => parseSpec(noOutcome)).toThrow(PlanningError);
    expect(() => parseSpec(noOutcome)).toThrow(/Outcome/);
    const noRequirements = spec.slice(0, spec.indexOf("## Requirements")) + spec.slice(spec.indexOf("## No-Gos"));
    expect(() => parseSpec(noRequirements)).toThrow(/Requirements/);
  });

  it("refuses a duplicated requirement id", () => {
    expect(() => parseSpec(spec.replace("- R4:", "- R2:"))).toThrow(/R2/);
  });

  it("refuses a requirement that does not begin with an id", () => {
    expect(() => parseSpec(spec.replace("- R4: The queue", "- The queue"))).toThrow(
      /R1 upward|requirement id/i,
    );
    expect(() => parseSpec(spec.replace("- R4:", "- R0:"))).toThrow(/R0/);
  });

  it("refuses a heading that is not one of the five D-103 names", () => {
    expect([...SPEC_HEADINGS]).toEqual([
      "Outcome",
      "Requirements",
      "No-Gos",
      "Rabbit holes",
      "Notes",
    ]);
    expect(() => parseSpec(spec.replace("## No-Gos", "## No-Go"))).toThrow(/No-Go/);
  });

  it("reads a spec with no title line as one nobody has named, and drafts from it (D-118)", () => {
    const untitled = parseSpec(spec.replace("# Activation email\n", ""));
    expect(untitled.title).toBe("");
    expect(untitled.requirements.length).toBeGreaterThan(0);
  });

  it("refuses a Requirements section that names no requirement", () => {
    const empty = `# A\n\n## Outcome\n\nSomething.\n\n## Requirements\n\nTo be written.\n`;
    expect(() => parseSpec(empty)).toThrow(/no requirement/);
  });
});
