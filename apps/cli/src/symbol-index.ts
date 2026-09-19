import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, posix, resolve } from "node:path";
// The one import that puts a compiler in what ships: `typescript` is inlined
// into the single-file bundle, as `zod` is, and it is declared beside `zod` in
// `devDependencies` for the same reason. `apps/cli`'s manifest names no
// runtime dependency at all — the tarball a person installs is the bundle and
// nothing beside it — so where a package is declared says when it is needed to
// *build*, and the bundle is what says it is needed to run.
import ts from "typescript";
import {
  EXIT_CODES,
  INDEXED_EXTENSIONS,
  IndexedFileSchema,
  SYMBOL_INDEX_FILENAME,
  SYMBOL_INDEX_SCHEMA_VERSION,
  SymbolIndexSchema,
  UnsupportedRepositorySchema,
  type ExportKind,
  type ExportedSymbol,
  type ImportEdge,
  type IndexedFile,
  type SkippedFile,
  type SymbolIndex,
  type UnsupportedRepository,
} from "@perbo/contracts";
import { UsageError } from "./args.js";
import { StoreError, headCommit, storeDir } from "./store.js";
import type { Streams } from "./streams.js";

/**
 * `perbo index` — the symbol and import index (D-015).
 *
 * The one piece of code intelligence Perbo has: what every tracked TypeScript
 * and JavaScript file exports, and what every one of them imports, built on
 * demand with TypeScript's own parser. No type checker, no `tsc` run and no
 * model: the answer is read off the syntax, so it is the same answer every
 * time and a repository's code never reaches a provider to produce it.
 *
 * It reads code and writes none, which is the whole of what Perbo does with a
 * repository's source. The record it writes is labels — names, kinds, lines
 * and paths — never a line of the code it read.
 *
 * Nothing keeps it fresh. It is stamped with the commit it was built at and
 * with whether the tracked files were that commit's or carried uncommitted
 * changes, and a reader that cares compares that against the checkout it is
 * looking at and asks for a rebuild rather than trusting what is on disk.
 */

/**
 * The largest file that is parsed, and the one bound on the work.
 *
 * A file over this is recorded as skipped rather than read: the cost of
 * parsing is in the bytes, and one generated megabyte should not decide how
 * long indexing a repository takes. Everything else is bounded by the tracked
 * tree itself.
 */
export const MAX_INDEXED_FILE_BYTES = 1024 * 1024;

/**
 * Directories the index never reads, whatever a repository tracks.
 *
 * `node_modules` and `dist` are other people's code and this repository's own
 * output — neither is a symbol a spec can name. `.perbo` is the store: it is
 * where the index is *written*, and indexing it would make every rebuild
 * change its own input.
 */
const EXCLUDED_SEGMENTS = new Set(["node_modules", "dist", ".perbo"]);

/** The extensions a `.js`-family specifier is written for, in the order they are tried. */
const SPECIFIER_EXTENSIONS: Record<string, readonly string[]> = {
  ".js": [".ts", ".tsx", ".d.ts", ".js"],
  ".jsx": [".tsx", ".jsx"],
  ".mjs": [".mts", ".d.mts", ".mjs"],
  ".cjs": [".cts", ".d.cts", ".cjs"],
  ".ts": [".ts"],
  ".tsx": [".tsx"],
  ".mts": [".mts"],
  ".cts": [".cts"],
};

/** What an extensionless specifier is tried as, then again under `<specifier>/index`. */
const BARE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"] as const;

// ---------------------------------------------------------------------------
// The tracked tree

