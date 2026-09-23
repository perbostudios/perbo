import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "@perbo/workspace";
import { z } from "zod";
import { BUNDLE_DIRNAME, BUNDLE_FILENAME } from "./bundle.js";
import type { LoadedFixture } from "./corpus.js";
import type { HarnessResult, RunRecord } from "./harness.js";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** Everything a run manifest has carried since it existed, in every version. */
const RunManifestFieldsSchema = z.strictObject({
  run_id: z.string().regex(/^run_[0-9a-f]{16}$/),
  started_at: z.iso.datetime(),
  finished_at: z.iso.datetime(),
  source_commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  source_tracked_dirty: z.boolean().nullable(),
  cli_entry_sha256: Sha256Schema,
  provider_binary_sha256: Sha256Schema.nullable(),
  corpus_sha256: Sha256Schema,
  fixture_ids_sha256: Sha256Schema,
  fixture_ids: z.array(z.string().min(1)).min(1),
  requested_repeats: z.number().int().positive(),
  repeat_structure: z.array(
    z.strictObject({
      fixture_id: z.string().min(1),
      repeats: z.array(z.number().int().positive()).min(1),
    }),
  ),
  run_records: z.number().int().nonnegative(),
  artifact_records: z.number().int().nonnegative(),
  runs_sha256: Sha256Schema,
  providers: z.array(z.string().min(1)),
  model_ids: z.array(z.string().min(1)),
  prompt_versions: z.array(z.string().min(1)),
  routing_policies: z.array(z.string().min(1)),
});

/**
 * A manifest written before a run took its own copy of the reviewer.
 *
 * It is still a manifest. The runs it binds cost real money and an hour each,
 * their `runs.json` and `report.md` are quoted in result documents, and none of
 * that stops being true because a later run records one more thing about
 * itself. Reading is where old versions are accommodated; only writing moves
 * forward.
 */
const CorpusRunManifestV1Schema = RunManifestFieldsSchema.extend({
  schema_version: z.literal(1),
});

/**
 * A manifest written by a run that bundled the reviewer into `<out>/bin/`
 * before its first fixture and spawned only that copy.
 *
 * `executed_bundle_sha256` is recorded beside `cli_entry_sha256` — the entry
 * point it was built from — because only this one names a file that could not
 * change during the run. The version is bumped rather than the fields being
 * made optional, so "this run predates the bundle copy" and "this run recorded
 * nothing about what it executed" cannot be confused for one another.
 */
const CorpusRunManifestV2Schema = RunManifestFieldsSchema.extend({
  schema_version: z.literal(2),
  executed_bundle_sha256: Sha256Schema,
  executed_bundle_bytes: z.number().int().positive(),
});

/**
 * A manifest written by a run that enforced its own review deadline
 * (SCP-199), rather than trusting whatever called the harness to bound a
 * spawned reviewer that never exits.
 *
 * `review_timeout_ms` is added the same way `executed_bundle_*` was: a new
 * version rather than an optional field, so "this run predates the harness
 * enforcing a deadline" is never confused with "this run recorded a deadline
 * of nothing".
 */
const CorpusRunManifestV3Schema = RunManifestFieldsSchema.extend({
  schema_version: z.literal(3),
  executed_bundle_sha256: Sha256Schema,
  executed_bundle_bytes: z.number().int().positive(),
  review_timeout_ms: z.number().int().positive(),
});

export const CorpusRunManifestSchema = z.discriminatedUnion("schema_version", [
  CorpusRunManifestV1Schema,
  CorpusRunManifestV2Schema,
  CorpusRunManifestV3Schema,
]);
export type CorpusRunManifest = z.infer<typeof CorpusRunManifestSchema>;

/** The version a run written now carries. */
export const RUN_MANIFEST_SCHEMA_VERSION = 3;

