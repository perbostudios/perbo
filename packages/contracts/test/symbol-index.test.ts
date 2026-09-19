import { describe, expect, it } from "vitest";
import {
  SYMBOL_INDEX_SCHEMA_VERSION,
  SymbolIndexSchema,
  UnsupportedRepositorySchema,
} from "../src/symbol-index.js";

/** A record of the shape `perbo index` writes, with one file in it. */
const INDEX = {
  schema_version: SYMBOL_INDEX_SCHEMA_VERSION,
  built_at: "2026-09-12T09:00:00.000Z",
  head_commit: "0123456789abcdef0123456789abcdef01234567",
  working_tree: "clean",
  files: [
    {
      path: "src/a.ts",
      exports: [{ name: "a", kind: "function", line: 3 }],
      imports: [{ specifier: "./b.js", resolved: "src/b.ts", external: false, line: 1 }],
    },
  ],
  skipped: [{ path: "src/huge.ts", reason: "2.1 MiB, over the 1 MiB cap" }],
};

describe("the symbol index record", () => {
  it("parses the record the command writes", () => {
    expect(SymbolIndexSchema.parse(INDEX)).toEqual(INDEX);
  });

  /**
   * The whole point of the strict object: a consumer reads this file to decide
   * whether a symbol still exists, and a field it does not understand is a
   * producer it does not understand. Refusing is what makes `schema_version` a
   * promise rather than a label.
   */
  it("refuses a record carrying a field it does not name", () => {
    expect(() => SymbolIndexSchema.parse({ ...INDEX, symbols: [] })).toThrow();
    expect(() =>
      SymbolIndexSchema.parse({
        ...INDEX,
        files: [{ ...INDEX.files[0], language: "typescript" }],
      }),
    ).toThrow();
    expect(() =>
      SymbolIndexSchema.parse({
        ...INDEX,
        files: [
          {
            ...INDEX.files[0],
            imports: [{ ...INDEX.files[0]!.imports[0], kind: "static" }],
          },
        ],
      }),
    ).toThrow();
  });

  it("refuses a record written against another schema version", () => {
    expect(() =>
      SymbolIndexSchema.parse({ ...INDEX, schema_version: SYMBOL_INDEX_SCHEMA_VERSION + 1 }),
    ).toThrow();
  });

  it("takes a resolved of null, which is an import inside the repository that lands nowhere", () => {
    const parsed = SymbolIndexSchema.parse({
      ...INDEX,
      files: [
        {
          path: "src/a.ts",
          exports: [],
          imports: [{ specifier: "./gone.js", resolved: null, external: false, line: 1 }],
        },
      ],
    });
    expect(parsed.files[0]!.imports[0]!.resolved).toBeNull();
  });

  it("names the extensions it saw in an unsupported repository's answer", () => {
    const answer = UnsupportedRepositorySchema.parse({
      supported: false,
      reason: "no tracked TypeScript or JavaScript file",
      languages_seen: [".md", ".py"],
    });
    expect(answer.languages_seen).toEqual([".md", ".py"]);
    expect(() =>
      UnsupportedRepositorySchema.parse({ supported: true, reason: "x", languages_seen: [] }),
    ).toThrow();
  });
});
