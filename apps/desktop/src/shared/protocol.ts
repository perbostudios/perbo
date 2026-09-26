import { z } from "zod";
import {
  CriterionIdSchema,
  DECISION_CHOICES,
  EffortLevelSchema,
  ExecutorSkillsSchema,
  GraphEditSchema,
  MaterializationEntrySchema,
  MAX_QUESTION_GROUPS,
  MAX_QUESTION_OPTIONS,
  MAX_QUESTION_PARTS,
  StandingProhibitedEntrySchema,
  TICKET_NAME_CAP,
  type DecisionChoice,
  type GraphEdge,
  type SizeEstimate,
  type StandingProhibitedEntry,
  type VerificationKind,
} from "@perbo/contracts/browser";
import type {
  CoverageStatus,
  ExportKind,
  PlanContract,
  ReviewArtifact,
  RunBundle,
  Ticket,
  VerificationStrength,
} from "@perbo/contracts";
import type { ImpactReport, SpecField } from "@perbo/planning/browser";
import { DriftFindingSchema, MAX_DRIFT_FINDINGS } from "@perbo/planning/browser";
import { BindingSchema, ShortcutActionSchema } from "./shortcuts.js";

/**
 * A record Perbo keeps between launches — the host's state file, and the
 * sample host's planning records in its browser storage — read against the schema
 * it is kept by, and refused whole where it does not match. The error names
 * where it was read from and each field that failed, with Zod's own words for
 * why: a failure repeated across a list's entries is named once, with every
 * index it holds at, and the error ends on what the person can do about it.
 */
export function parseStored<S extends z.ZodType>(schema: S, value: unknown, where: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  // Keyed by the path with its indexes taken out, and the message; each index
  // position collects the indexes the failure holds at.
  const groups = new Map<string, { path: (string | Set<number>)[]; message: string }>();
  for (const issue of parsed.error.issues) {
    const id = JSON.stringify([issue.path.map((part) => (typeof part === "number" ? "#" : String(part))), issue.message]);
    const group = groups.get(id) ?? {
      path: issue.path.map((part) => (typeof part === "number" ? new Set<number>() : String(part))),
      message: issue.message,
    };
    issue.path.forEach((part, at) => {
      if (typeof part === "number") (group.path[at] as Set<number>).add(part);
    });
    groups.set(id, group);
  }
  const fields = [...groups.values()]
    .map(({ path, message }) => {
      const named = path.map((part) => (typeof part === "string" ? `.${part}` : `[${[...part].join(",")}]`)).join("").replace(/^\./, "");
      return `${named || "(the whole record)"}: ${message}`;
    })
    .join("; ");
  throw new Error(`${where} holds a record Perbo cannot read — ${fields}. Correct the field or move the file aside.`);
}

const identifier = z.string().uuid();
const key = z.string().regex(/^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,6}$/);
const text = z.string().trim().min(1).max(12_000);
/** The four moments the loop may interrupt a person (S6F). */
export const NotifyOnSchema = z.strictObject({
  decision: z.boolean().default(true),
  review: z.boolean().default(true),
  ceiling: z.boolean().default(true),
  stage: z.boolean().default(false),
});
export type NotifyOn = z.infer<typeof NotifyOnSchema>;
export const AfkSchema = z.strictObject({
  holdSleep: z.boolean().default(false),
  displaySleep: z.boolean().default(true),
  releaseOnBattery: z.boolean().default(true),
});
export type Afk = z.infer<typeof AfkSchema>;
export const SettingsSchema = z.strictObject({
  name: z.string().trim().max(60).default(""),
  onboardingComplete: z.boolean().default(false),
  executorProvider: z.enum(["claude-cli", "codex-cli"]).default("claude-cli"),
  executorSkills: ExecutorSkillsSchema.default([]),
  executorModel: z.string().trim().min(1).max(100).default("claude-opus-5"),
  reviewerModel: z.string().trim().min(1).max(100).default("claude-opus-5"),
  reviewerProvider: z
    .enum(["claude-cli", "codex-cli", "anthropic"])
    .default("claude-cli"),
  /**
   * How hard each role's model thinks, from the levels its catalog row offers
   * (`EFFORT_LEVELS` in `packages/contracts/src/effort.ts`). Null sends nothing on Claude
   * Code; Codex starts at medium and the API at high.
   */
  executorEffort: EffortLevelSchema.nullable().default(null),
  reviewerEffort: EffortLevelSchema.nullable().default(null),
  draftingProvider: z.enum(["claude-cli", "codex-cli"]).default("claude-cli"),
  /**
   * Minutes without tool activity before a run is stopped (D-096). The one
   * setting here that stops a run: nothing bounds how long one takes, what it
   * spends or how many commands it runs.
   */
  stallMinutes: z.number().int().min(1).max(240).default(20),
  /** The pre-D-096 wall clock, kept so an older profile parses; nothing reads it. */
  minutes: z.number().int().min(1).max(120).default(30),
  /** The pre-D-096 command ceiling, kept so an older profile parses; nothing reads it. */
  commands: z.number().int().min(1).max(1000).default(200),
  /** The ticket's cost cap, which binds only an executor billed per token (D-096). */
  ticketDollars: z.number().min(0.1).max(1000).default(60),
  /** The pre-v2 master switch, kept so an older profile parses; `notifyOn` is the setting. */
  notifications: z.boolean().default(false),
  notifyOn: NotifyOnSchema.default({ decision: true, review: true, ceiling: true, stage: false }),
  notifySound: z.boolean().default(false),
  theme: z.enum(["light", "dark", "system"]).default("system"),
  textSize: z.enum(["small", "default", "large"]).default("default"),
  reduceMotion: z.boolean().default(false),
  afk: AfkSchema.default({ holdSleep: false, displaySleep: true, releaseOnBattery: true }),
  shortcuts: z.partialRecord(ShortcutActionSchema, BindingSchema).default({}),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const TaskModelsSchema = SettingsSchema.pick({
  executorProvider: true,
  executorModel: true,
  reviewerProvider: true,
  reviewerModel: true,
  draftingProvider: true,
  executorSkills: true,
}).extend({
  executorEffort: EffortLevelSchema.nullable(),
  reviewerEffort: EffortLevelSchema.nullable(),
});
export type TaskModels = z.infer<typeof TaskModelsSchema>;
export const ModelProviderSchema = z.enum([
  "claude-cli",
  "codex-cli",
  "anthropic",
]);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;
export const ProviderModelSchema = z.strictObject({
  id: z.string().trim().min(1).max(100),
  label: z.string().min(1).max(200),
  description: z.string().max(2000),
  isDefault: z.boolean(),
  /** The effort levels the provider reports for this model, lowest first; none where it reports none. */
  efforts: z.array(EffortLevelSchema),
});
export type ProviderModel = z.infer<typeof ProviderModelSchema>;
export const ModelCatalogSchema = z.strictObject({
  provider: ModelProviderSchema,
  models: z.array(ProviderModelSchema),
  source: z.enum([
    "claude-code",
    "codex-app-server",
    "anthropic-api",
    "sample",
  ]),
  discoveredAt: z.string().datetime(),
});
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;
export const CriterionSchema = z.strictObject({
  text,
  assertion: text,
  kind: z.enum(["test", "query", "metric", "artifact"]),
});
export const DraftSchema = z.strictObject({
  outcome: text,
  criteria: z.array(CriterionSchema).min(1),
  paths: z.array(z.string().trim().min(1).max(300)).min(1),
  /** Paths the executor may not write even inside the allowed ones (D-105); admission passes each as `--prohibit`. */
  prohibited: z.array(z.string().trim().min(1).max(300)).default([]),
});
export type Draft = z.infer<typeof DraftSchema>;
/**
 * The five sections of a spec as the Spec pane edits them, each as the text a
 * person typed (D-103). The requirement ids are assigned when the file is
 * written, so they arrive back on {@link SpecView} rather than travelling here.
 */
export const SpecSectionsSchema = z.strictObject({
  outcome: z.string().max(12_000),
  requirements: z.string().max(12_000),
  no_gos: z.string().max(12_000),
  rabbit_holes: z.string().max(12_000),
  notes: z.string().max(12_000),
});
export type SpecSections = z.infer<typeof SpecSectionsSchema>;
/**
 * A whole spec as one writer holds it: what a save asks the file to say, and,
 * beside it, what that writer read before it changed anything (SCP-321).
 */
export const SpecDocumentSchema = z.strictObject({
  title: z.string().trim().max(200),
  sections: SpecSectionsSchema,
});
export type SpecDocument = z.infer<typeof SpecDocumentSchema>;
/** One exported name the Spec pane completes: what it is, and the file it is in. */
export interface ExportedName {
  name: string;
  kind: ExportKind;
  /** Repository-relative, with forward slashes. */
  path: string;
}
/**
 * The exported names of one repository, from `perbo index` ([D-015](../../../../docs/11-open-decisions.md)).
 *
 * A repository the index cannot describe answers `supported: false` rather than
 * an empty list, because the two are different facts and the pane acts
 * differently on each: an empty index says every name the spec uses has gone,
 * and this says the question does not apply here, so every reference keeps
 * its mark and none is marked apart.
 */
export type SymbolIndexView =
  | {
      supported: false;
      reason: string;
      /** The record's `languages_seen`: the extensions the tracked tree does carry. */
      languages: string[];
    }
  | {
      supported: true;
      names: ExportedName[];
      /** The commit the tree was at when the index was built. */
      headCommit: string;
      /** Whether a tracked file differed from that commit when it was read. */
      workingTree: "clean" | "modified";
      builtAt: string;
    };
/** One requirement as the pane shows it: its id, and the nodes it landed in. */
export interface SpecRequirementView {
  /** Null only for a requirement typed and not yet saved. */
  id: string | null;
  text: string;
  /** Node ids holding the criteria that cite it; empty where none does yet. */
  nodes: string[];
}
/**
 * What a save through `specSave` answers (SCP-321).
 *
 * Two writers call this — the Spec pane and the Impact pane's No-Go action —
 * each reading the file, changing part of it and writing the whole of it
 * back. The interview writes the same file too, through its own tools rather
 * than this request, so its words simply become what the file says by the
 * time either pane next saves. A section the file holds differently from what
 * this save's own writer read is not overwritten by this save: it comes back
 * named here, with the file itself, so the pane can show both texts and the
 * person keeps whichever words they want.
 */
export interface SpecSaveReply {
  /**
   * The spec the repository holds now: what this save wrote, or what the other
   * writer left there where this one was refused.
   */
  view: SpecView;
  /**
   * The sections this save did not write. Empty where it landed; where it did
   * not, nothing at all was written, so a refused save is never half a save.
   */
  conflicting: SpecField[];
}
/** One spec as the pane reads it back: the file is what this says (D-095). */
export interface SpecView {
  /** Null until the first save, which creates the folder. */
  slug: string | null;
  /** `specs/<slug>/spec.md`, repository-relative. Null with no slug. */
  path: string | null;
  title: string;
  sections: SpecSections;
  requirements: SpecRequirementView[];
}
// Editing accepts incomplete text. Admission still uses DraftSchema.
const editableCriterion = z.strictObject({
  text: z.string().max(12_000),
  assertion: z.string().max(12_000),
  kind: z.enum(["test", "query", "metric", "artifact"]),
});
export const EditingFormSchema = z.strictObject({
  draft: z.strictObject({
    outcome: z.string().max(12_000),
    criteria: z.array(editableCriterion),
    paths: z.array(z.string().max(300)),
    prohibited: z.array(z.string().max(300)).default([]),
  }),
  models: TaskModelsSchema,
  editing: z.number().int().min(0).nullable(),
  criterion: editableCriterion,
  newPath: z.string().max(300).nullable(),
});
export type EditingForm = z.infer<typeof EditingFormSchema>;
export const EditingOperationSchema = z.strictObject({
  id: identifier,
  intent: z.enum(["compile", "generate", "startOver"]),
  inputRevision: z.number().int().nonnegative(),
  jobId: identifier.nullable(),
  state: z.enum(["accepted", "running", "stopping", "completed", "failed", "cancelled", "interrupted"]),
  resultKey: key.nullable(),
  error: z.string().nullable(),
  reconciled: z.boolean(),
});
/** What a path is marked for a draft: allowed, prohibited, or neither. */
export const DraftMarkSchema = z.enum(["allowed", "prohibited"]).nullable();
/**
 * One edit to a draft, with its author and enough to reverse it.
 *
 * The explorer's marks are the only kind so far; `change` is a union on `kind`
 * so the graph's and the spec's edits join it rather than start a second
 * history. A mark that moved the repository's standing list carries that move
 * too, because undoing the mark has to take the standing entry with it.
 */
export const DraftEditSchema = z.strictObject({
  /** Its place in the draft's history, counting from 1. Stable: an undone edit keeps its number. */
  n: z.number().int().min(1),
  at: z.string().datetime(),
  /** Who made it. The explorer's marks are the person's own. */
  author: z.enum(["you", "interview"]),
  summary: z.string().min(1).max(300),
  undone: z.boolean(),
  change: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("mark"),
      /** The glob the mark wrote: a directory as `<dir>/**`, a file as itself. */
      glob: z.string().min(1).max(300),
      before: DraftMarkSchema,
      after: DraftMarkSchema,
      /** The standing entry this mark added or removed, or null where the always box did not move. */
      standing: z
        .strictObject({
          before: StandingProhibitedEntrySchema.nullable(),
          after: StandingProhibitedEntrySchema.nullable(),
        })
        .nullable(),
    }),
  ]),
});
export type DraftEdit = z.infer<typeof DraftEditSchema>;
/**
 * How many lines of one interview's conversation the editing session keeps
 * (D-102). Past it the oldest go, and the chat says so, because the record
 * lives in a file this app rewrites on every line and a conversation nobody
 * ended would otherwise grow without a bound. The session itself is not
 * shortened: `--session` continues it where the provider left it.
 */
