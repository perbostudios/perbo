import { z } from "zod";
import { EXIT_CODES, TicketKeySchema } from "@perbo/contracts";
import { MODEL_PROVIDERS } from "@perbo/model";
import { isAbsolute } from "node:path";
import {
  IssueReferenceSchema,
  admitDraftReport,
  defaultAdmission,
  listReport,
  type DraftAdmission,
} from "../../commands/admit.js";
import { collectOutput } from "../../diagnostics.js";
import type { CommandContext, CommandReport } from "../../command.js";
import { edit } from "../../commands/edit/index.js";
import { escapesReport } from "../../commands/escapes/index.js";
import { AttemptIdSchema, inspectReport } from "../../commands/inspect.js";
import type { ServeTick } from "../../commands/serve/index.js";
import { stopsReport, IsoInstantSchema } from "../../commands/stops.js";
import { sync } from "../../commands/sync.js";

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

/** The store this endpoint's commands work against, as their input names it. */
const targetOf = (context: ToolContext): { repo: string; store: string | null } => ({
  repo: context.repo,
  store: context.store,
});

/**
 * One command run over typed input, and what it answered as a tool result.
 *
 * Nothing is parsed on the way in and nothing is parsed on the way out: the
 * command is given the object it would have been given by a line, and its own
 * record is the structured content. What it said while it worked goes in the
 * text beside the record, which is the join a session has always read.
 *
 * The command arrives as its {@link CommandReport} half, which has no reading
 * of argv on it: there is no line here to write and none to read.
 */
async function reported<Input, Report>(
  command: CommandReport<Input, { json: boolean }, Report>,
  input: Input,
  context: ToolContext,
): Promise<ToolResult> {
  const collected = collectOutput();
  const commandContext: CommandContext = {
    cwd: context.cwd,
    now: new Date(),
    diagnostics: collected.streams,
  };
  let report: Report;
  try {
    report = await command.run(input, commandContext);
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
  const rendered = command.render(report, { json: true }, { isTTY: false, color: false, json: true });
  const structuredContent = command.toJson === undefined ? undefined : command.toJson(report);
  const stdout = `${rendered.stdout}`.trim();
  const stderr = `${collected.stderr()}${rendered.stderr}`.trim();
  const text = [stdout, stderr].filter((part) => part.length > 0).join("\n");
  return {
    content: [{ type: "text", text: text.length === 0 ? `exit ${rendered.exitCode}` : text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
    ...(rendered.exitCode === EXIT_CODES.approve ? {} : { isError: true }),
  };
}

/**
 * One command that answers while it works, and what it said as a tool result.
 *
 * It writes text rather than a record, so there is no structured content to
 * give back: its stdout and stderr are joined exactly as a session has always
 * read them.
 */
async function narrated(
  run: (
    output: { json: boolean },
    context: CommandContext & { stdout(chunk: string): void; isTTY: boolean },
  ) => Promise<number> | number,
  context: ToolContext,
): Promise<ToolResult> {
  const collected = collectOutput();
  let code: number;
  try {
    code = await run(
      { json: false },
      {
        cwd: context.cwd,
        now: new Date(),
        diagnostics: collected.streams,
        stdout: collected.streams.stdout,
        isTTY: false,
      },
    );
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
  const text = [collected.stdout().trim(), collected.stderr().trim()]
    .filter((part) => part.length > 0)
    .join("\n");
  return {
    content: [{ type: "text", text: text.length === 0 ? `exit ${code}` : text }],
    ...(code === EXIT_CODES.approve ? {} : { isError: true }),
  };
}

const KeySchema = TicketKeySchema.describe("A ticket key, e.g. PRB-118.");

/**
 * Every string a session supplies is a value and only ever a value: a command
 * is reached here as a function over typed input, and this file imports
 * nothing that reads a line (`eslint.config.mjs`). What each schema below is
 * for is what it says rather than the shape of a flag — a ticket key is a key,
 * an issue reference is one, a model id is what a provider's own CLI will be
 * started with, which is an action parameter (ADR-0023 §4).
 */
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
    reported(listReport, { target: targetOf(context), all: input.all ?? false }, context),
});

const inspectTicket = tool({
  name: "inspect_ticket",
  description:
    "One ticket in full: its contract, every attempt with its termination, cost and ceilings, the " +
    "reviews and what they routed, the pull request and its checks.",
  role: "read",
  input: z.object({
    key: KeySchema,
    attempt: AttemptIdSchema.optional().describe("An attempt id, e.g. att_0000000000000001; for that attempt alone."),
  }),
  run: (input, context) =>
    reported(
      inspectReport,
      {
        target: targetOf(context),
        key: input.key,
        attempt: input.attempt ?? null,
        verify: null,
      },
      context,
    ),
});

const stops = tool({
  name: "stops",
  description:
    "What reached a person and why: every stop the loop recorded, unattended-merge share, cost per " +
    "merged ticket, and the precision of stopping.",
  role: "read",
  input: z.object({
    since: IsoInstantSchema.optional().describe("An ISO date; stops before it are left out."),
    by_week: z.boolean().optional().describe("One row per week rather than one table."),
  }),
  run: (input, context) =>
    reported(
      stopsReport,
      {
        target: targetOf(context),
        since: input.since ?? null,
        byWeek: input.by_week ?? false,
        arm: null,
      },
      context,
    ),
});

const escapes = tool({
  name: "escapes",
  description: "Merged changes whose fourteen days are up, and what escaped review in them.",
  role: "read",
  input: z.object({}),
  run: (_input, context) => reported(escapesReport, { target: targetOf(context) }, context),
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
    provider: z.enum(MODEL_PROVIDERS).optional().describe("The drafting provider."),
    // A session's own choice reaches a provider's argv, so it is held to the
    // narrow shape a model id has, not to what a person may type at the terminal.
    model: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
      .optional()
      .describe("The drafting model id, e.g. claude-opus-5."),
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
    // `admitDraft` has no `approve` among its fields at all, so there is no
    // approving to reach from here whatever this object carries (D-072).
    const defaults = defaultAdmission(targetOf(context));
    const admission: DraftAdmission = {
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
    };
    return reported(admitDraftReport, admission, context);
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
  run: (input, context) =>
    // No editor can be reached: the fields below are required, and the
    // environment handed in names none.
    narrated(
      (output, commandContext) =>
        edit(
          {
            target: targetOf(context),
            key: input.key,
            outcome: input.outcome ?? null,
            criteria: [...(input.criteria ?? [])],
            paths: [...(input.paths ?? [])],
            // The endpoint's tool names outcome, criteria and scope; a
            // prohibited path is a person's mark in the explorer, not a field
            // a session sets.
            prohibited: [],
            clearProhibited: false,
            manualReviewer: null,
            manualReason: null,
            graphEdit: null,
            undo: null,
            // The endpoint is the person's own session: its edits are recorded
            // as the interview's, so they do not raise the friction count
            // (D-100).
            author: "interview",
          },
          output,
          { ...commandContext, env: {} },
        ),
      context,
    ),
});

const syncTicket = tool({
  name: "sync_ticket",
  description:
    "Read a ticket's pull request, merge state and checks through local gh and write them onto the " +
    "ticket. Never merges.",
  role: "write",
  input: z.object({ key: KeySchema }),
  run: (input, context) =>
    narrated(
      (_output, commandContext) =>
        sync(
          { mode: "ticket", target: targetOf(context), key: input.key, merge: false },
          commandContext,
        ),
      context,
    ),
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
