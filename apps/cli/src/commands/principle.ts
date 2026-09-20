import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PRINCIPLES_FILENAME } from "@perbo/runner";
import { UsageError } from "../usage-error.js";
import { DEFAULT_STORE_DIRNAME } from "../store/tickets.js";

/**
 * `perbo principle` — the D-065 ratchet's human side.
 *
 * Every time a question stops for a person that no determinable practice
 * answers, the answer is recorded here, and every later executor brief
 * consults it — so the same question is never asked twice and the category of
 * things that must stop shrinks by accumulation. The file is written only by
 * this command: the runner's prohibited paths refuse the agent every write
 * under `.perbo/**`, so principles are always a person's.
 */

const HEADER = `# Product principles

Recorded answers to questions no determinable practice could settle.
Each entry states what the product should do; the executor consults these and
they never widen scope, weaken security, or excuse a failing check.
`;

export interface PrincipleArgs {
  action: "add" | "list";
  text: string | null;
  repo: string;
  store: string | null;
}

export function parsePrincipleArgs(argv: string[]): PrincipleArgs {
  const [action, ...rest] = argv;
  if (action !== "add" && action !== "list") {
    throw new UsageError("usage: perbo principle add \"<what the product should do>\" | perbo principle list");
  }
  const args: PrincipleArgs = { action, text: null, repo: ".", store: null };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (token === "--") {
      // End of options: everything after is the principle's text, even when it
      // starts with a dash.
      const remainder = rest.slice(i + 1).join(" ").trim();
      if (remainder.length > 0 && args.text === null) args.text = remainder;
      break;
    }
    if (token === "--repo") {
      const next = rest[++i];
      if (!next) throw new UsageError("--repo requires a value");
      args.repo = next;
    } else if (token === "--store") {
      const next = rest[++i];
      if (!next) throw new UsageError("--store requires a value");
      args.store = next;
    } else if (!token.startsWith("--") && args.text === null) {
      args.text = token;
    } else {
      throw new UsageError(`unknown argument '${token}'`);
    }
  }
  if (args.action === "add" && (args.text === null || args.text.trim().length === 0)) {
    throw new UsageError("principle add needs the principle's text as its one argument");
  }
  return args;
}

export function principlesPath(args: PrincipleArgs): string {
  return join(args.store ?? join(resolve(args.repo), DEFAULT_STORE_DIRNAME), PRINCIPLES_FILENAME);
}

export function runPrincipleCommand(args: PrincipleArgs): number {
  const path = principlesPath(args);
  if (args.action === "list") {
    if (!existsSync(path)) {
      process.stderr.write(`no principles recorded (${path} does not exist)\n`);
      return 0;
    }
    process.stdout.write(readFileSync(path, "utf8"));
    return 0;
  }
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, HEADER);
  const date = new Date().toISOString().slice(0, 10);
  appendFileSync(path, `\n- (${date}) ${args.text!.trim().replace(/\n+/g, " ")}\n`);
  process.stderr.write(`recorded in ${path}\n`);
  return 0;
}