/**
 * The reviewer bundle a manifest names, or null for a run made before the
 * harness took one. Callers that report it must be able to say "not recorded"
 * as distinct from "recorded as nothing".
 */
export function manifestExecutedBundle(
  manifest: CorpusRunManifest,
): { sha256: string; bytes: number } | null {
  return manifest.schema_version === 1
    ? null
    : { sha256: manifest.executed_bundle_sha256, bytes: manifest.executed_bundle_bytes };
}

/**
 * The review deadline a manifest recorded, in milliseconds — or null for a
 * run made before the harness enforced one (SCP-199) and so never recorded
 * it.
 */
export function manifestReviewTimeoutMs(manifest: CorpusRunManifest): number | null {
  return manifest.schema_version === 1 || manifest.schema_version === 2
    ? null
    : manifest.review_timeout_ms;
}

export const RunSourceSnapshotSchema = RunManifestFieldsSchema.pick({
  source_commit: true,
  source_tracked_dirty: true,
  cli_entry_sha256: true,
  provider_binary_sha256: true,
});
export type RunSourceSnapshot = z.infer<typeof RunSourceSnapshotSchema>;

export const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonical(child)]),
  );
};

const canonicalHash = (value: unknown): string => sha256(JSON.stringify(canonical(value)));

const unique = (values: Array<string | undefined>): string[] =>
  [...new Set(values.filter((value): value is string => typeof value === "string"))].sort();

export function corpusFingerprint(fixtures: readonly LoadedFixture[]): string {
  return canonicalHash(
    [...fixtures]
      .sort((a, b) => a.fixture.id.localeCompare(b.fixture.id))
      .map((entry) => ({
        fixture: entry.fixture,
        contract: entry.contract,
        checks: entry.checks,
        diff_sha256: sha256(entry.diff),
        pinned: entry.pinned,
        prepared: entry.prepared,
      })),
  );
}

export function repeatStructure(runs: readonly RunRecord[]): CorpusRunManifest["repeat_structure"] {
  const grouped = new Map<string, number[]>();
  for (const record of runs) {
    grouped.set(record.fixture_id, [...(grouped.get(record.fixture_id) ?? []), record.repeat]);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fixture_id, repeats]) => ({
      fixture_id,
      repeats: [...repeats].sort((a, b) => a - b),
    }));
}

/**
 * What the tree this run was made from was, as far as git will say.
 *
 * Through `@perbo/workspace`'s repository module, so it runs in the runner's
 * environment and under a bound: a manifest is written before the first paid
 * call, and a credential prompt here would hold the whole corpus run open on a
 * terminal nobody is watching. A directory git will not answer about is
 * recorded as unknown rather than guessed at — both fields or neither, because
 * "clean" about a commit nobody could name says nothing.
 */
const gitSnapshot = (cwd: string): { commit: string | null; trackedDirty: boolean | null } => {
  const unknown = { commit: null, trackedDirty: null };
  try {
    const commit = git.headSync(cwd);
    if (commit === null) return unknown;
    return {
      commit: /^[0-9a-f]{40}$/.test(commit) ? commit : null,
      trackedDirty: git.hasTrackedChangesSync(cwd),
    };
  } catch {
    return unknown;
  }
};

const executableHash = (pathOrCommand: string | undefined, cwd: string): string | null => {
  if (pathOrCommand === undefined) return null;
  let resolved = pathOrCommand;
  try {
    return sha256(readFileSync(resolved));
  } catch {
    try {
      resolved = execFileSync("which", [pathOrCommand], { cwd, encoding: "utf8" }).trim();
      return resolved.length > 0 ? sha256(readFileSync(resolved)) : null;
    } catch {
      return null;
    }
  }
};

/**
 * Capture the source and executables before the first paid model call. Building
 * these fields after a run would let an edit made during the run describe the
 * code at the end rather than the code that produced the first artifact.
 */
