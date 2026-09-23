import { describe, expect, it } from "vitest";
import { sameName } from "./ticket-name.js";

describe("sameName (D-NEW-a-ticket-is-named-apart-from-its-board)", () => {
  it("is the same name whatever its case and spacing", () => {
    expect(sameName("Snake on a walled board", "Snake on a walled board")).toBe(true);
    expect(sameName("Snake on a walled board", "snake ON A walled BOARD")).toBe(true);
    expect(sameName("Snake on a walled board", "  Snake\n on\ta  walled board ")).toBe(true);
  });

  it("is a different name when a word differs, is added or is joined to another", () => {
    expect(sameName("Snake on a walled board", "Snake on a board")).toBe(false);
    expect(sameName("Snake game", "Snake game speed")).toBe(false);
    expect(sameName("Twin-dial clock", "Twin dial clock")).toBe(false);
    expect(sameName("Snake game", "Snakegame")).toBe(false);
  });
});
