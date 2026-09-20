import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where this package is, for the suites that read a file rather than import
 * one. One home, so a module that moves does not leave a `".."` behind that
 * still resolves and names the wrong directory.
 */

/** `apps/cli`, from this file's fixed place in `src/test-support/`. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");

/** Authored fixtures: data, never compiled and never collected. */
export const FIXTURES = join(PACKAGE_ROOT, "test", "fixtures");

/** The compiled entry point `turbo run build` leaves, which some suites spawn. */
export const BUILT_ENTRY = join(PACKAGE_ROOT, "dist", "main.js");
