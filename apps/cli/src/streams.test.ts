import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * `Streams` is declared once, in `streams.ts`, and every module that takes it
 * reads it from there.
 *
 * The interface is three function-and-flag fields, so a second copy typechecks
 * against the first and nothing goes red: structural typing means a duplicate
 * is invisible to the compiler, and the only thing that notices is a reader
 * wondering which one a command means. Two copies also make the module that
 * happens to hold one — a command, say — the place other modules import the
 * interface from, which is how a command ends up on the import graph of every
 * module that only wanted to write to stdout.
 *
 * So this parses the package's own sources and holds two properties: one
 * declaration, in `streams.ts`; and every import or re-export of the name
 * carries a specifier ending in `streams.js`. An alias on either side of the
 * import counts, because `import { Streams as Writes } from "./admit.js"` is
 * the same reach through a command by another name.
 */

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");

/** The interface this file is about, and the module that may declare it. */
const NAME = "Streams";
const HOME = "src/streams.ts";

/** The suffix a specifier for the home module ends in, whatever the depth. */
const HOME_SPECIFIER = "streams.js";

/**
 * The compiler functions the walks call, read off the module once. The
 * `typescript` module exports each of them as a getter, and a walk that reads
 * `ts.isImportDeclaration` at every one of several hundred thousand nodes
 * spends most of its time in those getters rather than in the checks.
 */
const {
  forEachChild,
  isExportDeclaration,
  isImportDeclaration,
  isInterfaceDeclaration,
  isNamedExports,
  isNamedImports,
  isStringLiteral,
  isTypeAliasDeclaration,
} = ts;

/** A file as the scan reads it: its path from the package root, and its text. */
interface Source {
  readonly path: string;
  readonly text: string;
}

/**
 * The `.ts` files under `src` and `test`. `test/fixtures` is an authored
 * repository `perbo index` reads rather than code this package runs, and is
 * skipped for the same reason vitest skips it.
 */
function sources(): Source[] {
  const found: Source[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "fixtures" || entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        found.push({ path: relative(PACKAGE_ROOT, full), text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(join(PACKAGE_ROOT, "src"));
  walk(join(PACKAGE_ROOT, "test"));
  return found;
}

/**
 * An escape in an identifier or a string literal, and what it stands for:
 * `\u{…}` and `\uXXXX` (identifiers and strings), `\xXX` and a legacy octal
 * escape (strings), a line continuation (strings, standing for nothing), and
 * any other escaped character, which stands for itself (`"Stre\ams"` is
 * `Streams`). A single escape such as `\t` maps to its letter rather than its
 * control character, which can only let a file through that did not need to be.
 */
const ESCAPE =
  /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([0-7]{1,3})|(\r\n|[\r\n\u2028\u2029])|([\s\S]))/g;

function unescaped(text: string): string {
  return text.replace(
    ESCAPE,
    (_, braced?: string, four?: string, two?: string, octal?: string, continuation?: string, other?: string) => {
      const hex = braced ?? four ?? two;
      if (hex !== undefined) {
        const point = Number.parseInt(hex, 16);
        return point <= 0x10ffff ? String.fromCodePoint(point) : "";
      }
      if (octal !== undefined) return String.fromCharCode(Number.parseInt(octal, 8));
      if (continuation !== undefined) return "";
      return other ?? "";
    },
  );
}

/**
 * Whether a file can declare, import or re-export the name at all, read from
 * its text before anything is parsed. A declaration binds the name as an
 * identifier, and an import or re-export binds it as an identifier or a string
 * (`import { "Streams" as Writes }`), so either way the name is spelled in the
 * file's text, once escapes are undone: an identifier may spell a letter as
 * `\u0061`, and a string as `\x61`, `\141`, `\a` or across a line
 * continuation, and the parser reads each of those as the name. Undoing escapes
 * never removes a literal occurrence, because the name opens with `S`, which is
 * not a digit that a `\x`, `\u` or octal escape before it could consume. So a
 * file this returns false for has no token that is the name, and parsing it
 * could find nothing.
 */
function mayBind(text: string): boolean {
  return text.includes(NAME) || unescaped(text).includes(NAME);
}

/**
 * Each file that may bind the name, parsed once. Parent pointers are not set,
 * since neither scan walks upward.
 */
function parsed(sources: readonly Source[]): ts.SourceFile[] {
  return sources
    .filter((source) => mayBind(source.text))
    .map((source) => ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, false));
}

/** Every file that declares the name as an interface or a type alias. */
function declarations(files: readonly ts.SourceFile[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (
        (isInterfaceDeclaration(node) || isTypeAliasDeclaration(node)) &&
        node.name.text === NAME
      ) {
        found.push(file.fileName);
      }
      forEachChild(node, visit);
    };
    forEachChild(file, visit);
  }
  return found.sort();
}

