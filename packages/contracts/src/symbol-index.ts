import { z } from "zod";

/**
 * The TypeScript and JavaScript symbol and import index ([D-015](../../../docs/11-open-decisions.md)).
 *
 * One record per repository, built on demand by `perbo index` from the tracked
 * tree with TypeScript's own parser, and written to `<repo>/.perbo/index.json`.
 * It is a cache with a commit stamped on it, never a source of truth: nothing
 * keeps it fresh, and a reader compares `head_commit` against the checkout it
 * is looking at before believing it. The files are read as they are on disk,
 * so `working_tree` says whether they were the commit's or carried changes
 * not yet committed.
 *
 * Labels only — names, kinds, line numbers and paths. No file's contents and no
 * fragment of one enter the record, so it can be read by a surface that is not
 * allowed to read the code itself.
 */

export const SYMBOL_INDEX_SCHEMA_VERSION = 1;

/** What `<store>/index.json` is called, for a reader that needs to find it. */
export const SYMBOL_INDEX_FILENAME = "index.json";

/** The file extensions the index reads. Everything else is another language. */
export const INDEXED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;
export type IndexedExtension = (typeof INDEXED_EXTENSIONS)[number];

/**
 * What an exported name was declared as.
 *
 * `named` is `export { a }` over a name this file does not declare at the top
 * level — a re-exported import, or a name bound somewhere the parser does not
 * follow. `re-export` is the `export … from` forms, whose declaration is in
 * another file; `export * from` carries the name `*`, because what it exports
 * is not knowable without reading that file. `commonjs` is
 * `module.exports = { … }` and `exports.a =`.
 */
export const EXPORT_KINDS = [
  "function",
  "class",
  "variable",
  "type",
  "interface",
  "enum",
  "namespace",
  "default",
  "named",
  "re-export",
  "commonjs",
] as const;
export const ExportKindSchema = z.enum(EXPORT_KINDS);
export type ExportKind = (typeof EXPORT_KINDS)[number];

/** One name a file exports, and the line the `export` that names it starts on. */
export const ExportedSymbolSchema = z.strictObject({
  name: z.string().min(1),
  kind: ExportKindSchema,
  line: z.number().int().positive(),
});
export type ExportedSymbol = z.infer<typeof ExportedSymbolSchema>;

/**
 * One import edge out of a file.
 *
 * `specifier` is what the source wrote. `resolved` is the repository-relative
 * path it lands on, or `null` where nothing tracked does — a file the index
 * skipped, a path outside the repository, or a workspace package whose entry is
 * a build output no checkout carries. `external` is true only for a specifier
 * that leaves this repository: a Node builtin or a package from the registry.
 * So `resolved: null, external: false` is a real state and means "inside this
 * repository, and the file it names could not be found".
 */
export const ImportEdgeSchema = z.strictObject({
  specifier: z.string().min(1),
  resolved: z.string().min(1).nullable(),
  external: z.boolean(),
  line: z.number().int().positive(),
});
export type ImportEdge = z.infer<typeof ImportEdgeSchema>;

/** One indexed file, by its repository-relative path. */
export const IndexedFileSchema = z.strictObject({
  path: z.string().min(1),
  exports: z.array(ExportedSymbolSchema),
  imports: z.array(ImportEdgeSchema),
});
export type IndexedFile = z.infer<typeof IndexedFileSchema>;

/**
 * A file of an indexed extension that was not read, and why.
 *
 * Recorded rather than dropped: a symbol the index does not hold reads to every
 * consumer as a symbol that does not exist, and a stale-spec check that marks a
 * name missing because its file was too large to read would be wrong in the
 * direction that costs a person their time.
 */
export const SkippedFileSchema = z.strictObject({
  path: z.string().min(1),
  reason: z.string().min(1),
});
export type SkippedFile = z.infer<typeof SkippedFileSchema>;

export const SymbolIndexSchema = z.strictObject({
  schema_version: z.literal(SYMBOL_INDEX_SCHEMA_VERSION),
  built_at: z.iso.datetime(),
  /** The commit the tree was at when it was read. */
  head_commit: z.string().regex(/^[0-9a-f]{7,40}$/, "a commit sha"),
  /** Whether a tracked file differed from that commit when it was read. */
  working_tree: z.enum(["clean", "modified"]),
  files: z.array(IndexedFileSchema),
  skipped: z.array(SkippedFileSchema),
});
export type SymbolIndex = z.infer<typeof SymbolIndexSchema>;

/**
 * The answer for a repository this index cannot describe.
 *
 * A repository with no tracked TypeScript or JavaScript gets this rather than
 * an index holding no files, because the two are not the same fact and a
 * consumer acts differently on each: an empty index says every symbol a spec
 * names is gone, and this says the question does not apply here.
 *
 * `languages_seen` names the extensions the tracked tree does carry, so the
 * answer says what the repository is rather than only what it is not.
 */
export const UnsupportedRepositorySchema = z.strictObject({
  supported: z.literal(false),
  reason: z.string().min(1),
  languages_seen: z.array(z.string().min(1)),
});
export type UnsupportedRepository = z.infer<typeof UnsupportedRepositorySchema>;
