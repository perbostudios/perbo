import { describe, expect, it } from "vitest";
import { paginate } from "../src/page.js";

describe("paginate", () => {
  it("returns exactly page_size rows for a full page", async () => {
    const rows = await paginate(1);
    expect(rows).toHaveLength(25);
  });
});