/** `git ls-files` by argv: the root is an argument, never part of a command line. */
function trackedFiles(repositoryRoot: string): string[] {
  let listing: string;
  try {
    listing = execFileSync("git", ["-C", repositoryRoot, "ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new StoreError(
      `cannot list the tracked files in ${repositoryRoot}: ${
        error instanceof Error ? error.message.split("\n")[0] : String(error)
      }`,
    );
  }
  return listing.split("\0").filter((path) => path.length > 0);
}

/** Whether any tracked file differs from the commit, by argv. Untracked files are not indexed, so they do not count. */
export function workingTree(repositoryRoot: string): "clean" | "modified" {
  let status: string;
  try {
    status = execFileSync(
      "git",
      ["-C", repositoryRoot, "status", "--porcelain", "--untracked-files=no"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    throw new StoreError(
      `cannot read the working tree's state in ${repositoryRoot}: ${
        error instanceof Error ? error.message.split("\n")[0] : String(error)
      }`,
    );
  }
  return status.trim().length === 0 ? "clean" : "modified";
}

/** The repository `path` is inside, so `--repo` may name any directory within it. */
export function repositoryRootAt(path: string): string {
  try {
    return execFileSync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new StoreError(
      `${path} is not inside a git repository: ${
        error instanceof Error ? error.message.split("\n")[0] : String(error)
      }`,
    );
  }
}

const underExcludedDirectory = (path: string): boolean =>
  path.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment));

/** Whether the index reads this tracked path at all. `.d.ts` counts: it declares exports. */
const isIndexable = (path: string): boolean =>
  !underExcludedDirectory(path) &&
  INDEXED_EXTENSIONS.some((extension) => path.endsWith(extension));

/**
 * The extensions the tracked tree carries, for an unsupported repository's
 * answer. From the whole tree minus the directories above, so the answer
 * describes the repository rather than its vendored dependencies.
 */
function languagesSeen(tracked: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const path of tracked) {
    if (underExcludedDirectory(path)) continue;
    const extension = extname(path);
    if (extension.length > 0) seen.add(extension);
  }
  return [...seen].sort();
}

// ---------------------------------------------------------------------------
// Resolving a specifier

/** One workspace package: the name its manifest declares, and where it lives. */
interface WorkspacePackage {
  directory: string;
  manifest: Record<string, unknown>;
}

/**
 * The package globs `pnpm-workspace.yaml` declares.
 *
 * A deliberate reader rather than a YAML parser: the file this needs is a
 * `packages:` key over a list of quoted strings, and the index does not gain a
 * dependency to read four lines. A file shaped some other way yields no globs,
 * which costs a workspace package name its resolution and nothing else.
 */
function workspaceGlobs(repositoryRoot: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");
  } catch {
    return [];
  }
  const globs: string[] = [];
  let inPackages = false;
  for (const line of text.split("\n")) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s+-\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/.exec(line);
    if (item) {
      globs.push(item[1] ?? item[2] ?? item[3] ?? "");
      continue;
    }
    if (line.trim().length > 0) break;
  }
  return globs.filter((glob) => glob.length > 0);
}

/**
 * `*` matches within one path segment and `**` across them. Nothing else in a
 * glob is a pattern — enough for a `packages:` list, which is directory globs.
 *
 * One pass, so a character escaped for the regular expression can never be
 * read back as a pattern: every token is either a star to translate or a
 * character to escape.
 */
function globToRegExp(glob: string): RegExp {
  const pattern = glob.replace(/\*\*|\*|[.+?^${}()|[\]\\]/g, (token) =>
    token === "**" ? ".*" : token === "*" ? "[^/]*" : `\\${token}`,
  );
  return new RegExp(`^${pattern}$`);
}

/**
 * Every workspace package by the name its own manifest declares.
 *
 * A `package.json` counts when its directory matches one of the globs above,
 * which is the same rule pnpm itself installs by, so the names that resolve
 * here are the names that resolve at runtime.
 */
