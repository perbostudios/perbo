import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { createScratch } from "@perbo/test-support";

/**
 * No suite in this package reads the corpus except through the gate.
 *
 * `corpus-present.ts` is what makes absence observable: it checks the directory
 * exists, loads it once, and hands `describeCorpus` to the suites whose subject
 * *is* the corpus, so a tree carrying the harness without the corpus skips them
 * rather than failing. A suite that loads the corpus itself steps around all of
 * that — it reads while collecting, before a skip can apply, and the absence
 * gate never sees the read. `expectation-reachability.test.ts` was that suite.
 *
 * So the rule this scans for, in the one directory tree it applies to — `test/`
 * and everything under it, since that is what vitest's `include` collects:
 *
 *   - no `.test.ts` file holds the loader at all; the corpus arrives as
 *     `corpus`, and the sample as `sample`;
 *   - among the helper modules beside them, only `corpus-present.ts` calls it
 *     with no directory, since a call that names its own directory is a read
 *     the reader can see (`sample-fixtures.ts` names `sample/fixtures`);
 *   - and no file but the gate hands the loader on, since a re-export would put
 *     it within reach of a suite under a name that is not its own.
 *
 * The scan is two halves that catch different things. The textual half looks
 * for the loader's name against its parenthesis, which is the spelling anyone
 * writing this by accident uses. The structural half parses each file and
 * follows the loader from the module that exports it to the local name it
 * arrives under, so `import { loadCorpus as load }` and `load()` — invisible to
 * any text search for the call — is caught as the same offence. `typescript` is
 * already this package's compiler; its parser is what knows what an import is.
 */

const TEST_DIR = import.meta.dirname;
const SRC_DIR = resolve(TEST_DIR, "..", "src");

/** This package's own name, since `src/index.ts` re-exports the loader too. */
const PACKAGE_NAME = "@perbo/evaluation";

/** The single file allowed to leave the corpus directory to the loader. */
const GATE = "corpus-present.ts";

/**
 * The loader's name, never written in this file next to its own parenthesis:
 * this file is inside the directory it scans, and the literal would make it the
 * first offence found. Every planted example below is built from this constant
 * for the same reason.
 */
const LOADER = "loadCorpus";

/** The call, for a failure message that has to name it without the scan matching. */
const CALL_TEXT = `${LOADER}()`;

/**
 * Spelled with `\s*` between the name and its parenthesis, so a call broken
 * across lines is still one.
 */
const TEXTUAL_CALL = new RegExp(`\\b${LOADER}\\s*\\(`);
const TEXTUAL_BARE = new RegExp(`\\b${LOADER}\\s*\\(\\s*\\)`);

/* ------------------------------------------------------------------ *
 * Which modules the loader can arrive from
 * ------------------------------------------------------------------ */

/** What a module hands out that reaches the loader: exported names, and namespace objects. */
interface Exposure {
  /** Exported names bound to the loader itself. */
  names: Set<string>;
  /** Exported names bound to a namespace object that carries it. */
  namespaces: Set<string>;
}

function emptyExposure(): Exposure {
  return { names: new Set<string>(), namespaces: new Set<string>() };
}

function reachesLoader(exposure: Exposure | undefined): boolean {
  return exposure !== undefined && exposure.names.size + exposure.namespaces.size > 0;
}

function parseFile(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ESNext, true);
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/** Every `.ts` file under `dir`, including subdirectories. */
function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return tsFilesUnder(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    })
    .sort();
}

/**
 * The file a specifier names, when it is one this package owns, else null.
 * `.js` is how an ESM source spells a `.ts` file here.
 */
function resolveModule(fromFile: string, specifier: string): string | null {
  if (specifier === PACKAGE_NAME) return join(SRC_DIR, "index.ts");
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base.replace(/\.js$/, ".ts"), base, `${base}.ts`, join(base, "index.ts")];
  return candidates.find((candidate) => candidate.endsWith(".ts") && existsSync(candidate)) ?? null;
}

interface SrcFacts {
  declaresLoader: boolean;
  /** `export * from X`. */
  star: string[];
  /** `export { imported as exported } from X`. */
  named: Array<{ from: string; imported: string; exported: string }>;
  /** `export * as exported from X`. */
  starAs: Array<{ from: string; exported: string }>;
}

