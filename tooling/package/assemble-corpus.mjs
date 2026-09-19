#!/usr/bin/env node
// Builds the tree the public corpus repository will hold — exactly what
// ADR-0032 names (docs/adr/0032-open-source-the-local-cli-and-the-reviewer.md)
// and nothing else — into a target directory given on the command line.
//
// Usage:
//   node tooling/package/assemble-corpus.mjs <target-dir> [--dry-run]
//   node tooling/package/assemble-corpus.mjs --self-test
//
// Every fixture directory's entries are checked against an explicit allow
// list rather than copied wholesale, so a file added to a fixture in the
// future that ADR-0032 does not name fails the assembly instead of silently
// reaching the public repository. The target must not already exist as a
// non-empty directory. `--dry-run` computes and prints the manifest without
// writing anything — this package has no test harness, so this and
// `--self-test` are the substitute for one.
//
// Every fixture directory under packages/evaluation/corpus/fixtures travels —
// 108 today. The corpus is published whole and re-published whole, so a fixture
// written after the first publication is carried by the same rule as the ones
// that were there for it.
//
// Before writing (or, on a dry run, before printing the manifest), every
// resolved file's content is scanned against INTERNAL_REFERENCE_PATTERNS
// below — the product name, package scopes, ADR/decision/ticket ids, prompt
// versions, evidence-archive names. A hit refuses the assembly unless the
// (published path, pattern) pair is on ALLOWLIST, with a reason. The corpus
// tree is data about fictional products; this is what keeps a future fixture
// edit from putting this repository's own identifiers into it.
// `--self-test` proves the guard fires: it builds a throwaway corpus under a
// temp directory, plants one instance of every pattern in an unlisted
// fixture, and asserts assembly is refused with all of them reported.

