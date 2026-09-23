import { describe, expect, it } from "vitest";
import { changeSetFromDiff } from "./changeset.js";
import { packageOf } from "./paths.js";
import { deriveActualRisk, derivePlannedRisk, raisePlanLevel } from "./risk.js";

const scope = (paths: string[]) => ({
  repository_id: "repo_01J8QH",
  paths_allowed: paths,
  paths_prohibited: [],
  generated_paths: [],
  expansion_budget_files: 3,
});

const diffTouching = (paths: string[]) =>
  paths
    .map(
      (path) => `diff --git a/${path} b/${path}
index 1111111..2222222 100644
--- a/${path}
+++ b/${path}
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
`,
    )
    .join("");

describe("planned risk", () => {
  it("is P0 for a read-only action", () => {
    expect(
      derivePlannedRisk({
        scope: scope(["packages/auth/**"]),
        repository_sensitivity: "standard",
        action_class: "read_only",
      }).level,
    ).toBe("P0");
  });

  it("is P1 for a reversible change inside one package", () => {
    expect(
      derivePlannedRisk({
        scope: scope(["packages/queue/**"]),
        repository_sensitivity: "standard",
        action_class: "reversible_change",
      }).level,
    ).toBe("P1");
  });

  it("is P2 when the declared scope spans packages", () => {
    expect(
      derivePlannedRisk({
        scope: scope(["packages/auth/**", "packages/email/**"]),
        repository_sensitivity: "standard",
        action_class: "reversible_change",
      }).level,
    ).toBe("P2");
  });

  it("is P3 for an irreversible action", () => {
    expect(
      derivePlannedRisk({
        scope: scope(["packages/auth/**"]),
        repository_sensitivity: "standard",
        action_class: "irreversible_change",
      }).level,
    ).toBe("P3");
  });

  it("is P2 when the declared scope names a security-sensitive directory", () => {
    const derived = derivePlannedRisk({
      scope: scope(["packages/auth/**"]),
      repository_sensitivity: "standard",
      action_class: "reversible_change",
    });
    expect(derived.level).toBe("P2");
    expect(derived.reasons.join("\n")).toContain("security-sensitive");
  });

  it("is P2 when the declared scope includes configuration", () => {
    const derived = derivePlannedRisk({
      scope: scope(["apps/cli/tsconfig.json"]),
      repository_sensitivity: "standard",
      action_class: "reversible_change",
    });
    expect(derived.level).toBe("P2");
    expect(derived.reasons.join("\n")).toContain("configuration");
  });

  it("is P3 when the declared scope covers CI, infrastructure or policy", () => {
    for (const glob of [".github/**", "infra/**", "packages/policy/**"]) {
      const derived = derivePlannedRisk({
        scope: scope([glob]),
        repository_sensitivity: "standard",
        action_class: "reversible_change",
      });
      expect(derived.level, glob).toBe("P3");
      expect(derived.reasons.join("\n"), glob).toContain(glob);
    }
  });

  it("is P1 for a documentation or backlog scope: nothing assumes code paths", () => {
    for (const glob of ["docs/**", "backlog/**"]) {
      expect(
        derivePlannedRisk({
          scope: scope([glob]),
          repository_sensitivity: "standard",
          action_class: "reversible_change",
        }).level,
        glob,
      ).toBe("P1");
    }
  });
});

