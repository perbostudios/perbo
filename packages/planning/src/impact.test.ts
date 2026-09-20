import { describe, expect, it } from "vitest";
import { SymbolIndexSchema, UnsupportedRepositorySchema } from "@perbo/contracts";
import { isNeverReadPath } from "@perbo/contracts/paths";
import type { SymbolIndex, UnsupportedRepository } from "@perbo/contracts";
import {
  IMPACT_WARNING_CAP,
  impactReport,
  specNames,
  type ImpactInput,
  type ImpactReasonKind,
  type ImpactWarning,
  withNoGo,
} from "./impact.js";
import { specSymbolNames } from "./spec-text.js";

/**
 * Impact warnings (SCP-320, D-015): what a draft is likely to touch that its
 * scope does not cover, computed from the tracked tree, the draft's scope, the
 * spec's text and the symbol index, and from nothing else.
 */

const TRACKED = [
  "README.md",
  "package.json",
  "packages/auth/package.json",
  "packages/auth/src/signup.ts",
  "packages/auth/test/signup.test.ts",
  "packages/queue/migrations/0007-dead-letters.sql",
  "packages/queue/package.json",
  "packages/queue/src/retry.ts",
  "packages/web/src/checkout.ts",
  "packages/web/src/session/cookie.ts",
  "infra/policy/egress.yaml",
];

const edge = (specifier: string, resolved: string | null) => ({
  specifier,
  resolved,
  external: false,
  line: 1,
});

const index = (
  files: { path: string; exports?: { name: string; kind: "function"; line: number }[]; imports?: ReturnType<typeof edge>[] }[],
): SymbolIndex =>
  SymbolIndexSchema.parse({
    schema_version: 1,
    built_at: "2026-09-14T00:00:00.000Z",
    head_commit: "0123456789abcdef0123456789abcdef01234567",
    working_tree: "clean",
    files: files.map((file) => ({ path: file.path, exports: file.exports ?? [], imports: file.imports ?? [] })),
    skipped: [],
  });

const INDEX = index([
  {
    path: "packages/auth/src/signup.ts",
    exports: [{ name: "signup", kind: "function", line: 3 }],
    imports: [edge("@webstore/queue", "packages/queue/src/retry.ts")],
  },
  { path: "packages/auth/test/signup.test.ts", imports: [edge("../src/signup.js", "packages/auth/src/signup.ts")] },
  { path: "packages/queue/src/retry.ts", exports: [{ name: "retry", kind: "function", line: 2 }] },
  {
    path: "packages/web/src/checkout.ts",
    imports: [edge("@webstore/auth", "packages/auth/src/signup.ts"), edge("node:fs", null)],
  },
  { path: "packages/web/src/session/cookie.ts", imports: [] },
]);

const report = (over: Partial<ImpactInput> = {}) =>
  impactReport({ scope: ["packages/auth/src/**"], tracked: TRACKED, spec: null, index: INDEX, ...over });

const paths = (warnings: readonly ImpactWarning[]): string[] => warnings.map((warning) => warning.path);
const kinds = (warnings: readonly ImpactWarning[], path: string): ImpactReasonKind[] =>
  warnings.find((warning) => warning.path === path)?.reasons.map((reason) => reason.kind) ?? [];
const detail = (warnings: readonly ImpactWarning[], path: string, kind: ImpactReasonKind): string =>
  warnings.find((warning) => warning.path === path)?.reasons.find((reason) => reason.kind === kind)?.detail ?? "";

