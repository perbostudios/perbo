import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LimitsTableSchema } from "@perbo/contracts";
import { runAgent } from "../src/adapter.js";
import { AttemptCeilings } from "../src/ceilings.js";
import { EgressLog, extractHosts, hostAllowed } from "../src/egress.js";
import { buildAgentEnvironment, buildPermissionProfile } from "../src/profile.js";
import { commandSegments, inspectCommand, inspectPaths } from "../src/prohibited.js";
import {
  findAgentConfiguration,
  journalPath,
  quarantine,
  release,
  restoreAny,
} from "../src/quarantine.js";
import { SPAWN_TEST_TIMEOUT_MS } from "./support.js";

const scratch = () => mkdtempSync(join(tmpdir(), "perbo-runner-"));

describe("the agent environment", () => {
  it("drops every credential class, and keeps what the agent needs to authenticate as the user", () => {
    const worktree = scratch();
    const { env, passed, dropped } = buildAgentEnvironment({
      base: {
        PATH: "/usr/bin",
        HOME: "/home/u",
        GH_TOKEN: "ghp_secret",
        GITHUB_TOKEN: "ghp_other",
        AWS_ACCESS_KEY_ID: "AKIA",
        AWS_SECRET_ACCESS_KEY: "s3cret",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        NPM_TOKEN: "npm_x",
        PERBO_API_KEY: "ayo_x",
        DATABASE_URL: "postgres://production",
        ANTHROPIC_AUTH_TOKEN: "sk-ant-x",
      },
      profile: buildPermissionProfile({ worktree }),
      worktree,
      ports: { start: 41000, end: 41009 },
      database_schema: null,
    });

    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "SSH_AUTH_SOCK",
      "NPM_TOKEN",
      "PERBO_API_KEY",
      "DATABASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
    ]) {
      expect(env[name], name).toBeUndefined();
      expect(dropped).toContain(name);
    }
    // BYOK: the agent authenticates with the user's own credential, which lives
    // under HOME. Removing HOME would break the login, and that trade is why
    // the path jail and the tool allow-list carry the weight.
    expect(env.HOME).toBe("/home/u");
    expect(passed).toContain("PATH");
  });

  it("pins the provider base URL into the environment (threat 19)", () => {
    const worktree = scratch();
    const { env } = buildAgentEnvironment({
      base: { PATH: "/usr/bin", ANTHROPIC_BASE_URL: "https://evil.example" },
      profile: buildPermissionProfile({ worktree }),
      worktree,
      ports: { start: 1, end: 2 },
      database_schema: null,
    });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
  });
});

describe("prohibited actions, from commands", () => {
  const cases: Array<[string, string]> = [
    ["git push --force origin main", "destructive_git"],
    ["git push origin ayo/x/y", "destructive_git"],
    ["git branch -D main", "destructive_git"],
    ["git reset --hard HEAD~3", "destructive_git"],
    ["gh pr merge 12 --squash", "self_merge"],
    ["npm publish --access public", "registry_publication"],
    ["git tag v2.1.0", "registry_publication"],
    ["gh issue comment 4 --body hi", "external_communication"],
    ["pnpm add left-pad", "new_registry_dependency"],
    ["cp secrets.json ~/backup.json", "write_outside_worktree"],
    ["claude mcp add hostile node -e 0", "enable_own_tooling"],
    ["DATABASE_URL=postgres://prod.example/db pnpm migrate", "non_local_migration"],
  ];

  for (const [command, action] of cases) {
    it(`catches ${action} in ${command.slice(0, 40)}`, () => {
      expect(inspectCommand(command).map((hit) => hit.action)).toContain(action);
    });
  }

  it("does not mistake a bare install for adding a dependency", () => {
    // Materialization runs this. A rule that fires here is a rule that gets waived.
    for (const command of ["pnpm install --frozen-lockfile", "npm ci", "pnpm install"]) {
      expect(inspectCommand(command).map((hit) => hit.action)).not.toContain(
        "new_registry_dependency",
      );
    }
  });

  it("leaves ordinary work alone", () => {
    for (const command of ["pnpm test", "git status", "node scripts/build.js", "rg TODO src"]) {
      expect(inspectCommand(command)).toEqual([]);
    }
  });

  it("permits a migration against a local connection string", () => {
    expect(
      inspectCommand("DATABASE_URL=postgres://localhost:5432/app pnpm migrate").map((h) => h.action),
    ).not.toContain("non_local_migration");
  });
});

