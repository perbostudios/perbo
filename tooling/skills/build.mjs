import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = join(root, "tooling/skills/mattpocock");
const manifest = JSON.parse(await readFile(join(source, "source.json"), "utf8"));
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Skill symlinks are forbidden: ${path}`);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (/\.(md|txt|sh|ts|js|json)$/i.test(entry.name)) result.push(path);
  }
  return result;
}
const bodies = {};
for (const path of manifest.paths) {
  const name = path.split("/").at(-1), directory = join(source, name);
  const paths = await files(directory);
  paths.sort((a, b) => Number(!a.endsWith("/SKILL.md")) - Number(!b.endsWith("/SKILL.md")) || (relative(directory, a) < relative(directory, b) ? -1 : 1));
  bodies[name] = (await Promise.all(paths.map(async path => `## Bundled reference: ${name}/${relative(directory, path)}\n${await readFile(path, "utf8")}`))).join("\n\n");
  if (Buffer.byteLength(bodies[name]) > 150_000) throw new Error(`Oversized skill: ${name}`);
}
const generated = '// Generated from tooling/skills/mattpocock. Regenerate with tooling/skills/build.mjs.\nexport const skillContent = ' + JSON.stringify(bodies, null, 2) + ' as const;\n';
const target = join(root, "packages/runner/src/skills/internal/content.ts");
if (process.argv.includes("--check")) {
  if (await readFile(target, "utf8") !== generated) throw new Error("Bundled skill guidance is stale. Run node tooling/skills/build.mjs.");
  process.stdout.write(`Verified ${manifest.paths.length} pinned skill bundles.\n`);
} else await writeFile(target, generated);
