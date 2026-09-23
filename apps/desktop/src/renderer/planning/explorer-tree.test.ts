import { describe, expect, it } from "vitest";
import { EditingFormSchema, type EditingForm } from "../../shared/protocol.js";
import { rowMark, viaLabel } from "./explorer-tree.js";

/**
 * Which prohibited folder a row sits under.
 *
 * A row the draft prohibits through a folder is not marked itself; it says
 * which folder holds it, so a person reading the Explorer can see why a file
 * they did not mark is out of scope. The question is the same one a glob
 * answers everywhere else, so it is asked of the one matcher: a folder glob
 * with a wildcard above the folder covers a row exactly as admission reads it.
 */

const form = (prohibited: readonly string[]): EditingForm =>
  EditingFormSchema.parse({
    draft: { outcome: "", criteria: [], paths: [], prohibited },
    models: {},
    step: 1,
    editing: null,
    criterion: { text: "", assertion: "", kind: "test" },
    newPath: null,
  });

const via = (prohibited: readonly string[], path: string): string | null =>
  rowMark(form(prohibited), [], path).via;

describe("the prohibited folder a row sits under", () => {
  it("reads a wildcard above the folder, as every other glob is read", () => {
    expect(via(["packages/*/generated/**"], "packages/a/generated/x.ts")).toBe(
      "packages/*/generated/**",
    );
    expect(via(["packages/*/generated/**"], "packages/a/src/x.ts")).toBeNull();
  });

  it("reads a literal folder glob", () => {
    expect(via(["src/gen/**"], "src/gen/x.ts")).toBe("src/gen/**");
    expect(via(["src/gen/**"], "src/genx.ts")).toBeNull();
  });

  it("covers a folder row as well as a file", () => {
    expect(via(["src/gen/**"], "src/gen/nested/")).toBe("src/gen/**");
  });

  it("says nothing for the row that carries the mark itself", () => {
    expect(via(["src/gen/**"], "src/gen/")).toBeNull();
    expect(via(["src/one.ts"], "src/one.ts")).toBeNull();
  });

  it("names the folder a prohibition was inherited from", () => {
    expect(viaLabel("packages/*/generated/**")).toBe("generated/");
  });
});