function workspacePackages(
  repositoryRoot: string,
  tracked: readonly string[],
): Map<string, WorkspacePackage> {
  const globs = workspaceGlobs(repositoryRoot);
  if (globs.length === 0) return new Map();
  const include = globs.filter((glob) => !glob.startsWith("!")).map(globToRegExp);
  const exclude = globs.filter((glob) => glob.startsWith("!")).map((glob) => globToRegExp(glob.slice(1)));

  const packages = new Map<string, WorkspacePackage>();
  for (const path of tracked) {
    if (!path.endsWith("package.json") || underExcludedDirectory(path)) continue;
    const directory = posix.dirname(path);
    if (directory === ".") continue;
    if (!include.some((pattern) => pattern.test(directory))) continue;
    if (exclude.some((pattern) => pattern.test(directory))) continue;
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(readFileSync(join(repositoryRoot, path), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const name = manifest["name"];
    if (typeof name === "string" && name.length > 0 && !packages.has(name)) {
      packages.set(name, { directory, manifest });
    }
  }
  return packages;
}

/** The first tracked file `path` names, under the extension and `index.*` rules. */
function resolveInTree(path: string, tracked: ReadonlySet<string>): string | null {
  const normalised = posix.normalize(path);
  if (normalised.startsWith("..")) return null;
  const extension = extname(normalised);
  const written = SPECIFIER_EXTENSIONS[extension];
  if (written !== undefined) {
    const base = normalised.slice(0, normalised.length - extension.length);
    for (const candidate of written) {
      if (tracked.has(`${base}${candidate}`)) return `${base}${candidate}`;
    }
    return null;
  }
  for (const candidate of BARE_EXTENSIONS) {
    if (tracked.has(`${normalised}${candidate}`)) return `${normalised}${candidate}`;
  }
  for (const candidate of BARE_EXTENSIONS) {
    if (tracked.has(`${normalised}/index${candidate}`)) return `${normalised}/index${candidate}`;
  }
  return null;
}

/** The first string in an `exports` entry, which may be a string or a conditions object. */
function exportsTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  for (const condition of ["types", "import", "module", "default", "node", "require"]) {
    const target = exportsTarget((value as Record<string, unknown>)[condition]);
    if (target !== null) return target;
  }
  return null;
}

/**
 * Where a workspace package name lands in the tracked tree.
 *
 * The entry its manifest declares, where that file is tracked. Where the
 * manifest names a build output — `./dist/index.js`, which no checkout carries
 * — the package's own `src/index.*` is the entry the tracked tree has, and
 * that is what resolves. A package with neither resolves to `null` and stays
 * `external: false`: the import is inside this repository even where the file
 * it lands on cannot be named.
 */
function resolveWorkspace(
  pkg: WorkspacePackage,
  subpath: string | null,
  tracked: ReadonlySet<string>,
): string | null {
  const exported = pkg.manifest["exports"];
  const conditions =
    exported === null || typeof exported !== "object" || Array.isArray(exported)
      ? undefined
      : (exported as Record<string, unknown>);
  const key = subpath === null ? "." : `./${subpath}`;
  // `exports` is either a map from subpaths to entries, or the root entry's
  // own conditions object; the two are told apart by whether a key is a path.
  const subpathMap =
    conditions !== undefined && Object.keys(conditions).some((entry) => entry.startsWith("."));

  const declared: string[] = [];
  const fromExports =
    conditions === undefined
      ? exportsTarget(exported)
      : subpathMap
        ? exportsTarget(conditions[key])
        : subpath === null
          ? exportsTarget(conditions)
          : null;
  if (fromExports !== null) declared.push(fromExports);
  if (subpath === null) {
    for (const field of ["main", "module", "types"]) {
      const value = pkg.manifest[field];
      if (typeof value === "string") declared.push(value);
    }
  }

  for (const entry of declared) {
    const found = resolveInTree(posix.join(pkg.directory, entry), tracked);
    if (found !== null) return found;
  }
  const within = subpath === null ? "index" : subpath;
  return (
    resolveInTree(posix.join(pkg.directory, within), tracked) ??
    resolveInTree(posix.join(pkg.directory, "src", within), tracked)
  );
}

/** A specifier as the index records it: where it lands, and whether it leaves this repository. */
function resolveSpecifier(
  specifier: string,
  fromPath: string,
  tracked: ReadonlySet<string>,
  packages: ReadonlyMap<string, WorkspacePackage>,
): { resolved: string | null; external: boolean } {
  if (specifier.startsWith(".")) {
    return { resolved: resolveInTree(posix.join(posix.dirname(fromPath), specifier), tracked), external: false };
  }
  // A scoped name carries one slash before the package name ends.
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  const pkg = packages.get(name);
  if (pkg === undefined) return { resolved: null, external: true };
  const subpath = specifier.slice(name.length + 1);
  return {
    resolved: resolveWorkspace(pkg, subpath.length > 0 ? subpath : null, tracked),
    external: false,
  };
}

// ---------------------------------------------------------------------------
// Reading one file

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  ".ts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".js": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
};

/** Where `module.exports` and `exports.x` are read. Elsewhere they are two ordinary names. */
const COMMONJS_EXTENSIONS = new Set([".js", ".jsx", ".cjs"]);

/** An export as it is found, carrying the offset that puts the record in source order. */
interface FoundExport extends ExportedSymbol {
  at: number;
}

/** An import as it is found, before its specifier is resolved against the tree. */
interface FoundImport {
  at: number;
  specifier: string;
  line: number;
}

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);

/** Every name a binding introduces, including the ones a destructuring pattern names. */
function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? boundNames(element.name) : [],
  );
}

