import { z } from "zod";
import { EXIT_CODES } from "@perbo/contracts";
import { isAbsolute } from "node:path";
import { parseAdmitArgs, parseListArgs, runAdmitCommand, runListCommand, type AdmitArgs } from "./admit.js";
import { runEdit, type EditArgs } from "./edit.js";
import { runEscapesCommand } from "./escapes.js";
import { runInspectCommand } from "./inspect.js";
import type { ServeTick } from "./serve.js";
import { runStopsCommand } from "./stops.js";
import type { Streams } from "./streams.js";
import { runSyncCommand } from "./sync.js";

/**
 * The tools the queue's endpoint offers a session (the founder's decision of
 * 2026-09-10; paseo's mechanism, Perbo's authority).
 *
 * Each tool is one of this build's own commands, run in this process with
 * the arguments a person would type, built as values, so the endpoint cannot
 * do anything the command line cannot and says everything in the same words. Two roles: a
 * **read** tool is offered to every token; a **write** tool — admission, an
 * edit, a sync, the queue's pause — to the person's token alone.
 *
 * Three acts are not tools and cannot become ones by any input here:
 * `approve`, which is D-072's boundary; `--publish`, the flag a person types
 * per run; and any merge. A session prepares everything and the person's
 * keystroke is what the product waits for.
 */

/** The acts no tool name may carry, asserted by the endpoint's own test. */
export const PERSON_ONLY_ACTS = ["approve", "publish", "merge", "run"] as const;

export type ToolRole = "read" | "write";

/** What the queue lets the endpoint read and touch, supplied by `serve`. */
export interface QueueSurface {
  state(): { paused: boolean; tick: ServeTick | null };
  pause(): void;
  resume(): void;
}

export interface ToolContext {
  /** The store, absolute. */
  dir: string;
  /** Where the commands are run from, so a relative `--repo` means what it meant to `serve`. */
  cwd: string;
  repo: string;
  store: string | null;
  queue: QueueSurface;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface EndpointTool<Input extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  role: ToolRole;
  input: Input;
  /** The schema a client is shown, where the zod schema's own rendering says less than the check on the way in. */
  schema?: Record<string, unknown>;
  run(input: z.infer<Input>, context: ToolContext): Promise<ToolResult>;
}

/** One tool, typed by its own schema on the way in and widened on the way out. */
function tool<Input extends z.ZodType>(definition: EndpointTool<Input>): EndpointTool {
  return definition as unknown as EndpointTool;
}

const repoArgs = (context: ToolContext): string[] => [
  "--repo",
  context.repo,
  ...(context.store === null ? [] : ["--store", context.store]),
];

/**
 * Run one command with its streams captured, and turn what it wrote into a
 * tool result: the JSON it printed as the structured content where it printed
 * one, everything else as text, and its exit code as the error flag.
 */
async function captured(
  json: boolean,
  command: (streams: Streams) => number | Promise<number>,
): Promise<ToolResult> {
  const out: string[] = [];
  const err: string[] = [];
  const streams: Streams = {
    stdout: (chunk) => out.push(chunk),
    stderr: (chunk) => err.push(chunk),
    isTTY: false,
  };
  let code: number;
  try {
    code = await command(streams);
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
  const stdout = out.join("");
  const stderr = err.join("").trim();
  let structuredContent: unknown;
  if (json && stdout.trim().length > 0) {
    try {
      structuredContent = JSON.parse(stdout);
    } catch {
      // Not the JSON the command promised: the text below still carries it.
    }
  }
  const text = [stdout.trim(), stderr].filter((part) => part.length > 0).join("\n");
  return {
    content: [{ type: "text", text: text.length === 0 ? `exit ${code}` : text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
    ...(code === EXIT_CODES.approve ? {} : { isError: true }),
  };
}

const KeySchema = z.string().regex(/^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,6}$/).describe("A ticket key, e.g. PRB-118.");

/**
 * Every string a session supplies is a value and only ever a value. The
 * commands' own parsers split `--name=value` tokens wherever they appear, so a
 * value shaped like one would become a flag if it went through them as argv —
 * `--x=--approve` once approved a ticket that way. So the two commands that
 * take free text get their arguments built as objects, and everything that
 * does travel as argv is shaped by a schema that admits no leading dash.
 */
const AttemptIdSchema = z.string().regex(/^att_[0-9a-f]+$/).describe("An attempt id, e.g. att_0000000000000001.");
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[0-9:.]+Z?)?$/).describe("An ISO date, e.g. 2026-09-01.");
const IssueReferenceSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*#[1-9][0-9]*$/)
  .describe("owner/repo#N.");
const ModelIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).describe("A model id, e.g. claude-opus-5.");
const AbsoluteFileSchema = z
  .string()
  .refine((path) => isAbsolute(path) && !path.startsWith("-"), "an absolute path")
  .describe("An absolute path to the file.");