export const INTERVIEW_CONVERSATION_CAP = 400;
/**
 * What the host says when this planning cannot have an interview yet (D-102).
 *
 * Here rather than in the host, because the sample host stands in for the host
 * and a second spelling of a sentence the person reads would drift from this
 * one at the next edit.
 */
export const INTERVIEW_NEEDS_A_TITLE =
  "Give this planning a spec title first. The chat writes specs/<slug>/spec.md, and the slug " +
  "comes from the title.";
/**
 * What the host says once a turn has written the spec and there is no plan
 * beside it (D-102): the spec is readable and the three ways on from it are
 * the person's.
 *
 * Here for the reason {@link INTERVIEW_NEEDS_A_TITLE} is, and for one more:
 * the chat recognises this note by its words. For the rest of the turn it is
 * said in, the dock puts no status line under it, and the Spec pane reads it to know
 * the spec on screen came from the interview — so the sentence is written once
 * and the surfaces that say it and the surfaces that read it share the one
 * spelling.
 */
export const INTERVIEW_WROTE_THE_SPEC =
  "The spec is written: read it, change it on the Spec pane or by asking here, or press Generate " +
  "plan.";
/**
 * The note a reading puts once every problem between the plan and the spec is
 * resolved (D-128). It is words and carries no press: every pane the chat sits
 * beside but the Spec pane has Confirm the plan already. Here because the
 * chat's reckoning of what a turn is owed tells this note by its words, as a
 * line the reading put rather than one the turn led to.
 */
export const EVERY_PROBLEM_RESOLVED =
  "Every problem is resolved: the plan and the spec promise the same thing again.";
/**
 * One plan edit the interview made, as the ticket's own draft record holds it
 * (D-100), so the chat's card carries an Undo on its number.
 *
 * Read from that record rather than from the tool's account of what it did:
 * the record is written by `perbo edit`, which is the one path a plan changes
 * through ([ADR-0023](../../../docs/adr/0023-untrusted-context-boundary.md)).
 */
export const InterviewEditSchema = z.strictObject({
  /** Its place in the plan's history, counting from 1: what an undo names. */
  n: z.number().int().min(1),
  author: z.enum(["you", "interview"]),
  summary: z.string().min(1).max(300),
  undone: z.boolean(),
  /** The edit this one undid, by its number, or null for an edit of its own. */
  undoes: z.number().int().min(1).nullable(),
  /** The entity keys it changed either side: `node:<id>`, `criterion:<id>`, `edge:<from>-><to>`. */
  before: z.array(z.string().min(1).max(200)),
  after: z.array(z.string().min(1).max(200)),
});
export type InterviewEdit = z.infer<typeof InterviewEditSchema>;
/** Which asking a person is being put, and how many of its groups they have answered. */
export const AskingSchema = z.strictObject({
  /** The `asked` entry this is for, by its place in the conversation. */
  entry: z.number().int().min(1),
  answered: z.number().int().min(0),
});

export type Asking = z.infer<typeof AskingSchema>;

