import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SecretIndex, type RunBundle, type RunBundleKind } from "@perbo/contracts";
import { BundleStore } from "@perbo/runner";
import { runInspectCommand } from "./inspect.js";
import { makeAttempt, makeReview, makeTicket } from "../test-support/attempt-fixture.js";

/**
 * `perbo inspect <ticket> --verify <attempt>` (AYO-69).
 *
 * A run bundle is content-addressed and nothing ever recomputed one of its
 * hashes, so the record was trusted exactly as far as the file system was.
 * These drive the check over a store built the way the loop builds one, in the
 * three states a store can be in — intact, one object's bytes rewritten, one
 * object gone — and hold the property that makes a check on a record usable at
 * all: that running it leaves the record exactly as it found it.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-verify-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const TICKET_ID = "ticket_verify00001";
const ATTEMPT = "att_verify00000001";

function capture(isTTY = true) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    streams: {
      stdout: (chunk: string) => out.push(chunk),
      stderr: (chunk: string) => err.push(chunk),
      isTTY,
    },
  };
}

const DIFF = `diff --git a/packages/search/src/query.ts b/packages/search/src/query.ts
index 1111111..2222222 100644
--- a/packages/search/src/query.ts
+++ b/packages/search/src/query.ts
@@ -1,1 +1,2 @@
-export const PAGE = 0;
+export const PAGE = 25;
`;

interface Fixture {
  repo: string;
  store: string;
  /** The bundles the attempt wrote, as the store holds them. */
  execution: RunBundle;
  review: RunBundle;
  /** Every object the two manifests name, counted the way a reader would. */
  objects: number;
}

/**
 * One completed, reviewed attempt whose bundles retain their bytes: an
 * execution bundle of four artifacts and the review of the change set it
 * sealed. Every body is distinct, so no two artifacts share one object file and
 * a fault planted in one object is a fault in exactly one artifact.
 */
function storeWithBundle(name: string): Fixture {
  const repo = join(scratch, name);
  const store = join(repo, ".perbo");
  mkdirSync(join(store, "tickets"), { recursive: true });
  mkdirSync(join(store, "state"), { recursive: true });
  writeFileSync(
    join(store, "tickets", "AYO-8.json"),
    JSON.stringify(makeTicket({ key: "AYO-8", ticket_id: TICKET_ID, repository_root: repo })),
  );
  const attempt = makeAttempt({
    attempt_id: ATTEMPT,
    ticket_id: TICKET_ID,
    created_at: "2026-09-03T09:00:00.000Z",
    termination: { reason: "completed", detail: "" },
    usage: { iterations: 9, commands: 4, wall_clock_ms: 30_000 },
    changeset_id: "cs_verify00000001",
    head_commit: "b2c3d4e",
  });
  writeFileSync(
    join(store, "state", `${TICKET_ID}.attempts.json`),
    `${JSON.stringify({ ticket_id: TICKET_ID, attempts: [attempt] }, null, 2)}\n`,
  );

  const bundles = new BundleStore({ root: join(store, "bundles"), retainContext: true });
  const write = (
    kind: RunBundleKind,
    subject_id: string,
    inputs: RunBundle["inputs"],
    artifacts: Array<{ name: string; media_type: string; body: string }>,
    at: string,
  ): RunBundle =>
    bundles.write({
      kind,
      subject_id,
      ticket_id: TICKET_ID,
      inputs,
      context_manifest: [],
      versions: { code: "stage-3", prompt: "executor_v4", policy: "A2b", model: "claude-opus-5", tool: "1.0.98" },
      usage: { input_tokens: 1, output_tokens: 1, cost_micros: 0, cost_basis: "unavailable", wall_clock_ms: 1 },
      artifacts,
      errors: [],
      transitions: [],
      retention: { class: "raw_transcript", expires_at: null },
      secrets: new SecretIndex(),
      excluded_paths: [],
      deterministic: false,
      model_version_pinned: true,
      now: new Date(at),
    }).bundle;

  const execution = write(
    "execution",
    ATTEMPT,
    { termination: "completed" },
    [
      { name: "attempt.json", media_type: "application/json", body: JSON.stringify(attempt) },
      { name: "transcript.jsonl", media_type: "application/x-ndjson", body: '{"type":"assistant"}\n' },
      { name: "prompt.txt", media_type: "text/plain", body: "paginate the search results" },
      { name: "change.diff", media_type: "text/x-diff", body: DIFF },
    ],
    "2026-09-03T09:05:00.000Z",
  );
  const artifact = makeReview({
    review_id: "rev_verify0000001",
    changeset_id: "cs_verify00000001",
    decision: "approve",
    cost_basis: "transport_reported",
  });
  const review = write(
    "review",
    artifact.review_id,
    { changeset_id: "cs_verify00000001", decision: "approve", remediation_round: 0 },
    [{ name: "review.json", media_type: "application/json", body: JSON.stringify(artifact) }],
    "2026-09-03T09:06:00.000Z",
  );
  return {
    repo,
    store,
    execution,
    review,
    objects: execution.artifacts.length + review.artifacts.length,
  };
}