/** What a top-level declaration declares, for `export { a }` to look its kind up by. */
function declaredKind(statement: ts.Statement): ExportKind | null {
  if (ts.isFunctionDeclaration(statement)) return "function";
  if (ts.isClassDeclaration(statement)) return "class";
  if (ts.isVariableStatement(statement)) return "variable";
  if (ts.isTypeAliasDeclaration(statement)) return "type";
  if (ts.isInterfaceDeclaration(statement)) return "interface";
  if (ts.isEnumDeclaration(statement)) return "enum";
  if (ts.isModuleDeclaration(statement)) return "namespace";
  return null;
}

/** The names a top-level declaration binds, so an export clause can be given a kind. */
function declaredNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) => boundNames(declaration.name));
  }
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  ) {
    const name = statement.name;
    return name !== undefined && ts.isIdentifier(name) ? [name.text] : [];
  }
  return [];
}

/** The property names an object literal states, where every one of them is written out. */
function literalPropertyNames(literal: ts.ObjectLiteralExpression): string[] {
  const names: string[] = [];
  for (const property of literal.properties) {
    const name = property.name;
    if (name === undefined) continue;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) names.push(name.text);
  }
  return names;
}

const isModuleExports = (node: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === "module" &&
  node.name.text === "exports";

/**
 * What one file exports and what it imports.
 *
 * Exports are read from the top-level statements, because that is where
 * `export` can appear. Imports are read from the whole tree, because
 * `import()` and `require()` appear wherever an expression can.
 */
function readSource(path: string, text: string): { exports: FoundExport[]; imports: FoundImport[] } {
  const extension = path.endsWith(".d.ts") ? ".ts" : extname(path);
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    false,
    SCRIPT_KINDS[extension] ?? ts.ScriptKind.TS,
  );
  const line = (position: number): number => source.getLineAndCharacterOfPosition(position).line + 1;
  const exported: FoundExport[] = [];
  const imported: FoundImport[] = [];
  const at = (node: ts.Node): number => node.getStart(source);
  const exportedName = (position: number, name: string, kind: ExportKind): void => {
    exported.push({ at: position, name, kind, line: line(position) });
  };
  const importedFrom = (position: number, specifier: string): void => {
    imported.push({ at: position, specifier, line: line(position) });
  };

  const localKinds = new Map<string, ExportKind>();
  for (const statement of source.statements) {
    const kind = declaredKind(statement);
    if (kind === null) continue;
    for (const name of declaredNames(statement)) localKinds.set(name, kind);
  }

  const commonjs = COMMONJS_EXTENSIONS.has(extension);

  for (const statement of source.statements) {
    const position = at(statement);

    if (ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier;
      if (specifier !== undefined && ts.isStringLiteral(specifier)) {
        importedFrom(position, specifier.text);
      }
      const clause = statement.exportClause;
      if (clause === undefined) {
        // `export * from "x"`: what it exports is in the other file, so the
        // name is the star that was written rather than a guess at the list.
        exportedName(position, "*", "re-export");
      } else if (ts.isNamespaceExport(clause)) {
        exportedName(position, clause.name.text, "re-export");
      } else {
        for (const element of clause.elements) {
          const name = element.name.text;
          if (specifier !== undefined) {
            exportedName(position, name, "re-export");
          } else {
            const local = (element.propertyName ?? element.name).text;
            exportedName(position, name, localKinds.get(local) ?? "named");
          }
        }
      }
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      if (!statement.isExportEquals) exportedName(position, "default", "default");
      continue;
    }

    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      importedFrom(position, statement.moduleSpecifier.text);
      continue;
    }

    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      importedFrom(position, statement.moduleReference.expression.text);
      continue;
    }

    if (commonjs && ts.isExpressionStatement(statement)) {
      const assignment = statement.expression;
      if (
        ts.isBinaryExpression(assignment) &&
        assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const left = assignment.left;
        if (isModuleExports(left) && ts.isObjectLiteralExpression(assignment.right)) {
          for (const name of literalPropertyNames(assignment.right)) {
            exportedName(position, name, "commonjs");
          }
        } else if (
          ts.isPropertyAccessExpression(left) &&
          ((ts.isIdentifier(left.expression) && left.expression.text === "exports") ||
            isModuleExports(left.expression))
        ) {
          exportedName(position, left.name.text, "commonjs");
        }
      }
      continue;
    }

    if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
        exportedName(position, "default", "default");
        continue;
      }
      const kind = declaredKind(statement);
      if (kind !== null) {
        for (const name of declaredNames(statement)) exportedName(position, name, kind);
      }
    }
  }

  // `import()` and `require()` with a literal argument, wherever they are
  // written. Both carry a path the same way a declaration does, and a warning
  // that missed the one inside a function would miss a real dependency.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const argument = node.arguments[0];
      const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const required = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((dynamic || required) && argument !== undefined && ts.isStringLiteral(argument)) {
        importedFrom(at(node), argument.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  // Source order, so the record reads down the file however it was collected:
  // the declarations in one pass, the calls in another.
  const byPosition = (left: { at: number }, right: { at: number }): number => left.at - right.at;
  return { exports: exported.sort(byPosition), imports: imported.sort(byPosition) };
}

// ---------------------------------------------------------------------------
// The index

export interface BuildSymbolIndexOptions {
  /** The repository to read. Every path in the record is relative to it. */
  repositoryRoot: string;
  /** What `built_at` says. */
  now?: Date;
}

/** What the builder answers with: an index, or the reason there is none to build. */
export type SymbolIndexResult = SymbolIndex | UnsupportedRepository;

/** Whether a build answered that this repository is not one it can describe. */
export const isUnsupportedRepository = (result: SymbolIndexResult): result is UnsupportedRepository =>
  "supported" in result;

/** `1 MiB`, `1.5 MiB`, `12 KiB`: a size a person reads, with no `.0` on a round one. */
const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MiB`
    : `${Math.round(bytes / 1024)} KiB`;

/** Build the index of `repositoryRoot` from its tracked tree. Reads code; writes nothing. */
export function buildSymbolIndex(options: BuildSymbolIndexOptions): SymbolIndexResult {
  const root = resolve(options.repositoryRoot);
  const tracked = trackedFiles(root);
  const indexable = tracked.filter(isIndexable).sort();

  if (indexable.length === 0) {
    return UnsupportedRepositorySchema.parse({
      supported: false,
      reason:
        "no tracked TypeScript or JavaScript file outside node_modules, dist and .perbo: the " +
        `symbol index reads ${INDEXED_EXTENSIONS.join(" ")} and this repository tracks none of them there`,
      languages_seen: languagesSeen(tracked),
    } satisfies UnsupportedRepository);
  }

  const packages = workspacePackages(root, tracked);
  const read: Array<{ path: string; source: ReturnType<typeof readSource> }> = [];
  const skipped: SkippedFile[] = [];

  for (const path of indexable) {
    const absolute = join(root, path);
    let text: string;
    try {
      // A link is not followed: what it names may lie outside the repository,
      // and the index reads the tracked tree and nothing beyond it.
      if (lstatSync(absolute).isSymbolicLink()) {
        skipped.push({ path, reason: "a symbolic link, which the index does not follow" });
        continue;
      }
      const size = statSync(absolute).size;
      if (size > MAX_INDEXED_FILE_BYTES) {
        skipped.push({
          path,
          reason: `${formatBytes(size)}, over the ${formatBytes(MAX_INDEXED_FILE_BYTES)} cap`,
        });
        continue;
      }
      text = readFileSync(absolute, "utf8");
    } catch (error) {
      skipped.push({
        path,
        reason: `could not be read: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      });
      continue;
    }

    const source = readSource(path, text);
    // Held to the record's own schema one file at a time, so a name the record
    // cannot hold — an empty export name, an empty specifier — skips that file
    // with the reason, rather than failing the index for the whole repository.
    // Resolution comes after, so it is checked here with nothing resolved.
    const shape = IndexedFileSchema.safeParse({
      path,
      exports: source.exports.map(({ name, kind, line }) => ({ name, kind, line }) satisfies ExportedSymbol),
      imports: source.imports.map(({ specifier, line }) => ({ specifier, resolved: null, external: false, line })),
    });
    if (!shape.success) {
      skipped.push({
        path,
        reason:
          "carries a name the index cannot record: " +
          shape.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; "),
      });
      continue;
    }
    read.push({ path, source });
  }

  // An import resolves only to a file the index holds: one skipped above is
  // not a record a reader can follow, so an edge to it is unresolved.
  const indexed = new Set(read.map((entry) => entry.path));
  const files: IndexedFile[] = read.map(({ path, source }) => ({
    path,
    exports: source.exports.map(({ name, kind, line }) => ({ name, kind, line }) satisfies ExportedSymbol),
    imports: source.imports.map(({ specifier, line }) => {
      const where = resolveSpecifier(specifier, path, indexed, packages);
      return { specifier, resolved: where.resolved, external: where.external, line } satisfies ImportEdge;
    }),
  }));

  return SymbolIndexSchema.parse({
    schema_version: SYMBOL_INDEX_SCHEMA_VERSION,
    built_at: (options.now ?? new Date()).toISOString(),
    head_commit: headCommit(root),
    working_tree: workingTree(root),
    files,
    skipped,
  });
}