function srcFacts(path: string): SrcFacts {
  const source = parseFile(path);
  const facts: SrcFacts = { declaresLoader: false, star: [], named: [], starAs: [] };

  for (const statement of source.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === LOADER &&
      isExported(statement)
    ) {
      facts.declaresLoader = true;
    }
    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === LOADER) {
          facts.declaresLoader = true;
        }
      }
    }

    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier;
    if (specifier === undefined || !ts.isStringLiteralLike(specifier)) continue;
    const from = resolveModule(path, specifier.text);
    if (from === null) continue;

    const clause = statement.exportClause;
    if (clause === undefined) {
      facts.star.push(from);
      continue;
    }
    if (ts.isNamespaceExport(clause)) {
      facts.starAs.push({ from, exported: clause.name.text });
      continue;
    }
    for (const element of clause.elements) {
      if (element.isTypeOnly) continue;
      facts.named.push({
        from,
        imported: (element.propertyName ?? element.name).text,
        exported: element.name.text,
      });
    }
  }

  return facts;
}

/**
 * Every module under `src/` the loader can be imported from, and the names it
 * arrives under there.
 *
 * `src/corpus.ts` declares it and `src/index.ts` re-exports that whole file, so
 * a suite could reach the loader from either — a scan that knew only the first
 * path would not see the second. Re-export edges are followed to a fixpoint, so
 * a chain of them is one too.
 */
function loaderModules(srcDir: string): Map<string, Exposure> {
  const facts = new Map(tsFilesUnder(srcDir).map((path) => [path, srcFacts(path)] as const));
  const exposure = new Map<string, Exposure>();

  for (const [path, fact] of facts) {
    if (fact.declaresLoader) exposure.set(path, { names: new Set([LOADER]), namespaces: new Set() });
  }

  for (let changed = true; changed; ) {
    changed = false;
    for (const [path, fact] of facts) {
      const here = exposure.get(path) ?? emptyExposure();
      const before = here.names.size + here.namespaces.size;

      for (const from of fact.star) {
        const source = exposure.get(from);
        if (source === undefined) continue;
        for (const name of source.names) here.names.add(name);
        for (const name of source.namespaces) here.namespaces.add(name);
      }
      for (const edge of fact.named) {
        const source = exposure.get(edge.from);
        if (source === undefined) continue;
        if (source.names.has(edge.imported)) here.names.add(edge.exported);
        if (source.namespaces.has(edge.imported)) here.namespaces.add(edge.exported);
      }
      for (const edge of fact.starAs) {
        if (reachesLoader(exposure.get(edge.from))) here.namespaces.add(edge.exported);
      }

      if (here.names.size + here.namespaces.size > before) {
        exposure.set(path, here);
        changed = true;
      }
    }
  }

  return exposure;
}

/* ------------------------------------------------------------------ *
 * What one file in the scanned directory does with the loader
 * ------------------------------------------------------------------ */

interface LoaderCall {
  /** Whether the call states which directory it reads, rather than leaving it to the loader. */
  namesDirectory: boolean;
}

interface Read {
  /** Local names in this file bound to the loader, under whatever spelling. */
  holds: string[];
  /** Local names bound to a namespace object that carries it. */
  namespaces: string[];
  calls: LoaderCall[];
  /** Names this file exports that hand the loader on to another file. */
  handsOn: string[];
}

function forEachNode(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => forEachNode(child, visit));
}

/** `x`, `(x)`, `x as T`, `x!` — the expression under the syntax that does not change it. */
function unwrap(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return unwrap(expression.expression);
  }
  return expression;
}

/** The module a `import(...)` / `require(...)` expression names, resolved. */
function importedModule(expression: ts.Expression, fromFile: string): string | null {
  const call = unwrap(ts.isAwaitExpression(expression) ? expression.expression : expression);
  if (!ts.isCallExpression(call)) return null;
  const isDynamicImport = call.expression.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire = ts.isIdentifier(call.expression) && call.expression.text === "require";
  const [specifier] = call.arguments;
  if (!isDynamicImport && !isRequire) return null;
  if (specifier === undefined || !ts.isStringLiteralLike(specifier)) return null;
  return resolveModule(fromFile, specifier.text);
}

/**
 * What `path` does with the loader: the names it reaches it by, the calls it
 * makes through them, and whether it hands it on.
 *
 * Bindings are followed rather than matched: a named import under an alias, a
 * namespace import and a property off it, a destructured dynamic `import()`,
 * and a local `const` copy of any of those all end up in `holds`, so the rules
 * below do not depend on how the loader is spelled at the call.
 */
