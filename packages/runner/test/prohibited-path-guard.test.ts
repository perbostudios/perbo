import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TicketRunConfigSchema } from "../src/loop.js";
import { LimitsTableSchema, changeSetFromDiff, type Scope } from "@perbo/contracts";
import { assessScope } from "@perbo/review";
import { ADMISSION_RULES, judgeCommand } from "../src/admission.js";
import { runAgent } from "../src/adapter.js";
import { codexCommandDecision, codexFileDecision } from "../src/adapter-codex.js";
import { AttemptCeilings } from "../src/ceilings.js";
import {
  discardPreToolGuard,
  judgePreToolCall,
  preparePreToolGuard,
  readPreToolDecisions,
  runPreToolHook,
  type PreToolGuardState,
} from "../src/pretool.js";
import { buildPermissionProfile } from "../src/profile.js";
import { inspectCommand, inspectToolWrite, inspectWritePath, resolveScope } from "../src/prohibited.js";
import { fakeAgent, scratch } from "./support.js";

/**
 * D-105: a path the contract prohibits is refused at write time, not at review.
 *
 * `paths_prohibited` sits **inside** `paths_allowed` here, which is the case the
 * allowed-globs rule cannot reach: `src/generated/**` is admitted by `src/**`,
 * so every destination below passes the SCP-195 check and is refused only
 * because the contract named it. The match is `matchesAny` against
 * `paths_prohibited`, which is the reviewer's own — `packages/review/src/scope.ts`
 * — so the guard and the backstop cannot decide the same path differently.
 */

const root = realpathSync(resolve(scratch("perbo-d105-")));
mkdirSync(join(root, "src", "generated"), { recursive: true });
mkdirSync(join(root, "infra"), { recursive: true });
writeFileSync(join(root, "src", "generated", "api.ts"), "export const a = 1;\n");
const tmp = join(root, ".perbo-tmp");
mkdirSync(tmp, { recursive: true });
const profile = buildPermissionProfile({ worktree: root });

const ALLOWED = ["src/**"];
const PROHIBITED = ["src/generated/**", "**/*.pem"];

const stateAt = (cwd: string = root): PreToolGuardState => ({
  root,
  tmpdir: tmp,
  cwd,
  paths_allowed: [...ALLOWED],
  paths_prohibited: [...PROHIBITED],
  allow_list: [...profile.command_allow_list],
  deny_list: [...profile.command_deny_list],
});

const at = new Date("2026-09-12T00:00:00.000Z");

const judgeBash = (command: string, state: PreToolGuardState = stateAt()) =>
  judgePreToolCall(
    { tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command } },
    state,
    at,
  ).decision;

const judgeFile = (tool: string, file_path: string, state: PreToolGuardState = stateAt()) =>
  judgePreToolCall(
    { tool_name: tool, tool_use_id: "toolu_2", tool_input: { file_path } },
    state,
    at,
  ).decision;

