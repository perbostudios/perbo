import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sample } from "./sample-fixtures.js";
import type { HarnessResult, RunRecord } from "../src/harness.js";
import {
  buildCorpusRunManifest,
  captureRunSource,
  CorpusRunManifestSchema,
  manifestExecutedBundle,
  manifestReviewTimeoutMs,
  runManifestFingerprint,
  validateCorpusRunManifest,
} from "../src/run-manifest.js";

const fixtures = sample.slice(0, 2);
const runs: RunRecord[] = fixtures.flatMap((fixture) =>
  [1, 2].map(
    (repeat): RunRecord =>
      ({
        fixture_id: fixture.fixture.id,
        repeat,
        exit_code: 0,
        artifact: {
          model: {
            provider: "codex-cli",
            model_id: "gpt-5.6-terra",
            prompt_version: "reviewer_v6",
          },
          routing_policy: "d065",
        },
        score: null,
        wall_ms: 1,
        failure: null,
      }) as never,
  ),
);
const result: HarnessResult = {
  // The reviewer copy the run executed, as `runCorpus` reports it.
  bundle: {
    path: "/tmp/out/bin/perbo.mjs",
    sha256: "c".repeat(64),
    bytes: 4096,
    source: "apps/cli/dist/main.js",
  },
  fixtures,
  runs,
  excluded_unprepared: [],
  started_at: "2026-09-01T12:50:00.000Z",
  finished_at: "2026-09-01T12:51:00.000Z",
};
const serialisedRuns = `${JSON.stringify(runs, null, 2)}\n`;

const manifest = () => {
  const source = captureRunSource({
    cliPath: "src/main.ts",
    cwd: process.cwd(),
  });
  const built = buildCorpusRunManifest({
    result,
    requestedRepeats: 2,
    serialisedRuns,
    source: {
      ...source,
      source_commit: "a".repeat(40),
      source_tracked_dirty: false,
      provider_binary_sha256: "b".repeat(64),
    },
    reviewTimeoutMs: 900_000,
  });
  return CorpusRunManifestSchema.parse(built);
};

describe("corpus run manifests", () => {
  it("binds runs, fixture contents, repeats, providers, and source state", () => {
    expect(manifest().source_commit).toBe("a".repeat(40));
    // SCP-199: the deadline the harness enforced is stated in the manifest.
    expect(manifestReviewTimeoutMs(manifest())).toBe(900_000);
    expect(
      validateCorpusRunManifest({
        manifest: manifest(),
        runs,
        serialisedRuns,
        fixtures,
      }),
    ).toEqual([]);
  });

  it("rejects a changed runs file and an incomplete repeat structure", () => {
    const changedRuns = `${serialisedRuns} `;
    expect(
      validateCorpusRunManifest({
        manifest: manifest(),
        runs,
        serialisedRuns: changedRuns,
        fixtures,
      }).join(" "),
    ).toMatch(/runs\.json/);

    const incomplete = runs.slice(0, -1);
    expect(
      validateCorpusRunManifest({
        manifest: manifest(),
        runs: incomplete,
        serialisedRuns: `${JSON.stringify(incomplete, null, 2)}\n`,
        fixtures,
      }).join(" "),
    ).toMatch(/repeat structure|exact requested repeat/);
  });

  it("recomputes manifest identity and artifact metadata", () => {
    const changed = CorpusRunManifestSchema.parse({
      ...manifest(),
      run_id: `run_${"f".repeat(16)}`,
      providers: ["claude-cli"],
    });
    const reasons = validateCorpusRunManifest({
      manifest: changed,
      runs,
      serialisedRuns,
      fixtures,
    }).join(" ");

    expect(reasons).toMatch(/run id/);
    expect(reasons).toMatch(/providers/);
  });

  it("fingerprints canonical manifest content, independent of JSON formatting", () => {
    const original = manifest();
    const reparsed = CorpusRunManifestSchema.parse(JSON.parse(JSON.stringify(original)));
    expect(runManifestFingerprint(reparsed)).toBe(runManifestFingerprint(original));
  });
});

