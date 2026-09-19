import { describe, expect, it } from "vitest";
import {
  admittedWriteGlobs,
  changeSetFromDiff,
  insideAllowedPaths,
  type Scope,
} from "@perbo/contracts";
import { assessScope } from "../src/scope.js";

const scope: Scope = {
  repository_id: "repo_fixture",
  paths_allowed: ["packages/search/**"],
  paths_prohibited: [".github/**", "infra/**", "**/*.pem", "**/.env*"],
  generated_paths: ["pnpm-lock.yaml", "**/*.generated.ts"],
  expansion_budget_files: 2,
};

const diffFor = (paths: string[]) =>
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

const assess = (paths: string[]) =>
  assessScope(changeSetFromDiff({ diff: diffFor(paths), base_commit: "a1b2c3d" }), scope);

describe("scope enforcement is deterministic and exact", () => {
  it("passes a change entirely inside paths_allowed", () => {
    const result = assess(["packages/search/src/query.ts", "packages/search/test/query.test.ts"]);
    expect(result.findings).toEqual([]);
    expect(result.check.status).toBe("passed");
    expect(result.deviation.files_outside_scope).toEqual([]);
  });

  it("blocks a prohibited path", () => {
    const result = assess(["packages/search/src/query.ts", ".github/workflows/ci.yml"]);
    const blocking = result.findings.filter((finding) => finding.blocking);
    expect(blocking).toHaveLength(1);
    expect(blocking[0]?.rule_id).toBe("scope.prohibited_path");
    expect(blocking[0]?.file).toBe(".github/workflows/ci.yml");
    expect(result.check.status).toBe("failed");
  });

  it("does not let the generated exemption launder a prohibited path", () => {
    const laundering: Scope = { ...scope, generated_paths: [".github/**", "pnpm-lock.yaml"] };
    const result = assessScope(
      changeSetFromDiff({ diff: diffFor([".github/workflows/ci.yml"]), base_commit: "a1b2c3d" }),
      laundering,
    );
    expect(result.findings.some((finding) => finding.blocking)).toBe(true);
  });

  it("exempts generated paths from scope accounting", () => {
    const result = assess(["packages/search/src/query.ts", "pnpm-lock.yaml"]);
    expect(result.findings).toEqual([]);
    expect(result.deviation.files_exempt_as_generated).toEqual(["pnpm-lock.yaml"]);
  });

  it("makes in-package expansion within the budget advisory, not a gate", () => {
    const result = assess(["packages/search/src/query.ts", "packages/search/docs/notes.md"]);
    // docs/notes.md is inside the declared package but not inside the declared
    // paths, and packages/search/** matches it — so this is genuinely in scope.
    expect(result.findings.every((finding) => !finding.blocking)).toBe(true);
  });

  it("blocks a different package outright, whatever the budget", () => {
    const result = assess(["packages/search/src/query.ts", "packages/billing/src/charge.ts"]);
    const blocking = result.findings.filter((finding) => finding.blocking);
    expect(blocking.map((finding) => finding.rule_id)).toContain("scope.escape");
  });

  it("blocks in-package expansion beyond the budget", () => {
    const narrow: Scope = { ...scope, paths_allowed: ["packages/search/src/**"] };
    const changeset = changeSetFromDiff({
      diff: diffFor([
        "packages/search/src/query.ts",
        "packages/search/a.ts",
        "packages/search/b.ts",
        "packages/search/c.ts",
      ]),
      base_commit: "a1b2c3d",
    });
    const result = assessScope(changeset, narrow);
    expect(result.findings.some((finding) => finding.rule_id === "scope.expansion_budget_exceeded")).toBe(
      true,
    );
    expect(result.deviation.within_expansion_budget).toBe(false);
  });

  it("keeps a stable key for the same escape across runs", () => {
    const first = assess(["packages/search/src/query.ts", ".github/workflows/ci.yml"]);
    const second = assess([".github/workflows/ci.yml", "packages/search/src/query.ts"]);
    expect(first.findings.map((finding) => finding.key).sort()).toEqual(
      second.findings.map((finding) => finding.key).sort(),
    );
  });
});

