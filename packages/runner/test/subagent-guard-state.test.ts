import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ADMISSION_RULES } from "../src/admission.js";
import {
  discardPreToolGuard,
  guardHookEntry,
  preparePreToolGuard,
  readPreToolDecisions,
  type PreToolDecision,
  type PreToolGuard,
} from "../src/pretool.js";
import { UNKNOWN_CWD } from "../src/shell/index.js";
import { buildPermissionProfile } from "../src/profile.js";
import { SPAWN_TEST_TIMEOUT_MS, scratch } from "./support.js";

/**
 * D-106 criterion 2: the guard keeps its state per agent, and loses nothing
 * when two agents' calls arrive at once.
 *
 * The state the hook keeps is where an agent's shell stands (SCP-170), and
 * every agent has its own: Claude Code gives a subagent its own Bash session,
 * so a `cd` the parent ran says nothing about where a child's next relative
 * path resolves. One shared directory therefore judges one agent's write from
 * another agent's directory — silently, and in whichever direction the calls
 * happened to arrive.
 *
 * Both halves are driven through the hook program itself, as Claude Code runs
 * it, because the state is a file on disk and a process is what writes it.
 */

const root = realpathSync(resolve(scratch("perbo-agent-state-")));
for (const directory of ["src", "a", "b", "d0", "d1", "d2", "d3", "d4", "d5", "x", "y"]) {
  mkdirSync(join(root, directory), { recursive: true });
}
const profile = buildPermissionProfile({ worktree: root });

const guardFor = (paths_allowed: readonly string[] = ["src/**"]): PreToolGuard =>
  preparePreToolGuard({ worktree: root, tmpdir: null, profile, paths_allowed });

/** One agent as its hook payload names it: a subagent, or the session itself. */
interface Agent {
  agent_id?: string;
  agent_type?: string;
}

const bashCall = (agent: Agent, command: string, id: string) => ({
  session_id: "922fba1c-0000-0000-0000-000000000000",
  cwd: root,
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_use_id: id,
  tool_input: { command },
  ...agent,
});

