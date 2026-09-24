import { describe, expect, it } from "vitest";
import { specSlugOf } from "./spec-slug.js";

describe("the spec a ticket was drafted from", () => {
  it("is the folder's name where the recorded path is a spec in the repository's spec folder", () => {
    expect(specSlugOf("specs/activation-email/spec.md", "specs")).toBe("activation-email");
    expect(specSlugOf("docs/specs/activation-email/spec.md", "docs/specs")).toBe("activation-email");
  });

  it("is none where the path is outside the folder the repository keeps specs in", () => {
    expect(specSlugOf("specs/activation-email/spec.md", "docs/specs")).toBeNull();
    expect(specSlugOf("docs/specs/activation-email/spec.md", "specs")).toBeNull();
    expect(specSlugOf("specs/a/b/spec.md", "specs")).toBeNull();
    expect(specSlugOf("specs/activation-email/notes.md", "specs")).toBeNull();
    expect(specSlugOf("specs/Activation Email/spec.md", "specs")).toBeNull();
    expect(specSlugOf(null, "specs")).toBeNull();
    expect(specSlugOf(undefined, "specs")).toBeNull();
  });

  it("is none for a path that climbs out with `..`, or steps with `.`, even where it lands inside", () => {
    expect(specSlugOf("specs/../elsewhere/spec.md", "specs")).toBeNull();
    expect(specSlugOf("specs/../../outside/spec.md", "specs")).toBeNull();
    expect(specSlugOf("specs/other/../activation-email/spec.md", "specs")).toBeNull();
    expect(specSlugOf("specs/../spec.md", "specs")).toBeNull();
    expect(specSlugOf("./specs/activation-email/spec.md", "specs")).toBeNull();
  });
});