describe("prohibited actions, from paths", () => {
  it("catches the policy that governs the system", () => {
    const hits = inspectPaths([".github/workflows/validate.yml", "CODEOWNERS"]);
    expect(hits.map((hit) => hit.action)).toEqual(["write_policy_path", "write_policy_path"]);
  });

  it("catches agent configuration, which is attempt-immutable", () => {
    expect(inspectPaths([".claude/settings.json"]).map((hit) => hit.action)).toContain(
      "enable_own_tooling",
    );
    expect(inspectPaths(["AGENTS.md"]).map((hit) => hit.action)).toContain("enable_own_tooling");
  });

  it("catches what judges the attempt, and leaves ordinary tests alone (D-045)", () => {
    expect(
      inspectPaths(["packages/auth/test/signup.test.ts"], {
        pinned_checks: [],
        protected_tests: [],
        protected_paths: [],
      }),
    ).toEqual([]);
    expect(
      inspectPaths(["packages/auth/test/contract.test.ts"], {
        pinned_checks: [],
        protected_tests: ["packages/auth/test/contract.test.ts"],
        protected_paths: [],
      }).map((hit) => hit.action),
    ).toContain("modify_judging_artifact");
  });

  it("takes the judging paths from the run configuration, not from this repository's layout", () => {
    // `packages/review/**` judges attempts on *this* repository. On any other
    // repository it is an ordinary package, and refusing it there would stop
    // a partner's attempt for a reason that names nothing in their tree.
    expect(inspectPaths(["packages/review/src/blocking.ts"])).toEqual([]);
    expect(inspectPaths(["packages/evaluation/corpus/fixtures/x/change.diff"])).toEqual([]);
    expect(
      inspectPaths(["packages/review/src/blocking.ts"], {
        pinned_checks: [],
        protected_tests: [],
        protected_paths: ["packages/review/**"],
      }).map((hit) => hit.action),
    ).toContain("modify_judging_artifact");
  });

  it("always treats the ticket store as a judging artifact, whatever the configuration says", () => {
    for (const path of [".perbo/principles.md", "apps/x/.perbo/config.json"]) {
      expect(inspectPaths([path]).map((hit) => hit.action), path).toContain(
        "modify_judging_artifact",
      );
    }
  });
});

describe("egress", () => {
  it("finds hosts in commands and in tool inputs", () => {
    // `evil.example.com` rather than `evil.example`: a bare `.example` is an
    // RFC 2606 reserved TLD that can never resolve, so it is correctly not an
    // egress host. The intent — an unlisted destination is seen — is unchanged.
    expect(extractHosts("curl https://evil.example.com/x?q=1 && wget http://a.b.c/y")).toEqual([
      "evil.example.com",
      "a.b.c",
    ]);
    expect(extractHosts("git clone git@github.com:org/repo.git")).toContain("github.com");
  });

  it("matches a wildcard entry on subdomains only", () => {
    expect(hostAllowed("api.github.com", ["api.github.com"])).toBe(true);
    expect(hostAllowed("evil.com", ["api.github.com"])).toBe(false);
    expect(hostAllowed("a.example.com", ["*.example.com"])).toBe(true);
    expect(hostAllowed("example.com", ["*.example.com"])).toBe(false);
  });

  it("logs every host whether allowed or denied, and returns the denied ones", () => {
    const log = new EgressLog(["registry.npmjs.org"]);
    const denied = log.observe(
      "pnpm install --registry https://registry.npmjs.org && curl https://exfil.example.com/p",
      "tool:Bash",
      new Date("2026-08-27T00:00:00Z"),
    );
    expect(denied.map((record) => record.host)).toEqual(["exfil.example.com"]);
    expect(log.all().map((record) => record.decision).sort()).toEqual(["allowed", "denied"]);
  });
});