export function captureRunSource(args: {
  cliPath: string;
  providerBinaryPath?: string | undefined;
  cwd: string;
}): RunSourceSnapshot {
  const source = gitSnapshot(args.cwd);
  return RunSourceSnapshotSchema.parse({
    source_commit: source.commit,
    source_tracked_dirty: source.trackedDirty,
    cli_entry_sha256: sha256(readFileSync(args.cliPath)),
    provider_binary_sha256: executableHash(args.providerBinaryPath, args.cwd),
  });
}

export function buildCorpusRunManifest(args: {
  result: HarnessResult;
  requestedRepeats: number;
  serialisedRuns: string;
  source: RunSourceSnapshot;
  /** The review deadline this run enforced, in milliseconds (SCP-199). */
  reviewTimeoutMs: number;
}): CorpusRunManifest {
  const fixture_ids = args.result.fixtures.map((entry) => entry.fixture.id).sort();
  const fixture_ids_sha256 = sha256(fixture_ids.join("\n"));
  const runs_sha256 = sha256(args.serialisedRuns);
  const artifacts = args.result.runs.flatMap((record) =>
    record.artifact === null ? [] : [record.artifact],
  );
  const run_id = `run_${sha256(`${args.result.started_at}|${runs_sha256}`).slice(0, 16)}`;
  return CorpusRunManifestSchema.parse({
    schema_version: RUN_MANIFEST_SCHEMA_VERSION,
    run_id,
    started_at: args.result.started_at,
    finished_at: args.result.finished_at,
    ...args.source,
    // Taken from the run rather than from a caller: the manifest must name the
    // file the harness spawned, not one anything downstream believed it did.
    executed_bundle_sha256: args.result.bundle.sha256,
    executed_bundle_bytes: args.result.bundle.bytes,
    review_timeout_ms: args.reviewTimeoutMs,
    corpus_sha256: corpusFingerprint(args.result.fixtures),
    fixture_ids_sha256,
    fixture_ids,
    requested_repeats: args.requestedRepeats,
    repeat_structure: repeatStructure(args.result.runs),
    run_records: args.result.runs.length,
    artifact_records: artifacts.length,
    runs_sha256,
    providers: unique(artifacts.map((artifact) => artifact.model?.provider)),
    model_ids: unique(artifacts.map((artifact) => artifact.model?.model_id)),
    prompt_versions: unique(artifacts.map((artifact) => artifact.model?.prompt_version)),
    routing_policies: unique(artifacts.map((artifact) => artifact.routing_policy)),
  });
}

export function runManifestFingerprint(manifest: CorpusRunManifest): string {
  return canonicalHash(manifest);
}

