import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SYMBOL_INDEX_SCHEMA_VERSION, SymbolIndexSchema } from "@perbo/contracts";
import {
  buildSymbolIndex,
  isUnsupportedRepository,
  parseIndexArgs,
  runIndexCommand,
  symbolIndexPath,
} from "../src/symbol-index.js";
import type { Streams } from "../src/streams.js";

/**
 * `perbo index` over an authored monorepo (SCP-319, D-015).
 *
 * The fixture under `fixtures/symbol-index/` is a repository as a person would
 * write one — two workspace packages importing each other, an application over
 * both — and `fixtures/symbol-index.expected.json` is the index a reader would
 * write out by hand from reading it. The first case compares the two exactly,
 * so a parser that learns to see one more thing, or stops seeing one, fails
 * here rather than showing up as a missing impact warning months later.
 *
 * Every case copies the fixture and runs `git init` over the copy, because the
 * index reads the *tracked* tree: the fixture's own files are tracked by this
 * repository, not by one of their own.
 *
 * Each spawns several real `git` processes, so each carries an explicit
 * timeout rather than vitest's five-second default: on a machine also running
 * a gate, that work outruns five seconds on its own.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const TIMEOUT = 30_000;

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "perbo-symbol-index-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * An identity of this test's own, and neither the machine's global config nor
 * its system config: a commit here must not depend on whether whoever runs it
 * signs commits, has an identity set, or has hooks configured.
 */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "ignore" });
};

let made = 0;

/**
 * One fixture, copied out and committed as a repository of its own.
 *
 * `edit` runs against the copy before anything is added, which is how a case
 * adds a file this repository cannot carry — one inside `node_modules/`,
 * `dist/` or `.perbo/`, all of which its own `.gitignore` excludes.
 */
function repositoryFrom(fixture: string, edit?: (root: string) => void): string {
  const root = join(scratch, `${fixture}-${(made += 1)}`);
  cpSync(join(FIXTURES, fixture), root, { recursive: true });
  edit?.(root);
  git(root, "init", "--initial-branch", "main");
  git(root, "add", "-A");
  git(root, "commit", "-m", "the fixture");
  return root;
}

