#!/usr/bin/env node
// What stands between packing the partner archive and attaching it: the
// archive's contents in the log, and a refusal if the runner's write-guard
// hook is not among them. An archive without it installs a CLI whose `run`
// stops at its first tool call, and the person who finds that out is the
// partner. Called by .github/workflows/release.yml.
//
//   node tooling/package/verify-tarball.mjs release/perbo-<version>.tgz

import { execFileSync } from "node:child_process";
import { GUARD_HOOK_FILE, invokedDirectly } from "./bundle.mjs";

/** The path the archive must carry, inside its one top-level directory. */
const REQUIRED = `bin/${GUARD_HOOK_FILE}`;

/** Every entry in the archive, by its path inside the top-level directory. */
function insideTopLevel(entry) {
  return entry.split("/").slice(1).join("/");
}

/** Print the archive's contents and refuse if the hook is not among them. */
export function verifyTarball(tarball) {
  let listing;
  try {
    listing = execFileSync("tar", ["-tzf", tarball], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    console.log(
      `::error::${tarball} could not be listed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }

  const entries = listing.split("\n").filter((entry) => entry !== "");
  console.log(`${tarball} holds ${entries.length} entries:`);
  for (const entry of entries) console.log(`  ${entry}`);

  if (!entries.some((entry) => insideTopLevel(entry) === REQUIRED)) {
    console.log(
      `::error::${tarball} does not carry ${REQUIRED}: the runner's write-guard hook is not in ` +
        "the archive, so an installed `perbo run` would stop at its first tool call",
    );
    return false;
  }
  console.log(`\n${REQUIRED} is in the archive.`);
  return true;
}

if (invokedDirectly(import.meta.url)) {
  const tarball = process.argv[2];
  if (tarball === undefined) {
    console.log("::error::verify-tarball.mjs needs the path to a packed tarball");
    process.exit(1);
  }
  if (!verifyTarball(tarball)) process.exit(1);
}