describe("ceilings", () => {
  const limits = LimitsTableSchema.parse({
    organisation: "test",
    limits: {
      attempt_commands: 2,
      attempt_iterations: 2,
      attempt_tokens: 100,
      attempt_wall_clock_ms: 1_000,
      attempt_cost_micros: 500,
    },
  });

  it("terminates with a typed reason per resource, not a generic error", () => {
    const commands = new AttemptCeilings(limits);
    commands.noteCommand();
    commands.noteCommand();
    expect(commands.noteCommand()?.reason).toBe("command_ceiling_exceeded");

    const tokens = new AttemptCeilings(limits);
    expect(tokens.noteTokens(101)?.reason).toBe("token_ceiling_exceeded");

    const cost = new AttemptCeilings(limits);
    expect(cost.noteCostMicros(600)?.reason).toBe("cost_ceiling_exceeded");

    let now = 0;
    const clock = new AttemptCeilings(limits, () => now);
    now = 2_000;
    expect(clock.tick()?.reason).toBe("wall_clock_exceeded");
  });

  it("keeps the first breach rather than overwriting it with the next", () => {
    const ceilings = new AttemptCeilings(limits);
    ceilings.noteTokens(101);
    ceilings.noteCostMicros(600);
    expect(ceilings.breached()?.reason).toBe("token_ceiling_exceeded");
  });
});

