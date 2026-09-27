import { describe, expect, it } from "vitest";
import { installFailure } from "./runnable.js";

describe("why a pinned repository did not install", () => {
  it("says the reason and the line after it, whole (D-NEW-nothing-shown-is-cut)", () => {
    const named = "ERR_PNPM_OUTDATED_LOCKFILE Cannot install with \"frozen-lockfile\" because pnpm-lock.yaml is not up to date with packages/app/package.json";
    const detail =
      "Failure reason: specifiers in the lockfile ({\"react\":\"^18.2.0\",\"react-dom\":\"^18.2.0\"}) don't match specs in package.json ({\"react\":\"^19.0.0\",\"react-dom\":\"^19.0.0\"})";
    const said = installFailure(`${named}\n${detail}\n(Use \`node --trace-deprecation ...\`)`, "");
    expect(said.length).toBeGreaterThan(220);
    expect(said).toBe(`${named} — ${detail}`);
  });
});