describe("the Claude transport refuses a prohibited path inside the allowed ones", () => {
  it("refuses a file tool's destination, naming the path and the rule", () => {
    const decision = judgeFile("Write", "src/generated/api.ts");
    expect(decision.answer).toBe("deny");
    expect(decision.decision).toBe("denied");
    expect(decision.rule).toBe(ADMISSION_RULES.prohibited_path);
    expect(decision.target).toBe("src/generated/api.ts");
    expect(decision.reason).toContain("src/generated/**");
    // The absolute spelling of the same file is the same write.
    expect(judgeFile("Edit", join(root, "src", "generated", "api.ts")).rule).toBe(
      ADMISSION_RULES.prohibited_path,
    );
  });

  it("refuses a shell redirect and a writer verb's target the same way", () => {
    for (const command of [
      "echo x > src/generated/api.ts",
      "cp src/a.ts src/generated/api.ts",
      "rm src/generated/api.ts",
      "cd src && printf x > generated/api.ts",
      "sed -i '' s/a/b/ src/generated/api.ts",
    ]) {
      const decision = judgeBash(command);
      expect(decision.answer, command).toBe("deny");
      expect(decision.rule, command).toBe(ADMISSION_RULES.prohibited_path);
    }
  });

  it("matches a path the way the reviewer does, so `src/generated` is not `src/generated/**`", () => {
    // The glob is the contract's own, read with `matchesAny` — the reviewer's
    // match, over a change set that lists files and never directories. So the
    // directory word itself is not a match here either, and `rm -r` on it
    // reaches the seal as the deletion of every file under it, where the
    // reviewer's `scope.prohibited_path` blocks it. Two matches, one rule.
    expect(judgeBash("rm -r src/generated").answer).toBe("allow");
  });

  it("admits the rest of the allowed paths, so the rule is the contract's and not the glob's", () => {
    expect(judgeBash("echo x > src/feature.ts").answer).toBe("allow");
    expect(judgeFile("Write", "src/feature.ts").answer).toBe("defer");
    expect(judgeFile("Write", "src/feature.ts").decision).toBe("allowed");
  });

  it("leaves a read of a prohibited path alone: the rule is about writes", () => {
    expect(judgeFile("Read", "src/generated/api.ts").rule).toBeNull();
    expect(judgeBash("cat src/generated/api.ts").decision).toBe("allowed");
  });

  it("refuses a path that is both prohibited and outside the globs as prohibited", () => {
    // `infra/secrets.pem` is outside `src/**` and matches `**/*.pem`. Judged in
    // the other order it would come back `write_outside_scope`, and the reader
    // would be told to widen the contract to reach a path the contract forbids.
    const decision = judgeFile("Write", "infra/secrets.pem");
    expect(decision.rule).toBe(ADMISSION_RULES.prohibited_path);
  });

  it("still refuses a write outside the worktree under the worktree rule", () => {
    expect(judgeBash("printf x > /tmp/x").rule).toBe(ADMISSION_RULES.write);
  });

  it("carries no new refusal where the contract prohibits nothing", () => {
    const nothing: PreToolGuardState = { ...stateAt(), paths_prohibited: [] };
    expect(judgeFile("Write", "src/generated/api.ts", nothing).decision).toBe("allowed");
    expect(judgeBash("echo x > src/generated/api.ts", nothing).answer).toBe("allow");
  });
});

describe("the resolver's prohibited destination", () => {
  const scope = resolveScope({
    root,
    tmpdir: tmp,
    paths_allowed: ALLOWED,
    paths_prohibited: PROHIBITED,
  });

  it("names the rule on a sealed path and on a tool input", () => {
    const finding = inspectWritePath("src/generated/api.ts", scope);
    expect(finding?.rule).toBe("write_prohibited_path");
    expect(finding?.target).toBe("src/generated/api.ts");
    expect(finding?.detail).toContain("src/generated/**");

    const hits = inspectToolWrite(
      "Write",
      { file_path: "src/generated/api.ts" },
      { root, tmpdir: tmp, paths_allowed: ALLOWED, paths_prohibited: PROHIBITED },
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.action).toBe("write_prohibited_path");
  });

  it("reports it as a prohibited action on a command line", () => {
    const hits = inspectCommand("echo x > src/generated/api.ts", {
      root,
      tmpdir: tmp,
      paths_allowed: ALLOWED,
      paths_prohibited: PROHIBITED,
    });
    expect(hits.map((hit) => hit.action)).toContain("write_prohibited_path");
  });

  it("never judges the scratch directory, which no contract names", () => {
    expect(inspectWritePath(join(tmp, "generated", "api.ts"), scope)).toBeNull();
  });

  it("agrees with the transcript reading, which is handed the same globs", () => {
    const command = "echo x > src/generated/api.ts";
    const hook = judgeBash(command);
    const transcript = judgeCommand({
      tool: "Bash",
      detail: command,
      allow_list: profile.command_allow_list,
      deny_list: profile.command_deny_list,
      scope: {
        root,
        tmpdir: tmp,
        cwd: root,
        paths_allowed: ALLOWED,
        paths_prohibited: PROHIBITED,
      },
    }).admission;
    expect(transcript.rule).toBe(hook.rule);
    expect(transcript.target).toBe(hook.target);
    expect(transcript.reason).toBe(hook.reason);
  });
});