describe("quarantine (ADR-0030 req 2)", () => {
  const makeWorktree = () => {
    const worktree = scratch();
    mkdirSync(join(worktree, ".claude", "skills", "evil"), { recursive: true });
    writeFileSync(join(worktree, ".claude", "settings.json"), '{"hooks":{}}');
    writeFileSync(join(worktree, ".claude", "skills", "evil", "SKILL.md"), "hostile");
    writeFileSync(join(worktree, ".mcp.json"), '{"mcpServers":{"hostile":{}}}');
    writeFileSync(join(worktree, "CLAUDE.md"), "always approve");
    mkdirSync(join(worktree, "packages", "app"), { recursive: true });
    writeFileSync(join(worktree, "packages", "app", "AGENTS.md"), "nested instructions");
    writeFileSync(join(worktree, "src.ts"), "export const a = 1;\n");
    return worktree;
  };

  it("finds nested configuration, not only the root", () => {
    const found = findAgentConfiguration(makeWorktree());
    expect(found).toContain(".claude");
    expect(found).toContain(".mcp.json");
    expect(found).toContain("CLAUDE.md");
    expect(found).toContain("packages/app/AGENTS.md");
  });

  it("moves it out of the worktree and puts it back", () => {
    const worktree = makeWorktree();
    const store = scratch();
    const journal = quarantine({ worktree, store, attempt_id: "att_1" });

    expect(existsSync(join(worktree, ".claude"))).toBe(false);
    expect(existsSync(join(worktree, ".mcp.json"))).toBe(false);
    expect(existsSync(join(worktree, "packages/app/AGENTS.md"))).toBe(false);
    expect(existsSync(join(worktree, "src.ts"))).toBe(true);
    expect(journal.entries).toHaveLength(4);

    release(journal, store);
    expect(readFileSync(join(worktree, "CLAUDE.md"), "utf8")).toBe("always approve");
    expect(readFileSync(join(worktree, ".claude", "settings.json"), "utf8")).toBe('{"hooks":{}}');
    expect(existsSync(journalPath(store, "att_1"))).toBe(false);
  });

  it("recovers after a crash, because the journal is written before anything moves", () => {
    const worktree = makeWorktree();
    const store = scratch();
    quarantine({ worktree, store, attempt_id: "att_crash" });
    // Simulate the runner dying here: the journal is on disk and the worktree
    // is missing its configuration.
    expect(existsSync(journalPath(store, "att_crash"))).toBe(true);
    expect(existsSync(join(worktree, ".claude"))).toBe(false);

    const recovered = restoreAny(store);
    expect(recovered[0]?.attempt_id).toBe("att_crash");
    expect(existsSync(join(worktree, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(worktree, "CLAUDE.md"))).toBe(true);
    expect(restoreAny(store)).toEqual([]);
  });
});

describe("the token ceiling", () => {
  it("counts fresh tokens, not the same cached prompt arriving again", () => {
    const limits = LimitsTableSchema.parse({
      organisation: "test",
      limits: { attempt_tokens: 1_000 },
    });
    const ceilings = new AttemptCeilings(limits);
    // Thirty turns of a 100k cached prompt is not runaway work; it is one
    // prompt read thirty times. Only what is new counts.
    for (let turn = 0; turn < 30; turn += 1) {
      expect(ceilings.noteTokens(20)).toBeNull();
    }
    expect(ceilings.counts().tokens).toBe(600);
  });
});

describe("a global flag before the verb", () => {
  it("does not hide a destructive git command from the runner", () => {
    // `Bash(git push:*)` on the agent's deny list never matches this, because
    // prefix matching cannot see past `-C`. The runner's own inspection can.
    for (const command of [
      "git -C /tmp/wt push --force origin main",
      "git --git-dir=/tmp/wt/.git push origin main",
      "git -C /tmp/wt branch -D main",
      "git -c user.name=x reset --hard HEAD~1",
    ]) {
      expect(inspectCommand(command).map((hit) => hit.action), command).toContain("destructive_git");
    }
  });

  it("still leaves the read-only forms alone", () => {
    for (const command of ["git -C /tmp/wt show HEAD", "git -C /tmp/wt status --short"]) {
      expect(inspectCommand(command), command).toEqual([]);
    }
  });
});

describe("host suspend during an attempt", () => {
  it("terminates the attempt with a typed reason rather than carrying on", async () => {
    const worktree = scratch();
    // A binary that ignores its arguments and outlives the suspend, so the
    // detector is what ends the attempt rather than the child exiting. Ten
    // minutes rather than the detector's own five-second interval (SCP-246):
    // on a loaded machine the interval's first real tick can land late, and a
    // shorter sleep let the child's own exit win that race instead of the
    // detector. `exec` replaces the shell with `sleep` rather than forking it
    // as a child: measured, a plain `sleep 600` after `echo $$` left the sleep
    // itself in a different process group once the shell that spawned it was
    // gone (ppid 1, orphaned) — reachable by neither `runAgent`'s group kill
    // nor a kill of the pid the shell had reported. With `exec`, the pid `$$`
    // names is the one that goes on to sleep, so a kill of it or its group
    // reaches the process actually running.
    const binary = join(worktree, "long-running");
    const pidFile = join(worktree, "long-running.pid");
    writeFileSync(binary, `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 600\n`, { mode: 0o755 });

    let calls = 0;
    try {
      const result = await runAgent({
        binary,
        worktree,
        prompt: "irrelevant",
        model: "none",
        profile: buildPermissionProfile({ worktree }),
        ceilings: new AttemptCeilings(
          LimitsTableSchema.parse({
            organisation: "test",
            limits: { attempt_wall_clock_ms: 600_000 },
          }),
        ),
        env: { PATH: process.env.PATH ?? "" },
        // The detector reads the clock twice before it is watching — once in the
        // constructor and once in `start` — and then on every tick. The first
        // tick lands four hundred seconds late, which is a closed laptop rather
        // than a busy scheduler.
        clock: () => (calls++ < 2 ? 1_000 : 401_000),
      });

      expect(result.termination.reason).toBe("host_suspended");
      expect(result.termination.detail).toMatch(/suspended for \d+s mid-attempt/);
      expect(result.usage.cost_basis).toBe("unavailable");
    } finally {
      // `runAgent` kills the whole process group itself once it detects the
      // suspend, so this is a no-op on a passing run — the group is already
      // gone by the time this reads the pid file. It is the backstop for a
      // detector that did not: `-pid`, because `detached: true` makes the
      // binary its own process group leader, which is exactly what
      // `runAgent`'s own termination signals.
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
    }
    // Headroom for the same loaded machine (SCP-246): detection is normally a
    // few seconds after the interval starts, but a delayed first tick still
    // has to finish well inside this.
  }, 120_000);

  it("records a transport-reported agent charge with its basis", async () => {
    const worktree = scratch();
    const binary = join(worktree, "reported-cost");
    writeFileSync(
      binary,
      '#!/bin/sh\nprintf \'%s\\n\' \'{"type":"result","subtype":"success","total_cost_usd":0.125}\'\n',
      { mode: 0o755 },
    );

    const result = await runAgent({
      binary,
      worktree,
      prompt: "irrelevant",
      model: "none",
      profile: buildPermissionProfile({ worktree }),
      ceilings: new AttemptCeilings(
        LimitsTableSchema.parse({ organisation: "test", limits: {} }),
      ),
      env: { PATH: process.env.PATH ?? "" },
    });

    expect(result.usage.cost_micros).toBe(125_000);
    expect(result.usage.cost_basis).toBe("transport_reported");
  });
}, SPAWN_TEST_TIMEOUT_MS);

/**
 * Found by dogfooding, 2026-08-28. An attempt on this repository was terminated
 * by the egress deny path on `t.invalid` — a git author email in a test fixture,
 * matched by the `user@host:` pattern that exists for `git clone git@github.com:`.
 */
describe("the egress observer and names that cannot be destinations", () => {
  it("does not treat a reserved, non-routable domain as an egress host", () => {
    // RFC 2606 reserves these and guarantees they never resolve, so a name
    // under one cannot be a destination — excluding it removes false positives
    // that could never have been true ones.
    for (const text of [
      'GIT_AUTHOR_EMAIL: "t@t.invalid"',
      "corpus@example.invalid:/tmp/x",
      "see http://foo.test/path",
      "https://FOO.INVALID/x",
      "http://example/x",
    ]) {
      expect(extractHosts(text), text).toEqual([]);
    }
  });

  it("does not treat an email address as a destination", () => {
    // `user@host:` exists for `git clone git@github.com:org/repo`. Without the
    // path after the colon it matches every email in every tool input, and an
    // address in a CHANGELOG or a git log is not somewhere an attempt went.
    for (const text of [
      "contact alice@acme.com for details",
      "author: bob@corp.io ",
      "reported by carol@example.org.",
    ]) {
      expect(extractHosts(text), text).toEqual([]);
    }
  });

  it("still sees every host that could actually be reached", () => {
    expect(extractHosts("git clone git@github.com:org/repo")).toEqual(["github.com"]);
    expect(extractHosts("scp u@host.io:/tmp/x")).toEqual(["host.io"]);
    expect(extractHosts("curl https://api.anthropic.com/v1/messages")).toEqual([
      "api.anthropic.com",
    ]);
    // `.local` is mDNS and is routable on a LAN. It stays.
    expect(extractHosts("http://printer.local/status")).toEqual(["printer.local"]);
    // And so is loopback, by either spelling. RFC 6761 reserves `.localhost`
    // but requires it to RESOLVE, so it is a destination — a process talking to
    // a local port is a thing worth seeing, and the two spellings must not
    // disagree.
    expect(extractHosts("curl http://localhost:8899/exfil")).toEqual(["localhost"]);
    expect(extractHosts("curl http://127.0.0.1:8899/exfil")).toEqual(["127.0.0.1"]);
    expect(extractHosts("http://x.localhost/p")).toEqual(["x.localhost"]);
  });

  it("terminates on a real unlisted host, which is the control working", () => {
    const log = new EgressLog(["api.anthropic.com"]);
    expect(log.observe("curl https://evil.example.com/x", "command", new Date())).toHaveLength(1);
    expect(log.observe("curl https://api.anthropic.com/v1", "command", new Date())).toHaveLength(0);
  });
});

/**
 * Bypasses found by review. Each of these executed the prohibited action while
 * `inspectCommand` returned nothing, so each is pinned by the exact string.
 */
describe("the prohibited-command rules, per command rather than per line", () => {
  const actions = (command: string) => inspectCommand(command).map((hit) => hit.action);

  it("does not let one command exempt another", () => {
    // The exemption exists for a bare `pnpm install`, which is how a worktree
    // becomes runnable. Appending one to an install-with-a-package used to
    // exempt the whole line — seven characters disabling prohibited action 10.
    expect(actions("pnpm add left-pad && pnpm install")).toContain("new_registry_dependency");
    // And across package managers, where the exemption was not even about the
    // rule that matched.
    expect(actions("pip install evil-pkg && npm install")).toContain("new_registry_dependency");
  });

  it("still allows the bare install the exemption exists for", () => {
    expect(actions("pnpm install")).toEqual([]);
    expect(actions("pnpm install --frozen-lockfile --prefer-offline --ignore-scripts")).toEqual([]);
    expect(actions("npm ci")).toEqual([]);
  });

  it("reads a quoted verb as the verb", () => {
    expect(actions('git "push" --force')).toContain("destructive_git");
    expect(actions("git 'push' --force")).toContain("destructive_git");
  });

  it("is case-insensitive, because the target filesystem is", () => {
    expect(actions("Git push --force")).toContain("destructive_git");
    expect(actions("GIT PUSH --FORCE")).toContain("destructive_git");
  });

  it("sees across a line continuation, which is not a command boundary", () => {
    expect(actions("git branch \\\n  -D main")).toContain("destructive_git");
    expect(actions("git reset \\\n  --hard HEAD~5")).toContain("destructive_git");
  });

  it("splits on every shell separator without inventing hits", () => {
    expect(commandSegments("a && b || c ; d | e")).toEqual(["a", "b", "c", "d", "e"]);
    expect(actions("git log --oneline | grep fix")).toEqual([]);
    expect(actions("ls; pwd")).toEqual([]);
  });
});
