#!/usr/bin/env node
// The partner tarball. Builds the workspace, bundles the CLI and
// everything it imports into one file, stages the runner's write-guard hook
// beside it along with a manifest, the install page and the licence,
// archives the stage, and writes a SHA-256 next to the archive in
// `shasum -a 256` format. `release/` is gitignored; CI runs this
// script and attaches the result to a draft release (.github/workflows/release.yml).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLI_ENTRY_POINT,
  ROOT,
  bundleCli,
  bundleGuardHook,
  bundledPackages,
  invokedDirectly,
  readVersion,
} from "./bundle.mjs";

const RELEASE = join(ROOT, "release");
const SHEBANG = "#!/usr/bin/env node\n";

// The tarball's README is docs/install.md up to this marker; what follows the
// marker is written for readers of the repository, not of the archive.
const README_CUT = "<!-- pack.mjs: the tarball copy ends here -->";

// The tarball is the installable build of the same software the repository
// publishes, so it carries the same licence (D-075). The full text travels
// beside it, read from the repository's own LICENSE.
const LICENCE_NOTICE = `This software is licensed under the Apache License, Version 2.0.

  Copyright 2026 Lian Matsuo

You may not use this software except in compliance with the License. The
complete text is in LICENSE beside this file, and at
https://www.apache.org/licenses/LICENSE-2.0.

Unless required by applicable law or agreed to in writing, software distributed
under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied.
`;

/** Run one command as argv with inherited stdio; a non-zero exit stops the pack. */
function run(argv, options = {}) {
  const [command, ...args] = argv;
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${argv.join(" ")} exited with ${result.status}`);
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

/**
 * Everything the archive holds, written into `stage`: the binary, the runner's
 * write-guard hook beside it, the manifest the binary reads its version from,
 * the install page and the licence notice.
 *
 * `root` is the built tree the bundles are made from; building it is the
 * caller's. Returns the binary's metafile, which names what went into it.
 */
export async function stageArchive({ stage, version, root = ROOT }) {
  rmSync(stage, { recursive: true, force: true });
  const bin = join(stage, "bin");
  mkdirSync(bin, { recursive: true });

  // The same single-file bundle a corpus run executes (bundle.mjs), so the
  // archive and the measured binary are built one way.
  const bundle = join(bin, "perbo.mjs");
  const metafile = await bundleCli({
    entry: join(root, CLI_ENTRY_POINT),
    outfile: bundle,
    absWorkingDir: root,
  });

  const bundled = readFileSync(bundle, "utf8");
  if (!bundled.startsWith(SHEBANG)) {
    throw new Error(`${bundle} does not start with ${JSON.stringify(SHEBANG.trim())}`);
  }
  chmodSync(bundle, 0o755);

  // Beside the binary, where the runner looks for it: without it an attempt
  // stops at its first tool call, with the hook's absence as the reason.
  await bundleGuardHook({ beside: bin, root });

  writeFileSync(
    join(stage, "package.json"),
    `${JSON.stringify(
      {
        name: "perbo",
        version,
        description: "Contract to pull request, locally. The perbo CLI, bundled for design partners.",
        // Guards against `npm publish`; a tarball installs regardless.
        private: true,
        license: "Apache-2.0",
        type: "module",
        bin: { perbo: "bin/perbo.mjs" },
        engines: { node: ">=22" },
        files: ["bin", "README.md", "LICENSE", "NOTICE", "licenses"],
      },
      null,
      2,
    )}\n`,
  );

  const installPage = readFileSync(join(root, "docs", "install.md"), "utf8");
  const cut = installPage.indexOf(README_CUT);
  if (cut === -1) throw new Error(`docs/install.md has no ${JSON.stringify(README_CUT)} marker`);
  writeFileSync(join(stage, "README.md"), `${installPage.slice(0, cut).trimEnd()}\n`);
  copyFileSync(join(root, "LICENSE"), join(stage, "LICENSE"));
  writeFileSync(join(stage, "NOTICE"), LICENCE_NOTICE);
  mkdirSync(join(stage, "licenses"), { recursive: true });
  for (const [source, target] of [["LICENSE", "mattpocock-skills-MIT.txt"], ["source.json", "mattpocock-skills-source.json"]]) {
    copyFileSync(join(root, "tooling/skills/mattpocock", source), join(stage, "licenses", target));
  }

  return metafile;
}

if (invokedDirectly(import.meta.url)) {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 22) {
    console.error(`pack.mjs needs Node 22 or later; this is ${process.version}`);
    process.exit(1);
  }

  run(["pnpm", "exec", "turbo", "run", "build"]);

  const version = readVersion();
  const name = `perbo-${version}`;
  const stage = join(RELEASE, name);
  const metafile = await stageArchive({ stage, version });

  const tarball = join(RELEASE, `${name}.tgz`);
  rmSync(tarball, { force: true });
  // COPYFILE_DISABLE keeps macOS from adding ._* resource-fork entries to the archive.
  run(["tar", "-czf", tarball, "-C", RELEASE, name], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });

  const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  writeFileSync(`${tarball}.sha256`, `${digest}  ${name}.tgz\n`);

  const size = statSync(tarball).size;
  console.log(`\nbundled: ${bundledPackages(metafile).join(", ")}`);
  console.log(`tarball: ${tarball}`);
  console.log(`size:    ${formatSize(size)} (${size} bytes)`);
  console.log(`sha256:  ${digest}`);
}
