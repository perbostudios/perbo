import { describe, expect, it } from "vitest";
import { onePieceOfWork } from "./paths.js";

/**
 * A spec is one piece of work's, in a folder of its own under the folder this
 * repository keeps its specs in (D-103). `perbo admit --from-spec` and the
 * interview's `--spec` both read this, so it lives here rather than in either
 * of them, and the invariant is stated once here rather than a case per caller.
 */
describe("a spec that is one piece of work's", () => {
  const specs = "specs";

  it("takes a spec in a folder of its own, whatever the file is called", () => {
    expect(onePieceOfWork("specs/activation-email/spec.md", specs)).toBe(
      "specs/activation-email/spec.md",
    );

    expect(onePieceOfWork("specs/activation-email/notes.md", specs)).toBe(
      "specs/activation-email/notes.md",
    );
    // A configured folder is read the same way.
    expect(onePieceOfWork("docs/specs/x/spec.md", "docs/specs")).toBe("docs/specs/x/spec.md");
  });

  it("refuses every spelling whose folder is not one piece of work's", () => {
    for (const spelling of [
      // The repository itself, which is what a spec with no folder lands in.
      "spec.md",
      // The spec folder itself, which holds every piece of work's.
      "specs/spec.md",
      "specs/x/../spec.md",
      "specs/./spec.md",
      // A folder the repository keeps other things in.
      "docs/spec.md",
      "notes/deep/spec.md",
      // Inside another spec's folder, which is taken whole.
      "specs/inbox/retry/spec.md",
      // Padded, which is a different folder than the one that was meant.
      " specs/x/spec.md",
      "specs/x/spec.md ",
      // A name that starts with the folder's but is not under it.
      "specsfoo/x/spec.md",
      // Out of the repository, by climbing or by naming.
      "specs/x/../../elsewhere/spec.md",
      "../specs/x/spec.md",
      "/etc/specs/x/spec.md",
      "C:/specs/x/spec.md",
      "specs\\x\\spec.md",
      // A Windows separator inside a segment, which would otherwise read as a folder.
      "specs/a\\b/spec.md",
      // Nothing at all.
      "",
      "specs/",
    ]) {
      expect(onePieceOfWork(spelling, specs), spelling).toBeNull();
    }
  });

  it("judges where the path lands, not how it is spelled", () => {
    // The same folder, three spellings, one answer.
    for (const spelling of [
      "specs/activation-email/spec.md",
      "specs/activation-email/./spec.md",
      "specs/activation-email/nodes/../spec.md",
    ]) {
      expect(onePieceOfWork(spelling, specs)).toBe("specs/activation-email/spec.md");
    }
  });
});