describe("generated_sources — a generated path may declare what generates it (D-062)", () => {
  const declared: Scope = {
    ...scope,
    generated_sources: {
      "**/*.generated.ts": ["packages/search/openapi.yaml", "packages/search/codegen.config.*"],
      "pnpm-lock.yaml": ["**/package.json", "pnpm-workspace.yaml"],
    },
  };
  const assessDeclared = (paths: string[]) =>
    assessScope(changeSetFromDiff({ diff: diffFor(paths), base_commit: "a1b2c3d" }), declared);

  it("blocks a generated file changed with no declared source in the diff", () => {
    // scp-006's shape: a hand edit to generated output beside legitimate work.
    const result = assessDeclared([
      "packages/search/src/api.generated.ts",
      "packages/search/src/session.ts",
    ]);
    const finding = result.findings.find((f) => f.rule_id === "scope.generated_without_source");
    expect(finding).toBeDefined();
    expect(finding!.blocking).toBe(true);
    expect(finding!.file).toBe("packages/search/src/api.generated.ts");
    expect(result.check.status).toBe("failed");
  });

  it("stays silent when a declared source changed in the same diff", () => {
    const result = assessDeclared([
      "packages/search/src/api.generated.ts",
      "packages/search/openapi.yaml",
    ]);
    expect(result.findings.filter((f) => f.rule_id === "scope.generated_without_source")).toEqual([]);
    expect(result.deviation.files_exempt_as_generated).toContain(
      "packages/search/src/api.generated.ts",
    );
  });

  it("leaves undeclared generated paths exactly as before — exempt and silent", () => {
    const result = assessDeclared(["pnpm-lock.yaml", "packages/search/package.json"]);
    expect(result.findings.filter((f) => f.rule_id.startsWith("scope.generated"))).toEqual([]);
  });

  it("a contract with no generated_sources behaves as today on every input", () => {
    const result = assess(["packages/search/src/api.generated.ts"]);
    expect(result.findings).toEqual([]);
    expect(result.deviation.files_exempt_as_generated).toEqual([
      "packages/search/src/api.generated.ts",
    ]);
  });

  it("prohibited still wins over generated, declared or not", () => {
    const hostile: Scope = {
      ...declared,
      paths_prohibited: ["**/*.generated.ts"],
    };
    const result = assessScope(
      changeSetFromDiff({ diff: diffFor(["packages/search/src/api.generated.ts"]), base_commit: "a1b2c3d" }),
      hostile,
    );
    expect(result.findings.some((f) => f.rule_id === "scope.prohibited_path")).toBe(true);
    expect(result.findings.some((f) => f.rule_id === "scope.generated_without_source")).toBe(false);
  });
});

/**
 * SCP-195: this rule is now the **second** reading, not the first.
 *
 * The runner's write guard refuses a write outside the contract's admitted
 * globs before it happens, and the seal stops an attempt whose change set still
 * carries one as a runner defect. The rule here stays, because a write the
 * guard cannot see — a compiled program, a script file, anything it could not
 * resolve — still reaches the diff, and a boundary with one reading behind it
 * is a boundary that fails silently.
 *
 * What must hold between the two is that they do not contradict each other: a
 * change set built only from paths the guard admits never trips the blocking
 * scope rules. The change set here is built through the guard's own reading —
 * `admittedWriteGlobs` is the function the runner resolves a destination
 * against, and `insideAllowedPaths` is how it asks — so the two cannot drift
 * apart without this failing.
 */
describe("the review's scope rule never fires on a change the guard admitted", () => {
  const candidates = [
    "packages/search/src/query.ts",
    "packages/search/test/query.test.ts",
    "packages/search/docs/notes.md",
    "pnpm-lock.yaml",
    "packages/search/src/api.generated.ts",
    // The ones the guard refuses before they exist.
    "package.json",
    "packages/billing/src/charge.ts",
    ".github/workflows/ci.yml",
    "infra/main.tf",
  ];

  const globs = admittedWriteGlobs(scope);
  const admitted = candidates.filter((path) => insideAllowedPaths(path, globs));
  const refused = candidates.filter((path) => !insideAllowedPaths(path, globs));

  it("admits the in-scope paths and refuses the ones the rule blocks on", () => {
    expect(admitted).toContain("packages/search/src/query.ts");
    // In-package expansion is what the contract budgets for, so the guard has
    // to let it through: refusing it would make expansion_budget_files dead.
    expect(admitted).toContain("packages/search/docs/notes.md");
    expect(admitted).toContain("pnpm-lock.yaml");
    expect(refused).toEqual(["package.json", "packages/billing/src/charge.ts", ".github/workflows/ci.yml", "infra/main.tf"]);
  });

  it("produces no blocking scope finding on a change set of admitted paths only", () => {
    const result = assess(admitted);
    expect(result.findings.filter((finding) => finding.blocking)).toEqual([]);
    expect(result.findings.map((finding) => finding.rule_id)).not.toContain("scope.escape");
    expect(result.check.status).toBe("passed");
    expect(result.deviation.within_expansion_budget).toBe(true);
  });

  it("still blocks each path the guard refused, one at a time", () => {
    for (const path of refused) {
      const result = assess(["packages/search/src/query.ts", path]);
      expect(result.findings.some((finding) => finding.blocking), path).toBe(true);
    }
  });
});
