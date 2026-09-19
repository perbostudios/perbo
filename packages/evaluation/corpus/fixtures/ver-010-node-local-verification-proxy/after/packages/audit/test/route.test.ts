import { describe, expect, it } from "vitest";
import { handleAuditRequest } from "../src/route.js";

describe("handleAuditRequest", () => {
  it("calls the paginator and returns its rows as JSON", async () => {
    const response = await handleAuditRequest({ page: "1" });
    expect(response.status).toBe(200);
    expect((response.body as { rows: unknown[] }).rows).toHaveLength(25);
  });
});
