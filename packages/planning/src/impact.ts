import {
  insideAllowedPaths,
  isConfigPath,
  isDependencyPath,
  isMigrationPath,
  isSecurityPath,
  packageOf,
  resolveRepositoryPath,
} from "@perbo/contracts/paths";
import { isPlannedP3Path } from "@perbo/contracts/risk";
import type { SymbolIndex, UnsupportedRepository } from "@perbo/contracts/symbol-index";
import { specSymbolNames } from "./spec-text.js";

/**
 * Impact warnings: what a draft is likely to touch that its scope does not
 * cover ([D-015](../../../docs/11-open-decisions.md)).
 *
 * Advice and nothing else. A warning is a record a screen shows; no part of it
 * reaches a contract, a scope glob or a spec until the person acts on one, and
 * the acting is the draft's own scope edit or the spec's own save
 * ([ADR-0023](../../../docs/adr/0023-untrusted-context-boundary.md) §4).
 *
 * Nothing here touches the filesystem or starts a process, so the desktop's
 * browser preview computes the same warnings the host does from the same three
 * inputs: the tracked tree, the draft's allowed scope and the spec's text.
 */

/** Why a path is warned about. A path carries every reason that holds of it. */
export const IMPACT_REASON_KINDS = [
  "imports_scope",
  "imports_named",
  "named",
  "migration",
  "dependency",
  "config",
  "security",
  "ci_infra_policy",
] as const;
export type ImpactReasonKind = (typeof IMPACT_REASON_KINDS)[number];

export interface ImpactReason {
  kind: ImpactReasonKind;
  /** The whole sentence the pane shows, so the host and the preview say the same words. */
  detail: string;
}

/** One path outside the draft's scope, and every reason it is worth seeing. */
export interface ImpactWarning {
  path: string;
  /** Its package by {@link packageOf}, which is how the pane groups the list. */
  package: string;
  /** In {@link IMPACT_REASON_KINDS} order, never empty. */
  reasons: ImpactReason[];
}

/** What the symbol and import index could say about this repository. */
export interface ImpactIndexState {
  /** False where there is no index to read, and the import warnings are missing. */
  read: boolean;
  /** The commit the index was built at, or null where none was read. */
  commit: string | null;
  /** The sentence saying what is missing and why, or null where nothing is. */
  note: string | null;
}

export interface ImpactReport {
  /** Sorted by path, and the first {@link IMPACT_WARNING_CAP} of them where there are more. */
  warnings: ImpactWarning[];
  /** How many warnings the cap left out, or 0. */
  truncated: number;
  index: ImpactIndexState;
  /** The scope the warnings were judged against, as the draft holds it. */
  scope: string[];
  /**
   * What the spec names that this repository has: tracked paths, and the
   * `@Symbol` names a file here exports.
   *
   * A name no file exports is not here. The pane prints this as one sentence,
   * so a name that found nothing would sit beside the ones that rooted the
   * analysis with nothing to tell them apart. Empty of symbols where there was
   * no index to look them up in.
   */
  named: { paths: string[]; symbols: string[] };
}

export interface ImpactInput {
  /** The draft's `paths_allowed`, as admission would pass them. */
  scope: readonly string[];
  /**
   * The tracked paths this surface may name, with the never-read ones already
   * dropped. Everything the report names is taken from it: a warning's path,
   * and the paths its sentences read out.
   */
  tracked: readonly string[];
  /** The spec's text, or null before this planning has written one. */
  spec: string | null;
  /**
   * The index, or the answer saying this repository is not one it can describe.
   * As `perbo index` builds it, over the whole tracked tree and with no
   * never-read filter of its own, so nothing is named out of it unguarded.
   */
  index: SymbolIndex | UnsupportedRepository;
}

/**
 * The longest list the pane is given.
 *
 * A wide scope over a monorepo has thousands of importers, and a list that long
 * is neither readable nor a thing to send to a screen. The count of what was
 * left out goes with it, so the list never silently claims to be the whole
 * answer.
 *
 * What survives the cap is the first of them by path and not the most serious:
 * nothing here ranks one reason above another, so the sentence carrying the
 * count says which cut it is rather than letting the list read as a shortlist.
 */
export const IMPACT_WARNING_CAP = 200;

/**
 * The path classes `risk.ts` derives on, in report order.
 *
 * Repository-supplied agent configuration is the one it derives on that is not
 * here: every path `isAgentConfigPath` matches is on the never-read list
 * (ADR-0030), so no surface lists one and there is none for a warning to name.
 */
const PATH_CLASSES: readonly {
  kind: ImpactReasonKind;
  holds: (path: string) => boolean;
  detail: string;
}[] = [
  {
    kind: "migration",
    holds: isMigrationPath,
    detail: "a schema or data migration, whose effect outlives the pull request",
  },
  {
    kind: "dependency",
    holds: isDependencyPath,
    detail: "a dependency manifest, which changes what every other package resolves",
  },
  {
    kind: "config",
    holds: isConfigPath,
    detail: "configuration, which changes how the system runs rather than what it computes",
  },
  {
    kind: "security",
    holds: isSecurityPath,
    detail: "security-sensitive, where a mistake is an incident rather than a bug",
  },
  {
    kind: "ci_infra_policy",
    holds: isPlannedP3Path,
    detail: "CI, infrastructure or policy, which takes effect outside the pull request carrying it",
  },
];

