import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { codexCommandDecision } from "./codex/index.js";
import { judgePreToolCall, type PreToolGuardState } from "./pretool.js";
import { inspectCommand } from "./prohibited.js";

const scratch = scratchDirectories("perbo-runner-");
const ROOT = realpathSync(scratch("perbo-probe-"));
mkdirSync(join(ROOT, "src"), { recursive: true });
mkdirSync(join(ROOT, "sub"), { recursive: true });
writeFileSync(join(ROOT, "notes.md"), "notes\n");

const state: PreToolGuardState = {
  root: ROOT,
  cwd: ROOT,
  tmpdir: null,
  paths_allowed: ["**"],
  paths_prohibited: [],
  allow_list: ["Bash(cat:*)"],
  deny_list: [],
};

const writes = (c: string) =>
  inspectCommand(c, { root: ROOT, home: "/Users/nobody" }).filter(
    (h) => h.action === "write_outside_worktree",
  );
const guard = (c: string) => (writes(c).length > 0 ? "refused" : "allowed");
const claude = (c: string) =>
  judgePreToolCall({ tool_name: "Bash", tool_use_id: "t", tool_input: { command: c } }, state, new Date(0))
    .decision.answer;
const codex = (c: string) => codexCommandDecision(c, ROOT, state).decision;

const LINES = [
  "echo /etc/x | xargs touch",
  "xargs -0 rm -rf < list.txt",
  "xargs touch",
  "xargs rm ~/x",
  "xargs -I{} cp {} " + ROOT + "/out",
  "xargs -0 -n1 cp -t " + ROOT + "/out",
  "xargs -J % cp % " + ROOT + "/out",
  "xargs -R 2 cp -t " + ROOT + "/out",
  "xargs -I{} rm {}",
  "xargs cp a",
  "pushd /",
  "pushd /tmp",
  "pushd / && echo x > y",
  "pushd /tmp && echo x > y",
  "cd / && echo x > y",
  "pushd /; echo x > y",
  "cat <<A <<B\nnote\nA\nnote\nB",
  "cat <<A > " + ROOT + "/x <<B\n> /etc/x\nA\ncd /tmp\nB",
  "cat <<A <<B > /tmp/x\nnote\nA\nnote\nB",
];

describe("probe", () => {
  it("prints", () => {
    for (const line of LINES) {
      const w = writes(line).map((h) => h.detail.slice(0, 110));
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({ line, guard: guard(line), claude: claude(line), codex: codex(line), w }, null, 0),
      );
    }
  });
});
