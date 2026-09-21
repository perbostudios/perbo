import { describe, expect, it } from "vitest";
import {
  MATERIALIZATION_MANIFEST_VERSION,
  MaterializationEntrySchema,
  MaterializationManifestSchema,
  LifecycleScriptPolicySchema,
  manifestHash,
} from "./materialisation.js";

const entry = {
  path: ".env.local",
  kind: "file" as const,
  source_path: ".env.local",
  strategy: "copy" as const,
  secret: true,
  required: true,
  reason: "the application refuses to start without it",
};

const manifest = {
  manifest_version: MATERIALIZATION_MANIFEST_VERSION,
  repository_id: "repo_test",
  source_checkout: "/home/u/app",
  entries: [entry],
  install: {
    kind: "shared_store" as const,
    package_manager: "pnpm" as const,
    offline_preferred: true,
    lifecycle_scripts: { policy: "disabled" as const, exception: null },
    command: ["pnpm", "install", "--frozen-lockfile"],
    pinned: true,
  },
  verify: { command: ["pnpm", "test"], timeout_ms: 600_000 },
  isolation: {
    mode: "parallel" as const,
    port_range_size: 10,
    port_range_start: 41000,
    port_range_end: 41009,
    database_schema_prefix: "ayo_attempt_",
  },
};

describe("MaterializationEntry", () => {
  it("refuses a destination that escapes the worktree", () => {
    expect(MaterializationEntrySchema.safeParse({ ...entry, path: "../outside" }).success).toBe(
      false,
    );
    expect(MaterializationEntrySchema.safeParse({ ...entry, path: "/etc/passwd" }).success).toBe(
      false,
    );
  });

  it("refuses to symlink a secret", () => {
    const parsed = MaterializationEntrySchema.safeParse({ ...entry, strategy: "symlink" });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("copied, never symlinked");
  });

  it("permits a symlink for a non-secret cache directory", () => {
    expect(
      MaterializationEntrySchema.safeParse({
        ...entry,
        path: ".cache",
        kind: "directory",
        strategy: "symlink",
        secret: false,
      }).success,
    ).toBe(true);
  });
});

describe("lifecycle script policy", () => {
  it("disables scripts with no ceremony", () => {
    expect(
      LifecycleScriptPolicySchema.safeParse({ policy: "disabled", exception: null }).success,
    ).toBe(true);
  });

  it("requires a named, dated, reasoned exception to enable them", () => {
    expect(LifecycleScriptPolicySchema.safeParse({ policy: "enabled", exception: null }).success).toBe(
      false,
    );
    expect(
      LifecycleScriptPolicySchema.safeParse({
        policy: "enabled",
        exception: {
          approved_by: "lian",
          reason: "the native module has no prebuilt binary for arm64",
          recorded_at: "2026-08-27T10:00:00Z",
        },
      }).success,
    ).toBe(true);
  });
});

describe("manifestHash", () => {
  it("is stable under entry order", () => {
    const second = { ...entry, path: ".env.test", secret: true };
    const a = MaterializationManifestSchema.parse({ ...manifest, entries: [entry, second] });
    const b = MaterializationManifestSchema.parse({ ...manifest, entries: [second, entry] });
    expect(manifestHash(a)).toBe(manifestHash(b));
  });

  it("moves when the install command moves", () => {
    const a = MaterializationManifestSchema.parse(manifest);
    const b = MaterializationManifestSchema.parse({
      ...manifest,
      install: { ...manifest.install, command: ["pnpm", "install"] },
    });
    expect(manifestHash(a)).not.toBe(manifestHash(b));
  });

  it("ignores where the user happens to keep their checkout", () => {
    const a = MaterializationManifestSchema.parse(manifest);
    const b = MaterializationManifestSchema.parse({ ...manifest, source_checkout: "/other/path" });
    expect(manifestHash(a)).toBe(manifestHash(b));
  });
});
