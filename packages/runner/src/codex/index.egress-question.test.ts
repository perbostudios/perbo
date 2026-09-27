import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LimitsTableSchema } from "@perbo/contracts";
import { SPAWN_TEST_TIMEOUT_MS } from "@perbo/test-support";
import { runCodexAgent } from "./index.js";
import { ADMISSION_RULES } from "../admission.js";
import { AttemptCeilings } from "../ceilings.js";
import type { EgressGate, EgressVerdict } from "../egress.js";
import { buildPermissionProfile } from "../profile.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * An unlisted host on a command Codex asks approval for
 * (D-NEW-an-unlisted-host-asks): the approval is held while the gate is
 * asked, accepted on an allow, declined on a refusal with the executor told
 * why on its own thread, and the attempt ends `unlisted_egress_host` only where
 * nobody answers.
 */

const HOST = "googlechromelabs.github.io";
const OTHER = "storage.googleapis.com";
const fetchFrom = (host: string) => `npx @puppeteer/browsers install chrome@stable --base-url https://${host}/chrome`;

/** A Codex session that asks approval for one command per host, in order, and logs what it was answered and told. */
function fixture(hosts: readonly string[]): { worktree: string; binary: string; env: NodeJS.ProcessEnv; log: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "perbo-codex-egress-")));
  roots.push(root);
  const worktree = join(root, "worktree");
  mkdirSync(join(worktree, ".perbo-tmp"), { recursive: true });
  const home = join(root, "codex-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "auth.json"), "{}");
  vi.stubEnv("CODEX_HOME", home);
  const log = join(root, "answers.jsonl");
  const binary = join(root, "codex-fixture");
  writeFileSync(
    binary,
    String.raw`#!${process.execPath}
const readline = require('node:readline');
const { appendFileSync } = require('node:fs');
const COMMANDS = ${JSON.stringify(hosts.map(fetchFrom))};
const WORKTREE = ${JSON.stringify(worktree)};
const LOG = ${JSON.stringify(log)};
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const ask = (index) => {
  const id = 'cmd' + index;
  const command = COMMANDS[index];
  send({method:'item/started',params:{turnId:'turn',threadId:'thread',item:{id,type:'commandExecution',command,cwd:WORKTREE}}});
  send({id:'ask-' + index,method:'item/commandExecution/requestApproval',params:{itemId:id,turnId:'turn',threadId:'thread',command,cwd:WORKTREE}});
};
const finish = () => {
  send({method:'item/completed',params:{turnId:'turn',threadId:'thread',item:{id:'final',type:'agentMessage',text:'Finished'}}});
  send({method:'turn/completed',params:{turn:{id:'turn',status:'completed'}}});
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({id:m.id,result:{}});
  if (m.method === 'account/read') send({id:m.id,result:{account:{type:'chatgpt'}}});
  if (m.method === 'thread/start') send({id:m.id,result:{thread:{id:'thread'},model:m.params.model,instructionSources:[]}});
  if (m.method === 'thread/inject_items') {
    appendFileSync(LOG, JSON.stringify({told: m.params.threadId, text: m.params.items[0].text}) + '\n');
    send({id:m.id,result:{}});
  }
  if (m.method === 'turn/start') {
    send({id:m.id,result:{turn:{id:'turn'}}});
    ask(0);
  }
  if (typeof m.id === 'string' && m.id.startsWith('ask-')) {
    const index = Number(m.id.slice(4));
    appendFileSync(LOG, JSON.stringify({answered: index, decision: m.result.decision}) + '\n');
    if (index + 1 < COMMANDS.length) ask(index + 1);
    else setTimeout(finish, 200);
  }
});
`,
    { mode: 0o700 },
  );
  return { worktree, binary, env: { ...process.env, CODEX_HOME: home }, log };
}

function gate(answers: EgressVerdict[], delay_ms = 0) {
  const asked: Array<{ host: string; command: string }> = [];
  const gate: EgressGate = {
    ask: async ({ host, command }) => {
      asked.push({ host, command });
      await new Promise((resolve) => setTimeout(resolve, delay_ms));
      return answers.shift() ?? { answer: "refuse", tell: "closed" };
    },
  };
  return { gate, asked };
}

async function attempt(hosts: readonly string[], egress: EgressGate, stall_ms = 20 * 60_000) {
  const f = fixture(hosts);
  const result = await runCodexAgent({
    binary: f.binary,
    worktree: f.worktree,
    prompt: "Fetch the pinned browser.",
    model: "test-model",
    profile: buildPermissionProfile({ worktree: f.worktree, provider: "codex-cli" }),
    ceilings: new AttemptCeilings(LimitsTableSchema.parse({ organisation: "test", limits: { attempt_stall_ms: stall_ms } })),
    env: f.env,
    egress,
  });
  const lines = existsSync(f.log)
    ? readFileSync(f.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
  return { result, lines };
}

describe("an unlisted host on a Codex command", () => {
  it(
    "holds the approval and asks, with the host and the whole command, and accepts it on an allow",
    async () => {
      const { gate: asking, asked } = gate([{ answer: "allow" }]);
      const { result, lines } = await attempt([HOST], asking);
      expect(asked).toEqual([{ host: HOST, command: fetchFrom(HOST) }]);
      expect(lines).toContainEqual({ answered: 0, decision: "accept" });
      expect(result.termination.reason).toBe("completed");
      expect(result.commands[0]).toMatchObject({ decision: "allowed", decided_by: "runner_admission" });
      expect(result.egress.all()).toEqual([expect.objectContaining({ host: HOST, decision: "allowed" })]);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "declines it on a refusal and tells the executor, on the thread that asked, what the gate said",
    async () => {
      const tell = "A person refused it. The network is closed for the rest of this run. Finish the work without it.";
      const { result, lines } = await attempt([HOST], gate([{ answer: "refuse", tell }]).gate);
      expect(lines).toContainEqual({ answered: 0, decision: "decline" });
      expect(lines).toContainEqual({ told: "thread", text: tell });
      expect(result.termination.reason).toBe("completed");
      expect(result.commands[0]).toMatchObject({
        decision: "denied",
        denial_rule: ADMISSION_RULES.egress,
        denial_target: HOST,
        denial_reason: tell,
      });
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "asks the gate about a second host too, which refuses it without a person, and records both",
    async () => {
      const { gate: asking, asked } = gate([
        { answer: "refuse", tell: "refused" },
        { answer: "refuse", tell: "the network is closed for the rest of this run" },
      ]);
      const { result, lines } = await attempt([HOST, OTHER], asking);
      expect(asked.map((each) => each.host)).toEqual([HOST, OTHER]);
      expect(lines.filter((line) => "answered" in line)).toEqual([
        { answered: 0, decision: "decline" },
        { answered: 1, decision: "decline" },
      ]);
      expect(result.egress.denied().map((record) => record.host).sort()).toEqual([OTHER, HOST].sort());
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "ends the attempt unlisted_egress_host where nobody answers",
    async () => {
      const detail = `${HOST} is not on the resolved allow-list, and nobody answered whether to allow it within 20 minute(s)`;
      const { result } = await attempt([HOST], gate([{ answer: "unanswered", detail }]).gate);
      expect(result.termination).toEqual({ reason: "unlisted_egress_host", detail });
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "is not a stall while the approval is held",
    async () => {
      const { result } = await attempt([HOST], gate([{ answer: "allow" }], 9_000).gate, 4_000);
      expect(result.termination.reason).toBe("completed");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