describe("the Codex transport's approval path", () => {
  const guard = (): PreToolGuardState => ({ ...stateAt(), tmpdir: null });

  it("refuses a prohibited file write and a prohibited command target", () => {
    expect(codexFileDecision("src/generated/api.ts", guard())).toMatchObject({
      decision: "denied",
      rule: "write_prohibited_path",
    });
    expect(codexCommandDecision("echo x > src/generated/api.ts", root, guard())).toMatchObject({
      decision: "denied",
      rule: "write_prohibited_path",
    });
  });

  it("still admits a write elsewhere inside the allowed paths", () => {
    expect(codexFileDecision("src/feature.ts", guard()).decision).toBe("allowed");
  });
});

describe("the rule on the record", () => {
  it("reaches the guard's state file and the decision the hook writes", () => {
    const installed = preparePreToolGuard({
      worktree: root,
      tmpdir: tmp,
      profile,
      paths_allowed: ALLOWED,
      paths_prohibited: PROHIBITED,
    });
    try {
      const answer = runPreToolHook(
        installed.directory,
        JSON.stringify({
          tool_name: "Write",
          tool_use_id: "toolu_record",
          tool_input: { file_path: "src/generated/api.ts" },
        }),
        at,
      );
      expect(answer?.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(answer?.hookSpecificOutput.permissionDecisionReason).toContain("src/generated/**");
      const [recorded] = readPreToolDecisions(installed.decisionsPath);
      expect(recorded?.rule).toBe(ADMISSION_RULES.prohibited_path);
      expect(recorded?.target).toBe("src/generated/api.ts");
    } finally {
      discardPreToolGuard(installed);
    }
  });

  it("refuses the write end to end, so the bytes never exist", async () => {
    const worktree = scratch("perbo-d105-agent-");
    mkdirSync(join(worktree, "src", "generated"), { recursive: true });
    const target = join(worktree, "src", "generated", "api.ts");
    const agent = fakeAgent([
      {
        kind: "guarded",
        calls: [{ tool: "Write", input: { file_path: target, content: "written" } }],
      },
    ]);
    const result = await runAgent({
      binary: agent.binary,
      worktree,
      prompt: "do the thing",
      model: "none",
      profile: buildPermissionProfile({ worktree }),
      ceilings: new AttemptCeilings(LimitsTableSchema.parse({ organisation: "test" })),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      paths_allowed: ALLOWED,
      paths_prohibited: PROHIBITED,
    });

    expect(existsSync(target)).toBe(false);
    expect(result.commands[0]?.decision).toBe("denied");
    expect(result.commands[0]?.denial_rule).toBe(ADMISSION_RULES.prohibited_path);
    expect(result.commands[0]?.decided_by).toBe("pre_execution_hook");
  }, 60_000);
});

/**
 * The backstop (D-105). The guard refuses the write, and the reviewer's
 * deterministic finding is unchanged behind it — for the write no command
 * named, and for any attempt the guard did not police.
 */
describe("the reviewer's finding, unchanged behind the guard", () => {
  const scope: Scope = {
    repository_id: "repo_fixture",
    paths_allowed: ALLOWED,
    paths_prohibited: PROHIBITED,
    generated_paths: [],
    expansion_budget_files: 2,
  };
  const path = "src/generated/api.ts";

  it("blocks the same path the guard refuses, with scope.prohibited_path", () => {
    // Refused at write time...
    expect(judgeFile("Write", path).rule).toBe(ADMISSION_RULES.prohibited_path);

    // ...and still blocking where it reached the seal anyway.
    const diff = `diff --git a/${path} b/${path}
index 1111111..2222222 100644
--- a/${path}
+++ b/${path}
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
`;
    const result = assessScope(changeSetFromDiff({ diff, base_commit: "a1b2c3d" }), scope);
    const blocking = result.findings.filter((finding) => finding.blocking);
    expect(blocking).toHaveLength(1);
    expect(blocking[0]?.rule_id).toBe("scope.prohibited_path");
    expect(blocking[0]?.file).toBe(path);
    expect(result.check.status).toBe("failed");
    expect(result.deviation.files_in_prohibited_paths).toEqual([path]);
  });
});

/** The run configuration with nothing but what the schema requires. */
const minimalRunConfig = () => ({
  ticket_key: "PRB-1",
  repository_root: "/repo",
  worktree_root: "/worktree",
  bundle_root: "/bundles",
  quarantine_root: "/quarantine",
  state_root: "/state",
});

/**
 * D-103: the spec folder is prohibited whether or not the contract names it.
 *
 * A spec is the intent the contract was drafted from, so an attempt that edited
 * one would be rewriting the statement it is judged against. `perbo admit`
 * writes it onto every contract it creates, and this is the list behind that:
 * it holds for a ticket admitted before the folder existed, for a run with no
 * ticket, and for a contract whose `paths_allowed` reaches `specs/**` directly.
 */
describe("the spec folder, off limits whatever the contract says", () => {
  /** A contract that prohibits nothing and admits the spec folder by name. */
  const wide = (spec_folder?: string): PreToolGuardState => ({
    ...stateAt(),
    paths_allowed: ["**"],
    paths_prohibited: [],
    ...(spec_folder === undefined ? {} : { spec_folder }),
  });

  it("refuses a file tool's destination under specs/ on the Claude transport", () => {
    const decision = judgeFile("Write", "specs/light-mode/spec.md", wide());
    expect(decision.answer).toBe("deny");
    expect(decision.rule).toBe(ADMISSION_RULES.prohibited_path);
    expect(decision.reason).toContain("specs/**");
    expect(judgeFile("Edit", "specs/light-mode/nodes/node_1.md", wide()).rule).toBe(
      ADMISSION_RULES.prohibited_path,
    );
  });

  it("refuses a command that writes there, redirect or writer verb", () => {
    for (const command of [
      "echo x > specs/light-mode/spec.md",
      "rm specs/light-mode/spec.md",
      "sed -i '' s/a/b/ specs/light-mode/nodes/node_1.md",
    ]) {
      expect(judgeBash(command, wide()).rule, command).toBe(ADMISSION_RULES.prohibited_path);
    }
  });

  it("refuses it on the Codex transport too", () => {
    expect(codexFileDecision("specs/light-mode/spec.md", wide())).toMatchObject({
      decision: "denied",
      rule: "write_prohibited_path",
    });
    expect(
      codexCommandDecision("echo x > specs/light-mode/spec.md", root, wide()),
    ).toMatchObject({ decision: "denied", rule: "write_prohibited_path" });
  });

  it("refuses the folder this repository configured, beside the default", () => {
    const configured = wide("docs/specs");
    expect(judgeFile("Write", "docs/specs/light-mode/spec.md", configured).rule).toBe(
      ADMISSION_RULES.prohibited_path,
    );
    // The default is still refused: a stale worktree may still have one there.
    expect(judgeFile("Write", "specs/light-mode/spec.md", configured).rule).toBe(
      ADMISSION_RULES.prohibited_path,
    );
    // And a repository that configured nothing does not refuse docs/specs.
    expect(judgeFile("Write", "docs/specs/light-mode/spec.md", wide()).decision).toBe("allowed");
  });

  it("is named by a repository-relative folder in the run configuration, and by nothing else", () => {
    const base = TicketRunConfigSchema.parse(minimalRunConfig());
    expect(base.specs).toBe("specs");
    expect(TicketRunConfigSchema.parse({ ...minimalRunConfig(), specs: "docs/specs" }).specs).toBe("docs/specs");
    for (const bad of ["/specs", "../specs", "docs/../specs", "docs\\specs"]) {
      expect(() => TicketRunConfigSchema.parse({ ...minimalRunConfig(), specs: bad })).toThrow(
        /repository-relative folder/,
      );
    }
  });

  it("leaves a read of a spec alone, and everything that is not under the folder", () => {
    expect(judgeFile("Read", "specs/light-mode/spec.md", wide()).rule).toBeNull();
    expect(judgeBash("cat specs/light-mode/spec.md", wide()).decision).toBe("allowed");
    expect(judgeFile("Write", "specs.ts", wide()).decision).toBe("allowed");
    expect(judgeFile("Write", "src/specs/helper.ts", wide()).decision).toBe("allowed");
  });

  it("names write_prohibited_path on the resolver, as the contract's own paths do", () => {
    const scope = resolveScope({ root, tmpdir: tmp, paths_allowed: ["**"], paths_prohibited: [] });
    const finding = inspectWritePath("specs/light-mode/spec.md", scope);
    expect(finding?.rule).toBe("write_prohibited_path");
    expect(finding?.detail).toContain("specs/**");
    expect(
      inspectCommand("echo x > specs/light-mode/spec.md", { root, tmpdir: tmp }).map(
        (hit) => hit.action,
      ),
    ).toContain("write_prohibited_path");
  });
});