/**
 * One line of the interview's conversation as the chat draws it (D-102).
 *
 * The session's own messages arrive as the Claude Agent SDK shaped them and
 * are read down to their text here rather than kept whole: those shapes are
 * the provider's, and a record of them would be a second declaration of
 * somebody else's contract that drifts at their next release. A line of stdout
 * this build cannot read becomes a `note` saying so, and is never relayed raw.
 */
export const InterviewEntrySchema = z.strictObject({
  /** Its place in the conversation, counting from 1. Kept when the oldest lines are dropped. */
  n: z.number().int().min(1),
  at: z.string().datetime(),
  line: z.discriminatedUnion("kind", [
    /** The person's turn, as it went down the interview's stdin. */
    z.strictObject({ kind: z.literal("turn"), text }),
    /** What the session said. */
    z.strictObject({ kind: z.literal("said"), text }),
    /**
     * A call the guard refused. Shown as refused and never as a question:
     * there is nothing here to answer, because the session never asks (D-102).
     */
    z.strictObject({
      kind: z.literal("refused"),
      tool: z.string().min(1).max(200),
      /** The admission rule that refused it, as the runner names it. */
      rule: z.string().min(1).max(200),
      target: z.string().max(1000).nullable(),
      reason: z.string().min(1).max(2000),
    }),
    /** What one of the interview's own tools did, and the plan edit it made. */
    z.strictObject({
      kind: z.literal("tool"),
      tool: z.string().min(1).max(200),
      ok: z.boolean(),
      detail: z.string().max(12_000),
      edit: InterviewEditSchema.nullable(),
    }),
    /**
     * What the session wants to know, in groups it says can be asked apart
     * (D-117).
     *
     * Every group arrives at once because a tool returns to the model rather
     * than waiting on a person. Putting one group at a time to the person is
     * the dock's doing, and what it sends back is an ordinary turn in the
     * options' own words — so nothing the session wrote becomes anything but
     * the person's own sentence ([ADR-0023](../../../docs/adr/0023-untrusted-context-boundary.md) §4).
     */
    z.strictObject({
      kind: z.literal("asked"),
      groups: z
        .array(
          z.strictObject({
            title: z.string().max(200).nullable(),
            parts: z
              .array(
                z.strictObject({
                  question: z.string().min(1).max(600),
                  options: z
                    .array(
                      z.strictObject({
                        label: z.string().min(1).max(200),
                        detail: z.string().max(600).nullable(),
                        recommended: z.boolean(),
                      }),
                    )
                    .min(2)
                    .max(MAX_QUESTION_OPTIONS),
                }),
              )
              .min(1)
              .max(MAX_QUESTION_PARTS),
          }),
        )
        .min(1)
        .max(MAX_QUESTION_GROUPS),
      /**
       * Set where the question is one of the host's, not the session's: a
       * place the plan and the spec have parted, put to the person as the
       * problem in hand (D-128). `open`
       * is how many problems stood open as this one was put, so the card can
       * say which it is of how many. The answer goes down as a turn like any
       * other, which is how the interview closes it.
       */
      drift: z.strictObject({ open: z.number().int().positive() }).optional(),
    }),
    /**
     * The host's own word: the session started, ended, wrote something
     * unreadable, or moved a file the person is not looking at.
     */
    z.strictObject({
      kind: z.literal("note"),
      text,
      /**
       * Whether this is something to notice rather than something to know.
       *
       * A note is ordinarily the quietest line in the chat, which is right for
       * one that records what the chat itself just did. A note saying the spec
       * moved is about a different page, and a person who does not read it
       * does not find out; it is drawn to be read. Not a warning — nothing has
       * gone wrong — so it carries no danger colour.
       */
      notable: z.boolean().optional(),
    }),
  ]),
});
export type InterviewEntry = z.infer<typeof InterviewEntrySchema>;
/**
 * What a turn in flight is doing that its conversation does not show yet
 * (D-119): writing the spec, or holding a line of the session's own that is
 * still to be said. Set by the host from the events it relays, never from what
 * the session said, and cleared by the next line the turn puts in the
 * conversation, which the dock reads the rest of the turn's status from.
 */
export const INTERVIEW_DOING = ["writing_the_spec", "speaking"] as const;
export type InterviewDoing = (typeof INTERVIEW_DOING)[number];
/** What the chat calls the session that questions the person and writes the spec. */
export const INTERVIEWER_NAME = "The Architect";
/** Whether this planning has a live interview, and the conversation it holds (D-102). */
export interface InterviewStatus {
  /** The editing session the interview belongs to. */
  id: string;
  running: boolean;
  /** The session id `--session` continues, once the interview has reported one. */
  interview: string | null;
  conversation: InterviewEntry[];
}
/** A spec folder's name as `specSlug` mints it, lowercase words joined by hyphens with no path separator; every reader of a spec folder's name holds it to this. */
export const SPEC_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const specSlugText = z.string().max(120).regex(SPEC_SLUG, "a spec slug is lowercase words joined by hyphens");
/**
 * What a plan promises, as the reading of it against the spec and the marks
 * on the last change both read it: the outcome and each criterion's words,
 * by the criterion's id. Nothing else in the contract — the scope, the
 * assertions, the arrangement — is a promise the spec makes. Bounded as the
 * contract bounds them and no tighter: what the contract holds, this holds,
 * so a change read off a contract is never refused by the record of it.
 */
const PlanPromiseSchema = z.strictObject({
  outcome: z.string().min(1),
  criteria: z.array(z.strictObject({ id: CriterionIdSchema, text: z.string().min(1) })),
});
export type PlanPromise = z.infer<typeof PlanPromiseSchema>;
/**
 * The last change to the spec and the plan's promise, whoever made it: the
 * interview's turn, an edit by hand on the Graph or the Plan pane, a spec
 * save, an answer that closed a problem. The panes mark what it added and
 * what it took away, and the marks stand until the next change, which
 * replaces this whole (D-128). A side
 * the change did not move is null, so the panes on it mark nothing.
 */
const EditingChangeSchema = z.strictObject({
  at: z.string().datetime(),
  spec: z.strictObject({ before: SpecSectionsSchema, after: SpecSectionsSchema }).nullable(),
  plan: z.strictObject({ before: PlanPromiseSchema, after: PlanPromiseSchema }).nullable(),
});
export type EditingChange = z.infer<typeof EditingChangeSchema>;
/**
 * The panes planning mode has, by the id its routes and its record name them
 * with. The rail draws each from `renderer/planning/panes.ts`, which says what
 * each one is and which of them a planning offers.
 */
