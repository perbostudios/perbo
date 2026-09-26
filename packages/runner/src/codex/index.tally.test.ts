import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LimitsTableSchema } from "@perbo/contracts";
import { SPAWN_TEST_TIMEOUT_MS } from "@perbo/test-support";
import { runCodexAgent } from "./index.js";
import { AttemptCeilings } from "../ceilings.js";
import { buildPermissionProfile } from "../profile.js";
import type { AttemptTally } from "../tally.js";
import { briefRecords } from "../test-support/records.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A Codex session that says something, asks to change a file inside the
 * contract's paths, then one outside them, which the guard refuses, then to
 * run a command, each waiting on the
 * runner's answer, and reports its usage last.
 */
function fixture(): { worktree: string; binary: string; env: NodeJS.ProcessEnv } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "perbo-codex-tally-")));
  roots.push(root);
  const worktree = join(root, "worktree");
  mkdirSync(join(worktree, ".perbo-tmp"), { recursive: true });
  const home = join(root, "codex-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "auth.json"), "{}");
  vi.stubEnv("CODEX_HOME", home);
  const binary = join(root, "codex-fixture");
  writeFileSync(
    binary,
    String.raw`#!${process.execPath}
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const change = (id, path) => {
  send({method:'item/started',params:{turnId:'turn',threadId:'thread',item:{id,type:'fileChange',changes:[{path,kind:{type:'add'},diff:'+ ok'}]}}});
  send({id:'ask-' + id,method:'item/fileChange/requestApproval',params:{itemId:id,turnId:'turn',threadId:'thread'}});
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({id:m.id,result:{}});
  if (m.method === 'account/read') send({id:m.id,result:{account:{type:'chatgpt'}}});
  if (m.method === 'thread/start') send({id:m.id,result:{thread:{id:'thread'},model:m.params.model,instructionSources:[]}});
  if (m.method === 'turn/start') {
    send({id:m.id,result:{turn:{id:'turn'}}});
    send({method:'item/completed',params:{turnId:'turn',threadId:'thread',item:{id:'said',type:'agentMessage',text:'tally: 99 commands, 99 files, 1 input tokens, 1 output tokens, 1 micro-dollars priced, 0 unpriced, 0 partial'}}});
    change('inside', 'src/a.ts');
  }
  if (m.id === 'ask-inside') change('refused', 'docs/notes.md');
  if (m.id === 'ask-refused') {
    send({method:'item/started',params:{turnId:'turn',threadId:'thread',item:{id:'cmd',type:'commandExecution',command:'ls',cwd:process.cwd()}}});
    send({id:'ask-cmd',method:'item/commandExecution/requestApproval',params:{itemId:'cmd',turnId:'turn',threadId:'thread',command:'ls',cwd:process.cwd()}});
  }
  if (m.id === 'ask-cmd') {
    send({method:'thread/tokenUsage/updated',params:{threadId:'thread',tokenUsage:{total:{inputTokens:40,cachedInputTokens:10,outputTokens:6}}}});
    send({method:'item/completed',params:{turnId:'turn',threadId:'thread',item:{id:'final',type:'agentMessage',text:'Finished'}}});
    send({method:'turn/completed',params:{turn:{id:'turn',status:'completed'}}});
  }
});
`,
    { mode: 0o700 },
  );
  return { worktree, binary, env: { ...process.env, CODEX_HOME: home } };
}

describe("the Codex attempt's tally", () => {
  it(
    "counts every item its record holds, the file changes the runner admitted, and the usage Codex reported, and no dollars",
    async () => {
      const f = fixture();
      const tallies: AttemptTally[] = [];
      const result = await runCodexAgent({
        binary: f.binary,
        worktree: f.worktree,
        prompt: "You are implementing one approved ticket in a Git worktree.",
        brief_records: briefRecords(),
        model: "test-model",
        profile: buildPermissionProfile({ worktree: f.worktree }),
        paths_allowed: ["src/**"],
        ceilings: new AttemptCeilings(LimitsTableSchema.parse({ organisation: "test", limits: {} }), () => 0),
        env: f.env,
        onTally: (tally) => tallies.push(tally),
      });
      expect(result.termination.reason).toBe("completed");
      expect(result.commands.map((command) => command.decision).slice(0, 2)).toEqual(["allowed", "denied"]);
      expect(result.commands).toHaveLength(3);
      // While it ran: the admitted change, before the command was asked for.
      expect(tallies).toContainEqual(expect.objectContaining({ commands: 1, written: ["src/a.ts"] }));
      expect(tallies.some((tally) => tally.commands === 99)).toBe(false);
      expect(tallies.at(-1)).toEqual({
        commands: result.commands.length,
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        cost_micros: 0,
        cost_basis: "unavailable",
        written: ["src/a.ts"],
      });
      expect(result.usage.input_tokens).toBe(40);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