/** The hash a bundle files one of its artifacts under. */
function shaOf(bundle: RunBundle, name: string): string {
  const artifact = bundle.artifacts.find((one) => one.name === name);
  expect(artifact, `${bundle.bundle_id} names no ${name}`).toBeDefined();
  return artifact!.sha256;
}

const objectPath = (store: string, sha256: string): string =>
  join(store, "bundles", "objects", sha256);

/**
 * Every file under a directory, by path, as the bytes themselves — not a
 * summary of them — and every directory by name. What the check must not
 * change, including by leaving an empty directory behind.
 */
function snapshot(directory: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        files.set(`${relative(directory, path)}/`, "(directory)");
        walk(path);
      } else {
        files.set(relative(directory, path), readFileSync(path).toString("hex"));
      }
    }
  };
  walk(directory);
  return files;
}

/** `perbo inspect <key> --verify <attempt>`, as the entry point runs it. */
async function verify(
  fixture: Fixture,
  argv: string[] = [],
): Promise<{ code: number; out: string; err: string }> {
  const { out, err, streams } = capture();
  const code = await runInspectCommand({
    argv: ["AYO-8", "--verify", ATTEMPT, "--repo", fixture.repo, ...argv],
    streams,
    cwd: fixture.repo,
  });
  return { code, out: out.join(""), err: err.join("") };
}