describe("who a draft's change reaches", () => {
  it("warns about a file outside the scope that imports one inside it, and not about one inside", () => {
    const { warnings } = report();
    expect(paths(warnings)).toContain("packages/web/src/checkout.ts");
    expect(detail(warnings, "packages/web/src/checkout.ts", "imports_scope")).toBe(
      "imports packages/auth/src/signup.ts, which this draft changes",
    );
    // Inside `packages/auth/src/**`: it is the change, not a consequence of it.
    expect(paths(warnings)).not.toContain("packages/auth/src/signup.ts");
    // It imports the scope too, from outside it.
    expect(kinds(warnings, "packages/auth/test/signup.test.ts")).toContain("imports_scope");
    // It imports nothing the draft changes.
    expect(kinds(warnings, "packages/web/src/session/cookie.ts")).not.toContain("imports_scope");
  });

  it("reports one path's reasons in a fixed order, whatever order they were found in", () => {
    // checkout.ts is named by the spec (found first) and imports the scope
    // (found second); the pane's chips and sentences read in the order
    // `IMPACT_REASON_KINDS` declares, which is the other way round.
    const { warnings } = report({ spec: "Checkout is in packages/web/src/checkout.ts." });
    expect(kinds(warnings, "packages/web/src/checkout.ts")).toEqual(["imports_scope", "named"]);
  });

  it("names each package a warning belongs to", () => {
    const { warnings } = report();
    const checkout = warnings.find((warning) => warning.path === "packages/web/src/checkout.ts");
    expect(checkout?.package).toBe("packages/web");
  });

  it("follows one hop and not the closure", () => {
    // checkout imports signup; nothing imports checkout, so a closure would add
    // nothing here — but a draft over `packages/queue/src/**` would reach
    // checkout transitively through signup, and does not.
    const { warnings } = impactReport({
      scope: ["packages/queue/src/**"],
      tracked: TRACKED,
      spec: null,
      index: INDEX,
    });
    expect(kinds(warnings, "packages/auth/src/signup.ts")).toContain("imports_scope");
    expect(kinds(warnings, "packages/web/src/checkout.ts")).not.toContain("imports_scope");
  });

  it("names at most three imported files in one sentence and counts the rest", () => {
    const wide = index([
      {
        path: "packages/web/src/checkout.ts",
        imports: ["a", "b", "c", "d"].map((name) =>
          edge(`../../auth/src/${name}.js`, `packages/auth/src/${name}.ts`),
        ),
      },
    ]);
    const { warnings } = impactReport({
      scope: ["packages/auth/src/**"],
      tracked: [
        "packages/web/src/checkout.ts",
        ...["a", "b", "c", "d"].map((name) => `packages/auth/src/${name}.ts`),
      ],
      spec: null,
      index: wide,
    });
    expect(detail(warnings, "packages/web/src/checkout.ts", "imports_scope")).toBe(
      "imports packages/auth/src/a.ts, packages/auth/src/b.ts, packages/auth/src/c.ts and 1 more, which this draft changes",
    );
  });

  it("warns about a path the spec names that the scope does not cover, and about its importers", () => {
    const { warnings, named } = report({
      spec: "Retry lives in packages/queue/src/retry.ts and is called from @signup.",
    });
    expect(named.paths).toEqual(["packages/queue/src/retry.ts"]);
    expect(named.symbols).toEqual(["signup"]);
    expect(kinds(warnings, "packages/queue/src/retry.ts")).toContain("named");
    expect(detail(warnings, "packages/queue/src/retry.ts", "named")).toBe(
      "the spec names it, and this draft's scope does not cover it",
    );
    // `@signup` is exported by a file inside the scope, so the scope covers it.
    expect(paths(warnings)).not.toContain("packages/auth/src/signup.ts");
    // signup.ts imports retry.ts, which the spec names — but the scope covers signup.ts.
    // checkout.ts does not import retry.ts, so nothing carries `imports_named` here.
    expect(warnings.flatMap((warning) => warning.reasons.map((reason) => reason.kind))).not.toContain(
      "imports_named",
    );
  });

  it("warns about a file importing what a named symbol's file exports, from outside the scope", () => {
    const { warnings } = impactReport({
      scope: ["packages/queue/src/**"],
      tracked: TRACKED,
      spec: "The work is all in @signup.",
      index: INDEX,
    });
    expect(kinds(warnings, "packages/auth/src/signup.ts")).toContain("named");
    expect(detail(warnings, "packages/auth/src/signup.ts", "named")).toBe(
      "the spec names @signup, which it exports",
    );
    expect(detail(warnings, "packages/web/src/checkout.ts", "imports_named")).toBe(
      "imports packages/auth/src/signup.ts, which the spec names",
    );
  });

  it("names every file that exports a symbol the spec names, and every importer of each", () => {
    // Two packages exporting `retry` is the ordinary state of a monorepo, and
    // the case this whole feature is built for. Keeping one file per name would
    // halve the list, and which half survived would be decided by the order
    // `perbo index` happened to list files in.
    const both = index([
      { path: "packages/auth/src/signup.ts" },
      { path: "packages/http/src/client.ts", imports: [edge("./retry.js", "packages/http/src/retry.ts")] },
      { path: "packages/http/src/retry.ts", exports: [{ name: "retry", kind: "function", line: 2 }] },
      { path: "packages/queue/src/retry.ts", exports: [{ name: "retry", kind: "function", line: 2 }] },
      { path: "packages/queue/src/worker.ts", imports: [edge("./retry.js", "packages/queue/src/retry.ts")] },
    ]);
    const { warnings, named } = impactReport({
      scope: ["packages/auth/src/**"],
      tracked: [
        "packages/auth/src/signup.ts",
        "packages/http/src/client.ts",
        "packages/http/src/retry.ts",
        "packages/queue/src/retry.ts",
        "packages/queue/src/worker.ts",
      ],
      spec: "Rework @retry everywhere.",
      index: both,
    });
    // Four, not two: both declaring files, and the importer of each.
    expect(paths(warnings)).toEqual([
      "packages/http/src/client.ts",
      "packages/http/src/retry.ts",
      "packages/queue/src/retry.ts",
      "packages/queue/src/worker.ts",
    ]);
    expect(kinds(warnings, "packages/http/src/retry.ts")).toEqual(["named"]);
    expect(kinds(warnings, "packages/queue/src/retry.ts")).toEqual(["named"]);
    expect(detail(warnings, "packages/http/src/client.ts", "imports_named")).toBe(
      "imports packages/http/src/retry.ts, which the spec names",
    );
    expect(detail(warnings, "packages/queue/src/worker.ts", "imports_named")).toBe(
      "imports packages/queue/src/retry.ts, which the spec names",
    );
    expect(named.symbols).toEqual(["retry"]);
  });
});