export const PlanningPaneSchema = z.enum(["spec", "graph", "criteria", "explorer", "impact", "drift"]);
export type PlanningPane = z.infer<typeof PlanningPaneSchema>;
export const EditingSessionSchema = z.strictObject({
  version: z.literal(1),
  id: identifier,
  repoId: identifier,
  key: key.nullable(),
  /**
   * Whether this planning admitted the ticket it holds, rather than being
   * opened over one that already existed.
   *
   * Discarding a planning throws away the ticket it drafted, because a plan
   * thrown away must not leave its ticket on the board with no way back to it.
   * A session opened over a ticket the CLI admitted, or one another session
   * drafted, holds that key from birth and did not make it — deleting on the
   * key alone would take somebody else's work away with this one's.
   *
   * Defaulted so a session recorded before this was written reads back as
   * having admitted nothing, which is the reading that deletes nothing.
   */
  admitted: z.boolean().default(false),
  digest: z.string().length(64).nullable(),
  revision: z.number().int().nonnegative(),
  resumeNew: z.boolean(),
  /**
   * The spec this planning writes, by its slug, so reopening the session opens
   * the same one (D-103). Null until the first save creates the folder;
   * defaulted so a session saved before specs existed still parses.
   */
  specSlug: specSlugText.nullable().default(null),
  /**
   * The title the host cut from the person's first turn to name this
   * planning's spec folder (D-118), or null where the folder was named any
   * other way. The cut is no title, so the planning is Untitled while its
   * spec still states it.
   */
  specCut: z.string().min(1).max(500).nullable(),
  /**
   * Who last wrote the title this planning's spec states, and that title: the
   * person, from the Spec pane's title field, or the Architect, in a turn of
   * the chat. Null until one of them titles it; the cut is no title (D-118).
   *
   * A plan is drafted with `admit --keep-title` while the person's is the
   * title the spec still states, so the ticket takes their name and the spec
   * keeps it; otherwise the drafter names the ticket and the spec takes that
   * name (D-127). The title is kept beside the writer so a title the file no
   * longer states is not mistaken for the person's.
   */
  named: z
    .strictObject({ by: z.enum(["person", "architect"]), title: z.string().min(1).max(500) })
    .nullable(),
  /**
   * The asking being put to the person and how much of it they have answered
   * (D-117), as {@link AskingSchema} holds it.
   *
   * Recorded rather than counted back out of the conversation. Which group a
   * person is on is a fact about what they have been shown, and reading it off
   * the turns cannot tell an answer from a question they typed instead: one
   * reading moves the card past a group nobody answered, the other leaves a
   * card up for a question the session has already moved on from. It also
   * outlives the line it came from, which the conversation's own cap can drop.
   */
  asking: AskingSchema.nullable().default(null),
  /**
   * How many nodes the plan this session drafted has, zero for a flat plan or
   * for no plan at all.
   *
   * Kept here because the rail is outside planning mode and cannot read a
   * contract: what it needs to know is whether there is a graph worth offering,
   * and that is a number the reconcile already has in its hand. Zero on a
   * session from before it existed, which reads as "no graph" and is right.
   */
  nodes: z.number().int().nonnegative().default(0),
  /**
   * Where the plan and the spec have parted, as the last reading of the two
   * left it (D-128): the problems still
   * open, oldest first, and whether a reading has since found none. Null
   * where no reading has found a problem, which is what a planning without
   * the Problems pane means.
   *
   * Kept on the session rather than read off the verdict beside the ticket,
   * because the rail, the picker and the ticket's landing are drawn where no
   * verdict can be read, and what they need is whether problems are open.
   */
  drift: z
    .strictObject({
      open: z.array(DriftFindingSchema).max(MAX_DRIFT_FINDINGS),
      resolved: z.boolean(),
    })
    .nullable(),
  /**
   * The last change to this planning's spec and plan, or null where none has
   * been recorded, as {@link EditingChangeSchema} holds it. Replaced whole by
   * the next change and kept nowhere else, which is what "the marks stand
   * until the next change" means.
   */
  change: EditingChangeSchema.nullable(),
  /**
   * The pane the person was last on in this planning, or null before they
   * have been on one: every way back into the planning opens it there
   * (D-130). Recorded as the pane
   * changes, so going Home and closing Perbo each find it already written.
   */
  lastPane: PlanningPaneSchema.nullable(),
  /**
   * Whether the person was last on this planning's contract rather than on
   * one of its panes: "contract" from reaching the contract page until planning
   * mode records a pane, else null. The ticket's own page opens on the contract
   * while it says so and the plan waits for approval, where it would
   * otherwise send the person into the planning
   * (D-130). `lastPane` is kept, so the
   * contract's way back goes to the pane it was left from.
   */
  lastView: z.literal("contract").nullable(),
  form: EditingFormSchema,
  phase: z.enum(["editing", "working", "ready", "conflict", "outcome-unknown", "discarded"]),
  error: z.string().nullable(),
  operation: EditingOperationSchema.nullable(),
  /** The draft's edits, oldest first, each undoable. Empty until a path is marked. */
  history: z.array(DraftEditSchema).default([]),
  /**
   * The interview's conversation, oldest first, so leaving planning mode and
   * restarting the app both come back to it (D-102, D-095). Its writer keeps
   * the last {@link INTERVIEW_CONVERSATION_CAP} lines; empty until the chat
   * says something.
   */
  conversation: z.array(InterviewEntrySchema).default([]),
  /**
   * The interview's own session id, as its `started` event reported it, which
   * `--session` continues after the process has gone. Null until one has run.
   */
  interviewSession: z.string().min(1).max(200).nullable().default(null),
  /**
   * Which provider's id that is (SCP-312). The two keep separate namespaces,
   * so a planning whose drafting provider has changed since starts a session
   * of its own rather than continuing one the new provider has never heard of.
   */
  interviewProvider: z.enum(["claude", "codex"]).nullable().default(null),
  /** The model that session was started on, which the chat's header names. */
  interviewModel: z.string().min(1).max(100).nullable(),
});
export type EditingSession = z.infer<typeof EditingSessionSchema>;
export type EditingOperation = z.infer<typeof EditingOperationSchema>;
/** An editing session the picker offers to resume: planning that has not been discarded. */
export interface OpenDraft {
  id: string;
  repoId: string;
  key: string | null;
  /** Whether the planning drafted the ticket it holds, which is the only ticket its delete takes. */
  admitted: boolean;
  outcome: string;
  phase: EditingSession["phase"];
  /** How many nodes its plan has: zero for a flat plan, or for no plan yet. */
  nodes: number;
  /**
   * How many problems between its plan and its spec stand open, and whether
   * a reading has since resolved them; null where no reading found any. The
   * rail offers the Problems pane on it, and the ticket lands there while it
   * is open (D-128).
   */
  drift: { open: number; resolved: boolean } | null;
  /** The pane the person was last on, which the planning reopens on where it still offers it. */
  lastPane: PlanningPane | null;
  /** "contract" where the person was last on the contract rather than a pane, which the ticket's page then opens on. */
  lastView: "contract" | null;
  /**
   * The scope this session holds, which is not yet the contract's.
   *
   * A mark made in the Explorer writes here and reaches the contract only
   * through a compile. Approval freezes the contract's scope and never reads
   * this one, so the contract page compares the two and refuses to approve
   * over the difference rather than freezing a scope the person has already
   * moved on from.
   */
  scope: { paths: string[]; prohibited: string[] };
  /**
   * The spec this planning writes, by slug, or null before its first save.
   *
   * Here so the picker can subtract: a spec folder on disk that no planning
   * and no ticket names is one nothing in the app points at, and that is the
   * row {@link Snapshot.specs} exists to offer.
   */
  specSlug: string | null;
  /**
   * What the spec it writes is titled, or null while it has no spec, or one
   * whose title is still the cut its folder was named from (D-118): the
   * planning is Untitled until the Architect or the person titles it.
   */
  title: string | null;
}
/**
 * A spec folder this repository holds, by the slug that names it and the title
 * it states.
 *
 * Read from disk rather than from the records, because the point of it is the
 * spec no record names: a planning discarded takes its session and the ticket
 * it drafted, and the folder it wrote stays. Nothing else in the app enumerates
 * the spec folder, so without this a spec whose planning is gone is unreachable
 * while still holding its own title against a new one (D-129).
 */
export interface SpecRow {
  repoId: string;
  slug: string;
  /** The spec's own first heading, which is what a person named the work. */
  title: string;
}
export const EditingTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("new"), repoId: identifier }),
  /** Always a new session in this repository: what the picker starts. */
  z.strictObject({ kind: z.literal("fresh"), repoId: identifier }),
  z.strictObject({ kind: z.literal("ticket"), repoId: identifier, key }),
  /**
   * Planning mode over a ticket that already has a plan (D-101). The same
   * session a ticket target opens, refused unless the ticket is in
   * `plan_review`: planning mode curates a plan nobody has approved, and an
   * approved contract is immutable (ADR-0016).
   */
  z.strictObject({ kind: z.literal("planning"), repoId: identifier, key }),
  z.strictObject({ kind: z.literal("session"), id: identifier }),
  /**
   * Planning over a spec already in the repository, named by its slug.
   *
   * The way back into a spec whose planning was discarded. It carries no key:
   * the ticket that spec drafted is gone, and what is reopened is the writing,
   * which Generate plan drafts from again (D-129).
   */
  z.strictObject({ kind: z.literal("spec"), repoId: identifier, slug: specSlugText }),
]);
export type EditingTarget = z.infer<typeof EditingTargetSchema>;
export const LegacyEditingSchema = z.strictObject({
  repoId: identifier,
  key: key.nullable(),
  digest: z.string().length(64).nullable(),
  form: EditingFormSchema,
  pending: z.boolean(),
});
export type LegacyEditing = z.infer<typeof LegacyEditingSchema>;
const reference = { repoId: identifier, key };
export const HELP_LINKS = {
  documentation: "https://github.com/perbostudios/perbo#readme",
  problem: "https://github.com/perbostudios/perbo/issues/new",
  releases: "https://github.com/perbostudios/perbo/releases",
  privacy:
    "https://github.com/perbostudios/perbo/blob/main/docs/08-security-autonomy-and-data.md",
} as const;
export const ManifestEditorSchema = z.strictObject({
  entries: z.array(MaterializationEntrySchema),
  offLimits: z.array(z.string().trim().min(1).max(300)),
});
export type ManifestEditor = z.infer<typeof ManifestEditorSchema>;
/**
 * The largest file the explorer renders. A spec or a source file fits; a
 * bundle, a fixture dump or a minified asset does not, and is refused with a
 * sentence rather than shown truncated, which would read as the whole file.
 */