// ---------------------------------------------------------------------------
// The command

/** `<repo>/.perbo/index.json`: a judging path, which is why no executor can write it. */
export function symbolIndexPath(repositoryRoot: string): string {
  return join(storeDir(repositoryRoot), SYMBOL_INDEX_FILENAME);
}

/**
 * Replace the file in one step, or leave what is on disk alone.
 *
 * `rename` within a directory is atomic, so an index run killed while it
 * writes leaves the previous index intact rather than a half-written one every
 * later reader refuses.
 */
function writeAtomically(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(temporary, contents);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export interface IndexArgs {
  repo: string;
  json: boolean;
}

export function parseIndexArgs(argv: string[]): IndexArgs {
  const args: IndexArgs = { repo: ".", json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) throw new UsageError(`unexpected argument '${token}'`);
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    if (name === "--json") {
      if (eq !== -1) throw new UsageError("--json does not take a value");
      args.json = true;
      continue;
    }
    if (name !== "--repo") throw new UsageError(`unknown flag '${name}'`);
    const value = eq === -1 ? argv[++i] : token.slice(eq + 1);
    if (value === undefined || value.length === 0) throw new UsageError("--repo requires a value");
    args.repo = value;
  }
  return args;
}

const document = (record: unknown): string => `${JSON.stringify(record, null, 2)}\n`;

