import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import {
  ConfiguredFolderError,
  DEFAULT_LIMITS,
  LimitsTableSchema,
  MaterializationManifestSchema,
  PER_TOKEN_COST_LIMITS,
  SPEC_FOLDER_CONFIG_KEY,
  STANDING_PROHIBITED_KEY,
  configuredFolder,
  readStandingProhibited,
} from "@perbo/contracts";
import type { StandingProhibitedEntry } from "@perbo/contracts";
import { replaceFile } from "@perbo/workspace";
import { ManifestEditorSchema } from "../../shared/protocol.js";
import type { ManifestEditor, ReplyMap, Settings } from "../../shared/protocol.js";
import { configPath, perboPath } from "./layout.js";
import { safePath } from "./paths.js";
import type { RegisteredRepository } from "../profile/store.js";

/** The repository's `.perbo/config.json`, or null where it has none. */
export function readConfig(repo: RegisteredRepository): Record<string, unknown> | null {
  const path = configPath(repo);
  if (!existsSync(path)) return null;
  try {
    return z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(
      `This repository's .perbo/config.json could not be read as a JSON object: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

/** Replaces it whole, so a crash leaves the configuration as it was rather than half of it. */
export function writeConfig(
  repo: RegisteredRepository,
  config: Record<string, unknown>,
): void {
  mkdirSync(perboPath(repo), { recursive: true });
  replaceFile(configPath(repo), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

/**
 * The paths this repository always prohibits, whoever put them there (D-105),
 * and the one place the desktop writes them back: the entries replace their
 * key and every other key of the configuration stays as it was.
 */
export function readStanding(repo: RegisteredRepository): StandingProhibitedEntry[] {
  return readStandingProhibited(readConfig(repo));
}

export function writeStanding(
  repo: RegisteredRepository,
  entries: readonly StandingProhibitedEntry[],
): void {
  writeConfig(repo, { ...(readConfig(repo) ?? {}), [STANDING_PROHIBITED_KEY]: entries });
}

/**
 * The configuration as a record of keys, or an empty one where the repository
 * has none. A file that does not parse throws as JSON does: the readers below
 * report what they could not find rather than what could not be read.
 */
function configRecord(repo: RegisteredRepository): Record<string, unknown> {
  const path = configPath(repo);
  return existsSync(path)
    ? z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(path, "utf8")))
    : {};
}

/** Where this repository keeps its specs: `specs`, or the `specs` key (D-103). */
export function specFolder(repo: RegisteredRepository): string {
  let named: string;
  try {
    named = configuredFolder(configRecord(repo)[SPEC_FOLDER_CONFIG_KEY], SPEC_FOLDER_CONFIG_KEY);
  } catch (error) {
    if (!(error instanceof ConfiguredFolderError)) throw error;
    throw new Error(`This repository's .perbo/config.json ${error.message}`, { cause: error });
  }
  // Through safePath as well, so a link on the way is refused with its own sentence.
  safePath(repo, named);
  return named;
}

/**
 * The limits a run started here is given.
 *
 * D-096: a run started here has no time, token, iteration or command ceiling,
 * and the shell sets neither. What it can tighten is the stall window and the
 * ticket cost cap, and a repository that set a lower one of either keeps it.
 */
export function effectiveLimits(
  repo: RegisteredRepository,
  settings: Settings,
): z.infer<typeof LimitsTableSchema> {
  const current = LimitsTableSchema.parse(
    configRecord(repo)["limits"] ?? { organisation: "local" },
  );
  return {
    ...current,
    limits: {
      ...current.limits,
      attempt_stall_ms: Math.min(
        current.limits["attempt_stall_ms"] ?? DEFAULT_LIMITS.attempt_stall_ms,
        settings.stallMinutes * 60_000,
      ),
      ticket_cost_micros: Math.min(
        current.limits["ticket_cost_micros"] ?? PER_TOKEN_COST_LIMITS.ticket_cost_micros,
        Math.round(settings.ticketDollars * 1_000_000),
      ),
    },
  };
}

/** The configuration as read, with the digest of the bytes it was read from. */
function readConfigured(repo: RegisteredRepository): {
  config: Record<string, unknown>;
  digest: string;
  manifest: z.infer<typeof MaterializationManifestSchema>;
} {
  const path = configPath(repo);
  if (!existsSync(path))
    throw new Error("Run the environment check and save its proposed configuration first.");
  const text = readFileSync(path, "utf8");
  const config = z.record(z.string(), z.unknown()).parse(JSON.parse(text));
  return {
    config,
    digest: createHash("sha256").update(text).digest("hex"),
    manifest: MaterializationManifestSchema.parse(config["materialization_manifest"]),
  };
}

/** The manifest the editor shows, with the digest the save is judged against. */
export function readManifest(repo: RegisteredRepository): ReplyMap["manifest"] {
  const { config, digest, manifest } = readConfigured(repo);
  return {
    digest,
    testCommand: manifest.verify.command.join(" "),
    value: ManifestEditorSchema.parse({
      entries: manifest.entries,
      offLimits: config["protected_paths"] ?? [],
    }),
  };
}

/**
 * The edited manifest, written back whole. The digest is the one the editor
 * was opened on: a configuration that moved since then refuses the save rather
 * than overwriting what changed it.
 */
export function saveManifest(
  repo: RegisteredRepository,
  digest: string,
  value: ManifestEditor,
): void {
  const current = readConfigured(repo);
  if (digest !== current.digest)
    throw new Error(
      "The repository configuration changed. Reopen the manifest before saving.",
    );
  writeConfig(repo, {
    ...current.config,
    materialization_manifest: MaterializationManifestSchema.parse({
      ...current.manifest,
      entries: value.entries,
    }),
    protected_paths: value.offLimits,
  });
}