/** Whether a named import or export binds the name, under either spelling. */
function bindsName(element: ts.ImportSpecifier | ts.ExportSpecifier): boolean {
  return element.name.text === NAME || element.propertyName?.text === NAME;
}

/**
 * Every import or re-export of the name that names a module other than the
 * home, as `<file>: <specifier>`.
 */
function reachesElsewhere(files: readonly ts.SourceFile[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      const bindings = isImportDeclaration(node)
        ? node.importClause?.namedBindings
        : isExportDeclaration(node) && node.moduleSpecifier
          ? node.exportClause
          : undefined;
      const specifier =
        isImportDeclaration(node) || isExportDeclaration(node)
          ? node.moduleSpecifier
          : undefined;
      if (
        bindings &&
        specifier &&
        isStringLiteral(specifier) &&
        (isNamedImports(bindings) || isNamedExports(bindings)) &&
        bindings.elements.some((element) => bindsName(element)) &&
        !specifier.text.endsWith(HOME_SPECIFIER)
      ) {
        found.push(`${file.fileName}: ${specifier.text}`);
      }
      forEachChild(node, visit);
    };
    forEachChild(file, visit);
  }
  return found.sort();
}

/**
 * The package's files that may bind the name, read and parsed once when this
 * module loads and shared by both properties. The parse is most of the scan's
 * cost and grows with the package, and no test's timeout counts the time a
 * module takes to load, so what each test pays is a walk of trees it is given.
 */
const FILES = parsed(sources());

describe("the three writes every command is given", () => {
  it("is declared once, in streams.ts", () => {
    expect(declarations(FILES)).toEqual([HOME]);
  });

  it("is imported from streams.ts and nowhere else", () => {
    expect(reachesElsewhere(FILES)).toEqual([]);
  });
});

describe("what the scan refuses", () => {
  const planted = (path: string, text: string): ts.SourceFile[] => parsed([{ path, text }]);

  it("names a second declaration", () => {
    expect(
      declarations([
        ...planted(HOME, `export interface ${NAME} { isTTY: boolean }`),
        ...planted("src/commands/admit.ts", `interface ${NAME} { isTTY: boolean }`),
      ]),
    ).toEqual(["src/commands/admit.ts", HOME]);
  });

  it("names a type alias of the same name", () => {
    expect(
      declarations(planted("src/commands/sync.ts", `type ${NAME} = { isTTY: boolean };`)),
    ).toEqual(["src/commands/sync.ts"]);
  });

  it("names an import that reaches a command for it", () => {
    expect(
      reachesElsewhere(planted("src/commands/edit/index.ts", `import type { ${NAME} } from "../admit.js";`)),
    ).toEqual(["src/commands/edit/index.ts: ../admit.js"]);
  });

  it("sees through an alias", () => {
    expect(
      reachesElsewhere(planted("src/commands/stops.ts", `import type { ${NAME} as Writes } from "./admit.js";`)),
    ).toEqual(["src/commands/stops.ts: ./admit.js"]);
  });

  it("sees a re-export that names another module", () => {
    expect(
      reachesElsewhere(planted("src/index.ts", `export type { ${NAME} } from "./commands/admit.js";`)),
    ).toEqual(["src/index.ts: ./commands/admit.js"]);
  });

  it("passes an import of the home module at any depth", () => {
    expect(
      reachesElsewhere([
        ...planted("src/commands/agent.ts", `import type { ${NAME} } from "../streams.js";`),
        ...planted("src/commands/run/local.ts", `import type { ${NAME} } from "../../streams.js";`),
      ]),
    ).toEqual([]);
  });

  it("sees a declaration that spells the name with an escape", () => {
    expect(
      declarations(planted("src/commands/admit.ts", "interface Stre\\u0061ms { isTTY: boolean }")),
    ).toEqual(["src/commands/admit.ts"]);
  });

  it("sees an import that spells the name as an escaped string", () => {
    expect(
      reachesElsewhere([
        ...planted("src/commands/a.ts", 'import type { "Stre\\x61ms" as Writes } from "./admit.js";'),
        ...planted("src/commands/b.ts", 'import type { "Stre\\ams" as Writes } from "./admit.js";'),
        ...planted("src/commands/c.ts", 'import type { "\\123treams" as Writes } from "./admit.js";'),
        ...planted("src/commands/d.ts", 'import type { "Stre\\\nams" as Writes } from "./admit.js";'),
      ]),
    ).toEqual([
      "src/commands/a.ts: ./admit.js",
      "src/commands/b.ts: ./admit.js",
      "src/commands/c.ts: ./admit.js",
      "src/commands/d.ts: ./admit.js",
    ]);
  });

  it("leaves unparsed a file whose text cannot spell the name", () => {
    expect(planted("src/commands/sync.ts", "export const streams = { isTTY: true };")).toEqual([]);
  });
});