export function validateCorpusRunManifest(args: {
  manifest: CorpusRunManifest;
  runs: readonly RunRecord[];
  serialisedRuns: string;
  fixtures: readonly LoadedFixture[];
  /**
   * The run's output directory, if the caller has it. Given one, a reviewer
   * bundle *still sitting* in `<dir>/bin/` is checked against the manifest, so
   * a results directory someone has since rebuilt into stops being a source
   * anything is scored from.
   *
   * Its absence is not a finding. The copy is tens of megabytes and a results
   * directory is routinely archived, published or copied without it; the
   * manifest's digest is the record of what ran, and the file is the
   * convenience of being able to run it again.
   */
  bundleDir?: string | undefined;
}): string[] {
  const reasons: string[] = [];
  const registeredIds = new Set(args.manifest.fixture_ids);
  const manifestFixtures = args.fixtures.filter((entry) => registeredIds.has(entry.fixture.id));
  const fixtureIds = manifestFixtures.map((entry) => entry.fixture.id).sort();
  const expectedRepeats = Array.from(
    { length: args.manifest.requested_repeats },
    (_, index) => index + 1,
  );
  const expectedStructure = repeatStructure(args.runs);
  const artifacts = args.runs.flatMap((record) =>
    record.artifact === null ? [] : [record.artifact],
  );
  const expectedRunId = `run_${sha256(`${args.manifest.started_at}|${sha256(args.serialisedRuns)}`).slice(0, 16)}`;

  if (args.manifest.runs_sha256 !== sha256(args.serialisedRuns)) {
    reasons.push("runs.json does not match the run manifest hash");
  }
  if (args.manifest.run_id !== expectedRunId) {
    reasons.push("run id does not match the start time and runs.json");
  }
  if (args.manifest.run_records !== args.runs.length) {
    reasons.push("run-record count does not match the run manifest");
  }
  if (
    args.manifest.artifact_records !==
    artifacts.length
  ) {
    reasons.push("artifact count does not match the run manifest");
  }
  if (args.manifest.corpus_sha256 !== corpusFingerprint(manifestFixtures)) {
    reasons.push("current corpus contents do not match the run manifest");
  }
  if (JSON.stringify(args.manifest.fixture_ids) !== JSON.stringify(fixtureIds)) {
    reasons.push("fixture ids do not match the run manifest");
  }
  if (args.manifest.fixture_ids_sha256 !== sha256(fixtureIds.join("\n"))) {
    reasons.push("fixture-id fingerprint does not match the run manifest");
  }
  if (JSON.stringify(args.manifest.repeat_structure) !== JSON.stringify(expectedStructure)) {
    reasons.push("repeat structure does not match runs.json");
  }
  if (
    args.manifest.repeat_structure.some(
      (entry) => JSON.stringify(entry.repeats) !== JSON.stringify(expectedRepeats),
    )
  ) {
    reasons.push("not every fixture has the exact requested repeat sequence");
  }
  if (args.manifest.source_commit === null || args.manifest.source_tracked_dirty !== false) {
    reasons.push("source commit is absent or tracked source files were dirty during the run");
  }
  const executed = manifestExecutedBundle(args.manifest);
  if (args.bundleDir !== undefined && executed !== null) {
    const bundlePath = join(args.bundleDir, BUNDLE_DIRNAME, BUNDLE_FILENAME);
    let bundle: Buffer | null;
    try {
      bundle = readFileSync(bundlePath);
    } catch {
      // Gone or never carried with the directory. That says nothing about the
      // run, so it says nothing here.
      bundle = null;
    }
    if (
      bundle !== null &&
      (sha256(bundle) !== executed.sha256 || bundle.byteLength !== executed.bytes)
    ) {
      reasons.push(
        `the reviewer bundle at ${bundlePath} is not the one this run executed`,
      );
    }
  }
  const metadataSets: Array<{
    label: string;
    actual: string[];
    expected: string[];
  }> = [
    {
      label: "providers",
      actual: args.manifest.providers,
      expected: unique(artifacts.map((artifact) => artifact.model?.provider)),
    },
    {
      label: "model ids",
      actual: args.manifest.model_ids,
      expected: unique(artifacts.map((artifact) => artifact.model?.model_id)),
    },
    {
      label: "prompt versions",
      actual: args.manifest.prompt_versions,
      expected: unique(artifacts.map((artifact) => artifact.model?.prompt_version)),
    },
    {
      label: "routing policies",
      actual: args.manifest.routing_policies,
      expected: unique(artifacts.map((artifact) => artifact.routing_policy)),
    },
  ];
  for (const entry of metadataSets) {
    if (JSON.stringify(entry.actual) !== JSON.stringify(entry.expected)) {
      reasons.push(`${entry.label} do not match runs.json artifacts`);
    }
  }
  if (
    args.manifest.providers.some((provider) => provider.endsWith("-cli")) &&
    args.manifest.provider_binary_sha256 === null
  ) {
    reasons.push("CLI provider binary hash is absent");
  }
  if (Date.parse(args.manifest.finished_at) < Date.parse(args.manifest.started_at)) {
    reasons.push("run finish time precedes its start time");
  }
  return reasons;
}
