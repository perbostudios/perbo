import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT_CODES } from "@perbo/contracts";
import { parseReviewArgs } from "./internal/args.js";
import { runReviewCommand } from "./index.js";
import { recordStreams } from "../../test-support/streams.js";
import {
  REFUSING_TRANSPORTS,
  refusingModel,
  removeRefusingTransports,
} from "../../test-support/refusing-transports.js";

/**
 * `perbo review` over each transport whose provider refuses the request
 * (`request_refused`), end to end: the transport reads the refusal from the
 * provider's structured error, the review records the kind, and the command
 * says the request was refused and that trying again will not help, exits 3
 * as every review that did not complete does, and saves no resume, because a
 * resume would send the same request.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-cli-refused-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  removeRefusingTransports();
});

const repo = join(scratch, "repo");
mkdirSync(join(repo, "src"), { recursive: true });
writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
writeFileSync(
  join(scratch, "contract.json"),
  JSON.stringify({
    plan_id: "plan_cli",
    version: 1,
    ticket_id: "ticket_cli",
    level: "P1",
    outcome: "a is two",
    acceptance_criteria: [
      { id: "ac_1", text: "a is two.", expected_verification: { kind: "test", assertion: "a equals 2" } },
    ],
    scope: {
      repository_id: "repo_cli",
      paths_allowed: ["src/**"],
      paths_prohibited: [],
      generated_paths: [],
      expansion_budget_files: 3,
    },
    base: {
      base_commit: "a1b2c3d",
      context_manifest_hash: `sha256:${"0".repeat(64)}`,
      captured_at: "2026-08-27T09:00:00Z",
    },
  }),
);
writeFileSync(
  join(scratch, "change.diff"),
  "diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-export const a = 1;\n+export const a = 2;\n",
);
writeFileSync(join(scratch, "checks.json"), "[]");

describe.each(REFUSING_TRANSPORTS)("a review whose provider refuses the request, over %s", (transport) => {
  it("records request_refused, says trying again will not help, and saves no resume", async () => {
    const state = mkdtempSync(join(scratch, "state-"));
    const streams = recordStreams({ isTTY: false });
    const code = await runReviewCommand({
      args: parseReviewArgs([
        "--contract", "contract.json", "--diff", "change.diff", "--checks", "checks.json", "--repo", "repo",
        "--state", state,
      ]),
      streams,
      cwd: scratch,
      now: new Date("2026-08-27T10:00:00Z"),
      makeModel: (submitSchema) => refusingModel(transport, submitSchema),
    });

    const artifact = streams.json<{ decision: string; error: { kind: string } }>();
    expect(artifact.decision).toBe("error");
    expect(artifact.error.kind).toBe("request_refused");
    expect(code).toBe(EXIT_CODES.did_not_complete);
    expect(streams.err()).toContain("was refused by the model provider");
    expect(streams.err()).toContain("trying again will not help");
    expect(streams.err()).not.toMatch(/re-run|unfinished review saved/);
    expect(existsSync(state) ? readdirSync(state) : []).toEqual([]);
  });
});