/** Where each reason sorts within one warning. */
const ORDER = new Map(IMPACT_REASON_KINDS.map((kind, at) => [kind, at]));

/** `a`, `a and b`, `a, b and c`, `a, b, c and 4 more`. */
function series(items: readonly string[], most = 3): string {
  const shown = items.slice(0, most);
  const rest = items.length - shown.length;
  const parts = rest > 0 ? [...shown, `${rest} more`] : shown;
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)!}`;
}

/** A token a spec can write a path as: no whitespace, at least one `/`, nothing a sentence ends with. */
const PATH_TOKEN = /[^\s`"'()<>[\]{},;]*\/[^\s`"'()<>[\]{},;]*/g;

/**
 * What a spec names that this repository has (D-103).
 *
 * A path is judged where it lands, never as it was written: the token is
 * resolved through {@link resolveRepositoryPath} and kept only where the
 * resolved value is a path the repository tracks. So `specs/../packages/a.ts`
 * is `packages/a.ts`, and `../../etc/passwd` is not a path this repository
 * names and is dropped rather than followed. The spec is repository content
 * and therefore data (ADR-0023): matching it against the tracked tree is the
 * whole of what is done with it, and no token here is ever opened.
 *
 * A symbol is a name, not a path, so it is kept as written and looked up in the
 * index's exports. {@link specSymbolNames} is the one reading of `@Symbol`:
 * the Spec pane completes from it and marks by it, so a name this finds is a
 * name the pane already marked.
 */
export function specNames(
  spec: string,
  tracked: ReadonlySet<string>,
): { paths: string[]; symbols: string[] } {
  const paths = new Set<string>();
  for (const token of spec.match(PATH_TOKEN) ?? []) {
    const landed = resolveRepositoryPath(token.replace(/[.,;:]+$/, ""));
    if (landed !== null && tracked.has(landed)) paths.add(landed);
  }
  const symbols = new Set(specSymbolNames(spec));
  return { paths: [...paths].sort(), symbols: [...symbols].sort() };
}

/** Whether a build answered that this repository is not one it can describe. */
const unsupported = (index: SymbolIndex | UnsupportedRepository): index is UnsupportedRepository =>
  "supported" in index;

/** The extension a path carries, or `""`. A leading dot is a name, so `.env` has none. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot);
}

/**
 * Why the imports are missing, and what this repository is instead.
 *
 * The extensions named are the answer's own `languages_seen` narrowed to the
 * ones the tracked list handed in carries too. `perbo index` computes that
 * list over the whole tracked tree with no never-read filter of its own, and
 * this sentence is printed under a promise that no secret, `.git` entry or
 * agent configuration appears here (ADR-0030): a repository whose only `.pem`
 * is a deploy key would otherwise report `.pem`. What is dropped that way is an
 * extension no file this surface may name carries, which is nothing the reader
 * of this sentence can act on.
 */
function unsupportedNote(answer: UnsupportedRepository, tracked: readonly string[]): string {
  const carried = new Set(tracked.map(extensionOf));
  const seen = answer.languages_seen.filter((extension) => carried.has(extension));
  return (
    `Nothing here reads imports: ${answer.reason}. ` +
    "Only the path classes are listed — they are the same in any language. " +
    `Tracked extensions here: ${seen.length === 0 ? "none" : seen.join(" ")}.`
  );
}

/**
 * The warnings for one draft.
 *
 * Two kinds, and each answers a different question about the same change.
 *
 * **Importers** answer "who depends on what I am changing". The index's edges
 * are followed one hop: a file outside the scope that imports a file inside it,
 * or one the spec names. One hop rather than the closure, because the closure
 * of a package in a monorepo is the monorepo, and a list a person cannot read
 * is not advice.
 *
 * **Path classes** answer "where does this change reach that its file list does
 * not say", and are language-agnostic. They are raised for a path outside the
 * scope but inside a package this change reaches — one a scope entry names,
 * one the scope covers a tracked file of, or one the spec names a path in —
 * the same relation `admittedWriteGlobs` treats as the work spilling out of
 * its declared paths while the expansion budget is positive, which is what
 * "likely to touch, and not covered" means in this repository already.
 */