/** The three writes a command is given, with what it wrote kept. */
function capture(): Streams & { out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: (chunk: string) => out.push(chunk),
    stderr: (chunk: string) => err.push(chunk),
    isTTY: false,
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

/** The index as the expectation names it: the files and what was skipped, and nothing about this machine. */
const comparable = (index: unknown): unknown => {
  const parsed = SymbolIndexSchema.parse(index);
  return { files: parsed.files, skipped: parsed.skipped };
};

const EXPECTED = JSON.parse(readFileSync(join(FIXTURES, "symbol-index.expected.json"), "utf8")) as unknown;

describe("the index of an authored monorepo", () => {
  it(
    "matches the hand-written expectation, exactly",
    () => {
      const root = repositoryFrom("symbol-index");
      const built = buildSymbolIndex({ repositoryRoot: root });
      expect(isUnsupportedRepository(built)).toBe(false);
      expect(comparable(built)).toEqual(EXPECTED);
    },
    TIMEOUT,
  );

  /**
   * The fixture declares its packages as `apps/*` and `packages/**`. Both
   * forms are ordinary in a `packages:` list, and a repository written the
   * other way round has to resolve the same: a workspace name that stopped
   * matching would read as a package from the registry — `external: true`
   * with nothing resolved — rather than as an error.
   */
  it(
    "admits the same workspace packages whether they are globbed with * or **",
    () => {
      const root = repositoryFrom("symbol-index", (at) => {
        writeFileSync(
          join(at, "pnpm-workspace.yaml"),
          'packages:\n  - "apps/**"\n  - "packages/*"\n',
        );
      });
      expect(comparable(buildSymbolIndex({ repositoryRoot: root }))).toEqual(EXPECTED);
    },
    TIMEOUT,
  );

  /**
   * The rest of the dialect a `packages:` list is written in, and that the
   * package manager reads: a member may be written from the repository root
   * as `./apps/*`, and one entry may name several directories at once. A
   * repository written either way installs, so its names have to resolve.
   */
  it(
    "admits workspace globs written with a leading ./",
    () => {
      const root = repositoryFrom("symbol-index", (at) => {
        writeFileSync(
          join(at, "pnpm-workspace.yaml"),
          'packages:\n  - "./apps/*"\n  - "./packages/*"\n',
        );
      });
      expect(comparable(buildSymbolIndex({ repositoryRoot: root }))).toEqual(EXPECTED);
    },
    TIMEOUT,
  );

  it(
    "admits workspace globs written with braces",
    () => {
      const root = repositoryFrom("symbol-index", (at) => {
        writeFileSync(join(at, "pnpm-workspace.yaml"), 'packages:\n  - "{apps,packages}/*"\n');
      });
      expect(comparable(buildSymbolIndex({ repositoryRoot: root }))).toEqual(EXPECTED);
    },
    TIMEOUT,
  );

  /**
   * A negated entry takes a directory out of the workspace, so the name its
   * manifest declares is not a workspace name any more: an import of it is a
   * package from the registry, resolved to nothing, rather than an error.
   */
  it(
    "leaves out a package a negated glob names",
    () => {
      const root = repositoryFrom("symbol-index", (at) => {
        writeFileSync(
          join(at, "pnpm-workspace.yaml"),
          'packages:\n  - "apps/*"\n  - "packages/*"\n  - "!packages/ui"\n',
        );
      });
      const built = SymbolIndexSchema.parse(buildSymbolIndex({ repositoryRoot: root }));
      const main = built.files.find((file) => file.path === "apps/web/src/main.ts");
      expect(main?.imports.filter((edge) => edge.specifier === "@fixture/ui")).toEqual([
        { specifier: "@fixture/ui", resolved: null, external: true, line: 2 },
        { specifier: "@fixture/ui", resolved: null, external: true, line: 8 },
      ]);
      // The package that is still a member resolves, so the exclusion is the
      // negated entry rather than the whole list failing to match.
      expect(main?.imports.find((edge) => edge.specifier === "@fixture/core")?.resolved).toBe(
        "packages/core/src/index.ts",
      );
    },
    TIMEOUT,
  );

  it(
    "stamps the commit it read and the schema it was written against",
    () => {
      const root = repositoryFrom("symbol-index");
      const built = SymbolIndexSchema.parse(buildSymbolIndex({ repositoryRoot: root }));
      const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      expect(built.head_commit).toBe(head);
      expect(built.working_tree).toBe("clean");
      expect(built.schema_version).toBe(SYMBOL_INDEX_SCHEMA_VERSION);
      expect(Date.parse(built.built_at)).not.toBeNaN();
    },
    TIMEOUT,
  );

  it(
    "says when a tracked file was read with changes the commit does not carry",
    () => {
      const root = repositoryFrom("symbol-index");
      writeFileSync(join(root, "packages", "core", "src", "theme.ts"), "export const theme = 2;\n");
      const built = SymbolIndexSchema.parse(buildSymbolIndex({ repositoryRoot: root }));
      expect(built.working_tree).toBe("modified");
      // What is on disk is what was read: the record describes the checkout,
      // and the stamp says the checkout is not the commit.
      expect(built.files.find((file) => file.path === "packages/core/src/theme.ts")?.imports).toEqual([]);
      const streams = capture();
      expect(runIndexCommand({ argv: ["--repo", root], streams, cwd: scratch })).toBe(0);
      expect(streams.out()).toContain("with uncommitted changes");
    },
    TIMEOUT,
  );

  it(
    "resolves a workspace package whose exports is the root entry's own conditions object",
    () => {
      // The entry is not `index`, so nothing but the conditions object names it.
      const root = repositoryFrom("symbol-index", (at) => {
        renameSync(join(at, "packages", "ui", "src", "index.ts"), join(at, "packages", "ui", "src", "entry.ts"));
        writeFileSync(
          join(at, "packages", "ui", "package.json"),
          JSON.stringify(
            {
              name: "@fixture/ui",
              version: "0.0.0",
              type: "module",
              exports: { types: "./src/entry.ts", import: "./dist/entry.js" },
            },
            null,
            2,
          ),
        );
      });
      const moved = JSON.parse(
        JSON.stringify(EXPECTED).replaceAll("packages/ui/src/index.ts", "packages/ui/src/entry.ts"),
      ) as { files: { path: string }[] };
      moved.files.sort((left, right) => left.path.localeCompare(right.path));
      expect(comparable(buildSymbolIndex({ repositoryRoot: root }))).toEqual(moved);
    },
    TIMEOUT,
  );

  it(
    "reads none of node_modules, dist or the store, whatever the tree tracks",
    () => {
      const root = repositoryFrom("symbol-index", (at) => {
        for (const path of [
          join("packages", "ui", "dist", "index.ts"),
          join("apps", "web", "node_modules", "dep", "index.ts"),
          join(".perbo", "cache.ts"),
        ]) {
          mkdirSync(join(at, dirname(path)), { recursive: true });
          writeFileSync(join(at, path), "export const excluded = 1;\n");
        }
      });
      const tracked = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" });
      // The premise: git really is carrying all three, so a pass means the
      // indexer left them out rather than that they were never there.
      expect(tracked).toContain("packages/ui/dist/index.ts");
      expect(tracked).toContain("apps/web/node_modules/dep/index.ts");
      expect(tracked).toContain(".perbo/cache.ts");

      const built = SymbolIndexSchema.parse(buildSymbolIndex({ repositoryRoot: root }));
      expect(built.files.map((file) => file.path)).toEqual(
        (EXPECTED as { files: { path: string }[] }).files.map((file) => file.path),
      );
    },
    TIMEOUT,
  );

  it(
    "skips a file over the size cap and says so, rather than dropping it",
    () => {
      const root = repositoryFrom("symbol-index", (at) => {
        const filler = `export const padding = "${"x".repeat(64)}";\n`;
        writeFileSync(
          join(at, "packages", "core", "src", "huge.ts"),
          filler.repeat(Math.ceil((1.5 * 1024 * 1024) / filler.length)),
        );
        writeFileSync(
          join(at, "packages", "core", "src", "needs-huge.ts"),
          'import { padding } from "./huge.js";\nexport const needs = padding;\n',
        );
      });
      const built = SymbolIndexSchema.parse(buildSymbolIndex({ repositoryRoot: root }));
      expect(built.files.map((file) => file.path)).not.toContain("packages/core/src/huge.ts");
      expect(built.skipped.map((file) => file.path)).toEqual(["packages/core/src/huge.ts"]);
      expect(built.skipped[0]!.reason).toBe("1.5 MiB, over the 1 MiB cap");
      // An edge to it is unresolved, not resolved to a record the index does not hold.
      const importer = built.files.find((file) => file.path === "packages/core/src/needs-huge.ts");
      expect(importer?.imports).toEqual([
        { specifier: "./huge.js", resolved: null, external: false, line: 1 },
      ]);
    },
    TIMEOUT,
  );
});

describe("what the index skips rather than fails on", () => {
  it(
    "skips a file carrying a name the record cannot hold, and says which, keeping the rest",
    () => {
      const root = repositoryFrom("symbol-index", (at) => {
        writeFileSync(join(at, "packages", "core", "src", "nameless.cjs"), 'module.exports = { "": 1 };\n');
        writeFileSync(join(at, "packages", "core", "src", "blank.ts"), 'import "";\nexport const blank = 1;\n');
      });
      const streams = capture();
      expect(runIndexCommand({ argv: ["--repo", root], streams, cwd: scratch })).toBe(0);
      const built = SymbolIndexSchema.parse(JSON.parse(readFileSync(symbolIndexPath(root), "utf8")));
      expect(built.files.map((file) => file.path)).toEqual(
        (EXPECTED as { files: { path: string }[] }).files.map((file) => file.path),
      );
      expect(built.skipped.map((file) => file.path)).toEqual([
        "packages/core/src/blank.ts",
        "packages/core/src/nameless.cjs",
      ]);
      expect(built.skipped[0]!.reason).toMatch(/imports\.0\.specifier/);
      expect(built.skipped[1]!.reason).toMatch(/exports\.0\.name/);
      expect(streams.out()).toContain("2 skipped");
    },
    TIMEOUT,
  );

  it(
    "skips a tracked symbolic link rather than following it out of the repository",
    () => {
      const outside = join(scratch, `outside-${made}.ts`);
      writeFileSync(outside, "export const outside = 1;\n");
      const root = repositoryFrom("symbol-index", (at) => {
        symlinkSync(outside, join(at, "packages", "core", "src", "linked.ts"));
      });
      const built = SymbolIndexSchema.parse(buildSymbolIndex({ repositoryRoot: root }));
      expect(built.files.map((file) => file.path)).not.toContain("packages/core/src/linked.ts");
      expect(built.files.flatMap((file) => file.exports.map((symbol) => symbol.name))).not.toContain("outside");
      expect(built.skipped).toEqual([
        { path: "packages/core/src/linked.ts", reason: "a symbolic link, which the index does not follow" },
      ]);
    },
    TIMEOUT,
  );
});

describe("a repository outside TypeScript and JavaScript", () => {
  it(
    "answers that it is unsupported and names what it does hold",
    () => {
      const root = repositoryFrom("symbol-index-unsupported");
      const built = buildSymbolIndex({ repositoryRoot: root });
      expect(isUnsupportedRepository(built)).toBe(true);
      if (!isUnsupportedRepository(built)) throw new Error("unreachable");
      expect(built.supported).toBe(false);
      expect(built.reason).toMatch(/TypeScript|JavaScript/);
      expect(built.languages_seen).toEqual([".md", ".py", ".toml"]);
    },
    TIMEOUT,
  );

  it(
    "prints that answer, writes no index, and exits 0 — nothing is broken here",
    () => {
      const root = repositoryFrom("symbol-index-unsupported");
      const streams = capture();
      const code = runIndexCommand({ argv: ["--repo", root, "--json"], streams, cwd: scratch });
      expect(code).toBe(0);
      expect(JSON.parse(streams.out())).toEqual({
        supported: false,
        reason: expect.stringMatching(/TypeScript|JavaScript/) as unknown as string,
        languages_seen: [".md", ".py", ".toml"],
      });
      expect(() => readFileSync(symbolIndexPath(root), "utf8")).toThrow();

      const plain = capture();
      expect(runIndexCommand({ argv: ["--repo", root], streams: plain, cwd: scratch })).toBe(0);
      expect(plain.out()).toMatch(/not indexed|unsupported/i);
      expect(plain.out()).toContain(".py");
    },
    TIMEOUT,
  );
});

describe("perbo index, the command", () => {
  it(
    "writes the index under the store and prints the same record with --json",
    () => {
      const root = repositoryFrom("symbol-index");
      const streams = capture();
      const code = runIndexCommand({ argv: ["--repo", root, "--json"], streams, cwd: scratch });
      expect(code).toBe(0);

      const printed = JSON.parse(streams.out()) as unknown;
      const written = JSON.parse(readFileSync(symbolIndexPath(root), "utf8")) as unknown;
      expect(symbolIndexPath(root)).toBe(join(root, ".perbo", "index.json"));
      expect(written).toEqual(printed);
      expect(comparable(written)).toEqual(EXPECTED);
    },
    TIMEOUT,
  );

  it(
    "prints a summary rather than the record when --json is not given",
    () => {
      const root = repositoryFrom("symbol-index");
      const streams = capture();
      expect(runIndexCommand({ argv: ["--repo", root], streams, cwd: scratch })).toBe(0);
      const printed = streams.out();
      expect(() => JSON.parse(printed)).toThrow();
      // The counts the summary is for: nine files, and the exports and edges in them.
      expect(printed).toContain("9");
      expect(printed).toContain(join(root, ".perbo", "index.json"));
      expect(comparable(JSON.parse(readFileSync(symbolIndexPath(root), "utf8")))).toEqual(EXPECTED);
    },
    TIMEOUT,
  );

  it("refuses a flag it does not take", () => {
    expect(() => parseIndexArgs(["--depth", "2"])).toThrow(/--depth/);
    expect(() => parseIndexArgs(["--json=yes"])).toThrow();
    expect(() => parseIndexArgs(["--repo"])).toThrow(/value/);
  });

  it("defaults to the working directory and to the summary", () => {
    expect(parseIndexArgs([])).toEqual({ repo: ".", json: false });
    expect(parseIndexArgs(["--repo", "/somewhere", "--json"])).toEqual({
      repo: "/somewhere",
      json: true,
    });
  });
});
