import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { strictSchemaViolations, structuredTurnSchema } from "@perbo/model";
import {
  CONTRACT_DRAFT_JSON_SCHEMA,
  DECISION_OPTIONS_JSON_SCHEMA,
  DRIFT_REPORT_JSON_SCHEMA,
} from "@perbo/planning";
import { closureVerifySchema, verdictSchemas } from "@perbo/review";
import { PROBE_SUBMIT_SCHEMA } from "./commands/run/index.js";

/**
 * Every submit schema Perbo sends a provider keeps the one rule
 * (`strictSchemaViolations` in `@perbo/model`), sent as it is to the API's
 * strict tool and wrapped in the turn schema Claude Code and Codex receive.
 *
 * Here because this package is the one that imports every caller that sends
 * one. The review's two are built from the plan's ids, so each is built here
 * from a sample of them: the ids fill enums and never add a property.
 */
const verdict = verdictSchemas(["ac_1", "ac_2"], ["check_1", "check_scope", "check_agent_config"]).toolInputSchema;
const closure = closureVerifySchema(["a".repeat(64), "b".repeat(64)]);

/** Each source file that hands a transport a submit schema, and the schemas it hands. */
const SENT: Record<string, Record<string, Record<string, unknown>>> = {
  "apps/cli/src/commands/admit.ts": { CONTRACT_DRAFT_JSON_SCHEMA },
  "apps/cli/src/commands/drift.ts": { DRIFT_REPORT_JSON_SCHEMA },
  "apps/cli/src/commands/options.ts": { DECISION_OPTIONS_JSON_SCHEMA },
  "apps/cli/src/commands/review/index.ts": { verdict },
  "apps/cli/src/commands/run/internal/probe.ts": { PROBE_SUBMIT_SCHEMA },
  "packages/runner/src/loop/internal/review.ts": { verdict },
  "packages/runner/src/loop/internal/verify.ts": { closure },
};

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Every source file outside `@perbo/model` that names `submitSchema`: where a
 * schema is handed to a transport. Tests and their support are not senders.
 */
function senders(): string[] {
  const found: string[] = [];
  for (const top of ["apps", "packages"]) {
    for (const name of readdirSync(join(ROOT, top))) {
      if (top === "packages" && name === "model") continue;
      const src = join(ROOT, top, name, "src");
      if (!existsSync(src)) continue;
      for (const entry of readdirSync(src, { recursive: true, encoding: "utf8" })) {
        const path = `${top}/${name}/src/${entry.split("\\").join("/")}`;
        if (!/\.tsx?$/.test(path) || /test-support|\.test\.tsx?$/.test(path)) continue;
        if (readFileSync(join(ROOT, path), "utf8").includes("submitSchema")) found.push(path);
      }
    }
  }
  return found.sort();
}

describe("every submit schema Perbo sends a provider", () => {
  it("is listed here, so a new sender cannot go unchecked", () => {
    expect(senders()).toEqual(Object.keys(SENT).sort());
  });

  for (const [file, schemas] of Object.entries(SENT)) {
    for (const [name, schema] of Object.entries(schemas)) {
      it(`keeps the rule: ${name}, sent by ${file}`, () => {
        expect(strictSchemaViolations(schema)).toEqual([]);
        expect(strictSchemaViolations(structuredTurnSchema(schema))).toEqual([]);
      });
    }
  }
});