function readOfLoader(path: string, modules: Map<string, Exposure>): Read {
  const source = parseFile(path);
  const holds = new Set<string>();
  const namespaces = new Map<string, Exposure>();
  /** Aliases produced by `.bind(this, dir)`: calling one still names a directory. */
  const boundToDirectory = new Set<string>();
  const handsOn = new Set<string>();

  const moduleOf = (specifier: ts.Expression): Exposure | null => {
    if (!ts.isStringLiteralLike(specifier)) return null;
    const resolved = resolveModule(path, specifier.text);
    return resolved === null ? null : (modules.get(resolved) ?? null);
  };

  /** The name an import or export element refers to in the module it came from. */
  const importedName = (element: ts.ImportSpecifier | ts.ExportSpecifier | ts.BindingElement): string => {
    const name = element.propertyName ?? element.name;
    return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : "";
  };

  /** `export { x as y }` with no module of its own, judged once the aliases are known. */
  const localExports: ts.ExportSpecifier[] = [];

  // Static imports, and the re-exports that would hand the loader on.
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) {
      const exposure = moduleOf(statement.moduleSpecifier);
      const bindings = statement.importClause?.namedBindings;
      if (exposure === null || bindings === undefined) continue;
      if (ts.isNamespaceImport(bindings)) {
        namespaces.set(bindings.name.text, exposure);
        continue;
      }
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        const imported = importedName(element);
        if (exposure.names.has(imported)) holds.add(element.name.text);
        if (exposure.namespaces.has(imported)) namespaces.set(element.name.text, exposure);
      }
      continue;
    }

    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier;
    const exposure = specifier === undefined ? null : moduleOf(specifier);
    const clause = statement.exportClause;
    if (exposure !== null && clause === undefined) {
      handsOn.add("*");
      continue;
    }
    if (exposure !== null && clause !== undefined && ts.isNamespaceExport(clause)) {
      if (reachesLoader(exposure)) handsOn.add(clause.name.text);
      continue;
    }
    if (clause === undefined || !ts.isNamedExports(clause)) continue;
    for (const element of clause.elements) {
      if (element.isTypeOnly) continue;
      if (exposure === null) {
        // `export { load }` names something this file holds; which, is known below.
        localExports.push(element);
        continue;
      }
      const imported = importedName(element);
      if (exposure.names.has(imported) || exposure.namespaces.has(imported)) {
        handsOn.add(element.name.text);
      }
    }
  }

  /** Whether an expression evaluates to the loader itself. */
  const isLoader = (expression: ts.Expression): boolean => {
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) return holds.has(node.text);
    if (ts.isPropertyAccessExpression(node)) {
      return namespaceCarries(node.expression, node.name.text);
    }
    if (ts.isElementAccessExpression(node)) {
      const argument = node.argumentExpression;
      return (
        ts.isStringLiteralLike(argument) && namespaceCarries(node.expression, argument.text)
      );
    }
    // `loadCorpus.bind(this, dir)` is still the loader.
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      return (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "bind" &&
        isLoader(callee.expression)
      );
    }
    return false;
  };

  function namespaceCarries(target: ts.Expression, member: string): boolean {
    const node = unwrap(target);
    if (!ts.isIdentifier(node)) return false;
    const exposure = namespaces.get(node.text);
    return exposure !== undefined && exposure.names.has(member);
  }

  // Local aliases and destructured dynamic imports, to a fixpoint: `const load =
  // loadCorpus; const again = load;` reaches the loader by both names.
  for (let changed = true; changed; ) {
    const before = holds.size + namespaces.size + boundToDirectory.size;
    forEachNode(source, (node) => {
      if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return;
      const initializer = node.initializer;

      const fromImport = importedModule(initializer, path);
      const exposure = fromImport === null ? null : (modules.get(fromImport) ?? null);
      if (exposure !== null) {
        if (ts.isIdentifier(node.name)) namespaces.set(node.name.text, exposure);
        if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const imported = importedName(element);
            if (!ts.isIdentifier(element.name)) continue;
            if (exposure.names.has(imported)) holds.add(element.name.text);
            if (exposure.namespaces.has(imported)) namespaces.set(element.name.text, exposure);
          }
        }
        return;
      }

      if (!ts.isIdentifier(node.name) || !isLoader(initializer)) return;
      holds.add(node.name.text);
      const bind = unwrap(initializer);
      if (ts.isCallExpression(bind) && bind.arguments.length > 1) {
        boundToDirectory.add(node.name.text);
      }
    });
    changed = holds.size + namespaces.size + boundToDirectory.size > before;
  }

  // The hand-offs that go through a local name, now that the local names are
  // known: `const copy = load; export { copy };` and `export const copy = load;`.
  for (const element of localExports) {
    if (holds.has(importedName(element)) || namespaces.has(importedName(element))) {
      handsOn.add(element.name.text);
    }
  }
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || !isExported(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const name = declaration.name.text;
      if (holds.has(name) || namespaces.has(name)) handsOn.add(name);
    }
  }

  // Every call that reaches the loader, and whether it stated a directory.
  const calls: LoaderCall[] = [];
  forEachNode(source, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = unwrap(node.expression);

    if (isLoader(callee)) {
      if (ts.isCallExpression(callee)) return; // `f.bind(...)` is not itself a read
      const bound = ts.isIdentifier(callee) && boundToDirectory.has(callee.text);
      calls.push({ namesDirectory: bound || node.arguments.length > 0 });
      return;
    }

    // `loadCorpus.call(this, dir)` and `.apply(this, [dir])` reach it too.
    if (
      ts.isPropertyAccessExpression(callee) &&
      (callee.name.text === "call" || callee.name.text === "apply") &&
      isLoader(callee.expression)
    ) {
      calls.push({ namesDirectory: node.arguments.length > 1 });
    }
  });

  return {
    holds: [...holds].sort(),
    namespaces: [...namespaces.keys()].sort(),
    calls,
    handsOn: [...handsOn].sort(),
  };
}

