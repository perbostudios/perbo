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

function parse(source: Source): ts.SourceFile {
  return ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true);
}

/** Every file that declares the name as an interface or a type alias. */
function declarations(sources: readonly Source[]): string[] {
  const found: string[] = [];
  for (const source of sources) {
    const visit = (node: ts.Node): void => {
      if (
        (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
        node.name.text === NAME
      ) {
        found.push(source.path);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(parse(source), visit);
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
function reachesElsewhere(sources: readonly Source[]): string[] {
  const found: string[] = [];
  for (const source of sources) {
    const visit = (node: ts.Node): void => {
      const bindings = ts.isImportDeclaration(node)
        ? node.importClause?.namedBindings
        : ts.isExportDeclaration(node) && node.moduleSpecifier
          ? node.exportClause
          : undefined;
      const specifier =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : undefined;
      if (
        bindings &&
        specifier &&
        ts.isStringLiteral(specifier) &&
        (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) &&
        bindings.elements.some((element) => bindsName(element)) &&
        !specifier.text.endsWith(HOME_SPECIFIER)
      ) {
        found.push(`${source.path}: ${specifier.text}`);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(parse(source), visit);
  }
  return found.sort();
}

const FILES = sources();

describe("the three writes every command is given", () => {
  it("is declared once, in streams.ts", () => {
    expect(declarations(FILES)).toEqual([HOME]);
  });

  it("is imported from streams.ts and nowhere else", () => {
    expect(reachesElsewhere(FILES)).toEqual([]);
  });
});

describe("what the scan refuses", () => {
  const planted = (path: string, text: string): Source[] => [{ path, text }];

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
});