describe("a path a spec names, judged where it lands", () => {
  const tracked = new Set(TRACKED);

  it("resolves before it judges, whatever the spelling", () => {
    const cases: [string, string[]][] = [
      // The path itself, and the same path reached through `.` and `..`.
      ["packages/auth/src/signup.ts", ["packages/auth/src/signup.ts"]],
      ["./packages/auth/./src/signup.ts", ["packages/auth/src/signup.ts"]],
      ["packages/queue/../auth/src/signup.ts", ["packages/auth/src/signup.ts"]],
      // The container where a file was meant, and a trailing slash: neither is a tracked file.
      ["packages/auth/src", []],
      ["packages/auth/src/", []],
      // A climb out of the repository, and an absolute path inside and outside it.
      ["../../etc/passwd", []],
      ["packages/../../etc/passwd", []],
      ["/etc/passwd", []],
      ["/packages/auth/src/signup.ts", []],
      // A Windows spelling: Git states a tracked path with `/`, so this names none.
      ["packages\\auth\\src\\signup.ts", []],
      ["packages\\..\\..\\etc\\passwd", []],
    ];
    for (const [written, expected] of cases)
      expect(specNames(`The change is in ${written} and nowhere else.`, tracked).paths, written).toEqual(
        expected,
      );
  });

  it("reads a path out of prose, punctuation and Markdown around it", () => {
    expect(specNames("Change `packages/auth/src/signup.ts`, then stop.", tracked).paths).toEqual([
      "packages/auth/src/signup.ts",
    ]);
    expect(specNames("(see packages/queue/src/retry.ts).", tracked).paths).toEqual([
      "packages/queue/src/retry.ts",
    ]);
  });

  it("names nothing before this planning has written one", () => {
    expect(report().named).toEqual({ paths: [], symbols: [] });
  });

  it("reads @Symbol as a name and not an address", () => {
    expect(specNames("Ask owner@example.com about @retry and @signup.", tracked).symbols).toEqual([
      "retry",
      "signup",
    ]);
    // A doubled sigil is not a name either: the `@` a name follows must be the
    // first one, or a pasted `@@handle` reads as a symbol the spec never wrote.
    expect(specNames("Do not let @@retry read as one.", tracked).symbols).toEqual([]);
    // Nor is one hanging off the end of a filename or a version, where the `@`
    // belongs to the token before it rather than starting a name.
    expect(specNames("See spec.md.@retry for it.", tracked).symbols).toEqual([]);
  });

  it("reads @Symbol through the one shared reading, not a copy of the pattern", () => {
    // specNames calls spec-text.ts's specSymbolNames, the same reading the
    // Spec pane completes from and marks by. Comparing against that function
    // directly — rather than trusting the import — is what would redden if a
    // second copy of the pattern crept in and the two readings drifted apart.
    for (const text of [
      "Ask owner@example.com about @retry and @signup.",
      "Do not let @@retry read as one.",
      "See spec.md.@retry for it.",
      "@retry$Queue and @$ and @_private, from queue.@notAName.",
      "(@signup), [@retry], {@notify}.",
      "one\n@signup\ntwo",
      "",
    ]) {
      expect(specNames(text, tracked).symbols).toEqual([...specSymbolNames(text)].sort());
    }
  });

  it("names the symbols that reached a file, and not the ones the spec merely wrote", () => {
    // Both are `@Symbol` tokens in the spec; only one of them is exported by a
    // file here. The pane prints this list as one sentence, so a name that
    // rooted no analysis would read exactly like one that did.
    const { named, warnings } = report({ spec: "Rework @retry and @thisNeverExisted." });
    expect(named.symbols).toEqual(["retry"]);
    // The one that did reach a file still roots the analysis it always did.
    expect(kinds(warnings, "packages/queue/src/retry.ts")).toContain("named");
  });

  it("names no symbol where there was no index to look one up in", () => {
    const { named, index } = impactReport({
      scope: ["src/pages/**"],
      tracked: ["src/pages/home.html", "src/auth/login.html"],
      spec: "Rework @retry and @signup.",
      index: UnsupportedRepositorySchema.parse({
        supported: false,
        reason: "no tracked TypeScript or JavaScript file outside node_modules, dist and .perbo",
        languages_seen: [".html"],
      }),
    });
    // The note already says no import was read; the footer beside it must not
    // then list two symbols as things this repository has.
    expect(index.read).toBe(false);
    expect(named.symbols).toEqual([]);
  });
});