/* ------------------------------------------------------------------ *
 * The scan
 * ------------------------------------------------------------------ */

interface Offence {
  file: string;
  message: string;
}

/**
 * Every `.ts` file under `dir`, named by its path relative to `dir`.
 *
 * The walk goes down, because vitest's own `include` does: it collects a suite
 * one directory below just as it collects one beside this file, and a scan that
 * read only the top level would report an empty list for a directory it had
 * never opened. Relative paths rather than bare names, so a failure names the
 * file the way a reader would have to go and find it.
 */
function tsFiles(dir: string): string[] {
  return tsFilesUnder(dir)
    .map((path) => relative(dir, path).replaceAll("\\", "/"))
    .sort();
}

const SUITE_REMEDY =
  `A suite reads the corpus through ${GATE} — \`corpus\` behind \`describeCorpus\`, or \`sample\` ` +
  "from `sample-fixtures.ts` — so the run skips instead of failing in a tree that carries the " +
  "harness without the corpus.";

const HELPER_REMEDY = `Name the directory, or take the corpus from ${GATE}.`;

/**
 * Every file in `dir` that reads the corpus outside the gate, named, with the
 * sentence a reader needs to fix it.
 *
 * `gate` is a parameter so the scan can be run with nothing exempt, which is how
 * a test shows it is reading these files rather than reporting an empty list.
 */