/**
 * A run costs an hour and real money, and its directory is read long after the
 * run: sampled, scored, quoted, archived. Recording one more thing about a new
 * run must not make an old run's directory unreadable, and must not make the
 * ~40MB reviewer copy a file the directory has to keep forever to stay
 * scoreable.
 */
describe("run manifests written before the reviewer bundle was recorded", () => {
  const scratch = mkdtempSync(join(tmpdir(), "perbo-manifest-compat-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  /** Exactly what a run wrote before `<out>/bin/` existed: v1, and no bundle fields. */
  const priorManifest = (): Record<string, unknown> => {
    const prior: Record<string, unknown> = { ...manifest(), schema_version: 1 };
    delete prior.executed_bundle_sha256;
    delete prior.executed_bundle_bytes;
    delete prior.review_timeout_ms;
    return prior;
  };

  it("still parse, and still score, with no bundle recorded and none on disk", () => {
    const parsed = CorpusRunManifestSchema.safeParse(priorManifest());
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    const prior = CorpusRunManifestSchema.parse(priorManifest());
    expect(manifestExecutedBundle(prior)).toBeNull();

    const archived = join(scratch, "prior-run");
    mkdirSync(archived, { recursive: true });
    expect(
      validateCorpusRunManifest({
        manifest: prior,
        runs,
        serialisedRuns,
        fixtures,
        bundleDir: archived,
      }),
    ).toEqual([]);
  });

  it("are refused if they claim the current version without naming what they executed", () => {
    expect(
      CorpusRunManifestSchema.safeParse({ ...priorManifest(), schema_version: 2 }).success,
    ).toBe(false);
    // …and the fields cannot be smuggled into a v1 manifest either.
    expect(
      CorpusRunManifestSchema.safeParse({
        ...priorManifest(),
        executed_bundle_sha256: "c".repeat(64),
        executed_bundle_bytes: 4096,
      }).success,
    ).toBe(false);
  });
});

/**
 * A run written after the bundle copy (v2, SCP-098) but before SCP-199, when
 * the harness spawned a review with no deadline at all. Recording one more
 * thing about a new run must not make that run's directory unreadable either.
 */
describe("run manifests written before the harness enforced a review deadline", () => {
  /** Exactly what a run wrote after the bundle but before SCP-199's deadline: v2. */
  const v2Manifest = (): Record<string, unknown> => {
    const prior: Record<string, unknown> = { ...manifest(), schema_version: 2 };
    delete prior.review_timeout_ms;
    return prior;
  };

  it("still parse and still score, with no deadline recorded", () => {
    const parsed = CorpusRunManifestSchema.safeParse(v2Manifest());
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    const prior = CorpusRunManifestSchema.parse(v2Manifest());
    expect(manifestReviewTimeoutMs(prior)).toBeNull();
    // A run this old still names what it executed — only the deadline is new.
    expect(manifestExecutedBundle(prior)).not.toBeNull();

    expect(
      validateCorpusRunManifest({
        manifest: prior,
        runs,
        serialisedRuns,
        fixtures,
      }),
    ).toEqual([]);
  });

  it("is refused if it claims the current version without naming its deadline", () => {
    expect(
      CorpusRunManifestSchema.safeParse({ ...v2Manifest(), schema_version: 3 }).success,
    ).toBe(false);
    // …and the field cannot be smuggled into a v2 manifest either.
    expect(
      CorpusRunManifestSchema.safeParse({ ...v2Manifest(), review_timeout_ms: 900_000 }).success,
    ).toBe(false);
  });
});

describe("a results directory whose reviewer copy is no longer beside it", () => {
  const scratch = mkdtempSync(join(tmpdir(), "perbo-manifest-bundle-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const withBundle = (dir: string, contents: string | null): string => {
    mkdirSync(join(dir, "bin"), { recursive: true });
    if (contents !== null) writeFileSync(join(dir, "bin", "perbo.mjs"), contents);
    return dir;
  };

  it("scores, because the digest in the manifest is the record and the file is the convenience", () => {
    const pruned = withBundle(join(scratch, "pruned"), null);
    expect(
      validateCorpusRunManifest({
        manifest: manifest(),
        runs,
        serialisedRuns,
        fixtures,
        bundleDir: pruned,
      }),
    ).toEqual([]);
  });

  it("does not score when a different reviewer is sitting where that one was", () => {
    const rebuilt = withBundle(join(scratch, "rebuilt"), "// somebody built into the results\n");
    const reasons = validateCorpusRunManifest({
      manifest: manifest(),
      runs,
      serialisedRuns,
      fixtures,
      bundleDir: rebuilt,
    });
    expect(reasons.join(" ")).toMatch(/reviewer bundle .* is not the one this run executed/);
  });

  it("scores when the copy is still there and is the one that ran", () => {
    const kept = join(scratch, "kept");
    const contents = "// the reviewer this run executed\n";
    withBundle(kept, contents);
    const executed = {
      ...result,
      bundle: {
        path: join(kept, "bin", "perbo.mjs"),
        sha256: createHash("sha256").update(contents).digest("hex"),
        bytes: Buffer.byteLength(contents),
        source: "apps/cli/dist/main.js",
      },
    };
    const built = CorpusRunManifestSchema.parse(
      buildCorpusRunManifest({
        result: executed,
        requestedRepeats: 2,
        serialisedRuns,
        source: {
          ...captureRunSource({ cliPath: "src/main.ts", cwd: process.cwd() }),
          source_commit: "a".repeat(40),
          source_tracked_dirty: false,
          provider_binary_sha256: "b".repeat(64),
        },
        reviewTimeoutMs: 900_000,
      }),
    );
    expect(
      validateCorpusRunManifest({
        manifest: built,
        runs,
        serialisedRuns,
        fixtures,
        bundleDir: kept,
      }),
    ).toEqual([]);
  });
});

/**
 * The state of the tree is read by the runner's git, not by whatever the shell
 * that started the corpus run happened to hold.
 *
 * A manifest is written before the first paid call and read long afterwards, so
 * the two fields it takes from git have to come back or come back as unknown —
 * never after a wait nobody bounded, on a prompt nobody is there to answer.
 */
describe("the git a run manifest's source snapshot starts", () => {
  const scratch = mkdtempSync(join(tmpdir(), "perbo-manifest-git-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it.skipIf(process.platform === "win32")(
    "runs in the runner's environment, with prompts off and no ambient secret",
    () => {
      const bin = join(scratch, "bin");
      const dump = join(scratch, "child-env.txt");
      const entry = join(scratch, "entry.mjs");
      const commit = "9".repeat(40);
      mkdirSync(bin, { recursive: true });
      writeFileSync(entry, "// the reviewer entry a manifest records the digest of\n");
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\nenv > ${JSON.stringify(dump)}\ncase "$*" in *rev-parse*) echo ${commit};; esac\n`,
      );
      chmodSync(join(bin, "git"), 0o755);

      const path = process.env.PATH;
      process.env.PATH = `${bin}:${path ?? ""}`;
      process.env.PERBO_SENTINEL_TOKEN = "a token the child must not see";
      let source: ReturnType<typeof captureRunSource>;
      try {
        source = captureRunSource({ cliPath: entry, cwd: scratch });
      } finally {
        process.env.PATH = path;
        delete process.env.PERBO_SENTINEL_TOKEN;
      }

      expect(source.source_commit).toBe(commit);
      const child = readFileSync(dump, "utf8").split("\n");
      expect(child).toContain("GIT_TERMINAL_PROMPT=0");
      expect(child.filter((line) => line.startsWith("PERBO_SENTINEL_TOKEN="))).toEqual([]);
    },
  );
});
