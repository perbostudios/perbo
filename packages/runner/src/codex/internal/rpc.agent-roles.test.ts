import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PERBO_AGENT_ROLE_NAMES } from "../../agents.js";
import { writeAgentRoleFiles } from "./rpc.js";

/**
 * AC2: Perbo's role definitions replace the built-in roles in the runner's
 * isolated CODEX_HOME. `$CODEX_HOME/agents/<name>.toml`, one file per role
 * with `name`, `description` and `developer_instructions`, is the discovery
 * directory 0.145.0 actually reads (scp327-research/notes/design.md); the
 * second half of this file checks that against the real binary, because a
 * malformed TOML string is a runtime fact the type system cannot catch.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "perbo-codex-roles-"));
  roots.push(dir);
  return dir;
}

describe("Perbo's roles as files under CODEX_HOME/agents", () => {
  it("writes one file per role, named for it", () => {
    const dir = home();
    writeAgentRoleFiles(dir);
    expect(readdirSync(join(dir, "agents")).sort()).toEqual(
      [...PERBO_AGENT_ROLE_NAMES].map((name) => `${name}.toml`).sort(),
    );
  });

  it("carries name, description and developer_instructions as TOML strings", () => {
    const dir = home();
    writeAgentRoleFiles(dir, { "perbo-implementer": { description: "d", prompt: "p" } });
    const text = readFileSync(join(dir, "agents", "perbo-implementer.toml"), "utf8");
    expect(text).toContain('name = "perbo-implementer"');
    expect(text).toContain('description = "d"');
    expect(text).toContain('developer_instructions = "p"');
  });

  it("escapes backslashes, quotes and control characters so the string stays one TOML value", () => {
    const dir = home();
    writeAgentRoleFiles(dir, {
      torture: {
        description: 'a "quoted" word and a back\\slash',
        prompt: "line one\nline two\r\nwith a\ttab, a NUL \u0000, a backspace \b and DEL \u007f",
      },
    });
    const text = readFileSync(join(dir, "agents", "torture.toml"), "utf8");
    expect(text).toContain('description = "a \\"quoted\\" word and a back\\\\slash"');
    // A basic string may hold no control character unescaped: the ones TOML
    // spells escape by letter, every other by its code point.
    expect(text).toContain(
      'developer_instructions = "line one\\nline two\\r\\nwith a\\ttab, a NUL \\u0000, a backspace \\b and DEL \\u007F"',
    );
    // One line per field: an unescaped newline would have split the value in two.
    expect(text.split("\n")).toHaveLength(4); // name, description, developer_instructions, trailing
  });
});

const CODEX_BINARY = process.env.PERBO_CODEX_BINARY ?? "codex";
const CODEX_PRESENT = spawnSync(CODEX_BINARY, ["--version"], { stdio: "ignore" }).status === 0;
const describeIfCodex = CODEX_PRESENT ? describe : describe.skip;

if (!CODEX_PRESENT) {
  // eslint-disable-next-line no-console -- the reason a skipped gate was skipped
  console.log(
    "[codex-agent-roles] skipped: `codex` was not found on PATH. This probe spends nothing and " +
      "needs no login (an isolated CODEX_HOME with no auth.json, never a live turn) — set " +
      "PERBO_CODEX_BINARY or install Codex to run it.",
  );
}

/**
 * `codex --strict-config app-server --stdio` against a home with no
 * `auth.json`, stdin closed at once: the producer's own check for a role file
 * it will not load, with no model reached and no login used
 * (scp327-research/notes/design.md).
 */
function strictConfigProbe(dir: string): { status: number | null; stderr: string } {
  const result = spawnSync(
    CODEX_BINARY,
    ["--strict-config", "-c", "agents.enabled=true", "app-server", "--stdio"],
    { env: { ...process.env, CODEX_HOME: dir }, input: "", encoding: "utf8", timeout: 10_000 },
  );
  return { status: result.status, stderr: result.stderr };
}

describeIfCodex("against the shipped binary, with no login (AC2)", () => {
  it("loads Perbo's roles with no 'Ignoring malformed agent role' warning", () => {
    const dir = home();
    writeAgentRoleFiles(dir);
    const probe = strictConfigProbe(dir);
    expect(probe.status).toBe(0);
    expect(probe.stderr).not.toContain("Ignoring malformed agent role");
  });

  it("still warns on a role missing its description, so the check above can fail", () => {
    const dir = home();
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "agents", "bad-role.toml"), 'name = "bad-role"\ndeveloper_instructions = "hi"\n');
    const probe = strictConfigProbe(dir);
    expect(probe.stderr).toContain("Ignoring malformed agent role definition: agent role `bad-role` must define a description");
  });
});