const listTickets = tool({
  name: "list_tickets",
  description:
    "Every admitted ticket and where each is: key, state, priority, dependencies, what it waits on, " +
    "and its delivery record. Active tickets by default; `all` includes merged and cancelled ones.",
  role: "read",
  input: z.object({ all: z.boolean().optional().describe("Include settled tickets.") }),
  run: (input, context) =>
    captured(true, (streams) =>
      runListCommand({
        args: parseListArgs([...repoArgs(context), "--json", ...(input.all ? ["--all"] : [])]),
        streams,
        cwd: context.cwd,
      }),
    ),
});

const inspectTicket = tool({
  name: "inspect_ticket",
  description:
    "One ticket in full: its contract, every attempt with its termination, cost and ceilings, the " +
    "reviews and what they routed, the pull request and its checks.",
  role: "read",
  input: z.object({
    key: KeySchema,
    attempt: AttemptIdSchema.optional().describe("One attempt id, for that attempt alone."),
  }),
  run: (input, context) =>
    captured(true, (streams) =>
      runInspectCommand({
        argv: [input.key, ...repoArgs(context), "--json", ...(input.attempt ? ["--attempt", input.attempt] : [])],
        streams,
        cwd: context.cwd,
      }),
    ),
});

const stops = tool({
  name: "stops",
  description:
    "What reached a person and why: every stop the loop recorded, unattended-merge share, cost per " +
    "merged ticket, and the precision of stopping.",
  role: "read",
  input: z.object({
    since: IsoDateSchema.optional().describe("An ISO date; stops before it are left out."),
    by_week: z.boolean().optional().describe("One row per week rather than one table."),
  }),
  run: (input, context) =>
    captured(true, (streams) =>
      runStopsCommand({
        argv: [...repoArgs(context), "--json", ...(input.since ? ["--since", input.since] : []), ...(input.by_week ? ["--by-week"] : [])],
        streams,
        cwd: context.cwd,
      }),
    ),
});

const escapes = tool({
  name: "escapes",
  description: "Merged changes whose fourteen days are up, and what escaped review in them.",
  role: "read",
  input: z.object({}),
  run: (_input, context) =>
    captured(true, (streams) => runEscapesCommand({ argv: [...repoArgs(context), "--json"], streams, cwd: context.cwd })),
});

const queueState = tool({
  name: "queue_state",
  description:
    "The queue's last tick as `perbo serve --json` printed it — order, who waits on what, what " +
    "started — and whether the queue is paused.",
  role: "read",
  input: z.object({}),
  run: async (_input, context) => {
    const state = context.queue.state();
    return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }], structuredContent: state };
  },
});

const admitTicket = tool({
  name: "admit_ticket",
  description:
    "Admit one piece of work as a ticket in plan_review: typed (`outcome`, `criteria`, `paths`), or " +
    "drafted by a model from a tracker issue (`from`) or a file (`from_file`). Nothing runs from it; " +
    "a person edits and approves the contract. This tool cannot approve.",
  role: "write",
  input: z.object({
    outcome: z.string().min(1).optional().describe("One sentence: what will be true afterwards."),
    criteria: z
      .array(z.string())
      .optional()
      .describe('Each "what must be proven :: the assertion that proves it [:: test|artifact|query|metric]".'),
    paths: z.array(z.string()).optional().describe("Globs the change may touch, e.g. packages/auth/**."),
    prohibit: z.array(z.string()).optional().describe("Globs the change must not touch."),
    generated: z.array(z.string()).optional().describe("Globs exempt from scope accounting: lockfiles, codegen."),
    from: IssueReferenceSchema.optional().describe("owner/repo#N: draft the contract from that issue."),
    from_file: AbsoluteFileSchema.optional().describe("An absolute path: draft the contract from that file."),
    provider: z.enum(["anthropic", "claude-cli", "codex-cli"]).optional().describe("The drafting provider."),
    model: ModelIdSchema.optional().describe("The drafting model id."),
    priority: z.enum(["urgent", "high", "normal", "low"]).optional(),
    labels: z.array(z.string()).optional(),
    depends_on: z.array(KeySchema).optional().describe("Tickets that must merge first."),
    approve: z.boolean().optional().describe("Refused: approval is the person's keystroke."),
  }),
  run: (input, context) => {
    if (input.approve) {
      return Promise.resolve({
        content: [
          {
            type: "text",
            text: "approval is a person's own keystroke and this endpoint has no tool for it: admit the draft, then `perbo approve <key>` at the terminal or the contract page.",
          },
        ],
        isError: true,
      });
    }
    // Built as values, never parsed from a line: see the note above the schemas.
    const defaults = parseAdmitArgs([...repoArgs(context), "--json"]);
    const args: AdmitArgs = {
      ...defaults,
      title: input.outcome ?? null,
      criteria: [...(input.criteria ?? [])],
      paths: [...(input.paths ?? [])],
      // Appended to the command's own defaults, as a typed `--prohibit` or
      // `--generated` is: the standing prohibitions and the generated globs
      // are what the terminal gives every contract, and this gives no less.
      prohibited: [...defaults.prohibited, ...(input.prohibit ?? [])],
      generated: [...defaults.generated, ...(input.generated ?? [])],
      from: input.from ?? null,
      fromFile: input.from_file ?? null,
      provider: input.provider ?? defaults.provider,
      model: input.model ?? null,
      priority: input.priority ?? defaults.priority,
      labels: [...(input.labels ?? [])],
      dependsOn: [...(input.depends_on ?? [])],
      approve: false,
      json: true,
    };
    if (args.approve) throw new Error("the endpoint cannot approve");
    return captured(true, (streams) => runAdmitCommand({ args, streams, cwd: context.cwd }));
  },
});

