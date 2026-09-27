import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DiagnosticResultSchema, EXIT_CODES } from "@perbo/contracts";
import type { PreflightResult } from "@perbo/runner";
import { exitForThrown, runCommandLine } from "../../command-line/terminal.js";
import { type ExecuteDeps, doctorCommandLine, executeCommandLine } from "./index.js";
import { storeDir } from "../../store/index.js";
import { recordStreams } from "../../test-support/streams.js";
import { initRepository } from "@perbo/test-support";

/**
 * `network_allow_list` in `.perbo/config.json`: the hosts a repository adds to
 * the executor's egress allow-list.
 *
 * Driven through the shipped command. The executor is a hook that keeps the
 * profile it was handed and stops there, so what these read is the list the
 * configuration merge, the schema and provisioning really built.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-egress-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const EXTRA = "googlechromelabs.github.io";

function repository(name: string, config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  initRepository(dir, {
    files: {
      "package.json": `${JSON.stringify({ name: "fixture", scripts: { test: "node --test" } }, null, 2)}\n`,
      "src/index.ts": "export const version = 1;\n",
    },
  });
  const store = storeDir(dir, null);
  mkdirSync(store, { recursive: true });
  writeFileSync(
    join(store, "config.json"),
    `${JSON.stringify(
      {
        agent_binary: "true",
        model: "double",
        checks: [],
        limits: { organisation: "test", limits: { concurrent_local_attempts: 4 } },
        materialization_manifest: {
          manifest_version: 1,
          repository_id: `repo_${name}`,
          source_checkout: dir,
          entries: [],
          install: {
            kind: "none",
            package_manager: "none",
            offline_preferred: true,
            lifecycle_scripts: { policy: "disabled", exception: null },
            command: ["true"],
            pinned: true,
          },
          verify: { command: ["node", "-e", "process.exit(0)"], timeout_ms: 30_000 },
          isolation: {
            mode: "parallel",
            port_range_size: 0,
            port_range_start: 41_000,
            port_range_end: 41_009,
            database_schema_prefix: null,
          },
        },
        ...config,
      },
      null,
      2,
    )}\n`,
  );
  return dir;
}

const worktreeRoot = (name: string): string => join(scratch, `${name}-worktrees`);

/** The one key the repository's file may not set: the derived root is under `$HOME`. */
function worktreeOverride(name: string): string {
  const path = join(scratch, `${name}.config.json`);
  writeFileSync(path, JSON.stringify({ worktree_root: worktreeRoot(name) }));
  return path;
}

const machineReady: PreflightResult = { ok: true, findings: [], tools: {}, github: null };

/** An executor that keeps the allow-list it was given and ends the attempt there. */
function capturingAgent(): { seen: string[][]; hooks: ExecuteDeps["hooks"] } {
  const seen: string[][] = [];
  const hooks = {
    agent: (request: { profile: { network_allow_list: readonly string[] } }) => {
      seen.push([...request.profile.network_allow_list]);
      throw new Error("captured the profile");
    },
  } as never;
  return { seen, hooks };
}

async function run(name: string, config: Record<string, unknown>, hooks: ExecuteDeps["hooks"]) {
  const repo = repository(name, config);
  const streams = recordStreams();
  try {
    const code = await runCommandLine(executeCommandLine, {
      argv: [
        "--repo", repo,
        "--outcome", "The feature module exports a computed total",
        "--path", "src/**",
        "--config", worktreeOverride(name),
      ],
      streams,
      cwd: repo,
      deps: { preflight: () => machineReady, hooks },
    });
    return { code, err: streams.err() };
  } catch (error) {
    const failure = exitForThrown("run", error);
    streams.stderr(`error: ${failure.message}\n`);
    return { code: failure.code, err: streams.err() };
  }
}

async function doctor(config: Record<string, unknown>, json: boolean): Promise<string> {
  const repo = repository("doctor", config);
  const sinks = recordStreams({ isTTY: !json });
  await runCommandLine(doctorCommandLine, {
    argv: ["--repo", repo, ...(json ? ["--json"] : [])],
    streams: sinks,
    cwd: process.cwd(),
    deps: {
      preflight: () => machineReady,
      diagnose: () => Promise.resolve(DiagnosticResultSchema.parse({ materializable: true, findings: [], proposed: null })),
    },
  });
  return sinks.out();
}

describe("perbo run with a network_allow_list", () => {
  it("hands the executor the defaults and the configured host, and says so on startup", async () => {
    const agent = capturingAgent();
    const result = await run("extended", { network_allow_list: [EXTRA, "mirror.example.org"] }, agent.hooks);

    expect(agent.seen).toHaveLength(1);
    const allowed = agent.seen[0]!;
    expect(allowed).toContain("api.anthropic.com");
    expect(allowed).toContain("registry.npmjs.org");
    expect(allowed).toContain(EXTRA);
    expect(allowed).toContain("mirror.example.org");
    expect(result.err).toContain(`  egress    also allowed ${EXTRA}, mirror.example.org\n`);
  }, 120_000);

  it("prints no egress line where the repository adds nothing", async () => {
    const agent = capturingAgent();
    const result = await run("plain", {}, agent.hooks);

    expect(agent.seen).toHaveLength(1);
    expect(agent.seen[0]).not.toContain(EXTRA);
    expect(result.err).toContain("  ceilings  ");
    expect(result.err).not.toContain("  egress    ");
  }, 120_000);

  it("refuses a malformed entry by name before anything is provisioned", async () => {
    const agent = capturingAgent();
    const result = await run("malformed", { network_allow_list: [EXTRA, "https://evil.example.org"] }, agent.hooks);

    expect(result.code).toBe(EXIT_CODES.usage_or_input_error);
    expect(result.err).toContain("config.json is not a valid run configuration");
    expect(result.err).toContain('network_allow_list.1: "https://evil.example.org" is not a host name');
    expect(agent.seen).toEqual([]);
    const worktrees = worktreeRoot("malformed");
    expect(existsSync(worktrees) ? readdirSync(worktrees) : []).toEqual([]);
  }, 120_000);
});

describe("perbo doctor reports the egress allow-list", () => {
  it("names the hosts a repository adds", async () => {
    const out = await doctor({ network_allow_list: [EXTRA] }, false);
    expect(out).toMatch(new RegExp(`^EGRESS {4}also allowed ${EXTRA.replaceAll(".", "\\.")} {2}\\(network_allow_list in .*config\\.json\\)$`, "m"));
  });

  it("says the defaults stand alone where it adds none", async () => {
    const out = await doctor({}, false);
    expect(out).toMatch(/^EGRESS {4}the defaults only: the model provider, GitHub and the package registries$/m);
  });

  it("names a malformed entry as the run would refuse it", async () => {
    const out = await doctor({ network_allow_list: ["*.github.io"] }, false);
    expect(out).toMatch(/^EGRESS {4}network_allow_list\.0: "\*\.github\.io" is not a host name/m);
    expect(out).toContain("a run here is refused until it is fixed");
  });

  it("carries the hosts under egress for a script", async () => {
    const parsed = JSON.parse(await doctor({ network_allow_list: [EXTRA] }, true)) as {
      egress: { also_allowed: string[]; invalid: string | null };
    };
    expect(parsed.egress).toEqual({ also_allowed: [EXTRA], invalid: null });
  });
});
