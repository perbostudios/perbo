import { describe, expect, it } from "vitest";
import { NEVER_READ_PATHS, isNeverReadPath } from "./paths.js";

/**
 * The paths no surface reads into a model context or onto a screen (D-012,
 * ADR-0030). The reviewer and the desktop's explorer both apply it, so it lives
 * here rather than in either of them.
 */
describe("the never-read list", () => {
  it("covers materialized secrets, Git metadata and agent configuration", () => {
    for (const path of [
      ".env",
      "apps/web/.env.local",
      "certs/dev.pem",
      "keys/id_rsa",
      "packages/x/secrets/token.txt",
      ".npmrc",
      ".netrc",
      ".git/config",
      "apps/web/.git",
      ".claude/settings.json",
      "AGENTS.md",
      "apps/web/CLAUDE.md",
      ".mcp.json",
    ])
      expect(isNeverReadPath(path), path).toBe(true);
  });

  it("leaves ordinary source, tests and documents alone", () => {
    for (const path of [
      "src/index.ts",
      "test/service.test.ts",
      "docs/04-ticket-workspace-and-review.md",
      "README.md",
      "packages/ui/src/tokens.css",
      "environment.ts",
      "src/keyboard.ts",
    ])
      expect(isNeverReadPath(path), path).toBe(false);
  });

  it("names every glob it judges by, so a surface can say what it withholds", () => {
    expect(NEVER_READ_PATHS).toContain("**/*.pem");
    expect(NEVER_READ_PATHS.length).toBeGreaterThan(0);
  });
});
