import { describe, expect, it } from "vitest";
import { RequestSchema } from "./protocol.js";
import { PLANNING_KINDS, lane } from "./jobs.js";

/**
 * The Impact pane's one request (SCP-320, D-015). It names this planning
 * session and nothing else: the repository, the scope, the spec and the index
 * are all the host's to derive from the session's own records, so no field here
 * can become a filesystem target or a command
 * ([ADR-0023](../../../../docs/adr/0023-untrusted-context-boundary.md) §4).
 */

const session = "80000000-0000-4000-8000-000000000002";
const repoId = "80000000-0000-4000-8000-000000000001";

describe("the Impact pane's protocol", () => {
  it("takes a planning session and nothing else", () => {
    expect(RequestSchema.safeParse({ kind: "impactRead", id: session }).success).toBe(true);
    expect(RequestSchema.safeParse({ kind: "impactRead" }).success).toBe(false);
    expect(RequestSchema.safeParse({ kind: "impactRead", id: "not-a-session" }).success).toBe(false);
  });

  it("refuses a path, a repository or a command beside it", () => {
    for (const request of [
      { kind: "impactRead", id: session, path: "src/index.ts" },
      { kind: "impactRead", id: session, repoId },
      { kind: "impactRead", id: session, scope: ["**"] },
      { kind: "impactRead", id: session, command: "perbo index" },
      { kind: "impactRead", id: session, repo: "/etc" },
    ])
      expect(RequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(false);
  });

  it("runs in the planning lane, so a run is never in its way (D-101)", () => {
    expect(lane("impactRead")).toBe("planning");
    expect([...PLANNING_KINDS]).toContain("impactRead");
  });
});
