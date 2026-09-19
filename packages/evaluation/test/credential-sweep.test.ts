import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { findCredentials } from "@perbo/review";
import { corpus, describeCorpus } from "./corpus-present.js";

/**
 * The credential detector's false-positive behaviour, re-measured on every
 * build instead of stated once in a document.
 *
 * Zero false positives over the corpus trees was once a claim produced by a
 * script in a gitignored directory, which means it could not be checked again
 * after a rule changed — so it is a test now. A rule that starts firing on
 * ordinary fixture code fails here rather than being discovered when it
 * mangles a finding.
 */

const walk = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        return statSync(path).isDirectory() ? walk(path) : [path];
      })
    : [];

describeCorpus("the credential detector on ordinary fixture code (SCP-109)", () => {
  const declared = new Set(corpus.flatMap((entry) => entry.fixture.forbidden_strings));

  const matches = corpus.flatMap((entry) =>
    [...walk(join(entry.dir, "before")), ...walk(join(entry.dir, "after"))].flatMap((file) => {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        return [];
      }
      return findCredentials(text).map((m) => ({ fixture: entry.fixture.id, file, ...m }));
    }),
  );

  it("swept a corpus worth measuring against", () => {
    expect(corpus.length).toBeGreaterThan(80);
    expect(declared.size).toBeGreaterThan(0);
  });

  it("fires only on strings the corpus declares to be secrets", () => {
    const unexpected = matches.filter(
      (m) => ![...declared].some((d) => d.includes(m.value) || m.value.includes(d)),
    );
    expect(
      unexpected.map((m) => `${m.fixture}: ${m.rule} matched ${JSON.stringify(m.value)} in ${m.file}`),
      "the detector fired on fixture code that is not a declared secret — a false positive here " +
        "becomes a mangled finding once redaction is wired in",
    ).toEqual([]);
  });

  it("finds every secret the corpus declares", () => {
    const found = new Set(matches.map((m) => m.value));
    const missed = [...declared].filter((d) => ![...found].some((f) => f.includes(d) || d.includes(f)));
    expect(
      missed,
      "a declared secret the detector cannot see is a false negative, which is the half that " +
        "silently missed hunter2-pricing-secret in the first version",
    ).toEqual([]);
  });
});