describe("the path classes a change reaches", () => {
  it("warns about a hazard class outside the scope but inside a package the scope names", () => {
    const { warnings } = impactReport({
      scope: ["packages/queue/src/**"],
      tracked: TRACKED,
      spec: null,
      index: INDEX,
    });
    expect(kinds(warnings, "packages/queue/migrations/0007-dead-letters.sql")).toContain("migration");
    expect(detail(warnings, "packages/queue/migrations/0007-dead-letters.sql", "migration")).toBe(
      "a schema or data migration, whose effect outlives the pull request",
    );
    // Another package entirely: not this change's blast radius.
    expect(paths(warnings)).not.toContain("packages/auth/package.json");
    expect(paths(warnings)).not.toContain("infra/policy/egress.yaml");
  });

  it("recognises the dependency, configuration, security and policy classes by their own names", () => {
    const { warnings } = impactReport({
      scope: ["packages/auth/src/**", "packages/web/src/checkout.ts", "infra/terraform/**"],
      tracked: [...TRACKED, "infra/terraform/main.tf", "packages/web/tsconfig.json"],
      spec: null,
      index: INDEX,
    });
    expect(kinds(warnings, "packages/auth/package.json")).toContain("dependency");
    expect(kinds(warnings, "packages/web/tsconfig.json")).toContain("config");
    expect(kinds(warnings, "packages/web/src/session/cookie.ts")).toContain("security");
    expect(kinds(warnings, "infra/policy/egress.yaml")).toEqual(["config", "ci_infra_policy"]);
    expect(detail(warnings, "infra/policy/egress.yaml", "ci_infra_policy")).toBe(
      "CI, infrastructure or policy, which takes effect outside the pull request carrying it",
    );
  });

  it("says nothing about a hazard class the scope already covers", () => {
    const { warnings } = impactReport({
      scope: ["packages/queue/migrations/**", "packages/queue/src/**"],
      tracked: TRACKED,
      spec: null,
      index: INDEX,
    });
    expect(paths(warnings)).not.toContain("packages/queue/migrations/0007-dead-letters.sql");
    // The same call still lists one the scope does not cover, so the silence above is the rule and not an empty answer.
    expect(kinds(warnings, "packages/queue/package.json")).toEqual(["dependency"]);
  });

  it("reaches a package the scope covers a file of, however the glob is written", () => {
    // `packageOf("packages/**/*.ts")` is `packages/**`, which is no package a
    // tracked path belongs to. The packages reached are the ones holding a file
    // the scope covers, so a draft scoped by a wide glob still hears about the
    // manifests and migrations sitting beside what it changes.
    const { warnings } = impactReport({
      scope: ["packages/**/*.ts"],
      tracked: TRACKED,
      spec: null,
      index: INDEX,
    });
    expect(kinds(warnings, "packages/queue/migrations/0007-dead-letters.sql")).toContain("migration");
    expect(kinds(warnings, "packages/auth/package.json")).toContain("dependency");
    // A package the scope covers no file of is still outside this change.
    expect(paths(warnings)).not.toContain("infra/policy/egress.yaml");
  });

  it.each([
    ["a file the draft has not created yet", "packages/auth/src/new-thing.ts"],
    ["a plain directory, with no glob", "packages/auth/src"],
  ])("reaches a package a scope entry names by its own text — %s", (_label, entry) => {
    // A scope entry reaches its own package by its text alone, the same way
    // `admittedWriteGlobs` reads `paths_allowed`: neither spelling here
    // matches a tracked path, so without it `reached` would be empty.
    const { warnings } = impactReport({
      scope: [entry],
      tracked: TRACKED,
      spec: null,
      index: INDEX,
    });
    expect(kinds(warnings, "packages/auth/package.json")).toContain("dependency");
  });

  it("reaches a package the spec names even where the scope does not", () => {
    const { warnings } = impactReport({
      scope: ["packages/auth/src/**"],
      tracked: TRACKED,
      spec: "The dead-letter behaviour is in packages/queue/src/retry.ts.",
      index: INDEX,
    });
    expect(kinds(warnings, "packages/queue/migrations/0007-dead-letters.sql")).toContain("migration");
  });
});