export const PREVIEW_BYTE_CAP = 256 * 1024;
/**
 * A repository-relative path a renderer names. Shape only: the host resolves it
 * under the registered repository and refuses an absolute path, one that leaves
 * the repository, a symlink and a never-read path with the reason.
 */
const repositoryPath = z.string().min(1).max(1000);
/** What the explorer lists: the tracked files it will show, and what it withholds. */
export interface ExplorerListing {
  /** Repository-relative, sorted, never-read paths already removed. */
  files: string[];
  /** Tracked paths withheld because nothing here reads them: secrets, `.git`, agent configuration. */
  hidden: number;
  /** This repository's standing prohibited list, each entry with what put it there. */
  standing: StandingProhibitedEntry[];
}
/** One file, read-only. `text` is null where `refusal` says why it is not shown. */
export interface ExplorerFile {
  path: string;
  bytes: number;
  text: string | null;
  refusal: string | null;
}
/**
 * What the Impact pane shows: the warnings for the draft in hand, the index
 * state they were derived under, and what the spec names (D-015).
 *
 * The report is advice. Turning one warning into a scope change is
 * `explorerMark`, which is the draft's own scope edit, and turning it into a
 * No-Go is `specSave`, which is the spec's own save; neither is reachable from
 * this record without the person's click (ADR-0023 §4).
 */
export interface ImpactView extends ImpactReport {
  /** When these warnings were derived; each ask derives them again. */
  readAt: string;
}
/**
 * What `perbo drift KEY --json` prints, as the drift job leaves it on
 * `job.result`: the verdict kept beside the ticket, and whether a model ran
 * for it or the two hashes it is keyed by still held.
 */
export type { DriftVerdict } from "@perbo/planning/browser";
/** One acceptance criterion as the Graph pane shows and edits it. */
export interface GraphCriterionView {
  id: string;
  text: string;
  kind: VerificationKind;
  assertion: string;
  /** The spec requirement it was drafted from, or null where it cites none (D-103). */
  requirement: string | null;
  /** Who proves a criterion by hand and why it cannot be automated; null for every other kind. */
  manual: { reviewer: string; reason: string } | null;
}
/** One node: its criteria and paths, which are contract, and its generated page. */
export interface GraphNodeView {
  id: string;
  title: string;
  criteria: GraphCriterionView[];
  paths: string[];
  /**
   * `specs/<slug>/nodes/<id>.md` as the repository holds it (D-103, SCP-336),
   * or null where this ticket was not drafted from a spec. Read-only: the page
   * is generated, and editing it would be editing a rendering.
   */
  page: { path: string; text: string } | null;
}
/**
 * What a node's records say about it while the work runs (D-100, SCP-317), the
 * most conclusive record first: the pane shows the first that holds. Not worst
 * first — `covered` outranks `checks_passed` because a review that met a
 * node's criteria says more than a check that passed.
 *
 * - `finding_open` — the review artifact holds an open finding against one of
 *   the node's criteria.
 * - `checks_failed` — a pinned check narrowed to this node (D-107) did not pass.
 * - `covered` — every one of its criteria is `met` in the review's coverage.
 * - `checks_passed` — every pinned check narrowed to it passed, and the review
 *   has not met all of its criteria. A check the loop could not narrow to this
 *   node is the whole command under the node's name, and is not counted here.
 * - `changed` — the sealed change set touched a path its globs match, and
 *   nothing further is on record.
 * - `untouched` — no path in the sealed change set matches its globs.
 *
 * Nothing here is derived from the executor's own account of its work
 * ([ADR-0023](../../../docs/adr/0023-untrusted-context-boundary.md)).
 */
export const GRAPH_NODE_STATES = [
  "finding_open",
  "checks_failed",
  "covered",
  "checks_passed",
  "changed",
  "untouched",
] as const;
export type GraphNodeState = (typeof GRAPH_NODE_STATES)[number];
/** One criterion, as the review artifact's evidence binding leaves it. */
export interface GraphCriterionState {
  id: string;
  /** The binding's coverage status, or `unbound` where no review has covered it. */
  state: CoverageStatus | "unbound";
  /** How it was established: a mock the executor wrote is not a proof (D-035). */
  strength: VerificationStrength | null;
  /** Where the binding's evidence points — `file:line`, or the check it names. */
  evidence: string | null;
  /** The statement of an open finding the review left against it, or null. */
  finding: string | null;
}
/** One node's state, and the records it came from. */
export interface GraphNodeLive {
  id: string;
  state: GraphNodeState;
  /** The sealed change set's paths this node's globs match, sorted. */
  changed: string[];
  /** The pinned checks narrowed to this node's own changed files (D-107). */
  checks: { name: string; status: string }[];
  criteria: GraphCriterionState[];
}
/**
 * What a run has done to a graph so far, read from the records the loop wrote
 * and from nothing else (SCP-317).
 */
export interface GraphLiveView {
  /**
   * The attempt these records belong to — the latest on record — or null
   * before a ticket has run, when every node is `untouched` because no change
   * set exists for a path to be in.
   */
  attempt: string | null;
  nodes: GraphNodeLive[];
  /**
   * Changed paths no node's globs match: work nobody planned for. Empty for a
   * flat plan, which has no nodes for a path to be outside of.
   */
  outside: string[];
  /** Why the changed paths could not be read, where they could not be. */
  note: string | null;
}
/** One recorded edit, as `<KEY>.draft.json` holds it (D-100). */
export interface GraphEditView {
  /** Its place in the log, counting from 1: what an undo names. */
  n: number;
  at: string;
  author: "you" | "interview";
  summary: string;
  undone: boolean;
  /** True once the plan was re-drafted from its spec over the top of it. */
  replaced: boolean;
  /** The edit this one undid, by its number, or null for an edit of its own. */
  undoes: number | null;
}
/**
 * A plan's execution graph as the Graph pane reads it: the contract half, the
 * approach half, the size and the log of what changed either (D-100, D-104).
 */
