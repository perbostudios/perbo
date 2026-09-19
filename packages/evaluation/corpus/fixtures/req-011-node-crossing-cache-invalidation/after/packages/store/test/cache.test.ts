import { describe, expect, it } from "vitest";
import { createCachedStore } from "../src/cache.js";

describe("createCachedStore", () => {
  it("invalidates a key's cache entry when that key is written", async () => {
    const store = createCachedStore();
    await store.set("u1:name", "Ada");
    expect(await store.get("u1:name")).toBe("Ada");
    await store.set("u1:name", "Grace");
    expect(await store.get("u1:name")).toBe("Grace");
  });
});
