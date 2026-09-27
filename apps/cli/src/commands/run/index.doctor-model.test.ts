import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiagnosticResultSchema, type DiagnosticResult } from "@perbo/contracts";
import type { PreflightResult } from "@perbo/runner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doctorCommandLine } from "./index.js";
import { runCommandLine } from "../../command-line/terminal.js";
import { recordStreams } from "../../test-support/streams.js";
import { unaskedPullRequestChecks } from "../../pull-request.js";

/**
 * The model a proposed `.perbo/config.json` names (D-093): Claude Opus 5.5
 * where the agent binary's catalog offers it, and the run's own default where
 * the catalog does not or cannot say. The catalog is asked, never assumed, and
 * asked only where the proposal is on Claude Code and names no model already.
 */

const machineReady: PreflightResult = {
  ok: true,
  findings: [],
  tools: { node: { present: true, version: process.versions.node } },
  github: null,
};
const materializable: DiagnosticResult = DiagnosticResultSchema.parse({
  materializable: true,
  findings: [],
  proposed: null,
});

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repository(config: Record<string, unknown> | null): string {
  const dir = mkdtempSync(join(tmpdir(), "perbo-doctor-model-"));
  temporary.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  if (config !== null) {
    mkdirSync(join(dir, ".perbo"), { recursive: true });
    writeFileSync(join(dir, ".perbo", "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  }
  return dir;
}

interface Report {
  config: { proposed: Record<string, unknown> | null };
  provider: { transport: string; model: string };
}

/** `doctor --json` on `repo`, reading Claude Code's catalog through `claudeModels` where one is given. */
async function report(
  repo: string,
  claudeModels: ((binary: string) => Promise<readonly string[]>) | null,
  extra: string[] = [],
): Promise<Report> {
  const sinks = recordStreams({ isTTY: false });
  await runCommandLine(doctorCommandLine, {
    argv: ["--repo", repo, "--json", ...extra],
    streams: sinks,
    cwd: process.cwd(),
    deps: {
      preflight: () => machineReady,
      diagnose: () => Promise.resolve(materializable),
      baseRef: () => ({ base_ref: "main", from: "checkout" }),
      pullRequestChecks: () => Promise.resolve(unaskedPullRequestChecks("main", "not asked here")),
      ...(claudeModels === null ? {} : { claudeModels }),
    },
  });
  return JSON.parse(sinks.out()) as Report;
}

const doctor = async (
  repo: string,
  claudeModels: (binary: string) => Promise<readonly string[]>,
  extra: string[] = [],
): Promise<Report["config"]> => (await report(repo, claudeModels, extra)).config;

describe("the model a proposed configuration names", () => {
  it("is Claude Opus 5.5 for the executor where Claude Code's catalog offers it, the reviewer pinned to its own default, and --write-config writes both", async () => {
    const repo = repository(null);
    const catalog = vi.fn(() => Promise.resolve(["claude-opus-5", "claude-opus-5-5", "claude-fable-5-1"]));
    const proposed = (await doctor(repo, catalog)).proposed;
    expect(proposed).toMatchObject({ model: "claude-opus-5-5", reviewer_model: "claude-opus-5" });
    // The file says why the two differ (D-010).
    expect((proposed?.["_comment"] as string[]).join(" ")).toContain(
      "`reviewer_model` keeps the reviewer on claude-opus-5, its default until a regression-suite",
    );
    expect(catalog).toHaveBeenCalledWith("claude");
    await doctor(repo, catalog, ["--write-config"]);
    expect(JSON.parse(readFileSync(join(repo, ".perbo", "config.json"), "utf8"))).toMatchObject({
      model: "claude-opus-5-5",
      reviewer_model: "claude-opus-5",
    });
  });

  it("is its 1M-context id where the catalog offers only that", async () => {
    const repo = repository(null);
    expect((await doctor(repo, () => Promise.resolve(["claude-opus-5-5[1m]"]))).proposed).toMatchObject({
      model: "claude-opus-5-5[1m]",
      reviewer_model: "claude-opus-5",
    });
  });

  it.each([
    ["does not offer it", () => Promise.resolve(["claude-opus-5", "claude-sonnet-5"])],
    ["cannot be read", () => Promise.reject(new Error("Claude Code did not report its models in time"))],
  ])("is the run's own default where the catalog %s, with no reviewer model of its own", async (_, catalog) => {
    const repo = repository(null);
    const proposed = (await doctor(repo, catalog)).proposed;
    expect(proposed?.["model"]).toBe("claude-opus-5");
    expect(proposed).not.toHaveProperty("reviewer_model");
    expect((proposed?.["_comment"] as string[]).join(" ")).not.toContain("reviewer_model");
  });

  it("is not asked where the explicit configuration names a model, or a configuration exists", async () => {
    const catalog = vi.fn(() => Promise.resolve(["claude-opus-5-5"]));
    const repo = repository(null);
    const override = join(repo, "selection.json");
    writeFileSync(override, JSON.stringify({ model: "claude-sonnet-5" }));
    expect((await doctor(repo, catalog, ["--config", override])).proposed?.["model"]).toBe("claude-sonnet-5");
    expect((await doctor(repository({ model: "claude-opus-5" }), catalog)).proposed).toBeNull();
    expect(catalog).not.toHaveBeenCalled();
  });

  it("leaves the reviewer a new repository is checked on at its own default", async () => {
    const repo = repository(null);
    const offered = await report(repo, () => Promise.resolve(["claude-opus-5", "claude-opus-5-5"]));
    expect(offered.config.proposed?.["model"]).toBe("claude-opus-5-5");
    expect(offered.provider).toMatchObject({ transport: "claude-cli", model: "claude-opus-5" });
    const absent = await report(repository(null), () => Promise.resolve(["claude-opus-5"]));
    expect(absent.provider).toMatchObject({ transport: "claude-cli", model: "claude-opus-5" });
  });

  it("is not asked of a proposal whose executor is not on Claude Code", async () => {
    const catalog = vi.fn(() => Promise.resolve(["claude-opus-5-5"]));
    const repo = repository(null);
    const override = join(repo, "selection.json");
    writeFileSync(override, JSON.stringify({ agent_provider: "codex-cli", agent_binary: "codex" }));
    const proposed = (await doctor(repo, catalog, ["--config", override])).proposed;
    expect(catalog).not.toHaveBeenCalled();
    expect(proposed?.["model"]).toBe("claude-opus-5");
  });
});

/**
 * No test launches the `claude` on PATH to read its catalog: a harness that
 * names no reader of its own gets the package's stub, and the proposal falls
 * to the run's own default.
 */
describe("a doctor harness that names no catalog reader", () => {
  it("launches no claude binary", async () => {
    const bin = mkdtempSync(join(tmpdir(), "perbo-doctor-model-bin-"));
    temporary.push(bin);
    const launched = join(bin, "launched");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(launched)}\n`);
    chmodSync(join(bin, "claude"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    try {
      const { config } = await report(repository(null), null);
      expect(config.proposed?.["model"]).toBe("claude-opus-5");
    } finally {
      process.env.PATH = path;
    }
    expect(existsSync(launched)).toBe(false);
  });
});

