import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readPackageVersion(): string {
  const packagePath = new URL("../package.json", import.meta.url);
  let metadata: unknown;
  try {
    metadata = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error(
      `could not read CLI package metadata from ${fileURLToPath(packagePath)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("version" in metadata) ||
    typeof metadata.version !== "string" ||
    metadata.version.length === 0
  ) {
    throw new Error(`CLI package metadata at ${fileURLToPath(packagePath)} has no version`);
  }
  return metadata.version;
}

export const VERSION = readPackageVersion();