export function impactReport(input: ImpactInput): ImpactReport {
  const scope = [...input.scope];
  const tracked = new Set(input.tracked);
  const inScope = (path: string): boolean => insideAllowedPaths(path, scope);
  const named = input.spec === null ? { paths: [], symbols: [] } : specNames(input.spec, tracked);

  const index = unsupported(input.index) ? null : input.index;
  const state: ImpactIndexState = unsupported(input.index)
    ? { read: false, commit: null, note: unsupportedNote(input.index, input.tracked) }
    : { read: true, commit: input.index.head_commit, note: null };

  // Every reason found for a path, before the cap and the sort.
  const found = new Map<string, Map<ImpactReasonKind, string>>();
  const add = (path: string, kind: ImpactReasonKind, detail: string): void => {
    if (inScope(path) || !tracked.has(path)) return;
    const reasons = found.get(path) ?? new Map<ImpactReasonKind, string>();
    reasons.set(kind, detail);
    found.set(path, reasons);
  };

  for (const path of named.paths)
    add(path, "named", "the spec names it, and this draft's scope does not cover it");

  /**
   * Where each symbol the spec names is declared, so a spec naming `@signup`
   * roots the analysis at the file that exports it — and what the report says
   * the spec names, since a name no file here declares named nothing.
   *
   * Every file that declares a name is kept, not the last one seen: two
   * packages exporting `retry` is the ordinary state of a monorepo, and keeping
   * one would halve the warnings against a tiebreak nobody chose. Only files
   * this surface may name are looked at, because the index is built over the
   * whole tracked tree with no never-read filter of its own (ADR-0030), and a
   * symbol only that kind of file exports is not one this screen may report.
   */
  const declaring = new Map<string, string[]>();
  if (index !== null) {
    for (const file of index.files) {
      if (!tracked.has(file.path)) continue;
      for (const exported of file.exports) {
        if (!named.symbols.includes(exported.name)) continue;
        declaring.set(exported.name, [...(declaring.get(exported.name) ?? []), file.path]);
      }
    }
    for (const [symbol, files] of declaring)
      for (const path of files) add(path, "named", `the spec names @${symbol}, which it exports`);

    const namedFiles = new Set([...named.paths, ...[...declaring.values()].flat()]);
    for (const file of index.files) {
      const targets = { scope: new Set<string>(), named: new Set<string>() };
      for (const edge of file.imports) {
        // The index has no never-read filter of its own, so a resolved edge can
        // land on a path this surface may not name. `add` holds the warning's
        // own path; this holds the one its sentence reads out (ADR-0030).
        if (edge.resolved === null || !tracked.has(edge.resolved)) continue;
        if (inScope(edge.resolved)) targets.scope.add(edge.resolved);
        else if (namedFiles.has(edge.resolved)) targets.named.add(edge.resolved);
      }
      if (targets.scope.size > 0)
        add(
          file.path,
          "imports_scope",
          `imports ${series([...targets.scope].sort())}, which this draft changes`,
        );
      if (targets.named.size > 0)
        add(
          file.path,
          "imports_named",
          `imports ${series([...targets.named].sort())}, which the spec names`,
        );
    }
  }

  // A package this change reaches: one holding a tracked path the scope
  // covers, one a scope entry's own text names, or one holding a path the spec
  // names. The scope-covered branch is judged by the same matcher `inScope`
  // uses rather than by the package of a glob's own text, because a glob need
  // not have one — `packageOf("apps/**/*.ts")` is `apps/**`, which is no
  // package a tracked path belongs to. The entry's own text is kept too, the
  // same way `admittedWriteGlobs` reads `paths_allowed`, because a scope entry
  // naming a file not yet tracked or a plain directory matches no tracked path
  // and would otherwise reach no package at all.
  const reached = new Set([
    ...input.tracked.filter((path) => inScope(path)).map(packageOf),
    ...scope.map(packageOf),
    ...named.paths.map(packageOf),
  ]);
  for (const path of input.tracked) {
    // `add` refuses an in-scope path as well; skipping it here is what keeps
    // the class tests off every file of a package the scope already covers.
    if (inScope(path) || !reached.has(packageOf(path))) continue;
    for (const each of PATH_CLASSES) if (each.holds(path)) add(path, each.kind, each.detail);
  }

  const all = [...found.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, reasons]) => ({
      path,
      package: packageOf(path),
      reasons: [...reasons.entries()]
        .sort(([left], [right]) => ORDER.get(left)! - ORDER.get(right)!)
        .map(([kind, detail]) => ({ kind, detail })),
    }));
  return {
    warnings: all.slice(0, IMPACT_WARNING_CAP),
    truncated: Math.max(0, all.length - IMPACT_WARNING_CAP),
    index: state,
    scope,
    named: { paths: named.paths, symbols: [...declaring.keys()].sort() },
  };
}

/**
 * The No-Go one warning becomes (D-103, SCP-320).
 *
 * One sentence in the voice the section is written in — "Changing the brand
 * colours." — because what a person says by turning a warning into a No-Go is
 * that this piece of work does not touch that path.
 */
export const noGoForPath = (path: string): string => `Changing ${path}.`;

/**
 * The No-Gos section with one path's No-Go in it.
 *
 * The section is returned unchanged where it already carries that line: the
 * pane's action is idempotent, so a second click on the same warning does not
 * write the same No-Go twice into the spec a person then has to tidy.
 */
export function withNoGo(noGos: string, path: string): string {
  const line = `- ${noGoForPath(path)}`;
  if (noGos.split("\n").some((each) => each.trim() === line)) return noGos;
  const kept = noGos.replace(/\s+$/, "");
  return kept.length === 0 ? line : `${kept}\n${line}`;
}