describe("a repository the index cannot describe", () => {
  const answer: UnsupportedRepository = UnsupportedRepositorySchema.parse({
    supported: false,
    reason: "no tracked TypeScript or JavaScript file outside node_modules, dist and .perbo",
    languages_seen: [".css", ".html"],
  });

  it("lists the path-class warnings alone, and says why the imports are missing", () => {
    const { warnings, index } = impactReport({
      scope: ["src/pages/**"],
      tracked: ["src/pages/home.html", "src/styles.css", "src/auth/login.html", "src/migrations/0001.sql"],
      spec: null,
      index: answer,
    });
    expect(index.read).toBe(false);
    expect(index.commit).toBeNull();
    expect(index.note).toBe(
      "Nothing here reads imports: no tracked TypeScript or JavaScript file outside node_modules, dist and .perbo. " +
        "Only the path classes are listed — they are the same in any language. " +
        "Tracked extensions here: .css .html.",
    );
    expect(paths(warnings)).toEqual(["src/auth/login.html", "src/migrations/0001.sql"]);
    expect(warnings.flatMap((warning) => warning.reasons.map((reason) => reason.kind))).toEqual([
      "security",
      "migration",
    ]);
  });

  it("names only the extensions the tracked list it was handed carries too", () => {
    // `perbo index` computes `languages_seen` over its whole tracked tree with
    // no never-read filter of its own, so it can carry the extension of a file
    // this surface may never name — and the footer under this note promises
    // that secrets and agent configuration never appear here (ADR-0030).
    const { index } = impactReport({
      scope: ["src/pages/**"],
      tracked: ["src/pages/home.html", "src/styles.css"],
      spec: null,
      index: UnsupportedRepositorySchema.parse({
        supported: false,
        reason: "no tracked TypeScript or JavaScript file outside node_modules, dist and .perbo",
        languages_seen: [".css", ".html", ".pem"],
      }),
    });
    expect(index.note?.endsWith("Tracked extensions here: .css .html.")).toBe(true);
  });

  it("says the tracked extensions are none where the repository has none", () => {
    const { index } = impactReport({
      scope: ["src/**"],
      tracked: [],
      spec: null,
      index: UnsupportedRepositorySchema.parse({
        supported: false,
        reason: "this repository tracks no file at all",
        languages_seen: [],
      }),
    });
    expect(index.note?.endsWith("Tracked extensions here: none.")).toBe(true);
  });

  it("carries the commit an index was built at when there is one", () => {
    expect(report().index).toEqual({
      read: true,
      commit: "0123456789abcdef0123456789abcdef01234567",
      note: null,
    });
  });
});