describe("perbo inspect --verify", () => {
  it("recomputes every object an intact bundle names, and says how many", async () => {
    const fixture = storeWithBundle("verify-intact");
    const { code, out } = await verify(fixture);

    // Five: the execution bundle's four artifacts and the review's one.
    expect(fixture.objects).toBe(5);
    expect(out).toContain(`verified: ${fixture.objects} objects`);
    expect(code).toBe(0);
    // Nothing about an intact store reads as either fault.
    expect(out).not.toContain("mismatch");
    expect(out).not.toContain("missing");
    // The bundles it read are named, so the count can be checked against them.
    expect(out).toContain(fixture.execution.bundle_id);
    expect(out).toContain(fixture.review.bundle_id);
    for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("names the object, the hash expected and the hash found when bytes were rewritten", async () => {
    const fixture = storeWithBundle("verify-mismatch");
    const expected = shaOf(fixture.execution, "change.diff");
    const tampered = `${DIFF}+export const total = 140;\n`;
    writeFileSync(objectPath(fixture.store, expected), tampered);
    const found = createHash("sha256").update(Buffer.from(tampered, "utf8")).digest("hex");

    const { code, out } = await verify(fixture);

    expect(code).not.toBe(0);
    expect(out).toContain("change.diff");
    expect(out).toContain(expected);
    expect(out).toContain(found);
    expect(out).toContain("mismatch");
    // The other three objects of that bundle, and the review's, still verify.
    expect(out).toContain(`verified: ${fixture.objects - 1} of ${fixture.objects} objects`);
  });

  it("reports an object the manifest names and the store does not hold as missing", async () => {
    const fixture = storeWithBundle("verify-missing");
    const expected = shaOf(fixture.execution, "transcript.jsonl");
    unlinkSync(objectPath(fixture.store, expected));

    const { code, out } = await verify(fixture);

    expect(code).not.toBe(0);
    expect(out).toContain("transcript.jsonl");
    expect(out).toContain(expected);
    expect(out).toContain("missing");
    // Absence is not corruption, and the report does not use the word for one
    // fault when it found the other: a person acts differently on each.
    expect(out).not.toContain("mismatch");
    expect(out).toContain(`verified: ${fixture.objects - 1} of ${fixture.objects} objects`);
  });

  it("says the same about a mismatch and a missing object in different words", async () => {
    const bad = storeWithBundle("verify-words-mismatch");
    writeFileSync(objectPath(bad.store, shaOf(bad.execution, "change.diff")), "rewritten");
    const gone = storeWithBundle("verify-words-missing");
    unlinkSync(objectPath(gone.store, shaOf(gone.execution, "change.diff")));

    const mismatched = await verify(bad);
    const absent = await verify(gone);

    expect(mismatched.out).not.toBe(absent.out);
    expect(mismatched.out).not.toContain("missing");
    expect(absent.out).not.toContain("mismatch");
    expect(mismatched.code).not.toBe(0);
    expect(absent.code).not.toBe(0);
  });

  it("writes nothing: the store is byte-identical after the check, intact or not", async () => {
    for (const [name, damage] of [
      ["verify-readonly-intact", () => undefined],
      [
        "verify-readonly-mismatch",
        (fixture: Fixture) =>
          writeFileSync(objectPath(fixture.store, shaOf(fixture.execution, "change.diff")), "rewritten"),
      ],
      [
        "verify-readonly-missing",
        (fixture: Fixture) => unlinkSync(objectPath(fixture.store, shaOf(fixture.execution, "prompt.txt"))),
      ],
    ] as const) {
      const fixture = storeWithBundle(name);
      damage(fixture);
      const bundleDirectory = join(fixture.store, "bundles");
      const before = snapshot(bundleDirectory);
      const wholeStoreBefore = snapshot(fixture.store);

      await verify(fixture);

      // Every file the bundle directory holds, still the same bytes under the
      // same name — and nothing added to it, which an equal set of keys says.
      expect(snapshot(bundleDirectory)).toEqual(before);
      expect(snapshot(fixture.store)).toEqual(wholeStoreBefore);
    }
  });

  it("verifies a store the loop wrote without retaining the bytes, and fails nothing", async () => {
    // A `forensic` bundle names its artifacts and records that it does not hold
    // them. That is the bundle being honest, not the store being wrong.
    const repo = join(scratch, "verify-not-retained");
    const store = join(repo, ".perbo");
    mkdirSync(join(store, "tickets"), { recursive: true });
    mkdirSync(join(store, "state"), { recursive: true });
    writeFileSync(
      join(store, "tickets", "AYO-8.json"),
      JSON.stringify(makeTicket({ key: "AYO-8", ticket_id: TICKET_ID, repository_root: repo })),
    );
    const attempt = makeAttempt({
      attempt_id: ATTEMPT,
      ticket_id: TICKET_ID,
      created_at: "2026-09-03T09:00:00.000Z",
      termination: { reason: "completed", detail: "" },
      usage: { iterations: 9, commands: 4, wall_clock_ms: 30_000 },
      changeset_id: null,
      head_commit: null,
    });
    writeFileSync(
      join(store, "state", `${TICKET_ID}.attempts.json`),
      `${JSON.stringify({ ticket_id: TICKET_ID, attempts: [attempt] }, null, 2)}\n`,
    );
    new BundleStore({ root: join(store, "bundles"), retainContext: false }).write({
      kind: "execution",
      subject_id: ATTEMPT,
      ticket_id: TICKET_ID,
      inputs: { termination: "completed" },
      context_manifest: [],
      versions: { code: "stage-3", prompt: "executor_v4", policy: "A2b", model: "claude-opus-5", tool: "1.0.98" },
      usage: { input_tokens: 1, output_tokens: 1, cost_micros: 0, cost_basis: "unavailable", wall_clock_ms: 1 },
      artifacts: [{ name: "change.diff", media_type: "text/x-diff", body: DIFF }],
      errors: [],
      transitions: [],
      retention: { class: "artifact", expires_at: null },
      secrets: new SecretIndex(),
      excluded_paths: [],
      deterministic: false,
      model_version_pinned: true,
      now: new Date("2026-09-03T09:05:00.000Z"),
    });

    const { out, streams } = capture();
    const code = await runInspectCommand({
      argv: ["AYO-8", "--verify", ATTEMPT, "--repo", repo],
      streams,
      cwd: repo,
    });

    expect(code).toBe(0);
    expect(out.join("")).toContain("not retained");
    expect(out.join("")).toContain("verified: 0 objects");
    expect(out.join("")).not.toContain("missing");
  });

  it("hands the same verdict to a script under --json", async () => {
    const fixture = storeWithBundle("verify-json");
    writeFileSync(objectPath(fixture.store, shaOf(fixture.execution, "change.diff")), "rewritten");
    const { code, out } = await verify(fixture, ["--json"]);

    const report = JSON.parse(out) as {
      ticket: string;
      attempt_id: string;
      ok: boolean;
      verified: number;
      mismatched: number;
      missing: number;
      objects: Array<{ name: string; status: string; expected: string; found: string | null }>;
    };
    expect(code).not.toBe(0);
    expect(report.ticket).toBe("AYO-8");
    expect(report.attempt_id).toBe(ATTEMPT);
    expect(report.ok).toBe(false);
    expect(report.verified).toBe(fixture.objects - 1);
    expect(report.mismatched).toBe(1);
    expect(report.missing).toBe(0);
    expect(report.objects).toHaveLength(fixture.objects);
    const diff = report.objects.find((object) => object.name === "change.diff");
    expect(diff?.status).toBe("mismatch");
    expect(diff?.expected).toBe(shaOf(fixture.execution, "change.diff"));
    expect(diff?.found).not.toBe(diff?.expected);
  });

  it("does not pass an attempt whose bundles this store does not hold, or make one", async () => {
    // The record was written here and the bundles were not — a store copied
    // without its objects, or a run whose bundles went elsewhere. There is
    // nothing to stand behind, so it is not a pass; and asking must not create
    // the bundle store it was asked about.
    const repo = join(scratch, "verify-no-bundles");
    const store = join(repo, ".perbo");
    mkdirSync(join(store, "tickets"), { recursive: true });
    mkdirSync(join(store, "state"), { recursive: true });
    writeFileSync(
      join(store, "tickets", "AYO-8.json"),
      JSON.stringify(makeTicket({ key: "AYO-8", ticket_id: TICKET_ID, repository_root: repo })),
    );
    writeFileSync(
      join(store, "state", `${TICKET_ID}.attempts.json`),
      `${JSON.stringify({
        ticket_id: TICKET_ID,
        attempts: [
          makeAttempt({
            attempt_id: ATTEMPT,
            ticket_id: TICKET_ID,
            created_at: "2026-09-03T09:00:00.000Z",
            termination: { reason: "completed", detail: "" },
            usage: { iterations: 9, commands: 4, wall_clock_ms: 30_000 },
            changeset_id: null,
            head_commit: null,
          }),
        ],
      })}\n`,
    );
    const before = snapshot(store);

    const { out, streams } = capture();
    const code = await runInspectCommand({
      argv: ["AYO-8", "--verify", ATTEMPT, "--repo", repo],
      streams,
      cwd: repo,
    });

    expect(code).not.toBe(0);
    expect(out.join("")).toContain("holds no bundle for this attempt");
    expect(out.join("")).not.toContain("verified:");
    expect(existsSync(join(store, "bundles"))).toBe(false);
    expect(snapshot(store)).toEqual(before);
  });

  it("refuses an attempt the record does not hold rather than verifying nothing", async () => {
    const fixture = storeWithBundle("verify-unknown-attempt");
    const { streams } = capture();
    await expect(
      runInspectCommand({
        argv: ["AYO-8", "--verify", "att_nope", "--repo", fixture.repo],
        streams,
        cwd: fixture.repo,
      }),
    ).rejects.toThrow(/has no attempt att_nope/);
  });
});
