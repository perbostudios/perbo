import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SecretIndex } from "@perbo/contracts";
import { BundleStore } from "@perbo/runner";
import { buildCli, removeStagedBundles, SPAWN_DEADLINE_MS } from "../../test-support/built-cli.js";
import { FINDING_KEY, makeAttempt, makeReview, makeTicket } from "../../test-support/records.js";
import { LocalVerdictsSchema } from "./record.js";

/**
 * Two `perbo verdict` processes started together against one store both land.
 *
 * The desktop records decisions on different tickets at the same time (D-049),
 * and each one reads `verdicts.json`, adds its row and writes the file back.
 * This starts two real processes of the compiled CLI in the same tick, each
 * deciding a finding on its own ticket, and asserts after every round that
 * both rows are on record. Many rounds, because a lost write is a race: one
 * round that happens not to overlap proves nothing.
 */

const ROUNDS = 25;

/** The compile once, then every round's two processes. */
const BUILD_AND_ROUNDS_TIMEOUT_MS = 200_000 + ROUNDS * SPAWN_DEADLINE_MS;

const scratch = mkdtempSync(join(tmpdir(), "perbo-verdict-concurrent-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterAll(removeStagedBundles);

const AUTHOR = "Lian Matsuo <lian@example.invalid>";

/** One ticket as the loop leaves it: the ticket, its attempt, and the bundles holding its review. */
function seedTicket(repo: string, store: string, key: string, ticket_id: string, suffix: string): void {
  const attempt = makeAttempt({
    attempt_id: `att_concurrent${suffix}`,
    ticket_id,
    created_at: "2026-09-03T11:47:38.000Z",
    termination: { reason: "completed", detail: "" },
    usage: { iterations: 1, commands: 1, wall_clock_ms: 1, cost_basis: "unavailable" },
    changeset_id: `cs_concurrent${suffix}`,
    head_commit: "b2c3d4e",
  });
  writeFileSync(
    join(store, "tickets", `${key}.json`),
    JSON.stringify(makeTicket({ key, ticket_id, repository_root: repo })),
  );
  writeFileSync(
    join(store, "state", `${ticket_id}.attempts.json`),
    `${JSON.stringify({ ticket_id, attempts: [attempt] }, null, 2)}\n`,
  );
  const bundles = new BundleStore({ root: join(store, "bundles"), retainContext: true });
  const write = (
    kind: "execution" | "review",
    subject_id: string,
    inputs: Record<string, unknown>,
    artifacts: Array<{ name: string; media_type: string; body: string }>,
  ) =>
    bundles.write({
      kind,
      subject_id,
      ticket_id,
      inputs: inputs as never,
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
      now: new Date("2026-09-03T11:52:00.000Z"),
    });
  const review = makeReview({
    review_id: `rev_concurrent${suffix}`,
    changeset_id: `cs_concurrent${suffix}`,
    decision: "changes_requested",
    cost_basis: "unavailable",
  });
  write("execution", attempt.attempt_id, { termination: "completed" }, [
    { name: "attempt.json", media_type: "application/json", body: JSON.stringify(attempt) },
    { name: "transcript.jsonl", media_type: "application/x-ndjson", body: "" },
  ]);
  write(
    "review",
    review.review_id,
    { attempt_id: attempt.attempt_id, changeset_id: review.target.id, decision: "changes_requested", remediation_round: 0 },
    [{ name: "review.json", media_type: "application/json", body: JSON.stringify(review) }],
  );
}

/** One process of the compiled CLI, resolved with its exit status and what it wrote. */
function start(main: string, repo: string, key: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [main, "verdict", key, "--accept", FINDING_KEY.slice(0, 12), "--author", AUTHOR, "--repo", repo, "--json"],
      { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const deadline = setTimeout(() => child.kill("SIGKILL"), SPAWN_DEADLINE_MS);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(deadline);
      resolve({ status, stdout, stderr });
    });
  });
}

describe("perbo verdict under concurrent writers", () => {
  it(
    "keeps both decisions when two processes record at once, every round",
    async () => {
      const main = join(buildCli(), "main.js");
      const repo = join(scratch, "repo");
      const store = join(repo, ".perbo");
      mkdirSync(join(store, "tickets"), { recursive: true });
      mkdirSync(join(store, "state"), { recursive: true });
      seedTicket(repo, store, "AYO-7", "ticket_concurrent0007", "0007");
      seedTicket(repo, store, "AYO-8", "ticket_concurrent0008", "0008");
      const record = join(store, "verdicts.json");

      const lost: number[] = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        rmSync(record, { force: true });
        const [one, two] = await Promise.all([start(main, repo, "AYO-7"), start(main, repo, "AYO-8")]);
        expect(one.stderr).toBe("");
        expect(two.stderr).toBe("");
        expect([one.status, two.status]).toEqual([0, 0]);
        const rows = LocalVerdictsSchema.parse(JSON.parse(readFileSync(record, "utf8"))).verdicts;
        const tickets = rows.map((row) => row.review.ticket_key).sort();
        if (tickets.join(",") !== "AYO-7,AYO-8") lost.push(round);
      }

      expect(lost).toEqual([]);
      // Nothing the lock used is left beside the record.
      expect(existsSync(`${record}.lock`)).toBe(false);
      expect(readdirSync(store).filter((name) => name.startsWith("verdicts.json."))).toEqual([]);
    },
    BUILD_AND_ROUNDS_TIMEOUT_MS,
  );
});