describe("the list the pane is given", () => {
  it("is capped, and says how many it left out", () => {
    const many = Array.from({ length: IMPACT_WARNING_CAP + 7 }, (_, at) => `packages/web/src/page-${at}.sql`);
    const { warnings, truncated } = impactReport({
      scope: ["packages/web/src/checkout.ts"],
      tracked: ["packages/web/src/checkout.ts", ...many],
      spec: null,
      index: INDEX,
    });
    expect(warnings).toHaveLength(IMPACT_WARNING_CAP);
    expect(truncated).toBe(7);
    expect(paths(warnings)).toEqual([...many].sort().slice(0, IMPACT_WARNING_CAP));
    // The cap itself, so shortening it is a change somebody chose to make.
    expect(IMPACT_WARNING_CAP).toBe(200);
  });

  it("says nothing was left out where the cap was not reached", () => {
    // `truncated` is documented as a count "or 0", and the pane renders its
    // sentence on `truncated > 0`, so a negative would be a silent nothing.
    expect(report().truncated).toBe(0);
  });

  it("never names a path the repository does not track", () => {
    const stale = index([
      { path: "packages/web/src/gone.ts", imports: [edge("../../auth/src/signup.js", "packages/auth/src/signup.ts")] },
    ]);
    const { warnings } = impactReport({
      scope: ["packages/auth/src/**"],
      tracked: TRACKED,
      spec: "It is all in packages/web/src/gone.ts, beside packages/queue/src/retry.ts.",
      index: stale,
    });
    expect(paths(warnings)).not.toContain("packages/web/src/gone.ts");
    // A tracked path the same spec names is here, so the silence above is the tracked check and not an empty answer.
    expect(kinds(warnings, "packages/queue/src/retry.ts")).toEqual(["named"]);
  });

  it("reports the scope it judged against without holding on to the draft's own array", () => {
    const scope = ["packages/auth/src/**"];
    const answer = impactReport({ scope, tracked: TRACKED, spec: null, index: INDEX });
    expect(answer.scope).toEqual(["packages/auth/src/**"]);
    expect(answer.scope).not.toBe(scope);
    answer.scope.push("packages/web/**");
    expect(scope).toEqual(["packages/auth/src/**"]);
  });
});

/**
 * A path nothing here reads (ADR-0030, D-015).
 *
 * `perbo index` has no never-read filter of its own: the filter is applied to
 * the tracked list this is handed, and the index is built over the whole tree.
 * So a resolved import edge can land on a secret or on agent configuration
 * while every warning *path* is still a tracked one. What leaks that way is the
 * name and never the contents — but a name is what the pane prints, and the
 * pane, `docs/15` and this file all promise the absolute.
 */