const EditTicketInputSchema = z
  .object({
    key: KeySchema,
    outcome: z.string().min(1).optional(),
    criteria: z.array(z.string().min(1)).optional().describe("Replaces the criteria; same shape as admit_ticket's."),
    paths: z.array(z.string().min(1)).optional().describe("Replaces the allowed globs."),
  })
  .refine(
    (input) => input.outcome !== undefined || (input.criteria?.length ?? 0) > 0 || (input.paths?.length ?? 0) > 0,
    "name at least one of outcome, criteria or paths: the endpoint has no editor to open",
  );

const editTicket = tool({
  name: "edit_ticket",
  description:
    "Change an unapproved contract's outcome, criteria or scope. Refused once the contract is approved.",
  role: "write",
  input: EditTicketInputSchema,
  // What the zod refine checks on the way in, said to the client too.
  schema: {
    ...z.toJSONSchema(EditTicketInputSchema),
    anyOf: [{ required: ["outcome"] }, { required: ["criteria"] }, { required: ["paths"] }],
  },
  run: (input, context) => {
    const args: EditArgs = {
      repo: context.repo,
      store: context.store,
      outcome: input.outcome ?? null,
      criteria: [...(input.criteria ?? [])],
      paths: [...(input.paths ?? [])],
      // The endpoint's tool names outcome, criteria and scope; a prohibited
      // path is a person's mark in the explorer, not a field a session sets.
      prohibited: [],
      manualReviewer: null,
      manualReason: null,
      graphEdit: null,
      undo: null,
      // The endpoint is the person's own session: its edits are recorded as
      // the interview's, so they do not raise the friction count (D-100).
      author: "interview",
      json: false,
    };
    // No editor can be reached: the fields above are required, and the
    // environment handed in names none.
    return captured(false, (streams) => runEdit({ key: input.key, args, streams, cwd: context.cwd, env: {} }));
  },
});

const syncTicket = tool({
  name: "sync_ticket",
  description:
    "Read a ticket's pull request, merge state and checks through local gh and write them onto the " +
    "ticket. Never merges.",
  role: "write",
  input: z.object({ key: KeySchema }),
  run: (input, context) =>
    captured(false, (streams) => runSyncCommand({ argv: [input.key, ...repoArgs(context)], streams, cwd: context.cwd })),
});

const queuePause = tool({
  name: "queue_pause",
  description: "Stop the queue starting anything new. Runs already going finish; syncs continue.",
  role: "write",
  input: z.object({}),
  run: async (_input, context) => {
    context.queue.pause();
    return { content: [{ type: "text", text: "paused: nothing new starts until queue_resume" }] };
  },
});

const queueResume = tool({
  name: "queue_resume",
  description: "Let the queue start work again.",
  role: "write",
  input: z.object({}),
  run: async (_input, context) => {
    context.queue.resume();
    return { content: [{ type: "text", text: "resumed" }] };
  },
});

/** Every tool, reads first, in the order a client lists them. */
export const ENDPOINT_TOOLS: readonly EndpointTool[] = [
  listTickets,
  inspectTicket,
  stops,
  escapes,
  queueState,
  admitTicket,
  editTicket,
  syncTicket,
  queuePause,
  queueResume,
];

/** The tools a role may see and call. */
export function toolsFor(role: ToolRole): readonly EndpointTool[] {
  return role === "write" ? ENDPOINT_TOOLS : ENDPOINT_TOOLS.filter((tool) => tool.role === "read");
}

/**
 * What a session launched by `perbo agent` is told about Perbo before its
 * first turn. Appended to the provider's own system prompt; the person's own
 * configuration still applies.
 */
export function agentOrientation(input: { repo: string }): string {
  return `You are working beside a person in ${input.repo}, a repository run by Perbo (the \`perbo\` command).
Perbo takes a ticket from an approved contract to a pull request on this machine: a person admits work
as a ticket (state plan_review), edits and approves its contract (ready), the queue runs it — a worktree,
one coding agent under a permission profile, a sealed change set, the pinned checks, an independent
review, bounded remediation — and opens a pull request (pr_open); \`sync\` records the merge (merged).
A ticket waits (blocked) while a dependency is unmerged or a ticket ahead in the queue holds a scope it
reaches; the queue keeps open branches level with the base and re-levels them after each merge.

Through the \`perbo\` tool server you can read every ticket, its attempts, reviews, stops and escapes,
and the queue's state; admit tickets as drafts; edit an unapproved contract; sync a ticket's pull
request; pause and resume the queue. Three acts are the person's alone and have no tool: approving a
contract, publishing a run, and merging. Prepare those and say what is ready for their keystroke.
State names and numbers come from the tools, never from memory.`;
}
