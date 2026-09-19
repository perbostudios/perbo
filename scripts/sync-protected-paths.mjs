#!/usr/bin/env node
// Keeps the three places that name the files a change may not edit in
// agreement, and derives the third from the other two.
//
//   .perbo/config.json          `protected_tests` — canonical; what the runner
//                                protects on this repository
//   .github/protected-paths.json the same `protected_tests`, plus its own
//                                `protected_paths` globs, for the pull request check
//   .claude/settings.json        a checked-in Claude Code project settings file.
//                                Its `permissions.deny` is generated from the two
//                                above: an agent working here is refused the edit
//                                at the point it is attempted rather than at CI.
//                                Every other key in that file is hand-written and
//                                is preserved.
//
// A deny rule is written as `Edit(/<path>)`. The leading slash anchors the
// pattern at the settings file's own source — the repository root — so the rule
// names one file in this tree and not a same-named file anywhere else.
//
//   node scripts/sync-protected-paths.mjs --check   # fail on any disagreement
//   node scripts/sync-protected-paths.mjs --write   # regenerate permissions.deny
//
// Exit codes: 0 agreement, 1 a disagreement named on stderr, 2 a bad command line.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PERBO_CONFIG = ".perbo/config.json";
export const PROTECTED_PATHS = ".github/protected-paths.json";
export const CLAUDE_SETTINGS = ".claude/settings.json";

function readJson(path) {
  if (!existsSync(path)) throw new Error(`no file at ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function stringArray(value, what, path) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${path}: "${what}" must be an array of strings`);
  }
  return value;
}

/** The protected lists, read from the two files that declare them. */
export function readSources(repo) {
  const configPath = resolve(repo, PERBO_CONFIG);
  const checkPath = resolve(repo, PROTECTED_PATHS);
  const config = readJson(configPath);
  const check = readJson(checkPath);
  return {
    configTests: stringArray(config.protected_tests, "protected_tests", PERBO_CONFIG),
    checkTests: stringArray(check.protected_tests, "protected_tests", PROTECTED_PATHS),
    checkPaths: stringArray(check.protected_paths, "protected_paths", PROTECTED_PATHS),
  };
}

/** How the two `protected_tests` arrays disagree; empty when they do not. */
export function protectedTestsDifferences(configTests, checkTests) {
  const onlyInConfig = configTests.filter((entry) => !checkTests.includes(entry));
  const onlyInCheck = checkTests.filter((entry) => !configTests.includes(entry));
  const lines = [];
  for (const entry of onlyInConfig) lines.push(`  ${entry} — in ${PERBO_CONFIG}, not in ${PROTECTED_PATHS}`);
  for (const entry of onlyInCheck) lines.push(`  ${entry} — in ${PROTECTED_PATHS}, not in ${PERBO_CONFIG}`);
  if (lines.length === 0 && configTests.join("\n") !== checkTests.join("\n")) {
    lines.push(`  the same entries in a different order in ${PERBO_CONFIG} and ${PROTECTED_PATHS}`);
  }
  return lines;
}

/** The deny list: the protected tests in order, then the protected globs. */
export function computeDenyList({ configTests, checkPaths }) {
  return [...configTests, ...checkPaths].map((entry) => `Edit(/${entry})`);
}

function sameList(left, right) {
  return (
    Array.isArray(left) && left.length === right.length && left.every((entry, i) => entry === right[i])
  );
}

/** The settings file with `permissions.deny` replaced and every other key kept. */
export function withDenyList(settings, deny) {
  return { ...settings, permissions: { ...(settings.permissions ?? {}), deny } };
}

export function run(argv, { repo = REPO_ROOT, log = console.log, logError = console.error } = {}) {
  let mode = null;
  let repoDir = repo;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check" || arg === "--write") {
      if (mode && mode !== arg.slice(2)) {
        logError("Give one of --check or --write, not both");
        return 2;
      }
      mode = arg.slice(2);
    } else if (arg === "--repo") {
      const value = argv[(i += 1)];
      if (value === undefined) {
        logError("--repo needs a directory");
        return 2;
      }
      repoDir = resolve(value);
    } else {
      logError(`Usage: sync-protected-paths.mjs --check | --write [--repo <dir>]`);
      return 2;
    }
  }
  if (!mode) {
    logError("Usage: sync-protected-paths.mjs --check | --write [--repo <dir>]");
    return 2;
  }

  let sources;
  try {
    sources = readSources(repoDir);
  } catch (error) {
    logError(`sync-protected-paths: ${error.message}`);
    return 1;
  }

  const differences = protectedTestsDifferences(sources.configTests, sources.checkTests);
  if (differences.length > 0) {
    logError(`sync-protected-paths: the two protected_tests lists disagree:\n${differences.join("\n")}`);
    logError(
      `\n${PERBO_CONFIG} is canonical: make ${PROTECTED_PATHS} match it, in the same change.`,
    );
    return 1;
  }

  const deny = computeDenyList(sources);
  const settingsPath = resolve(repoDir, CLAUDE_SETTINGS);

  if (mode === "write") {
    const settings = existsSync(settingsPath) ? readJson(settingsPath) : {};
    writeSettings(settingsPath, withDenyList(settings, deny));
    log(`sync-protected-paths: wrote ${deny.length} deny rule(s) to ${CLAUDE_SETTINGS}`);
    return 0;
  }

  if (!existsSync(settingsPath)) {
    logError(
      `sync-protected-paths: no ${CLAUDE_SETTINGS}. Run: node scripts/sync-protected-paths.mjs --write`,
    );
    return 1;
  }
  const settings = readJson(settingsPath);
  const current = settings.permissions?.deny;
  if (!sameList(current, deny)) {
    logError(`sync-protected-paths: ${CLAUDE_SETTINGS} permissions.deny is not what the two lists produce.`);
    logError(`  expected:\n${deny.map((entry) => `    ${entry}`).join("\n")}`);
    logError(`  found:\n${(current ?? []).map((entry) => `    ${entry}`).join("\n") || "    (nothing)"}`);
    logError(`\nRun: node scripts/sync-protected-paths.mjs --write`);
    return 1;
  }
  log(`sync-protected-paths: ${CLAUDE_SETTINGS} carries the ${deny.length} rule(s) the two lists produce`);
  return 0;
}

function writeSettings(path, settings) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
