import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT_CODES, OPENCODE_SESSION_RETRY_MS } from "@perbo/contracts";
import { SPAWN_TEST_TIMEOUT_MS } from "@perbo/test-support";
import { INTERVIEW_TOOL_NAMES, interviewCommandLine } from "./index.js";
import {
  claimOpenCodeDataDirectory,
  OPENCODE_DATA_MARKER,
  openCodeDataDirectory,
  openCodeInterviewTransport,
} from "./opencode.js";
import { refusals, repository, SPEC_FOLDER } from "./test-support/contract.js";
import { fakeOpenCode, type OpenCodeStep } from "./test-support/fake-opencode.js";
import { runCommandLine } from "../../command-line/terminal.js";
import { recordStreams } from "../../test-support/streams.js";

/**
 * The interview on OpenCode: what only this transport has
 * (D-NEW-opencode-is-a-provider). What all three share runs from
 * `index.test.ts` through `test-support/contract.ts`; here is `opencode acp`
 * itself — how it is started, the tool server the chat's tools are served on,
 * the turn a refusal ends and the one that follows it, and the resume —
 * driven against `test-support/fake-opencode.ts`. Nothing starts a real
 * `opencode` and nothing reaches a model.
 */

const scratch = mkdtempSync(join(tmpdir(), "perbo-interview-opencode-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function interview(
  steps: readonly OpenCodeStep[],
  extra: {
    argv?: readonly string[];
    env?: NodeJS.ProcessEnv;
    /** The chat's data directory; a fresh one, not yet made, where none is given. */
    data?: string;
    repo?: string;
    refuseResumes?: number;
  } = {},
) {
  const repo = extra.repo ?? repository(scratch);
  const fake = fakeOpenCode({
    root: mkdtempSync(join(scratch, "fake-")),
    steps,
    sessionId: "ses-7",
    ...(extra.refuseResumes === undefined ? {} : { refuseResumes: extra.refuseResumes }),
  });
  const data = extra.data ?? join(mkdtempSync(join(scratch, "home-")), "data");
  const streams = recordStreams();
  const code = await runCommandLine(interviewCommandLine, {
    argv: ["--repo", repo, "--spec", SPEC_FOLDER, "--provider", "opencode", ...(extra.argv ?? [])],
    streams,
    cwd: repo,
    deps: {
      transport: openCodeInterviewTransport({
        binary: fake.binary,
        dataDirectory: data,
        env: extra.env ?? { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GH_TOKEN: "ghp_not_forwarded" },
      }),
      turns: (async function* () {
        yield JSON.stringify({ type: "turn", text: "let us write the spec" });
      })(),
    },
  });
  return { code, repo, fake, streams, data };
}

/**
 * A case that runs a session spawns the fake OpenCode, a Node process, and
 * waits out the transport's grace after the tool listing (500 ms), so it takes
 * the spawn timeout every process-spawning test here takes, rather than the
 * default five seconds a loaded machine can spend starting Node alone.
 */
describe("the OpenCode the interview starts", () => {
  it("runs `opencode acp` under a home of its own, with the orientation as its one instruction and the four tools on its tool server", async () => {
    const { code, fake, data } = await interview([], {
      env: { PATH: process.env.PATH ?? "", HOME: "/home/person", GH_TOKEN: "ghp_x", OPENCODE_API_KEY: "zen-key-for-test" },
    });
    expect(code).toBe(EXIT_CODES.approve);
    const seen = fake.seen();
    expect(seen.argv).toEqual(["acp"]);
    expect(seen.env["OPENCODE_DISABLE_PROJECT_CONFIG"]).toBe("1");
    expect(seen.env["GH_TOKEN"]).toBeUndefined();
    expect(seen.env["OPENCODE_API_KEY"]).toBe("zen-key-for-test");
    // Its sessions are kept where the store keeps them, so --session finds one again.
    expect(seen.env["XDG_DATA_HOME"]).toBe(data);
    expect(seen.env["XDG_CONFIG_HOME"]).toContain("perbo-interview-opencode-");
    expect(seen.instructions).toContain(SPEC_FOLDER);
    // The four tools, and no other, each allowed by its exact name.
    expect(seen.listed).toEqual([...INTERVIEW_TOOL_NAMES]);
    const config = JSON.parse(seen.env["OPENCODE_CONFIG_CONTENT"]!) as { permission: Record<string, string> };
    expect(Object.entries(config.permission).filter(([, effect]) => effect === "allow").map(([name]) => name)).toEqual([
      "read",
      "glob",
      "grep",
      "list",
      ...INTERVIEW_TOOL_NAMES.map((name) => `perbo_interview_${name}`),
    ]);
  }, SPAWN_TEST_TIMEOUT_MS);

  it("refuses a tool-server call without the process's token", async () => {
    const { fake } = await interview([{ kind: "tokenless" }]);
    expect(fake.answers()).toEqual([expect.objectContaining({ kind: "tokenless", status: 401 })]);
  }, SPAWN_TEST_TIMEOUT_MS);

  it("answers a refused call `reject`, reports it, and starts the next turn with the refusal in the rules' words", async () => {
    const { fake, streams } = await interview([
      { kind: "command", command: "rm -rf packages" },
      { kind: "write", path: `${SPEC_FOLDER}/spec.md`, content: "# Spec\n" },
    ]);
    expect(fake.answers().map((answer) => answer.decision)).toEqual(["reject", "once"]);
    const refused = refusals(streams);
    expect(refused.map((event) => event.tool)).toEqual(["Bash"]);
    const prompts = fake.seen().prompts;
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("The interview refused these calls");
    expect(prompts[1]).toContain(refused[0]!.reason);
  }, SPAWN_TEST_TIMEOUT_MS);

  it("refuses a session, opened or resumed, that loaded an agent definition of its own", async () => {
    for (const argv of [[], ["--session", "ses-7"]]) {
      const repo = repository(scratch);
      const fake = fakeOpenCode({
        root: mkdtempSync(join(scratch, "fake-")),
        steps: [{ kind: "say", text: "never said" }],
        sessionId: "ses-7",
        modes: ["build", "plan", "repository-agent"],
      });
      const streams = recordStreams();
      const failure = await Promise.resolve(
        runCommandLine(interviewCommandLine, {
          argv: ["--repo", repo, "--spec", SPEC_FOLDER, "--provider", "opencode", ...argv],
          streams,
          cwd: repo,
          deps: {
            transport: openCodeInterviewTransport({
              binary: fake.binary,
              dataDirectory: join(mkdtempSync(join(scratch, "home-")), "data"),
            }),
            turns: (async function* () {
              yield JSON.stringify({ type: "turn", text: "hello" });
            })(),
          },
        }),
      ).catch((error: unknown) => error);
      expect(failure, argv.join(" ")).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(
        "OpenCode loaded agent definitions into the chat's session: repository-agent",
      );
      // No turn was sent to a session that carried it.
      expect(fake.seen().prompts).toEqual([]);
    }
  }, SPAWN_TEST_TIMEOUT_MS);

  it("continues a session through ACP's own resume", async () => {
    const { fake } = await interview([], { argv: ["--session", "ses-7"] });
    expect(fake.seen().resumed).toBe("ses-7");
  }, SPAWN_TEST_TIMEOUT_MS);
});

describe("where the chat keeps OpenCode's data", () => {
  it("is Perbo's own directory per repository, outside the checkout", () => {
    const repo = "/work/api";
    const directory = openCodeDataDirectory(repo, "/home/person");
    expect(directory.startsWith("/home/person/.perbo/opencode/api-")).toBe(true);
    expect(directory.startsWith(repo)).toBe(false);
    expect(openCodeDataDirectory("/clients/api", "/home/person")).not.toBe(directory);
  });

  it("is made mode 0700 with Perbo's marker, and a later run resumes from it", async () => {
    const first = await interview([]);
    expect(first.code).toBe(EXIT_CODES.approve);
    expect(existsSync(join(first.data, OPENCODE_DATA_MARKER))).toBe(true);
    expect(existsSync(join(first.data, "opencode", "opencode.db"))).toBe(true);
    const again = await interview([], { argv: ["--session", "ses-7"], data: first.data, repo: first.repo });
    expect(again.code).toBe(EXIT_CODES.approve);
    expect(again.fake.seen().resumed).toBe("ses-7");
  }, SPAWN_TEST_TIMEOUT_MS);

  /**
   * The refusal a run over `data` ends in, and the argv the fake OpenCode was
   * started with. The claim runs before the tool server or OpenCode is
   * started, so a refused run spawns nothing and needs no more than the
   * default timeout.
   */
  const refusal = async (data: string, repo: string) => {
    const fake = fakeOpenCode({ root: mkdtempSync(join(scratch, "fake-")), steps: [], sessionId: "ses-7" });
    const error = await Promise.resolve(
      runCommandLine(interviewCommandLine, {
        argv: ["--repo", repo, "--spec", SPEC_FOLDER, "--provider", "opencode"],
        streams: recordStreams(),
        cwd: repo,
        deps: {
          transport: openCodeInterviewTransport({ binary: fake.binary, dataDirectory: data }),
          turns: (async function* () {
            yield JSON.stringify({ type: "turn", text: "hello" });
          })(),
        },
      }),
    ).catch((failure: unknown) => failure);
    return { message: error instanceof Error ? error.message : `no refusal: ${String(error)}`, started: fake.seen().argv };
  };

  /**
   * A directory Perbo made for `repo`, holding the database OpenCode writes
   * under `opencode/`, as a run leaves it — made by the claim itself rather
   * than by a run, so no case here waits on the fake.
   */
  const madeFor = (repo: string): string => {
    const data = join(mkdtempSync(join(scratch, "home-")), "data");
    claimOpenCodeDataDirectory(data, repo);
    mkdirSync(join(data, "opencode"));
    writeFileSync(join(data, "opencode", "opencode.db"), "");
    return data;
  };

  it("refuses to start over an OpenCode database it did not make", async () => {
    // No marker of Perbo's: another's approvals could be in it.
    const seeded = join(mkdtempSync(join(scratch, "home-")), "data");
    mkdirSync(join(seeded, "opencode"), { recursive: true, mode: 0o700 });
    chmodSync(seeded, 0o700);
    writeFileSync(join(seeded, "opencode", "opencode.db"), "");
    const refused = await refusal(seeded, repository(scratch));
    expect(refused.message).toContain("was not made by Perbo for this repository");
    expect(refused.started).toEqual([]);
  });

  it("refuses to start over a file beside OpenCode's own directory that neither writes", async () => {
    const repo = repository(scratch);
    const data = madeFor(repo);
    writeFileSync(join(data, "auth.json"), "{}");
    const refused = await refusal(data, repo);
    expect(refused.message).toContain("holds auth.json, which Perbo does not recognise from OpenCode 2.0.14");
    expect(refused.started).toEqual([]);
  });

  it("refuses to start over a file inside OpenCode's own directory that OpenCode 2.0.14 does not write", async () => {
    const repo = repository(scratch);
    const data = madeFor(repo);
    writeFileSync(join(data, "opencode", "auth.json"), "{}");
    const refused = await refusal(data, repo);
    expect(refused.message).toContain("holds opencode/auth.json, which Perbo does not recognise from OpenCode 2.0.14");
    expect(refused.message).toContain(`remove ${data} to start the chat afresh; its saved sessions go with it`);
    expect(refused.started).toEqual([]);
  });

  it("refuses to start in its own directory opened to other users", async () => {
    const repo = repository(scratch);
    const data = madeFor(repo);
    chmodSync(data, 0o755);
    const refused = await refusal(data, repo);
    expect(refused.message).toContain("is open to other users");
    expect(refused.started).toEqual([]);
  });

  it("refuses to start in a directory it made for another repository", async () => {
    const data = madeFor(repository(scratch));
    const refused = await refusal(data, repository(scratch));
    expect(refused.message).toContain("was not made by Perbo for this repository");
    expect(refused.started).toEqual([]);
  });

  it("asks again for a session OpenCode refused to resume while its catalogue was still arriving", async () => {
    const { code, fake } = await interview([], { argv: ["--session", "ses-7"], refuseResumes: 1 });
    expect(code).toBe(EXIT_CODES.approve);
    expect(fake.seen().resumed).toBe("ses-7");
    // Spawns the fake, and waits OPENCODE_SESSION_RETRY_MS before asking again.
  }, SPAWN_TEST_TIMEOUT_MS + OPENCODE_SESSION_RETRY_MS);
});

describe("claiming the chat's OpenCode data directory", () => {
  /** A directory Perbo made for `repo`, holding what OpenCode 2.0.14 was measured to write in it. */
  const measuredLayout = (repo: string): string => {
    const directory = join(mkdtempSync(join(scratch, "claim-")), "data");
    claimOpenCodeDataDirectory(directory, repo);
    const root = join(directory, "opencode");
    mkdirSync(root);
    for (const file of ["opencode.db", "opencode.db-shm", "opencode.db-wal"]) writeFileSync(join(root, file), "");
    for (const folder of ["log", "repos", "shell"]) mkdirSync(join(root, folder));
    return directory;
  };

  it("takes up again a directory holding the layout OpenCode 2.0.14 writes", () => {
    const directory = measuredLayout("/work/api");
    expect(() => claimOpenCodeDataDirectory(directory, "/work/api")).not.toThrow();
    expect(() => claimOpenCodeDataDirectory(directory, "/work/api")).not.toThrow();
  });

  it("refuses a directory open to others except on Windows, whose mode bits say nothing of its access list", () => {
    const directory = measuredLayout("/work/api");
    chmodSync(directory, 0o755);
    expect(() => claimOpenCodeDataDirectory(directory, "/work/api", "darwin")).toThrow("is open to other users");
    expect(() => claimOpenCodeDataDirectory(directory, "/work/api", "linux")).toThrow("is open to other users");
    expect(() => claimOpenCodeDataDirectory(directory, "/work/api", "win32")).not.toThrow();
  });
});
