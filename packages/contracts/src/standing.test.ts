import { describe, expect, it } from "vitest";
import {
  STANDING_PROHIBITED_KEY,
  StandingProhibitedSchema,
  readStandingProhibited,
  standingGlob,
} from "./standing.js";

/**
 * The list a repository prohibits for every ticket (D-105), read from
 * `.perbo/config.json` under one key by admission, by the runner's guard and
 * by the desktop's explorer.
 */
describe("the standing prohibited list", () => {
  it("is read from one key", () => {
    expect(STANDING_PROHIBITED_KEY).toBe("paths_prohibited");
  });

  it("keeps each entry's source and when it was added", () => {
    const entries = StandingProhibitedSchema.parse([
      {
        path: "packages/app/src/generated/**",
        draft: "b7b0f3e2-0000-4000-8000-000000000001",
        source: "PRB-142",
        added_at: "2026-09-12T10:00:00.000Z",
      },
    ]);
    expect(entries[0]).toEqual({
      path: "packages/app/src/generated/**",
      draft: "b7b0f3e2-0000-4000-8000-000000000001",
      source: "PRB-142",
      added_at: "2026-09-12T10:00:00.000Z",
    });
  });

  it("reads a bare glob as an entry nobody's draft owns", () => {
    const [entry] = StandingProhibitedSchema.parse(["specs/**"]);
    expect(entry?.path).toBe("specs/**");
    expect(entry?.draft).toBeNull();
    expect(entry?.source).toBe("written in .perbo/config.json");
  });

  it("reads the key off a configuration, and answers nothing where it is absent or malformed", () => {
    expect(readStandingProhibited({ paths_prohibited: ["infra/**"] }).map((entry) => entry.path)).toEqual([
      "infra/**",
    ]);
    expect(readStandingProhibited({})).toEqual([]);
    expect(readStandingProhibited(null)).toEqual([]);
    expect(readStandingProhibited({ paths_prohibited: "infra/**" })).toEqual([]);
    expect(readStandingProhibited({ paths_prohibited: [{ path: "" }] })).toEqual([]);
  });

  it("writes a directory as the glob that covers it and a file as itself", () => {
    expect(standingGlob("packages/app/src/generated/")).toBe("packages/app/src/generated/**");
    expect(standingGlob("packages/app/src/theme.ts")).toBe("packages/app/src/theme.ts");
  });
});