export interface GraphView {
  key: string;
  /** The ticket's state, so a pane opened on one that has moved says so. */
  state: string;
  approved: boolean;
  outcome: string;
  /** Empty for a flat plan, which has criteria and no graph to curate. */
  nodes: GraphNodeView[];
  criteria: GraphCriterionView[];
  edges: GraphEdge[];
  pathsAllowed: string[];
  size: SizeEstimate;
  /** What admission counts a person having changed (D-072). */
  editCount: number;
  history: GraphEditView[];
  /** The contract as read, so approving approves what was shown. */
  digest: string;
  /** What the run's own records say about this graph (SCP-317). */
  live: GraphLiveView;
}
export const RequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("snapshot") }),
  z.strictObject({ kind: z.literal("repositorySnapshot"), repoId: identifier }),
  /**
   * The explorer's two reads (D-101, D-015), and its marks. A read carries a
   * repository id and, for one file, a repository-relative path; the host
   * resolves it and never takes a command or a filesystem target.
   */
  z.strictObject({ kind: z.literal("explorerList"), repoId: identifier }),
  z.strictObject({ kind: z.literal("explorerRead"), repoId: identifier, path: repositoryPath }),
  /**
   * The Graph pane's three (D-100): read the plan, apply one operation, undo
   * one recorded edit. Each names a repository and a ticket and nothing a
   * filesystem or a shell could take; the host runs `perbo edit`, which is the
   * one path a graph changes through, and never writes the contract itself.
   */
  z.strictObject({ kind: z.literal("graphRead"), repoId: identifier, key }),
  z.strictObject({ kind: z.literal("graphEdit"), repoId: identifier, key, edit: GraphEditSchema }),
  z.strictObject({
    kind: z.literal("graphUndo"),
    repoId: identifier,
    key,
    edit: z.number().int().min(1),
  }),
  z.strictObject({
    kind: z.literal("explorerMark"),
    id: identifier,
    revision: z.number().int().nonnegative(),
    path: repositoryPath,
    mark: z.enum(["allowed", "prohibited"]).nullable(),
    /** Null leaves the standing list alone; true adds the path, false removes what this draft added. */
    always: z.boolean().nullable(),
  }),
  z.strictObject({
    kind: z.literal("explorerUndo"),
    id: identifier,
    revision: z.number().int().nonnegative(),
    edit: z.number().int().min(1),
  }),
  z.strictObject({ kind: z.literal("editingOpen"), target: EditingTargetSchema, legacy: LegacyEditingSchema.optional() }),
  z.strictObject({ kind: z.literal("editingRead"), id: identifier }),
  z.strictObject({ kind: z.literal("editingSave"), id: identifier, revision: z.number().int().nonnegative(), repoId: identifier, form: EditingFormSchema }),
  z.strictObject({ kind: z.literal("editingSubmit"), id: identifier, revision: z.number().int().nonnegative(), operationId: identifier, intent: EditingOperationSchema.shape.intent }),
  z.strictObject({ kind: z.literal("editingStop"), id: identifier }),
  /**
   * The person is now on this pane of this planning. Recorded on the session
   * as its `lastPane`, which is where the planning reopens
   * (D-130); not an edit, so it moves no
   * revision.
   */
  z.strictObject({ kind: z.literal("editingVisited"), id: identifier, pane: PlanningPaneSchema }),
  /**
   * The person is now on this planning's contract. Recorded on the session
   * as its `lastView`, which is where its ticket reopens
   * (D-130); not an edit, so it moves no
   * revision.
   */
  z.strictObject({ kind: z.literal("editingContractVisited"), id: identifier }),
  /** The spec this planning session holds, read from the repository (D-103). */
  z.strictObject({ kind: z.literal("specRead"), id: identifier }),
  /**
   * The impact warnings for this planning's draft (D-015, D-101). On demand:
   * the pane asks when a person asks it to, because the answer is a fresh
   * `perbo index` over the tracked tree.
   *
   * The session names itself and nothing else. The repository, the scope, the
   * spec and the index are the host's to derive from the registered repository
   * and the session's own records, so no field here becomes a path or an
   * argument (ADR-0023 §4).
   */
  z.strictObject({ kind: z.literal("impactRead"), id: identifier }),
  /**
   * The same reading, asked of a compiled contract rather than of a draft.
   *
   * Impact is only ever actionable before approval — a scope frozen is a
   * scope no warning can move — so the count belongs on the page where
   * approving happens, and that page is reached from a ticket, not from a
   * planning session. A ticket the CLI admitted never had one at all.
   */
  z.strictObject({ kind: z.literal("impactContract"), repoId: identifier, key }),
  /**
   * The plan read against the spec it was drafted from, on the way from the
   * plan to the contract (D-128): where
   * the two no longer promise the same thing, and the ways to close each
   * difference. Advice, never a gate. `driftDismiss` records that the person
   * went on with the findings open, so the same reading is not put to them
   * again at the same state.
   *
   * The session names itself, as `impactRead` does: the repository, the ticket
   * and the spec are the host's to derive from its records, and the model is
   * the ticket's own or the settings', so nothing here becomes an argument
   * (ADR-0023 §4). What a finding offers goes to the interview as a turn in
   * the person's own words, through `interviewTurn`, and reaches no edit.
   */
  z.strictObject({ kind: z.literal("driftCheck"), id: identifier }),
  z.strictObject({ kind: z.literal("driftDismiss"), id: identifier }),
  /**
   * Delete a spec folder, by the slug that names it.
   *
   * The slug and not a path, as every other request naming a file in a
   * repository does (ADR-0023 §4): the host builds the path from the
   * repository it registered and the folder it configured, and nothing a
   * renderer sent reaches the filesystem.
   *
   * Refused for a spec any ticket was drafted from. A plan's provenance is the
   * spec it names, and staleness is judged by reading those bytes back
   * (D-103): deleting them leaves a ticket that can never be read as current
   * again. What the picker offers has no ticket by definition, so this refuses
   * only a request the picker would not have made.
   */
  z.strictObject({ kind: z.literal("specDelete"), repoId: identifier, slug: specSlugText }),
  /**
   * Write the spec to `specs/<slug>/spec.md`, creating the folders the first
   * time. The session names itself and its repository; the path is the host's
   * to derive, as every other repository path is.
   */
  z.strictObject({
    kind: z.literal("specSave"),
    id: identifier,
    repoId: identifier,
    ...SpecDocumentSchema.shape,
    /**
     * The spec as this writer last read it, which is what its changes are
     * against (SCP-321). Required rather than optional: a save that could
     * leave it out would be a save that silently drops whatever the interview
     * or the Impact pane put in the file since.
     */
    base: SpecDocumentSchema,
  }),
  /**
   * The repository's exported names, for the Spec pane's `@Symbol` completion
   * and the names it marks (D-015). The request names a repository and nothing
   * else: the index is built by the host running `perbo index` over the
   * registered checkout, and no name, path or file the renderer sent reaches it
   * ([ADR-0023](../../../../docs/adr/0023-untrusted-context-boundary.md) §4).
   */
  z.strictObject({ kind: z.literal("symbolIndex"), repoId: identifier }),
  /**
   * The interview docked beside the panes (D-102): start it, send one turn,
   * stop it. A request names a repository and this planning's own editing
   * session, and for a turn the text the person typed, and carries nothing
   * else. The spec folder the interview writes, the session it continues and
   * the model it runs on are the host's to derive from the registered
   * repository and the session's own records, so nothing here becomes an
   * argument ([ADR-0023](../../../docs/adr/0023-untrusted-context-boundary.md)).
   */
  z.strictObject({ kind: z.literal("interviewStart"), repoId: identifier, id: identifier }),
  z.strictObject({ kind: z.literal("interviewTurn"), id: identifier, text }),
  z.strictObject({ kind: z.literal("interviewStop"), id: identifier }),
  z.strictObject({ kind: z.literal("editingDiscard"), id: identifier, revision: z.number().int().nonnegative().optional() }),
  /** The open drafts alone, for the picker: cheaper than a snapshot when an editing session changes. */
  z.strictObject({ kind: z.literal("drafts") }),
  z.strictObject({
    kind: z.literal("openHelp"),
    page: z.enum(["documentation", "problem", "releases", "privacy"]),
  }),
  z.strictObject({ kind: z.literal("chooseRepository") }),
  z.strictObject({ kind: z.literal("forgetRepository"), repoId: identifier }),
  z.strictObject({ kind: z.literal("saveSettings"), settings: SettingsSchema }),
  /**
   * The models one ticket runs on, chosen for that ticket alone.
   *
   * The defaults are the person's settings; this is the override the contract
   * page writes, so a person deciding whether to approve can change what will
   * run without leaving the page that says what approving freezes. Refused on
   * an approved contract: what runs is settled when the loop is started.
   */
  z.strictObject({
    kind: z.literal("taskModels"),
    repoId: z.string().min(1),
    key: z.string().min(1),
    models: TaskModelsSchema,
  }),
  z.strictObject({ kind: z.literal("providers") }),
  /** Opens the machine's terminal on the provider's own sign-in command; the desktop never takes a credential. */
  z.strictObject({ kind: z.literal("login"), provider: z.enum(["claude", "codex"]) }),
  z.strictObject({ kind: z.literal("models"), provider: ModelProviderSchema }),
  z.strictObject({ kind: z.literal("usage") }),
  z.strictObject({ kind: z.literal("detail"), ...reference }),
  z.strictObject({ kind: z.literal("taskSummary"), ...reference }),
  z.strictObject({ kind: z.literal("output"), ...reference, attemptId: z.string().min(1).max(200).optional() }),
  z.strictObject({
    kind: z.literal("exportArchive"),
    repoId: identifier.nullable(),
    search: z.string().max(200),
    outcome: z.enum(["all", "merged", "closed", "cancelled"]),
    sort: z.enum(["newest", "oldest", "title"]),
  }),
  z.strictObject({ kind: z.literal("manifest"), repoId: identifier }),
  z.strictObject({
    kind: z.literal("saveManifest"),
    repoId: identifier,
    digest: z.string().length(64),
    value: ManifestEditorSchema,
  }),
  /** A name a person gives a ticket, held to a ticket's name's length (D-127). */
  z.strictObject({
    kind: z.literal("rename"),
    ...reference,
    title: z.string().trim().min(1).max(TICKET_NAME_CAP),
  }),
  /**
   * Permanently deletes a piece of work whole, from the contract page and from
   * the page a stopped run lands on: the ticket's own files, the reading of its
   * plan against its spec, the attempts it recorded, the bundles those attempts
   * sealed and the spec folder it was drafted from
   * (D-129). Refused at one stage only — a ticket
   * at `pr_open`, whose pull request is a record this machine does not own.
   */
  z.strictObject({ kind: z.literal("discard"), ...reference }),
  /**
   * What is typed on a repository's question page and not yet sent
   * (D-131); a desktop preference, and an
   * empty text removes it.
   */
  z.strictObject({ kind: z.literal("askSave"), repoId: identifier, text: z.string().max(12_000) }),
  /** A ticket's page opened, written as the time Home orders it by within its colour; a desktop preference. */
  z.strictObject({ kind: z.literal("ticketOpened"), ...reference }),
  /** Files completed tickets away from Home (S4); a desktop preference, never a Ticket state. */
  z.strictObject({
    kind: z.literal("archive"),
    repoId: identifier,
    keys: z.array(key).min(1),
    archived: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("doctor"),
    repoId: identifier,
    writeConfig: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("admit"),
    repoId: identifier,
    draft: DraftSchema,
    models: TaskModelsSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("edit"),
    ...reference,
    digest: z.string().length(64),
    draft: DraftSchema,
    models: TaskModelsSchema.optional(),
  }),
  /** Draft the first plan from this session's spec: `admit --from-spec`. */
  z.strictObject({
    kind: z.literal("generatePlan"),
    repoId: identifier,
    id: identifier,
    models: TaskModelsSchema.optional(),
  }),
  /**
   * Plan a stopped ticket's work again from the spec it was drafted from.
   *
   * Delete the stopped ticket with everything recorded after its contract
   * (the spec stays) and draft a fresh `plan_review` ticket from that spec
   * with `admit --from-spec`; the planning opened over it is what the answer
   * names.
   */
  z.strictObject({ kind: z.literal("replan"), ...reference }),
  /** Re-draft this session's ticket from its spec, keeping the ticket (D-103). */
  z.strictObject({
    kind: z.literal("startOver"),
    repoId: identifier,
    id: identifier,
    key,
    models: TaskModelsSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("run"),
    ...reference,
    digest: z.string().length(64),
    publish: z.boolean(),
    approve: z.boolean(),
    resumeFrom: z
      .string()
      .regex(/^bundle_[0-9a-f]{16}$/)
      .nullable(),
  }),
  z.strictObject({ kind: z.literal("sync"), ...reference }),
  z.strictObject({ kind: z.literal("principle"), ...reference, answer: text }),
  z.strictObject({
    kind: z.literal("decide"),
    ...reference,
    answer: text,
    /**
     * The person's answer to each question that took a choice, by the
     * finding's key: each is recorded on its finding
     * (D-132). None where every
     * question took the person's words alone. `answer` is every question's
     * words together, recorded as a principle for the executor (D-065).
     */
    decisions: z.array(
      z.strictObject({
        findingKey: z.string().regex(/^[a-f0-9]{64}$/),
        choice: z.enum(DECISION_CHOICES),
        answer: text,
      }),
    ),
    digest: z.string().length(64),
  }),
  z.strictObject({
    kind: z.literal("verdict"),
    ...reference,
    findingKey: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(["endorse", "override", "accept", "reject"]),
    note: text,
  }),
  z.strictObject({ kind: z.literal("cancel"), jobId: identifier }),
  z.strictObject({ kind: z.literal("openRepository"), repoId: identifier }),
  z.strictObject({ kind: z.literal("openWorktree"), ...reference }),
  z.strictObject({ kind: z.literal("openPullRequest"), ...reference }),
  z.strictObject({
    kind: z.literal("export"),
    repoId: identifier,
    key: key.nullable(),
  }),
]);
export type Request = z.infer<typeof RequestSchema>;
export interface Repository {
  id: string;
  name: string;
  path: string;
  branch: string;
  head: string;
  dirty: boolean;
  configured: boolean;
  error: string | null;
  testCommand?: string;
  manifestCount?: number;
  prohibitedPaths?: string[];
}
export interface Provider {
  id: "claude" | "codex" | "anthropic";
  name: string;
  installed: boolean;
  authenticated: boolean;
  detail: string;
  loginCommand: string;
  roles: string[];
}
export interface Job {
  id: string;
  repoId: string;
  key: string | null;
  kind: string;
  label: string;
  state:
    | "running"
    | "stopping"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  startedAt: string;
  endedAt: string | null;
  log: string;
  error: string | null;
  resultKey: string | null;
  result: unknown;
  editing?: { sessionId: string; operationId: string } | undefined;
  /** A run's publication choice: whether it pushes and opens a pull request once the review gate passes. */
  publish?: boolean | undefined;
}
export interface TaskRow {
  repoId: string;
  repository: string;
  ticket: Ticket;
}
/** Whether the machine is being held awake for a live run (S6F, Away from keyboard). */
export interface PowerState {
  holding: boolean;
  detail: string | null;
  since: string | null;
}
export interface Snapshot {
  version: string;
  settings: Settings;
  repositories: Repository[];
  tasks: TaskRow[];
  jobs: Job[];
  errors: string[];
  titles?: Record<string, string>;
  taskModels?: Record<string, TaskModels>;
  /** `repoId:key` of every completed ticket filed away by hand. */
  archived?: string[];
  /** Each repository's unsent answer to "What do you want to build?", by repository id. */
  asks?: Record<string, string>;
  /** When each ticket's page was last opened, `repoId:key` to an ISO time. */
  lastOpened?: Record<string, string>;
  power?: PowerState;
  sequence?: number;
  repositoryErrors?: Record<string, string[]>;
  /** Renderer freshness only; never persisted as Ticket state. */
  refreshingRepos?: string[];
  /** Open planning, newest first, for the Create picker. */
  drafts?: OpenDraft[];
  /**
   * Every spec each connected repository holds (D-103). The picker offers the
   * ones no planning and no ticket names.
   */
  specs?: SpecRow[];
  /**
   * The editing sessions with a live interview beside them (D-102). An
   * interview outlives the pane it was started from, as drafting outlives the
   * screen that asked for it (D-095), so this is what says it is still there.
   */
  interviews?: string[];
  /**
   * The editing sessions whose interview is working on what it will say next.
   *
   * Beside the live ones for the same reason they are here: a dock opened part
   * way through a turn has to know it is mid-pause, and the change that said so
   * went out before it was listening
   * (D-119).
   */
  working?: string[];
}
export interface RepositorySnapshot {
  repository: Repository;
  tasks: TaskRow[];
  errors: string[];
}
const JobUpdateSchema = z.object({
  id: identifier, repoId: identifier, key: key.nullable(), resultKey: key.nullable(),
  kind: z.string(), label: z.string(), state: z.enum(["running", "stopping", "completed", "failed", "cancelled", "interrupted"]),
  startedAt: z.string(), endedAt: z.string().nullable(), log: z.string().max(80_000), error: z.string().nullable(), result: z.unknown(),
  editing: z.object({ sessionId: identifier, operationId: identifier }).optional(),
});
export const PowerStateSchema = z.strictObject({
  holding: z.boolean(),
  detail: z.string().nullable(),
  since: z.string().nullable(),
});
export const ChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("progress"), sequence: z.number().int().nonnegative(), job: JobUpdateSchema }),
  z.object({ kind: z.literal("records"), sequence: z.number().int().nonnegative(), repoId: identifier.nullable(), key: key.nullable(), job: JobUpdateSchema.optional() }),
  z.object({
    kind: z.literal("preferences"), sequence: z.number().int().nonnegative(), settings: SettingsSchema, titles: z.record(z.string(), z.string()),
    taskModels: z.record(z.string(), TaskModelsSchema), archived: z.array(z.string()).default([]),
    asks: z.record(z.string(), z.string()),
  }),
  z.object({ kind: z.literal("repositories"), sequence: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("editing"), sequence: z.number().int().nonnegative(), sessionId: identifier }),
  /**
   * One line of an interview, as it arrives, and whether the interview is
   * still running (D-102). The line is null where only the running state
   * moved: a start, a stop, or a process that ended on its own.
   */
  z.object({
    kind: z.literal("interview"),
    sequence: z.number().int().nonnegative(),
    sessionId: identifier,
    running: z.boolean(),
    entry: InterviewEntrySchema.nullable(),
    /**
     * The asking in front of the person as this change leaves, so the dock has
     * it without reading the session back.
     *
     * The conversation reaches the dock on this stream and the record reaches
     * it on a refresh the editor holds back while a save is in flight; a card
     * that waited for the second would come and go with whether the person
     * happened to be saving something (D-117).
     */
    asking: AskingSchema.nullable().default(null),
    /**
     * Whether the session is working on what it will say next, as against
     * waiting on the person.
     *
     * It is the pauses this answers. A session reading the repository before it
     * asks anything says nothing for a while, and a reader cannot tell that
     * from a session that has finished or fallen over — so the dock says which
     * it is, from the turn the session itself reports finishing
     * (D-119).
     */
    working: z.boolean().default(false),
    /**
     * What the turn in flight is doing that its conversation does not show
     * yet, or null where it is nothing of the kind or no turn is.
     */
    doing: z.enum(INTERVIEW_DOING).nullable().default(null),
  }),
  z.object({ kind: z.literal("power"), sequence: z.number().int().nonnegative(), power: PowerStateSchema }),
  /**
   * When each ticket's page was last opened. Nothing a read returned has moved
   * when one opens, so it is patched where it is and no read is taken again.
   */
  z.object({ kind: z.literal("opened"), sequence: z.number().int().nonnegative(), lastOpened: z.record(z.string(), z.iso.datetime()) }),
]);
export type Change = z.infer<typeof ChangeSchema>;
export type ChangeInput = Change extends infer T ? T extends Change ? Omit<T, "sequence"> : never : never;
export interface AttemptView {
  id: string;
  run: number;
  round: number;
  startedAt: string;
  outcome: string;
  termination: string;
  model: string;
  costMicros: number | null;
  costBasis: string;
  partial: boolean;
  ceilings: {
    resource: string;
    used: number | null;
    /** Null where nothing bounds the resource ([D-096](../../../docs/11-open-decisions.md)). */
    ceiling: number | null;
    hit: boolean;
  }[];
  review: ReviewArtifact | null;
  reviewDecision: string | null;
  changes: {
    path: string;
    change_kind: string;
    additions: number | null;
    deletions: number | null;
  }[];
  checks: { name: string; status: string; detail: string }[];
  verification: unknown;
  bundles: RunBundle[];
}
export interface Detail {
  ticket: Ticket;
  contract: PlanContract;
  /**
   * Where the plan and the spec it was drafted from disagree, read before the
   * contract is approved.
   *
   * Approving freezes the contract and starts the loop, so this is the last
   * moment either can still move. Advice and never a gate: a warning that held
   * the button is one people learn to click past, as the impact count beside it
   * is not (D-128).
   *
   * Empty for a plan drafted from no spec, and for one whose spec cannot be
   * read — what cannot be judged is not asserted.
   */
  specFindings: {
    /** `uncited`: the spec asks for this and nothing answers it. `dangling`: a criterion cites what the spec no longer states. */
    kind: "uncited" | "dangling";
    requirementId: string;
    /** The criteria involved, for a dangling citation. Empty for an uncited requirement. */
    criteria: string[];
    /** What the requirement says, where the spec still states it. */
    text: string | null;
  }[];
  /**
   * The criteria whose `expected_verification` differs from the one the draft
   * proposed, by criterion id.
   *
   * Read on the page that approves, because approving freezes the criteria and
   * their verification and starts the loop (D-100): a criterion proven
   * differently from how it was drafted reads exactly as it did, since the
   * claim is untouched, so nothing otherwise shows that what will be taken for
   * proof has moved. Empty where the plan has no recorded edits.
   */
  changedAssertions: string[];
  digest: string;
  attempts: AttemptView[];
  cost: { micros: number; partial: boolean; unavailable: number };
  principles: string;
  verdicts: unknown[];
  /**
   * What this run is actually bounded by (D-096): the stall window, and the
   * ticket cost cap that applies only where the executor is billed per token.
   */
  effective: { stallMinutes: number; ticketDollars: number };
  report: unknown;
}
export interface DecisionQuestion {
  id: string;
  title: string;
  context: string;
  /**
   * The answers the finding takes (D-132);
   * none where the question takes the person's words for a principle alone.
   */
  choices: readonly DecisionChoice[];
  options: {
    title: string;
    detail: string;
    recommended?: boolean;
    metadata?: string[];
  }[];
}
/** What one card or row can say about a ticket's work without opening it (S4, S5). */
export interface TaskSummary {
  branch: string | null;
  attempts: number;
  latestAttemptAt: string | null;
  costMicros: number | null;
  costBasis: "priced" | "unpriced" | "none";
  diff: { files: number; additions: number; deletions: number } | null;
  note: string | null;
  /** The contract's outcome sentence, the line under the title on its contract page; null where the contract cannot be read. */
  outcome: string | null;
}
/** A provider's own account of its plan, and the ledger this machine keeps (S6E). */
export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}
export interface UsageProvider {
  id: "claude" | "codex" | "anthropic";
  name: string;
  role: string | null;
  /** Signed in on this machine, whether or not the provider reports a window. */
  connected: boolean;
  plan: string | null;
  windows: UsageWindow[] | null;
  detail: string;
}
export interface UsageLedger {
  month: string;
  spentMicros: number;
  pricedAttempts: number;
  unpricedAttempts: number;
  ticketsRun: number;
  ticketsMerged: number;
  /** Tickets an attempt stopped short of finishing — a stall, or a ceiling the repository set. */
  stoppedShort: number;
  averageMergedMicros: number | null;
}
export interface UsageReport {
  readAt: string;
  ledger: UsageLedger;
  providers: UsageProvider[];
  notes: string[];
}
export interface ReplyMap {
  repositorySnapshot: RepositorySnapshot;
  explorerList: ExplorerListing;
  explorerRead: ExplorerFile;
  graphRead: GraphView;
  graphEdit: Job;
  graphUndo: Job;
  explorerMark: EditingSession;
  explorerUndo: EditingSession;
  snapshot: Snapshot;
  drafts: OpenDraft[];
  editingOpen: EditingSession;
  editingRead: EditingSession;
  editingSave: EditingSession;
  editingSubmit: EditingSession;
  editingStop: EditingSession;
  editingVisited: EditingSession;
  editingContractVisited: EditingSession;
  editingDiscard: EditingSession;
  interviewStart: InterviewStatus;
  interviewTurn: InterviewStatus;
  interviewStop: InterviewStatus;
  specRead: SpecView;
  specSave: SpecSaveReply;
  symbolIndex: SymbolIndexView;
  impactRead: ImpactView;
  impactContract: ImpactView;
  driftCheck: Job;
  driftDismiss: null;
  specDelete: null;
  openHelp: null;
  chooseRepository: Repository | null;
  forgetRepository: null;
  saveSettings: Settings;
  taskModels: null;
  providers: Provider[];
  login: null;
  models: ModelCatalog;
  usage: UsageReport;
  detail: Detail;
  taskSummary: TaskSummary;
  output: { transcript: string | null; diff: string | null; notes: string[] };
  exportArchive: string | null;
  manifest: { digest: string; value: ManifestEditor; testCommand: string };
  saveManifest: null;
  rename: null;
  archive: null;
  askSave: null;
  ticketOpened: null;
  discard: null;
  doctor: Job;
  admit: Job;
  edit: Job;
  generatePlan: Job;
  /** The planning opened over the new plan, and which of its panes holds it. */
  replan: { sessionId: string; pane: "graph" | "criteria" };
  startOver: Job;
  run: Job;
  sync: Job;
  principle: Job;
  decide: Job;
  verdict: Job;
  cancel: null;
  openRepository: null;
  openWorktree: null;
  openPullRequest: null;
  export: string | null;
}
/** One Request, narrowed to the kind it carries. */
export type RequestOf<K extends Request["kind"]> = Extract<Request, { kind: K }>;
/**
 * A handler for every Request kind and for nothing else: a host that answers
 * the protocol is this table. A missing kind or a key the protocol does not
 * declare is a compile error, which is what makes the table exhaustive.
 */
export type RequestHandlers<Context = void> = {
  [K in Request["kind"]]: (
    request: RequestOf<K>,
    context: Context,
  ) => Promise<ReplyMap[K]> | ReplyMap[K];
};
export interface DesktopBridge {
  request<T extends Request>(request: T): Promise<ReplyMap[T["kind"]]>;
  subscribe(listener: (change: Change) => void): () => void;
  beforeClose?(listener: () => Promise<void>): () => void;
}
export type Response =
  | { ok: true; value: unknown }
  | { ok: false; error: string };
export const CHANNEL = "perbo:request";
export const CHANGED = "perbo:changed";
export const CLOSE_REQUEST = "perbo:close-request";
export const CLOSE_RESPONSE = "perbo:close-response";
export const CLOSE_CANCEL = "perbo:close-cancel";
export const CloseResponseSchema = z.strictObject({ token: identifier, ok: z.boolean(), error: z.string().max(2000).nullable() });
declare global {
  interface Window {
    perbo?: DesktopBridge;
  }
}