describe("actual risk", () => {
  const actual = (paths: string[]) =>
    deriveActualRisk(changeSetFromDiff({ diff: diffTouching(paths), base_commit: "a1b2c3d" }));

  it("is P1 for one package", () => {
    expect(actual(["packages/queue/enqueue.ts", "packages/queue/retry.ts"]).level).toBe("P1");
  });

  // docs/04 lists "auth/billing/security paths" as a P2 trigger, so a change
  // inside packages/auth derives to P2 even when it touches one package. The
  // derivation errs upward on purpose: a human may raise a level and may not
  // lower one, so an under-call is the dangerous direction.
  it("rises to P2 inside an auth package", () => {
    expect(actual(["packages/auth/signup.ts"]).level).toBe("P2");
  });

  it("rises to P2 on a migration", () => {
    const derived = actual(["packages/queue/migrations/003_add_column.sql"]);
    expect(derived.level).toBe("P2");
    expect(derived.reasons.join(" ")).toMatch(/migration/);
  });

  it("rises to P2 on a dependency manifest", () => {
    expect(actual(["packages/queue/package.json"]).level).toBe("P2");
  });

  it("rises to P2 on repository-supplied agent configuration (ADR-0030)", () => {
    const derived = actual([".claude/settings.json"]);
    expect(derived.level).toBe("P2");
    expect(derived.reasons.join(" ")).toMatch(/ADR-0030/);
  });

  it("records why, not just what", () => {
    expect(actual(["packages/queue/session/token.ts"]).reasons.length).toBeGreaterThan(0);
  });
});

describe("generated paths are exempt from risk as well as from scope", () => {
  const scopeWith = (generated: string[], prohibited: string[] = []) => ({
    repository_id: "repo_fixture",
    paths_allowed: ["packages/queue/**"],
    paths_prohibited: prohibited,
    generated_paths: generated,
    expansion_budget_files: 3,
  });
  const derive = (paths: string[], scope?: ReturnType<typeof scopeWith>) =>
    deriveActualRisk(
      changeSetFromDiff({ diff: diffTouching(paths), base_commit: "a1b2c3d" }),
      scope,
    );

  // Without the exemption a lockfile update carries a schema migration's
  // blocking policy into an ordinary change.
  it("does not let a lockfile update escalate an ordinary change", () => {
    const paths = ["packages/queue/src/enqueue.ts", "pnpm-lock.yaml"];
    expect(derive(paths).level).toBe("P2");
    expect(derive(paths, scopeWith(["pnpm-lock.yaml"])).level).toBe("P1");
  });

  it("says which paths it exempted", () => {
    const derived = derive(["packages/queue/src/a.ts", "pnpm-lock.yaml"], scopeWith(["pnpm-lock.yaml"]));
    expect(derived.reasons.join(" ")).toMatch(/exempt as generated: pnpm-lock\.yaml/);
  });

  it("still gives a P1 change a reason of its own, not only the exemption note", () => {
    const derived = derive(["packages/queue/src/a.ts", "pnpm-lock.yaml"], scopeWith(["pnpm-lock.yaml"]));
    expect(derived.reasons[0]).toBe("reversible change inside one package");
  });

  it("refuses to exempt a path that is also prohibited", () => {
    // Otherwise generated_paths launders a prohibited path out of the risk
    // derivation, exactly as it must not in scope accounting.
    const scope = scopeWith(["**/.env*"], ["**/.env*"]);
    expect(derive(["packages/queue/src/a.ts", "packages/queue/.env.production"], scope).level).toBe(
      "P2",
    );
  });

  it("leaves the derivation unchanged when no scope is supplied", () => {
    const paths = ["packages/queue/src/a.ts"];
    expect(derive(paths).level).toBe(derive(paths, scopeWith([])).level);
  });
});

describe("a human may raise a level but not lower it", () => {
  it("permits raising", () => {
    expect(raisePlanLevel("P1", "P2")).toBe("P2");
    expect(raisePlanLevel("P1", "P1")).toBe("P1");
  });

  it("refuses lowering", () => {
    expect(() => raisePlanLevel("P2", "P1")).toThrow(/may be raised but not lowered/);
    expect(() => raisePlanLevel("P3", "P0")).toThrow();
  });
});

describe("path helpers", () => {
  it("resolves the package a path belongs to", () => {
    expect(packageOf("packages/auth/signup.ts")).toBe("packages/auth");
    expect(packageOf("apps/cli/src/main.ts")).toBe("apps/cli");
    expect(packageOf("infra/terraform/main.tf")).toBe("infra");
  });
});
