import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { EXIT_CODES } from "@perbo/contracts";
import { PRINCIPLES_FILENAME } from "@perbo/runner";
import { UsageError, readInput } from "../usage-error.js";
import {
  parseArgv,
  valueFlag,
  type FlagTable,
  type Grammar,
} from "../command-line/grammar.js";
import type { CommandContext, Rendered } from "../command.js";
import type { ReportCommand } from "../command-line/terminal.js";
import { StoreTargetSchema, storeFor, type StoreTarget } from "../store/index.js";

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

/** The two things this command does: write one answer down, or read them back. */
export const PRINCIPLE_VERBS = ["add", "list"] as const;
export type PrincipleVerb = (typeof PRINCIPLE_VERBS)[number];

export const PrincipleInputSchema = z.discriminatedUnion("verb", [
  z.strictObject({
    verb: z.literal("add"),
    target: StoreTargetSchema,
    /** What the product should do, as one sentence a later brief reads. */
    text: z.string().trim().min(1, "principle add needs the principle's text as its one argument"),
  }),
  z.strictObject({ verb: z.literal("list"), target: StoreTargetSchema }),
]);
export type PrincipleInput = z.infer<typeof PrincipleInputSchema>;

/** What the command did, and the file it did it to. */
export type PrincipleReport =
  | { readonly verb: "add"; readonly path: string }
  /** `text` is null where nothing has been recorded in this store yet. */
  | { readonly verb: "list"; readonly path: string; readonly text: string | null };

/**
 * The file in the store the target names, through {@link storeFor} like every
 * other path this edge resolves: an empty `--store` is the store the
 * repository holds, and a relative one is resolved rather than left to be read
 * against whatever directory the process is standing in. A principle written
 * anywhere else is one the executor's brief never reads.
 */
export function principlesPath(cwd: string, target: StoreTarget): string {
  return join(storeFor(cwd, target), PRINCIPLES_FILENAME);
}

export function principle(input: PrincipleInput, context: CommandContext): PrincipleReport {
  const path = principlesPath(context.cwd, input.target);
  if (input.verb === "list") {
    return { verb: "list", path, text: existsSync(path) ? readFileSync(path, "utf8") : null };
  }
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, HEADER);
  const date = context.now.toISOString().slice(0, 10);
  appendFileSync(path, `\n- (${date}) ${input.text.trim().replace(/\n+/g, " ")}\n`);
  return { verb: "add", path };
}

const FLAGS = {
  "--repo": valueFlag(),
  "--store": valueFlag(),
} satisfies FlagTable;

const ADD_GRAMMAR: Grammar<typeof FLAGS> = {
  command: "principle add",
  flags: FLAGS,
  positionals: {
    min: 1,
    max: 1,
    /**
     * One argument, because the text is one sentence. Text beginning with a
     * dash goes after `--`, which the desktop cannot reach: it appends
     * `--repo` last, so what it records can never start with one (SCP-091).
     */
    refusal:
      'principle add needs the principle\'s text as its one argument, e.g. perbo principle add ' +
      '"perbo list shows open tickets; finished ones need --all."',
  },
  afterDoubleDash: "positionals",
};

const LIST_GRAMMAR: Grammar<typeof FLAGS> = {
  command: "principle list",
  flags: FLAGS,
  positionals: {
    min: 0,
    max: 0,
    refusal: "principle list takes no argument: it prints what is recorded, e.g. perbo principle list",
  },
  afterDoubleDash: "positionals",
};

const VERB_USAGE =
  'usage: perbo principle add "<what the product should do>" | perbo principle list';

/**
 * The verb's own grammar, so the whole of the rest of the line is read by it.
 *
 * A line naming no verb is read by `add`'s, and refused by {@link read}: a
 * `perbo principle --help` is a person asking what the command takes, and
 * answering it with a refusal would be answering a different question.
 */
const grammarFor = (argv: readonly string[]): Grammar =>
  argv[0] === "list" ? LIST_GRAMMAR : ADD_GRAMMAR;

export const principleCommandLine: ReportCommand<
  PrincipleInput,
  { json: boolean },
  PrincipleReport
> = {
  kind: "report",
  name: "principle",
  grammars: [ADD_GRAMMAR, LIST_GRAMMAR],
  jsonWhenPiped: false,
  grammarFor,
  read(argv) {
    const verb = argv[0];
    if (verb !== "add" && verb !== "list") throw new UsageError(VERB_USAGE);
    const line = parseArgv(verb === "list" ? LIST_GRAMMAR : ADD_GRAMMAR, argv.slice(1));
    const target = { repo: line.flags["--repo"] ?? ".", store: line.flags["--store"] ?? null };
    return {
      input: readInput(
        PrincipleInputSchema,
        verb === "list" ? { verb, target } : { verb, target, text: line.positionals[0] },
      ),
      output: { json: false },
    };
  },
  run: principle,
  render(report): Rendered {
    if (report.verb === "add") {
      return { stdout: "", stderr: `recorded in ${report.path}\n`, exitCode: EXIT_CODES.approve };
    }
    return report.text === null
      ? {
          stdout: "",
          stderr: `no principles recorded (${report.path} does not exist)\n`,
          exitCode: EXIT_CODES.approve,
        }
      : { stdout: report.text, stderr: "", exitCode: EXIT_CODES.approve };
  },
};
