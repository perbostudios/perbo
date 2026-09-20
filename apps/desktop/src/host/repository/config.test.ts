import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsSchema } from "../../shared/protocol.js";
import { configPath } from "./layout.js";
import {
  effectiveLimits,
  readConfig,
  readManifest,
  saveManifest,
  specFolder,
  writeConfig,
} from "./config.js";
import type { RegisteredRepository } from "../profile/store.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
const manifest = {
  manifest_version: 1,
  repository_id: "repo_0000000000000001",
  source_checkout: ".",
  entries: [],
  install: {
    kind: "none",
    package_manager: "none",
    offline_preferred: true,
    lifecycle_scripts: { policy: "disabled", exception: null },
    command: ["true"],
    pinned: true,
  },
  verify: { command: ["pnpm", "test"], timeout_ms: 900_000 },
  isolation: {
    mode: "serialized",
    port_range_size: 0,
    port_range_start: 20_000,
    port_range_end: 21_000,
    database_schema_prefix: null,
  },
};
const entry = {
  path: ".env.local",
  source_path: ".env.local",
  kind: "file" as const,
  strategy: "copy" as const,
  secret: true,
  required: true,
  reason: "Local configuration",
};
function repository(config?: Record<string, unknown>): RegisteredRepository {
  const root = mkdtempSync(join(tmpdir(), "perbo-config-"));
  temporary.push(root);
  const path = join(root, "checkout");
  mkdirSync(path, { recursive: true });
  const repo = { id: "80000000-0000-4000-8000-000000000001", name: "checkout", path };
  if (config) {
    mkdirSync(join(path, ".perbo"), { recursive: true });
    writeFileSync(configPath(repo), JSON.stringify(config, null, 2) + "\n");
  }
  return repo;
}
const settings = SettingsSchema.parse({});

describe("reading and replacing the configuration", () => {
  it("answers nothing for a repository that has none", () => {
    expect(readConfig(repository())).toBeNull();
  });

  it("says which repository's configuration could not be read", () => {
    const repo = repository();
    mkdirSync(join(repo.path, ".perbo"), { recursive: true });
    writeFileSync(configPath(repo), "{not json");
    expect(() => readConfig(repo)).toThrow(".perbo/config.json could not be read as a JSON object");
  });

  it("replaces the file whole, readable only by its owner and ending in a newline", () => {
    const repo = repository();
    writeConfig(repo, { specs: "docs/specs" });
    const text = readFileSync(configPath(repo), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({ specs: "docs/specs" });
    expect(statSync(configPath(repo)).mode & 0o777).toBe(0o600);
    writeConfig(repo, { specs: "specs" });
    expect(readConfig(repo)).toEqual({ specs: "specs" });
  });
});

describe("specFolder", () => {
  it("is `specs` where the repository names none", () => {
    expect(specFolder(repository())).toBe("specs");
    expect(specFolder(repository({ limits: {} }))).toBe("specs");
  });

  it("is the folder the repository named", () => {
    expect(specFolder(repository({ specs: "docs/specs" }))).toBe("docs/specs");
  });

  it("refuses a name that is not a repository-relative folder", () => {
    for (const named of ["/absolute", "../outside", 7, "specs/../.."])
      expect(() => specFolder(repository({ specs: named }))).toThrow(
        "not a repository-relative folder",
      );
  });

  it("refuses a folder reached through a link", () => {
    const repo = repository({ specs: "specs" });
    symlinkSync(join(repo.path, ".."), join(repo.path, "specs"));
    expect(() => specFolder(repo)).toThrow("refuses a symlink");
  });
});

describe("effectiveLimits", () => {
  it("tightens the stall window and the ticket cap to the person's settings", () => {
    const limits = effectiveLimits(repository(), {
      ...settings,
      stallMinutes: 5,
      ticketDollars: 2,
    }).limits;
    expect(limits["attempt_stall_ms"]).toBe(5 * 60_000);
    expect(limits["ticket_cost_micros"]).toBe(2_000_000);
  });

  it("keeps a repository's own lower ceiling", () => {
    const repo = repository({
      limits: {
        organisation: "acme",
        limits: { attempt_stall_ms: 60_000, ticket_cost_micros: 500_000 },
      },
    });
    const table = effectiveLimits(repo, { ...settings, stallMinutes: 5, ticketDollars: 2 });
    expect(table.organisation).toBe("acme");
    expect(table.limits["attempt_stall_ms"]).toBe(60_000);
    expect(table.limits["ticket_cost_micros"]).toBe(500_000);
  });

  it("keeps every other ceiling the repository set", () => {
    const repo = repository({
      limits: { organisation: "acme", limits: { attempt_tokens: 1_000 } },
    });
    expect(effectiveLimits(repo, settings).limits["attempt_tokens"]).toBe(1_000);
  });
});

describe("the materialization manifest", () => {
  it("refuses to open one for a repository that has never been configured", () => {
    expect(() => readManifest(repository())).toThrow(
      "Run the environment check and save its proposed configuration first.",
    );
  });

  it("carries the verify command, the entries and the digest of the file as read", () => {
    const repo = repository({ materialization_manifest: manifest, protected_paths: [".github/**"] });
    const read = readManifest(repo);
    expect(read.testCommand).toBe("pnpm test");
    expect(read.value.entries).toEqual([]);
    expect(read.value.offLimits).toEqual([".github/**"]);
    expect(read.digest).toBe(
      createHash("sha256").update(readFileSync(configPath(repo), "utf8")).digest("hex"),
    );
  });

  it("defaults the off-limits list to nothing where the repository set none", () => {
    expect(readManifest(repository({ materialization_manifest: manifest })).value.offLimits).toEqual([]);
  });

  it("refuses a save against a digest the file has moved past", () => {
    const repo = repository({ materialization_manifest: manifest });
    expect(() =>
      saveManifest(repo, "0".repeat(64), { entries: [], offLimits: [] }),
    ).toThrow("The repository configuration changed. Reopen the manifest before saving.");
  });

  it("saves the edited entries and keeps every other key, including the verify command", () => {
    const repo = repository({
      materialization_manifest: manifest,
      specs: "docs/specs",
      limits: { organisation: "acme" },
    });
    const entries = [entry];
    saveManifest(repo, readManifest(repo).digest, { entries, offLimits: ["secrets/**"] });
    const saved = readManifest(repo);
    expect(saved.value.entries).toEqual(entries);
    expect(saved.value.offLimits).toEqual(["secrets/**"]);
    expect(saved.testCommand).toBe("pnpm test");
    expect(readConfig(repo)).toMatchObject({ specs: "docs/specs", limits: { organisation: "acme" } });
    expect(statSync(configPath(repo)).mode & 0o777).toBe(0o600);
  });
});