function renderSummary(index: SymbolIndex, path: string): string {
  const exports = index.files.reduce((total, file) => total + file.exports.length, 0);
  const edges = index.files.flatMap((file) => file.imports);
  const external = edges.filter((edge) => edge.external).length;
  const unresolved = edges.filter((edge) => !edge.external && edge.resolved === null).length;
  return [
    `INDEX  ${index.files.length} files, ${exports} exported names, ${edges.length} import edges`,
    `  ${edges.length - external - unresolved} resolved in this repository, ${external} external, ${unresolved} unresolved`,
    `  ${index.skipped.length} skipped${index.skipped.length === 0 ? "" : `: ${index.skipped.map((file) => `${file.path} (${file.reason})`).join(", ")}`}`,
    `  at ${index.head_commit.slice(0, 7)}${index.working_tree === "clean" ? "" : " with uncommitted changes"}, written to ${path}`,
    "",
  ].join("\n");
}

const renderUnsupported = (answer: UnsupportedRepository): string =>
  [
    `INDEX  not indexed: ${answer.reason}`,
    `  tracked extensions here: ${answer.languages_seen.length === 0 ? "none" : answer.languages_seen.join(" ")}`,
    "",
  ].join("\n");

/**
 * `perbo index --repo <path> [--json]`.
 *
 * Exit 0 either way. A repository outside TypeScript and JavaScript is not a
 * usage error — the command was used correctly — and nothing about it failed
 * to complete: the question was asked and answered. `perbo sync` exits 0 on a
 * repository nothing has run in for the same reason, and a caller that needs
 * to act on it reads `supported` out of `--json`.
 */
export function runIndexCommand(options: { argv: string[]; streams: Streams; cwd: string }): number {
  const args = parseIndexArgs(options.argv);
  const root = repositoryRootAt(resolve(options.cwd, args.repo));
  const built = buildSymbolIndex({ repositoryRoot: root });

  if (isUnsupportedRepository(built)) {
    // No file is written: the index is the file, and this repository has none.
    // Writing an answer here would also stand on top of an index a supported
    // checkout of the same store had already built.
    options.streams.stdout(args.json ? document(built) : renderUnsupported(built));
    return EXIT_CODES.approve;
  }

  const path = symbolIndexPath(root);
  writeAtomically(path, document(built));
  options.streams.stdout(args.json ? document(built) : renderSummary(built, path));
  return EXIT_CODES.approve;
}