function unguardedCorpusReads(
  dir: string,
  options: { modules: Map<string, Exposure>; gate?: string },
): Offence[] {
  const gate = options.gate ?? GATE;
  const offences: Offence[] = [];

  for (const file of tsFiles(dir)) {
    if (file === gate) continue;
    const path = join(dir, file);
    const source = readFileSync(path, "utf8");
    const suite = file.endsWith(".test.ts");
    const read = readOfLoader(path, options.modules);
    const reasons: string[] = [];

    if (suite && TEXTUAL_CALL.test(source)) {
      reasons.push(`calls ${CALL_TEXT} itself.`);
    }
    if (suite && read.holds.length + read.namespaces.length > 0) {
      reasons.push(
        `holds the loader as ${[...read.holds, ...read.namespaces].map((name) => `\`${name}\``).join(", ")}, ` +
          `so it can read the corpus under a name a search for ${CALL_TEXT} would not find.`,
      );
    }
    if (!suite && TEXTUAL_BARE.test(source)) {
      reasons.push(
        `calls ${CALL_TEXT} with no directory, so what it reads depends on PERBO_EVAL_CORPUS_DIR ` +
          "and nothing here says so.",
      );
    }
    if (!suite && read.calls.some((call) => !call.namesDirectory)) {
      reasons.push("calls the loader with no directory, leaving what it reads to the environment.");
    }
    if (read.handsOn.length > 0) {
      reasons.push(
        `re-exports the loader as ${read.handsOn.map((name) => `\`${name}\``).join(", ")}, which ` +
          "puts it within reach of a suite under a name that is not its own.",
      );
    }

    if (reasons.length > 0) {
      offences.push({
        file,
        message: `${file} ${reasons.join(" ")} ${suite ? SUITE_REMEDY : HELPER_REMEDY}`,
      });
    }
  }

  return offences;
}

/* ------------------------------------------------------------------ *
 * The suite
 * ------------------------------------------------------------------ */

describe("no suite reads the corpus outside the gate", () => {
  const modules = loaderModules(SRC_DIR);

  /** A directory of planted files, removed after each test that asks for one. */
  const scratchDirectory = createScratch("perbo-corpus-guard-");
  let scratch: string | null = null;

  afterEach(() => {
    scratchDirectory.removeAll();
    scratch = null;
  });

  /**
   * Planted files go in a directory of their own, never in the directory being
   * scanned: the rest of this package's suite runs in parallel workers over
   * `test/`, and a file that exists for part of a run is a file another worker
   * may collect.
   */
  function scratchDir(): string {
    scratch ??= scratchDirectory();
    return scratch;
  }

  /** The specifier a file in `dir` imports the loader's own module by. */
  function corpusSpecifier(dir: string): string {
    const step = relative(dir, join(SRC_DIR, "corpus.ts"))
      .replaceAll("\\", "/")
      .replace(/\.ts$/, ".js");
    return step.startsWith(".") ? step : `./${step}`;
  }

  function plant(dir: string, file: string, source: string): string {
    writeFileSync(join(dir, file), source, "utf8");
    return file;
  }

  it("knows every module the loader can be imported from", () => {
    const found = [...modules.keys()].map((path) => relative(SRC_DIR, path)).sort();

    expect(found, "the module that declares it").toContain("corpus.ts");
    expect(found, "and the barrel that re-exports that file").toContain("index.ts");
    expect(modules.get(join(SRC_DIR, "index.ts"))?.names).toContain(LOADER);
  });

  it("scans every test file in this package", () => {
    const files = tsFiles(TEST_DIR);

    expect(files.filter((file) => file.endsWith(".test.ts")).length).toBeGreaterThan(30);
    expect(files).toContain(GATE);
  });

  it("finds no unguarded read in the suite as it stands", () => {
    expect(unguardedCorpusReads(TEST_DIR, { modules }).map((offence) => offence.message)).toEqual(
      [],
    );
  });

  /**
   * The scan, shown reading the real files it claims to have cleared, without
   * writing anything into them: run with nothing exempt, the gate itself is the
   * one bare read in this directory — it is the file that makes the call. A scan
   * that had quietly stopped opening files would pass the assertion above and
   * fail this one.
   */
  it("names the gate as the one bare read here, when nothing is exempt", () => {
    const offences = unguardedCorpusReads(TEST_DIR, { modules, gate: "" });

    expect(offences.map((offence) => offence.file)).toEqual([GATE]);
    expect(offences[0]?.message).toContain(GATE);
    expect(offences[0]?.message).toContain(CALL_TEXT);
  });

  it("names a suite that reads the corpus, however the loader is spelled there", () => {
    const dir = scratchDir();
    const from = corpusSpecifier(dir);

    const direct = plant(
      dir,
      "planted-direct.test.ts",
      `import { ${LOADER} } from "${from}";\nexport const planted = ${LOADER}();\n`,
    );
    const alias = plant(
      dir,
      "planted-alias.test.ts",
      `import { ${LOADER} as load } from "${from}";\nexport const planted = load();\n`,
    );
    const namespaced = plant(
      dir,
      "planted-namespace.test.ts",
      `import * as corpusModule from "${from}";\nexport const planted = corpusModule.${LOADER}();\n`,
    );
    const dynamic = plant(
      dir,
      "planted-dynamic.test.ts",
      `const { ${LOADER}: load } = await import("${from}");\nexport const planted = load();\n`,
    );
    const barrel = plant(
      dir,
      "planted-barrel.test.ts",
      `import { ${LOADER} as load } from "${corpusSpecifier(dir).replace("corpus.js", "index.js")}";\n` +
        `export const planted = load();\n`,
    );
    const clean = plant(
      dir,
      "planted-clean.test.ts",
      `import { defaultSampleDir } from "${from}";\nexport const where = defaultSampleDir();\n`,
    );

    const offences = unguardedCorpusReads(dir, { modules });

    expect(offences.map((offence) => offence.file).sort()).toEqual(
      [alias, barrel, direct, dynamic, namespaced].sort(),
    );
    expect(
      offences.map((offence) => offence.file),
      "a suite that imports something else from the same module is not an offence",
    ).not.toContain(clean);
    for (const offence of offences) {
      expect(offence.message, "every failure names its file").toContain(offence.file);
    }

    /**
     * The alias is the case a text search cannot see: the loader's name never
     * touches a parenthesis in that file, and the scan flags it anyway.
     */
    expect(TEXTUAL_CALL.test(readFileSync(join(dir, alias), "utf8"))).toBe(false);
    expect(offences.find((offence) => offence.file === alias)?.message).toContain("`load`");
  });

  /**
   * A suite one directory down is a suite: vitest's `include` reaches every
   * `.test.ts` under `test/`, at any depth, so such a file is collected and run
   * like any other and the gate it steps around is the same gate. The scan
   * therefore walks down as well as across, and names what it finds by the path
   * a reader would use to open it.
   */
  it("names a suite in a subdirectory, which vitest collects too", () => {
    const dir = scratchDir();
    const nested = join(dir, "nested");
    mkdirSync(nested);
    const file = `nested/${plant(
      nested,
      "planted-nested.test.ts",
      `import { ${LOADER} } from "${corpusSpecifier(nested)}";\nexport const planted = ${LOADER}();\n`,
    )}`;

    expect(tsFiles(dir), "the walk reaches it at all").toEqual([file]);

    const offences = unguardedCorpusReads(dir, { modules });

    expect(offences.map((offence) => offence.file)).toEqual([file]);
    expect(offences[0]?.message, "and names it by its path, not by its bare name").toContain(file);
  });

  /**
   * The helper rule, on the same terms. A module beside the suites may load a
   * corpus it names — `sample-fixtures.ts` does — and only the gate may leave
   * the directory to the loader, under any spelling.
   */
  it("names a helper that leaves the directory to the loader, and allows one that states it", () => {
    const dir = scratchDir();
    const from = corpusSpecifier(dir);

    const bare = plant(
      dir,
      "planted-helper.ts",
      `import { ${LOADER} } from "${from}";\nexport const planted = ${LOADER}();\n`,
    );
    const aliased = plant(
      dir,
      "planted-helper-alias.ts",
      `import { ${LOADER} as load } from "${from}";\n` +
        `const again = load;\nexport const planted = again();\n`,
    );
    const named = plant(
      dir,
      "planted-helper-named.ts",
      `import { ${LOADER}, defaultSampleDir } from "${from}";\n` +
        `export const planted = ${LOADER}(defaultSampleDir());\n`,
    );
    const namedByAlias = plant(
      dir,
      "planted-helper-named-alias.ts",
      `import { ${LOADER} as load, defaultSampleDir } from "${from}";\n` +
        `export const planted = load(defaultSampleDir());\n`,
    );

    const offences = unguardedCorpusReads(dir, { modules });

    expect(offences.map((offence) => offence.file).sort()).toEqual([aliased, bare].sort());
    expect(offences.map((offence) => offence.file)).not.toContain(named);
    expect(offences.map((offence) => offence.file)).not.toContain(namedByAlias);
    expect(offences.find((offence) => offence.file === aliased)?.message).toContain(aliased);
  });

  /**
   * The third way a suite could reach the loader: not by importing it from
   * `src/`, but from a helper beside it that passed it on. A file that hands the
   * loader out under a new name would make every rule above searchable only for
   * a name the scan no longer knows.
   */
  it("names a helper that hands the loader on to the files beside it", () => {
    const dir = scratchDir();
    const from = corpusSpecifier(dir);

    const plain = plant(dir, "planted-hands-on.ts", `export { ${LOADER} } from "${from}";\n`);
    const renamed = plant(
      dir,
      "planted-hands-on-alias.ts",
      `export { ${LOADER} as load } from "${from}";\n`,
    );
    const star = plant(dir, "planted-hands-on-star.ts", `export * from "${from}";\n`);
    const local = plant(
      dir,
      "planted-hands-on-local.ts",
      `import { ${LOADER} as load } from "${from}";\nconst copy = load;\nexport { copy };\n`,
    );
    const other = plant(
      dir,
      "planted-hands-on-other.ts",
      `export { defaultSampleDir } from "${from}";\n`,
    );

    const offences = unguardedCorpusReads(dir, { modules });

    expect(offences.map((offence) => offence.file).sort()).toEqual(
      [local, plain, renamed, star].sort(),
    );
    expect(
      offences.map((offence) => offence.file),
      "re-exporting something else from that module is not a hand-off",
    ).not.toContain(other);
    expect(offences.find((offence) => offence.file === renamed)?.message).toContain("`load`");
  });
});