import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) {
  console.error(`assemble-corpus.mjs needs Node 22 or later; this is ${process.version}`);
  process.exit(1);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORPUS = join(ROOT, "packages", "evaluation", "corpus");
const LICENSES = join(ROOT, "tooling", "package", "licenses");

// Every entry a fixture directory is allowed to carry. Enumerated in
// packages/evaluation/corpus/README.md's fixture table and named by ADR-0032;
// `before/` and `after/` are absent on a pinned-repository fixture, and every
// other name here is optional except fixture.json.
const FIXTURE_ENTRIES = new Set(["fixture.json", "contract.json", "checks.json", "before", "after", "change.diff"]);

// Everything a published file must not carry, as (id, label, pattern)
// triples. `id` keys ALLOWLIST entries; `label` is what a refusal names.
// SCP-nnn and D-0nn are case-sensitive on purpose: a fixture's own id
// (`scp-001-…`, lowercase, this corpus's scope-escape class) and cross-
// references to it (`scp-004 is this fixture with five such files…`) are
// legitimate fixture content and must not trip the guard meant for this
// repository's uppercase SCP-nnn ticket ids.
const INTERNAL_REFERENCE_PATTERNS = [
  { id: "product-name", label: "the product name", pattern: /perbo/i },
  { id: "package-scope", label: "an @perbo/ package reference", pattern: /@perbo\// },
  { id: "adr", label: "an ADR-nnnn reference", pattern: /\bADR-\d{4}\b/ },
  { id: "docs-nn", label: "a docs/NN reference", pattern: /\bdocs\/\d{2}\b/ },
  { id: "decision", label: "a D-0nn decision reference", pattern: /\bD-0\d{2}\b/ },
  { id: "ticket-scp", label: "an SCP-nnn ticket reference", pattern: /\bSCP-\d{3}\b/ },
  { id: "ticket-key", label: "a PRB-n or AYO-n ticket reference", pattern: /\b(?:PRB|AYO)-\d+\b/ },
  {
    id: "prompt-version",
    label: "a reviewer_v/executor_v prompt version",
    pattern: /\b(?:reviewer|executor)_v\d/i,
  },
  { id: "evidence-archive", label: "an evidence-archive name", pattern: /\.local\/|SHA256SUMS|evidence-archive/i },
];

// (Published path, pattern id) pairs allowed to carry that reference, each
// with the reason. Every occurrence the publication sweep found in a fixture
// tree was fixed at the source (reworded in a fixture's prose, or the one tree
// file changed and its change.diff regenerated) rather than listed here; the
// one entry below is not a fixture-tree leak but the root README naming the
// product on purpose, to point a reader at the open reviewer and harness these
// fixtures grade. An entry documents a deliberate, reviewed exception; it is
// not a way to silence the guard by surprise.
const ALLOWLIST = [
  // { path: "fixtures/<id>/<published-relative-path>", patternId: "...", reason: "..." },
  {
    path: "README.md",
    patternId: "product-name",
    reason:
      "PUBLIC-README.md names the product by design, to point a reader at the open reviewer and " +
      "harness that read this corpus — not a leak from a fixture tree.",
  },
];

function parseArgs(argv) {
  let target;
  let dryRun = false;
  let selfTest = false;
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--self-test") {
      selfTest = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else if (target === undefined) {
      target = arg;
    } else {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
  }
  if (selfTest) {
    if (target || dryRun) {
      throw new Error("--self-test takes no target and no --dry-run");
    }
    return { selfTest: true };
  }
  if (!target) {
    throw new Error(
      "Usage: node tooling/package/assemble-corpus.mjs <target-dir> [--dry-run]\n" +
        "   or: node tooling/package/assemble-corpus.mjs --self-test",
    );
  }
  return { target: resolve(target), dryRun, selfTest: false };
}

/**
 * A plan entry: where a file or directory comes from and where it lands.
 * `corpusDir`/`licensesDir` default to this repository's real corpus and
 * licence texts; `--self-test` passes a throwaway temp directory instead, so
 * the guard can be proven without touching real fixtures.
 */
function plan({ corpusDir = CORPUS, licensesDir = LICENSES } = {}) {
  const entries = [];
  const fixturesDir = join(corpusDir, "fixtures");

  entries.push({ from: join(corpusDir, "PUBLIC-README.md"), to: "README.md", kind: "file" });
  entries.push({ from: join(corpusDir, "regression-suite.json"), to: "regression-suite.json", kind: "file" });
  entries.push({ from: join(licensesDir, "LICENSE-FORMAT.txt"), to: "LICENSE-FORMAT.txt", kind: "file" });
  entries.push({ from: join(licensesDir, "LICENSE-FIXTURES.txt"), to: "LICENSE-FIXTURES.txt", kind: "file" });
  entries.push({ from: join(licensesDir, "NOTICE"), to: "NOTICE", kind: "file" });

  const fixtureIds = readdirSync(fixturesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const id of fixtureIds) {
    const dir = join(fixturesDir, id);
    const found = readdirSync(dir);
    for (const name of found) {
      if (!FIXTURE_ENTRIES.has(name)) {
        throw new Error(
          `${id} carries ${JSON.stringify(name)}, which is not one of the entries ADR-0032 ` +
            `names (${[...FIXTURE_ENTRIES].join(", ")}). Refusing to guess whether it belongs ` +
            `in the public repository.`,
        );
      }
    }
    if (!found.includes("fixture.json")) {
      throw new Error(`${id} has no fixture.json`);
    }
    for (const name of found) {
      const from = join(dir, name);
      const kind = statSync(from).isDirectory() ? "dir" : "file";
      entries.push({ from, to: join("fixtures", id, name), kind });
    }
  }

  return entries;
}

/** Every regular file the plan would place, resolved to source bytes — used for both the copy and the manifest, so a dry run reports exactly what a real run would write. */
function resolveFiles(planEntries) {
  const files = [];
  for (const entry of planEntries) {
    if (entry.kind === "file") {
      files.push({ from: entry.from, to: entry.to });
      continue;
    }
    // kind === "dir": walk it and place every regular file underneath.
    const stack = [entry.from];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const name of readdirSync(current)) {
        const from = join(current, name);
        const to = join(entry.to, relative(entry.from, from));
        if (statSync(from).isDirectory()) {
          stack.push(from);
        } else {
          files.push({ from, to });
        }
      }
    }
  }
  files.sort((a, b) => a.to.localeCompare(b.to));
  return files;
}

/** Refuses if any resolved file's content matches an INTERNAL_REFERENCE_PATTERNS entry, unless that (path, pattern) pair is on `allowlist`. */
function guardAgainstInternalReferences(files, allowlist = ALLOWLIST) {
  const allowed = new Set(allowlist.map((entry) => `${entry.path} ${entry.patternId}`));
  const hits = [];
  for (const { from, to } of files) {
    const text = readFileSync(from, "utf8");
    for (const { id, label, pattern } of INTERNAL_REFERENCE_PATTERNS) {
      if (pattern.test(text) && !allowed.has(`${to} ${id}`)) {
        hits.push(`${to}: ${label}`);
      }
    }
  }
  if (hits.length > 0) {
    throw new Error(
      `Refusing to assemble: ${hits.length} internal reference(s) not on ALLOWLIST:\n  ` +
        `${hits.join("\n  ")}\nIf it is a leak, fix it at the source (a fixture's tree or ` +
        `fixture.json). If it genuinely belongs, add it to ALLOWLIST with a reason.`,
    );
  }
}

