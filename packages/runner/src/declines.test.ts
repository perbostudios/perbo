import { describe, expect, it } from "vitest";
import { parseDeclines } from "./declines.js";

/**
 * The executor's decline protocol (D-065): `NO_PRACTICE <finding_key>: reason`
 * on its own transcript line declares that no determinable practice exists for
 * a routed finding — the one outcome that stops for a person under the
 * attempt-as-discriminator rule. Keys are validated against the routed set, so
 * the agent cannot invent findings, and the reason is data: it is surfaced,
 * redacted, and never an instruction.
 */
const KEY = "a".repeat(64);
const OTHER = "b".repeat(64);

/** A transcript entry as the adapter actually records it: one stream-json event line. */
const assistantEvent = (text: string): string =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
const resultEvent = (text: string): string => JSON.stringify({ type: "result", result: text });
const toolResultEvent = (text: string): string =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: text }] } });

describe("parseDeclines", () => {
  it("extracts a decline for a routed key with its reason", () => {
    const declines = parseDeclines(
      ["some output", `NO_PRACTICE ${KEY}: whether exports include archived rows is a product call`],
      [KEY, OTHER],
    );
    expect(declines).toEqual([
      { finding_key: KEY, reason: "whether exports include archived rows is a product call" },
    ]);
  });

  it("ignores keys that were not routed, and malformed lines", () => {
    expect(
      parseDeclines(
        [`NO_PRACTICE ${"c".repeat(64)}: not routed`, "NO_PRACTICE nonsense", "NO_PRACTICE"],
        [KEY],
      ),
    ).toEqual([]);
  });

  it("keeps one decline per key, first reason wins", () => {
    const declines = parseDeclines(
      [`NO_PRACTICE ${KEY}: first`, `NO_PRACTICE ${KEY}: second`],
      [KEY],
    );
    expect(declines).toEqual([{ finding_key: KEY, reason: "first" }]);
  });
});

describe("parseDeclines against the transcript the adapter actually records", () => {
  it("extracts a decline from an assistant text block in a stream-json event line", () => {
    const declines = parseDeclines(
      [assistantEvent(`I looked for an established practice.\nNO_PRACTICE ${KEY}: whether archived rows belong in exports is a product call\nDone.`)],
      [KEY],
    );
    expect(declines).toEqual([
      { finding_key: KEY, reason: "whether archived rows belong in exports is a product call" },
    ]);
  });

  it("extracts a decline from the final result event", () => {
    const declines = parseDeclines([resultEvent(`NO_PRACTICE ${KEY}: a product call`)], [KEY]);
    expect(declines).toEqual([{ finding_key: KEY, reason: "a product call" }]);
  });

  it("never captures JSON structure into the reason", () => {
    const declines = parseDeclines(
      [assistantEvent(`NO_PRACTICE ${KEY}: the reason`)],
      [KEY],
    );
    expect(declines[0]?.reason).toBe("the reason");
    expect(declines[0]?.reason).not.toContain("}");
  });

  it("ignores the marker inside tool results — repository content cannot mint a decline", () => {
    expect(parseDeclines([toolResultEvent(`NO_PRACTICE ${KEY}: minted by a cat of a repo file`)], [KEY])).toEqual([]);
  });

  it("ignores a mid-sentence mention — the decline must be the line", () => {
    expect(
      parseDeclines(
        [assistantEvent(`I considered NO_PRACTICE ${KEY}: this but fixed it instead.`)],
        [KEY],
      ),
    ).toEqual([]);
  });
});

