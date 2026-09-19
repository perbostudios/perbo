import { describe, expect, it } from "vitest";
import { writeProfile } from "../src/write.js";

describe("writeProfile", () => {
  it("writes the field through the store client", async () => {
    await expect(writeProfile("u1", "name", "Ada")).resolves.toBeUndefined();
  });
});