describe("a path nothing here reads", () => {
  const withheld = ["src/secrets/keys.ts", ".claude/hooks/helper.mjs"];
  const tracked = ["app/main.ts", "src/pay.ts", ...withheld].filter(
    (path) => !isNeverReadPath(path),
  );
  const leaky = index([
    {
      path: "app/main.ts",
      imports: [
        // One the scope covers, one the scope covers that nothing here reads,
        // and one that a symbol the spec names is exported by.
        edge("./src/pay.js", "src/pay.ts"),
        edge("./src/secrets/keys.js", "src/secrets/keys.ts"),
        edge("../.claude/hooks/helper.mjs", ".claude/hooks/helper.mjs"),
      ],
    },
    { path: "src/secrets/keys.ts", exports: [{ name: "KEYS", kind: "function", line: 1 }] },
    { path: ".claude/hooks/helper.mjs", exports: [{ name: "analyze", kind: "function", line: 1 }] },
  ]);
  const withheldReport = () =>
    impactReport({
      scope: ["src/**"],
      tracked,
      spec: "Run @analyze over app/main.ts.",
      index: leaky,
    });

  it("is not read out by the sentence for a file that imports it", () => {
    const { warnings } = withheldReport();
    // The importer is warned about, and its sentence names the one import it
    // has that this surface may name — so the two silences below are the guard
    // and not an empty answer.
    expect(detail(warnings, "app/main.ts", "imports_scope")).toBe(
      "imports src/pay.ts, which this draft changes",
    );
    expect(kinds(warnings, "app/main.ts")).not.toContain("imports_named");
  });

  it("appears nowhere in the report, as a path or inside a sentence", () => {
    const serialised = JSON.stringify(withheldReport());
    for (const hidden of withheld) expect(serialised, hidden).not.toContain(hidden);
  });

  it("does not answer for a symbol only a file nothing here reads exports", () => {
    // `@analyze` is exported by the withheld hook and by nothing else. The
    // footer lists the symbols the spec names that this repository has, so
    // answering for it would say the repository has one through a file this
    // surface may not look at.
    expect(withheldReport().named.symbols).toEqual([]);
    // A symbol a file this surface may name exports is still answered for, so
    // the silence above is the guard and not an empty answer.
    const { named } = impactReport({
      scope: ["src/**"],
      tracked: [...tracked, "app/exported.ts"],
      spec: "Run @analyze and @open over app/main.ts.",
      index: index([
        { path: "app/exported.ts", exports: [{ name: "open", kind: "function", line: 1 }] },
        { path: ".claude/hooks/helper.mjs", exports: [{ name: "analyze", kind: "function", line: 1 }] },
      ]),
    });
    expect(named.symbols).toEqual(["open"]);
  });
});

describe("the No-Go a warning becomes", () => {
  it("appends one line in the section's own voice", () => {
    expect(withNoGo("", "packages/queue/src/retry.ts")).toBe("- Changing packages/queue/src/retry.ts.");
    expect(withNoGo("- Changing the brand colours.", "packages/ui/src/theme.ts")).toBe(
      "- Changing the brand colours.\n- Changing packages/ui/src/theme.ts.",
    );
    // A section left with a trailing newline gains one line, not a blank one.
    expect(withNoGo("- Changing the brand colours.\n\n", "packages/ui/src/theme.ts")).toBe(
      "- Changing the brand colours.\n- Changing packages/ui/src/theme.ts.",
    );
  });

  it("says it once, however often it is asked", () => {
    const once = withNoGo("- Changing the brand colours.", "packages/ui/src/theme.ts");
    expect(withNoGo(once, "packages/ui/src/theme.ts")).toBe(once);
    // A different path still lands.
    expect(withNoGo(once, "packages/queue/src/retry.ts").split("\n")).toHaveLength(3);
    // The spec is a file a person edits by hand, so the line it already
    // carries is the same line whatever whitespace is around it.
    const spaced = "- Changing the brand colours.\n  - Changing packages/ui/src/theme.ts.  ";
    expect(withNoGo(spaced, "packages/ui/src/theme.ts")).toBe(spaced);
  });
});
