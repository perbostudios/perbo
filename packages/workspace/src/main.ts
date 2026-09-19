#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ExperimentConfigSchema, renderExperiment, runExperiment } from "./experiment.js";

/**
 * `perbo-materialisation <config.json> [--out result.json]`
 *
 * The harness behind [ADR-0025](../../../docs/adr/0025-worktree-environment-contract.md)'s
 * validation trigger. It prints a table on stdout and writes the full record,
 * including every phase timing, beside it.
 */
async function main(argv: string[]): Promise<number> {
  const [configPath, ...rest] = argv;
  if (!configPath || configPath === "--help") {
    process.stderr.write(
      "usage: perbo-materialisation <config.json> [--out <result.json>]\n" +
        "\n" +
        "Measures clean clone -> provision -> materialize -> install -> green tests\n" +
        "for each repository in the config, cold and warm (ADR-0025, SCP-079).\n",
    );
    return configPath ? 0 : 1;
  }
  let out: string | null = null;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--out") out = rest[++i] ?? null;
  }

  const config = ExperimentConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
  const results = await runExperiment(config, (message) => process.stderr.write(`  ${message}\n`));
  process.stdout.write(`${renderExperiment(results)}\n`);
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), `${JSON.stringify({ results }, null, 2)}\n`);
    process.stderr.write(`  wrote ${resolve(out)}\n`);
  }
  return results.every((result) => result.cold?.verified && result.warm?.verified) ? 0 : 2;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
