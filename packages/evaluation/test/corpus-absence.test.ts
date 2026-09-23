import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import {
  CORPUS_ABSENT_REASON,
  CORPUS_DIR_ENV,
  CORPUS_SUBJECT_SUITES,
} from "./corpus-present.js";

const runVitest = promisify(execFile);
const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const scratchDirectory = scratchDirectories("perbo-absence-");

/** Runs vitest over `suites` with `env` applied, and reads back its JSON report. */
async function runSuites(
  suites: readonly string[],
  env: Record<string, string>,
): Promise<{ report: Report }> {
  const outputFile = join(scratchDirectory(), "report.json");
  await runVitest(
    "pnpm",
    ["exec", "vitest", "run", ...suites, "--reporter=json", `--outputFile=${outputFile}`],
    {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, CI: "1", ...env },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return { report: JSON.parse(readFileSync(outputFile, "utf8")) as Report };
}

interface Report {
  numFailedTests: number;
  numPendingTests: number;
  testResults: Array<{
    name: string;
    assertionResults: Array<{ status: string; fullName: string }>;
  }>;
}

/**
 * Every named suite ran, failed nothing, and skipped at least one test whose
 * name says why. The reason travels in the test name so a reader of the report
 * — not only of the console — is told what is missing.
 */
function expectSkipped(report: Report, suites: readonly string[], reason: string): void {
  expect(report.numFailedTests, "nothing failed on absence").toBe(0);
  expect(report.numPendingTests).toBeGreaterThan(0);
  for (const suite of suites) {
    const file = report.testResults.find((entry) => entry.name.endsWith(suite));
    expect(file, `${suite} ran`).toBeDefined();
    expect(
      file!.assertionResults.some(
        (assertion) => assertion.status === "skipped" && assertion.fullName.includes(reason),
      ),
      `${suite} skipped at least one test, naming what is absent`,
    ).toBe(true);
  }
}

/**
 * A checkout without the fixture corpus still carries this harness, so every
 * suite whose subject *is* the corpus has to skip there rather than fail.
 * Absence is a fact about a tree, not a defect in it.
 *
 * The run is a real one: vitest, on the real suites, with the corpus directory
 * pointed somewhere that does not exist, and nothing deleted here. What it
 * asserts is the whole of the property: nothing failed, and every one of those
 * files contributed at least one skipped test, so a suite that quietly stopped
 * collecting tests would not pass for a skip.
 */
describe("the corpus suites skip, and do not fail, when the corpus is absent", () => {
  it("reports no failure and at least one skipped test per corpus suite", async () => {
    const { report } = await runSuites(CORPUS_SUBJECT_SUITES, {
      [CORPUS_DIR_ENV]: join(PACKAGE_ROOT, "corpus-that-is-not-here"),
    });
    expectSkipped(report, CORPUS_SUBJECT_SUITES, CORPUS_ABSENT_REASON);
  }, 300_000);
});