function manifest(files) {
  return files.map(({ from, to }) => {
    const bytes = readFileSync(from);
    return { to, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
}

function printManifest(rows) {
  console.log(`${rows.length} file(s):\n`);
  for (const row of rows) {
    console.log(`${row.sha256}  ${String(row.size).padStart(8)}  ${row.to}`);
  }
  const totalBytes = rows.reduce((sum, row) => sum + row.size, 0);
  console.log(`\ntotal: ${rows.length} files, ${totalBytes} bytes`);
}

/**
 * Builds a throwaway corpus under a temp directory with one fixture whose
 * fixture.json plants one instance of every INTERNAL_REFERENCE_PATTERNS
 * entry, none on ALLOWLIST, then asserts assembling it is refused and that
 * every pattern is named in the refusal. Proves the guard actually fires
 * for the whole pattern set, rather than trusting that it would.
 */
function selfTest() {
  const tmp = mkdtempSync(join(tmpdir(), "assemble-corpus-selftest-"));
  try {
    writeFileSync(join(tmp, "PUBLIC-README.md"), "placeholder README\n");
    writeFileSync(join(tmp, "regression-suite.json"), "{}\n");

    const fakeLicenses = join(tmp, "licenses");
    mkdirSync(fakeLicenses, { recursive: true });
    writeFileSync(join(fakeLicenses, "LICENSE-FORMAT.txt"), "placeholder\n");
    writeFileSync(join(fakeLicenses, "LICENSE-FIXTURES.txt"), "placeholder\n");
    writeFileSync(join(fakeLicenses, "NOTICE"), "placeholder\n");

    const fixtureDir = join(tmp, "fixtures", "fake-001-self-test");
    mkdirSync(fixtureDir, { recursive: true });
    const planted =
      "Planted by assemble-corpus.mjs --self-test, one of each pattern: " +
      "Perbo, @perbo/reviewer, ADR-9999, docs/99, D-099, SCP-999, PRB-9, " +
      "reviewer_v9, executor_v9, evidence-archive.local/ — all must be refused.";
    writeFileSync(
      join(fixtureDir, "fixture.json"),
      `${JSON.stringify({ id: "fake-001-self-test", notes: planted }, null, 2)}\n`,
    );

    const planEntries = plan({ corpusDir: tmp, licensesDir: fakeLicenses });
    const files = resolveFiles(planEntries);

    let refusalMessage;
    try {
      guardAgainstInternalReferences(files);
    } catch (error) {
      refusalMessage = error.message;
    }

    const missingLabels = INTERNAL_REFERENCE_PATTERNS.filter(
      ({ label }) => !refusalMessage?.includes(label),
    ).map(({ label }) => label);

    if (!refusalMessage || missingLabels.length > 0) {
      throw new Error(
        `self-test failed: expected assembly to be refused naming all ${INTERNAL_REFERENCE_PATTERNS.length} ` +
          `pattern(s). ${
            refusalMessage
              ? `Missing from the refusal: ${missingLabels.join(", ")}`
              : "Assembly was not refused at all."
          }`,
      );
    }

    console.log("self-test passed:");
    console.log(`  temp corpus: ${tmp}`);
    console.log(`  planted: fixtures/fake-001-self-test/fixture.json, one instance of every pattern`);
    console.log(`  refused, naming all ${INTERNAL_REFERENCE_PATTERNS.length} patterns:`);
    console.log(
      refusalMessage
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function main(argv) {
  const args = parseArgs(argv);

  if (args.selfTest) {
    selfTest();
    return;
  }

  const { target, dryRun } = args;

  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) {
      throw new Error(`${target} exists and is not a directory`);
    }
    if (readdirSync(target).length > 0) {
      throw new Error(`${target} exists and is not empty — refusing to write into it`);
    }
  }

  const planEntries = plan();
  const files = resolveFiles(planEntries);
  guardAgainstInternalReferences(files);

  if (dryRun) {
    console.log(`dry run — nothing written to ${target}\n`);
    printManifest(manifest(files));
    return;
  }

  mkdirSync(target, { recursive: true });
  for (const entry of planEntries) {
    const dest = join(target, entry.to);
    mkdirSync(dirname(dest), { recursive: true });
    if (entry.kind === "file") {
      copyFileSync(entry.from, dest);
    } else {
      cpSync(entry.from, dest, { recursive: true });
    }
  }

  console.log(`assembled ${target}\n`);
  printManifest(manifest(files));
}

main(process.argv.slice(2));
