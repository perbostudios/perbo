import { describe, expect, it } from "vitest";
import { pad } from "./text.js";

/**
 * A name held to a fixed column is an identifier, so it may be cut, but only
 * where the cut shows (D-NEW-nothing-shown-is-cut).
 */
describe("pad", () => {
  it("fills a name shorter than the column out to it", () => {
    expect(pad("unit", 8)).toBe("unit    ");
  });

  it("keeps a name exactly the column's width as it is", () => {
    expect(pad("typecheck", 9)).toBe("typecheck");
  });

  it("cuts a name longer than the column with a visible mark, keeping the row's width", () => {
    const cut = pad("typecheck:desktop-renderer", 15);
    expect(cut).toBe("typecheck:desk…");
    expect(cut).toHaveLength(15);
  });
});