/** The hook as Claude Code runs it: the program, the directory, the call on stdin. */
function runHook(directory: string, call: Record<string, unknown>): Promise<string> {
  return new Promise((done, failed) => {
    const child = spawn(process.execPath, [guardHookEntry(), directory], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", failed);
    child.on("close", () => done(out));
    child.stdin.end(JSON.stringify(call));
  });
}

const SESSION: Agent = {};
const ALPHA: Agent = { agent_id: "a1068d4ecef4890c3", agent_type: "perbo-implementer" };
/** Beta is the same role as alpha, and a different agent: two of one role can run at once. */
const BETA: Agent = { agent_id: "b2f7c04d1e9a35b86", agent_type: "perbo-implementer" };

const last = (decisions: readonly PreToolDecision[], count: number): PreToolDecision[] =>
  decisions.slice(decisions.length - count);

describe("where each agent's shell stands (D-106 criterion 2)", () => {
  it(
    "judges each agent's relative write from that agent's own directory",
    async () => {
      const guard = guardFor();
      // Three `cd` calls, one per agent, arriving one after another — which is
      // all it takes: with one shared directory the third overwrites the first
      // two and every later call is judged from wherever the last `cd` went.
      await runHook(guard.directory, bashCall(ALPHA, "cd a", "toolu_cd_alpha"));
      await runHook(guard.directory, bashCall(BETA, "cd b", "toolu_cd_beta"));
      await runHook(guard.directory, bashCall(SESSION, "cd src", "toolu_cd_session"));

      // The same line from each of them. The bytes it writes land in three
      // different places, and only one of those is inside the contract.
      const write = "echo x > out.txt";
      await runHook(guard.directory, bashCall(ALPHA, write, "toolu_w_alpha"));
      await runHook(guard.directory, bashCall(BETA, write, "toolu_w_beta"));
      await runHook(guard.directory, bashCall(SESSION, write, "toolu_w_session"));

      const [alpha, beta, session] = last(readPreToolDecisions(guard.decisionsPath), 3);
      expect(alpha?.cwd).toBe("a");
      expect(alpha?.decision).toBe("denied");
      expect(alpha?.rule).toBe(ADMISSION_RULES.scope);
      expect(beta?.cwd).toBe("b");
      expect(beta?.decision).toBe("denied");
      expect(beta?.rule).toBe(ADMISSION_RULES.scope);
      // The one agent standing inside the contract's globs, so the test says
      // the guard still admits rather than only that it refuses.
      expect(session?.cwd).toBe("src");
      expect(session?.decision).toBe("allowed");
      discardPreToolGuard(guard);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "loses no agent's directory when six of them move at once",
    async () => {
      const guard = guardFor();
      const agents: Agent[] = [0, 1, 2, 3, 4, 5].map((index) => ({
        agent_id: `agent-${index}-b2f7c04d1e9a35b86`,
        agent_type: "perbo-explorer",
      }));
      // Every `cd` in flight together: six processes reading and writing the
      // guard's state with nothing serialising them.
      await Promise.all(
        agents.map((agent, index) =>
          runHook(guard.directory, bashCall(agent, `cd d${index}`, `toolu_cd_${index}`)),
        ),
      );
      for (const [index, agent] of agents.entries()) {
        await runHook(guard.directory, bashCall(agent, "ls -la", `toolu_ls_${index}`));
      }
      expect(last(readPreToolDecisions(guard.decisionsPath), 6).map((each) => each.cwd)).toEqual([
        "d0",
        "d1",
        "d2",
        "d3",
        "d4",
        "d5",
      ]);
      discardPreToolGuard(guard);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "keeps two agents of one role apart, and the session apart from both",
    async () => {
      const guard = guardFor();
      await runHook(guard.directory, bashCall(ALPHA, "cd a", "toolu_2cd_alpha"));
      await runHook(guard.directory, bashCall(BETA, "cd b", "toolu_2cd_beta"));
      await runHook(guard.directory, bashCall(ALPHA, "ls", "toolu_2ls_alpha"));
      await runHook(guard.directory, bashCall(BETA, "ls", "toolu_2ls_beta"));
      await runHook(guard.directory, bashCall(SESSION, "ls", "toolu_2ls_session"));
      expect(last(readPreToolDecisions(guard.decisionsPath), 3).map((each) => each.cwd)).toEqual([
        "a",
        "b",
        // The session never moved, so it stands where the attempt started it.
        ".",
      ]);
      discardPreToolGuard(guard);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  /**
   * The move back is what tells an agent's own directory from the attempt's.
   *
   * Every other case here moves an agent away and leaves it there, so the file
   * the hook writes is the same whether the line that writes it compares
   * against this agent's held directory or against the one the attempt started
   * every agent at. They differ on the way back: compared against the attempt's
   * root, the return is not written down, the agent's file still says `src`,
   * and the guard resolves the next relative write from a directory the shell
   * left — admitting `a.ts` at the root as `src/a.ts` under a `src/**`
   * contract, which is the boundary D-022 and D-105 rest on.
   */
  it(
    "follows an agent back to where the attempt started it",
    async () => {
      const guard = guardFor();
      await runHook(guard.directory, bashCall(ALPHA, "cd src", "toolu_back_in"));
      await runHook(guard.directory, bashCall(ALPHA, "cd ..", "toolu_back_out"));
      await runHook(guard.directory, bashCall(ALPHA, "echo x > a.ts", "toolu_back_write"));

      const [write] = last(readPreToolDecisions(guard.decisionsPath), 1);
      // Judged from the root, where the shell actually stands.
      expect(write?.cwd).toBe(".");
      expect(write?.decision).toBe("denied");
      expect(write?.rule).toBe(ADMISSION_RULES.scope);
      expect(write?.target).toBe("a.ts");
      // And the same line one directory in is the write the contract admits,
      // so the case says the guard still resolves rather than only refuses.
      await runHook(guard.directory, bashCall(ALPHA, "cd src", "toolu_back_in2"));
      await runHook(guard.directory, bashCall(ALPHA, "echo x > a.ts", "toolu_back_write2"));
      const [inside] = last(readPreToolDecisions(guard.decisionsPath), 1);
      expect(inside?.cwd).toBe("src");
      expect(inside?.decision).toBe("allowed");
      discardPreToolGuard(guard);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  /**
   * An agent id is a value off a process's standard input, so it is a name the
   * guard is handed and not one it chose. Keeping a file per agent makes it a
   * filename, and a filename made from an untrusted value is a path (ADR-0023).
   */
  it(
    "cannot be made to write its state outside its own directory",
    async () => {
      const guard = guardFor();
      const escaping: Agent[] = [
        { agent_id: "../x", agent_type: "perbo-explorer" },
        { agent_id: "/y", agent_type: "perbo-explorer" },
      ];
      await runHook(guard.directory, bashCall(escaping[0]!, "cd x", "toolu_esc_x_cd"));
      await runHook(guard.directory, bashCall(escaping[1]!, "cd y", "toolu_esc_y_cd"));
      await runHook(guard.directory, bashCall(escaping[0]!, "ls", "toolu_esc_x_ls"));
      await runHook(guard.directory, bashCall(escaping[1]!, "ls", "toolu_esc_y_ls"));

      // They are still two agents, and still their own directories.
      expect(last(readPreToolDecisions(guard.decisionsPath), 2).map((each) => each.cwd)).toEqual([
        "x",
        "y",
      ]);
      // And the files they put on disk are inside the guard's own directory,
      // under names nothing off the agent's input can shape. Spelled out
      // rather than derived, so a name escaping into the guard's root shows
      // here as a new entry.
      expect(readdirSync(guard.directory).sort()).toEqual([
        "agents",
        "decisions.jsonl",
        "settings.json",
        "state.json",
      ]);
      const held = readdirSync(join(guard.directory, "agents")).sort();
      expect(held).toHaveLength(2);
      for (const name of held) expect(name).toMatch(/^[0-9a-f]{32}\.json$/);
      discardPreToolGuard(guard);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  /**
   * A file that is not there and a file that will not read back are two
   * different facts about one agent, and only the first one has an answer.
   *
   * The file is written by the call that moves the agent, so no file at all is
   * an agent that has not moved: it stands where the attempt started every
   * agent, which is the root, and a relative target of its own resolves there.
   */
  it(
    "judges an agent that has never moved from the root it was started at",
    async () => {
      const guard = guardFor();
      // No `cd` before it, so this agent has no file of its own yet.
      await runHook(guard.directory, bashCall(ALPHA, "echo x > src/a.ts", "toolu_first_write"));
      const [first] = last(readPreToolDecisions(guard.decisionsPath), 1);
      expect(first?.cwd).toBe(".");
      expect(first?.decision).toBe("allowed");
      expect(readdirSync(join(guard.directory, "agents"))).toEqual([]);
      discardPreToolGuard(guard);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  /**
   * The other half: a file that is there and does not read back.
   *
   * Those bytes were written because this agent moved, and where it moved to
   * is gone with them. Standing it back at the root is not the safe answer it
   * looks like — the shell is still wherever it went, so `echo x > out.txt` is
   * resolved against the root, admitted as a path inside the worktree, and
   * written wherever the shell actually stands. The guard has no directory for
   * this agent and refuses instead, saying so.
   */
  it(
    "refuses an agent's call where the file holding its directory is unreadable",
    async () => {
      const guard = guardFor();
      await runHook(guard.directory, bashCall(ALPHA, "cd a", "toolu_torn_cd"));
      const [file] = readdirSync(join(guard.directory, "agents"));
      const path = join(guard.directory, "agents", file!);
      const damaged = [
        // A torn write: the bytes stop mid-key.
        '{"agent":"perbo-implementer","cw',
        // Parses, and says nothing about where the agent is.
        '{"agent":null}',
        '{"cwd":""}',
        // An empty file: nothing in it to parse at all.
        "",
      ];
      for (const [index, bytes] of damaged.entries()) {
        writeFileSync(path, bytes, "utf8");
        // The line from the finding: a relative target, which is exactly what
        // a directory the guard does not have would have placed wrongly.
        const answer = await runHook(
          guard.directory,
          bashCall(ALPHA, "echo x > out.txt", `toolu_torn_write_${index}`),
        );
        const [refused] = last(readPreToolDecisions(guard.decisionsPath), 1);
        expect(refused?.decision, bytes).toBe("denied");
        expect(refused?.rule, bytes).toBe(ADMISSION_RULES.agent_directory_unknown);
        expect(refused?.cwd, bytes).toBe(UNKNOWN_CWD);
        expect(refused?.agent, bytes).toBe("perbo-implementer");
        // And the agent is told, by the answer its own binary acts on, not
        // only in a record a person reads afterwards.
        expect(JSON.parse(answer).hookSpecificOutput, bytes).toMatchObject({
          permissionDecision: "deny",
        });
        expect(refused?.reason, bytes).toContain("cannot say where perbo-implementer stands");
      }
      // Nothing was written back over the damaged file: the guard cannot say
      // where this agent is, so it has nothing to record about where it went.
      expect(readFileSync(path, "utf8")).toBe(damaged.at(-1));
      discardPreToolGuard(guard);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  /**
   * The third way a read ends, and the one the four shapes above cannot reach.
   *
   * Each of those is a file that opens and gives back bytes the guard then
   * rejects. This is the read itself failing — and the discrimination the
   * refusal rests on is between `ENOENT` and everything else, so a case that
   * never fails for anything else leaves that discrimination unheld. A
   * directory where the file should be fails `EISDIR`, which is the shape a
   * permission this process lacks or a device error would also take.
   */
  it(
    "refuses an agent's call where reading the file fails for any reason but its absence",
    async () => {
      const guard = guardFor();
      await runHook(guard.directory, bashCall(ALPHA, "cd a", "toolu_eisdir_cd"));
      const [file] = readdirSync(join(guard.directory, "agents"));
      const path = join(guard.directory, "agents", file!);
      rmSync(path);
      mkdirSync(path);

      const answer = await runHook(
        guard.directory,
        bashCall(ALPHA, "echo x > out.txt", "toolu_eisdir_write"),
      );
      const [refused] = last(readPreToolDecisions(guard.decisionsPath), 1);
      expect(refused?.decision).toBe("denied");
      expect(refused?.rule).toBe(ADMISSION_RULES.agent_directory_unknown);
      expect(refused?.cwd).toBe(UNKNOWN_CWD);
      expect(JSON.parse(answer).hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
      discardPreToolGuard(guard);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  /**
   * The same fact reached through the other door: a move the guard cannot
   * write down.
   *
   * Reading an agent's file as where its shell stands is only sound while
   * every move is recorded. A `cd` whose new directory will not write is
   * therefore refused: admitted, it would leave the file saying `src` — or
   * saying nothing, for an agent that never moved — while the shell stood in
   * /tmp, and the next `echo x > out.txt` would be judged from there, admitted
   * as a path inside the worktree and written outside it. The agent moves to
   * `src` before the directory is made unwritable, so the directory the
   * refusal names is that agent's own rather than the one the attempt started
   * every agent at. The contract admits everything inside the worktree, so a
   * regression admits rather than refusing for some other reason.
   */
  it(
    "refuses to move an agent whose new directory it cannot record",
    async () => {
      const guard = guardFor([]);
      const outside = realpathSync("/tmp");
      const agents = join(guard.directory, "agents");
      await runHook(guard.directory, bashCall(ALPHA, "cd src", "toolu_unwritable_in"));
      chmodSync(agents, 0o500);
      try {
        const moved = await runHook(guard.directory, bashCall(ALPHA, `cd ${outside}`, "toolu_unwritable_cd"));
        expect(JSON.parse(moved).hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
        const [refused] = last(readPreToolDecisions(guard.decisionsPath), 1);
        expect(refused?.decision).toBe("denied");
        expect(refused?.rule).toBe(ADMISSION_RULES.agent_directory_unknown);
        // The sentence reaches the executor's own model, so it has to be true
        // of this door rather than the other one's. Here the guard knows
        // exactly where the agent is — refusing is what keeps it there — and
        // what failed is recording where the call would take it.
        expect(refused?.reason).toContain("could not record where this call moves");
        expect(refused?.reason).toContain("stays where it is");
        expect(refused?.reason).not.toContain("cannot say where");
        // Where it stays, spelled as every other decision spells a directory.
        expect(refused?.cwd).toBe("src");

        // And because the move was refused, the shell never left: the next
        // relative write is judged from `src`, where admitting it is the true
        // answer rather than one that puts the bytes in /tmp.
        await runHook(guard.directory, bashCall(ALPHA, "echo x > out.txt", "toolu_unwritable_write"));
        const [after] = last(readPreToolDecisions(guard.decisionsPath), 1);
        expect(after?.decision).toBe("allowed");
        expect(after?.cwd).toBe("src");
      } finally {
        chmodSync(agents, 0o700);
      }
      discardPreToolGuard(guard);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  /**
   * A refusal has to be about this agent, and a name beside its file is not.
   *
   * The bytes a move writes go to a temporary of this call's own before the
   * rename swaps them in. Anything else standing in that directory — another
   * hook process's temporary, or what one killed mid-write left — belongs to
   * that call and not to this one, so it can neither be written over nor stop
   * this agent moving. A refusal here would reach the executor's own model
   * saying the guard cannot record where the agent went, which would be a
   * false account of a directory that is perfectly writable.
   *
   * The entry planted here is a directory, because that is the shape a write
   * to a taken name fails on rather than silently overwriting.
   */
  it(
    "moves an agent although an entry stands beside the file holding its directory",
    async () => {
      const guard = guardFor([]);
      const agents = join(guard.directory, "agents");
      await runHook(guard.directory, bashCall(ALPHA, "cd src", "toolu_pending_in"));
      const [file] = readdirSync(agents);
      const planted = join(agents, `${file!}.pending`);
      mkdirSync(planted);

      const moved = await runHook(guard.directory, bashCall(ALPHA, "cd ..", "toolu_pending_out"));
      expect(moved).not.toContain("deny");
      const [recorded] = last(readPreToolDecisions(guard.decisionsPath), 1);
      expect(recorded?.decision).toBe("allowed");

      // The move landed, so the next relative target is judged from the root
      // the shell went back to rather than from the directory it left.
      await runHook(guard.directory, bashCall(ALPHA, "echo x > out.txt", "toolu_pending_write"));
      const [after] = last(readPreToolDecisions(guard.decisionsPath), 1);
      expect(after?.decision).toBe("allowed");
      expect(after?.cwd).toBe(".");
      // And what was planted is still there: it was never this call's to remove.
      expect(statSync(planted).isDirectory()).toBe(true);
      discardPreToolGuard(guard);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  /**
   * The same file, and the case where falling back to the root does not refuse
   * for some other reason but admits.
   *
   * The contract here admits everything inside the worktree, and the shell has
   * left it. Judged from the root, `out.txt` is a path inside the worktree and
   * there is nothing left to refuse it — the bytes land in the directory the
   * shell is actually in, outside the worktree, with the guard's own record
   * saying the write was admitted inside it.
   */
  it(
    "does not admit a write from a directory outside the worktree it cannot see",
    async () => {
      const guard = guardFor([]);
      const outside = realpathSync("/tmp");
      await runHook(guard.directory, bashCall(ALPHA, `cd ${outside}`, "toolu_out_cd"));
      // Intact, the guard knows where the shell went and refuses on the target.
      await runHook(guard.directory, bashCall(ALPHA, "echo x > out.txt", "toolu_out_write"));
      const [placed] = last(readPreToolDecisions(guard.decisionsPath), 1);
      expect(placed?.decision).toBe("denied");
      expect(placed?.rule).toBe(ADMISSION_RULES.write);

      const [file] = readdirSync(join(guard.directory, "agents"));
      writeFileSync(join(guard.directory, "agents", file!), '{"agent":null}', "utf8");
      await runHook(guard.directory, bashCall(ALPHA, "echo x > out.txt", "toolu_out_write_torn"));
      const [unplaced] = last(readPreToolDecisions(guard.decisionsPath), 1);
      expect(unplaced?.decision).toBe("denied");
      expect(unplaced?.rule).toBe(ADMISSION_RULES.agent_directory_unknown);
      discardPreToolGuard(guard);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  /**
   * The file's `cwd` is the one thing the guard has to take from it. Its
   * `agent` is not: the role arrives on the payload in front of the guard,
   * from Claude Code, and the file is the one thing a torn write or a stale
   * round could leave a name in. So the name is taken from the call and
   * written over whatever the file said, and never carried forward from it.
   */
  it(
    "names an agent's file from the call in front of it, not from the file",
    async () => {
      const guard = guardFor();
      await runHook(guard.directory, bashCall(ALPHA, "cd a", "toolu_name_cd"));
      const [file] = readdirSync(join(guard.directory, "agents"));
      const path = join(guard.directory, "agents", file!);
      writeFileSync(path, JSON.stringify({ agent: "perbo-explorer", cwd: root }), "utf8");

      await runHook(guard.directory, bashCall(ALPHA, "cd b", "toolu_name_cd_again"));
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        agent: "perbo-implementer",
        cwd: join(root, "b"),
      });
      discardPreToolGuard(guard);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("which agent a decision names (D-106 criterion 3)", () => {
  it(
    "names the role on a subagent's call and nothing on the session's own",
    async () => {
      const guard = guardFor();
      await runHook(guard.directory, bashCall(ALPHA, "ls", "toolu_n_alpha"));
      await runHook(guard.directory, bashCall(SESSION, "ls", "toolu_n_session"));
      expect(last(readPreToolDecisions(guard.decisionsPath), 2).map((each) => each.agent)).toEqual([
        "perbo-implementer",
        null,
      ]);
      discardPreToolGuard(guard);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
