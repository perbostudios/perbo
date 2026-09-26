import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";

/**
 * Nothing a person reads is cut (D-NEW-nothing-shown-is-cut), and that holds
 * at the edge of a box as much as in the text: a line too long for its box
 * wraps onto more lines rather than ending in an ellipsis. Read from every
 * stylesheet the renderer ships — the bundle its entry builds, the same module
 * graph the app loads — and from the inline styles its components write.
 */

const RENDERER = import.meta.dirname;

/** Each declaration in a stylesheet, as `property` and `value`, comments dropped. */
function declarations(css: string): { property: string; value: string }[] {
  const found: { property: string; value: string }[] = [];
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // The innermost blocks are the ones that hold declarations; an at-rule's
  // block holds rules, whose own blocks this finds.
  for (const block of bare.matchAll(/\{([^{}]*)\}/g))
    for (const declaration of block[1]!.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      found.push({
        property: declaration.slice(0, colon).trim().toLowerCase(),
        value: declaration.slice(colon + 1).trim().toLowerCase(),
      });
    }
  return found;
}

/** Whether a declaration cuts text short at its box's edge. */
function clips(declaration: { property: string; value: string }): boolean {
  if (declaration.property === "text-overflow") return declaration.value.includes("ellipsis");
  return /(^|-)line-clamp$/.test(declaration.property) && declaration.value !== "none";
}

async function shippedCss(): Promise<string> {
  const result = await build({
    entryPoints: [join(RENDERER, "mount.tsx")],
    platform: "browser",
    bundle: true,
    write: false,
    outdir: "out",
    format: "esm",
    logLevel: "silent",
    loader: { ".woff": "empty", ".woff2": "empty", ".ttf": "empty", ".svg": "empty", ".png": "empty" },
  });
  return result.outputFiles
    .filter((file) => file.path.endsWith(".css"))
    .map((file) => file.text)
    .join("\n");
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test-support" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

it("reads a clipping declaration as one, and nothing else", () => {
  const found = declarations(`
    /* text-overflow: ellipsis; in a comment is no rule */
    .a { overflow: hidden; TEXT-OVERFLOW: Ellipsis }
    @media (max-width: 10px) { .b { -webkit-line-clamp: 2; } }
    .c { line-clamp: none; text-overflow: clip; overflow-wrap: anywhere; }
  `);
  expect(found.filter(clips)).toEqual([
    { property: "text-overflow", value: "ellipsis" },
    { property: "-webkit-line-clamp", value: "2" },
  ]);
});

it("ships no stylesheet rule that cuts text with an ellipsis or a line clamp", async () => {
  const css = await shippedCss();
  // The renderer's own sheets are in the bundle, so it is the one the app loads.
  expect(css).toContain(".task-card-outcome");
  expect(css).toContain(".titlebar-name");
  expect(declarations(css).filter(clips)).toEqual([]);
});

it("writes no inline style that cuts text with an ellipsis or a line clamp", () => {
  const files = sources(RENDERER);
  expect(files.some((file) => file.endsWith("HomePage.tsx"))).toBe(true);
  const clipping = files.filter((file) =>
    /textOverflow\s*:\s*["'`]ellipsis|lineClamp\s*:/i.test(readFileSync(file, "utf8")),
  );
  expect(clipping).toEqual([]);
});
