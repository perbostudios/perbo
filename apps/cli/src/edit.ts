import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ZodError } from "zod";
import {
  EXIT_CODES,
  PlanContractSchema,
  TicketSchema,
  compareLevels,
  hasAcceptanceCriteria,
  planNodes,
  type AcceptanceCriterion,
  type ApproachRecord,
  type PlanContract,
  type PlanNode,
  type PlanLevel,
  type Scope,
  type Ticket,
} from "@perbo/contracts";
import { PlanningError, blockingEdit, contractEditCount, readSpecFile } from "@perbo/planning";
import { assembleContract, assertContractSealed, assertRequirementsCarried, chooseLevel, parseCriterion, recordedEdits, type ManualVerifier } from "./admit.js";
import type { Streams } from "./streams.js";
import { UsageError } from "./usage-error.js";
import { readNodePageInputs } from "./specs.js";
import {
  DRAFT_SNAPSHOT_VERSION,
  EDIT_AUTHORS,
  assertContractMatches,
  contextManifestHash,
  contractPathFor,
  deleteApproachRecord,
  readApproachRecord,
  readContract,
  readDraftSnapshotFile,
  readTicket,
  storeDir,
  writeApproachRecord,
  writeContract,
  writeDraftSnapshot,
  writeTicket,
  type AppliedEdit,
  type DraftSnapshot,
  type EditAuthor,
} from "./tickets.js";
import { applyGraphEdit, emptyApproach, undoGraphEdit } from "./graph-edit.js";

/**
 * `perbo edit KEY` — the person's half of a drafted contract.
 *
 * Opens `<KEY>.contract.json` in `$VISUAL` or `$EDITOR`, by argv, and
 * re-validates the file when the editor returns. A contract that no longer
 * parses is refused with its issues listed and **left as edited**, so the
 * person fixes their text rather than losing it. Only a ticket in
 * `plan_review` may be edited: an approved contract is immutable (ADR-0016).
 *
 * `--outcome`, `--criterion`, `--path` and `--prohibit` edit without an editor,
 * for scripts and tests; each replaces the whole of its part.
 *
 * After either kind of edit the level is derived again from the new scope and
 * the context manifest hash is recomputed — a scope that grew into `auth/` is
 * P2 whether or not the person changed the `level` field, and a person may
 * not set a level below the derivation (D-010).
 */

export interface EditArgs {
  repo: string;
  store: string | null;
  outcome: string | null;
  criteria: string[];
  paths: string[];
  /** Paths the executor may not write even inside the allowed ones (D-105). Replaces the list. */
  prohibited: string[];
  manualReviewer: string | null;
  manualReason: string | null;
  /** One graph edit, as JSON. See `GraphEditSchema` in `@perbo/contracts`. */
  graphEdit: string | null;
  /** The number of the edit to revert, one upward through the recorded list. */
  undo: number | null;
  /** Who is making it. The interview passes `interview`; a person's edits count. */
  author: EditAuthor;
  json: boolean;
}

export interface EditInput {
  argv: string[];
  streams: Streams;
  cwd: string;
  now?: Date;
  /** Where `VISUAL` and `EDITOR` are read from. Tests supply one. */
  env?: NodeJS.ProcessEnv;
}

const takeValue = (rest: readonly string[], index: number, token: string): string => {
  const next = rest[index];
  if (next === undefined) throw new UsageError(`${token} requires a value`);
  return next;
};

export function parseEditArgs(argv: readonly string[]): { key: string; args: EditArgs } {
  const [key, ...rest] = argv;
  if (!key || key.startsWith("--")) throw new UsageError("edit requires a ticket key, e.g. PRB-1");
  const args: EditArgs = {
    repo: ".",
    store: null,
    outcome: null,
    criteria: [],
    paths: [],
    prohibited: [],
    manualReviewer: null,
    manualReason: null,
    graphEdit: null,
    undo: null,
    author: "you",
    json: false,
  };
  const tokens = rest.flatMap((token) => {
    if (!token.startsWith("--")) return [token];
    const eq = token.indexOf("=");
    return eq === -1 ? [token] : [token.slice(0, eq), token.slice(eq + 1)];
  });
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    switch (token) {
      case "--repo":
        args.repo = takeValue(tokens, ++i, token);
        break;
      case "--store":
        args.store = takeValue(tokens, ++i, token);
        break;
      case "--outcome":
        args.outcome = takeValue(tokens, ++i, token);
        break;
      case "--criterion":
        args.criteria.push(takeValue(tokens, ++i, token));
        break;
      case "--path":
        args.paths.push(takeValue(tokens, ++i, token));
        break;
      case "--prohibit":
        args.prohibited.push(takeValue(tokens, ++i, token));
        break;
      case "--manual-reviewer":
        args.manualReviewer = takeValue(tokens, ++i, token);
        break;
      case "--manual-reason":
        args.manualReason = takeValue(tokens, ++i, token);
        break;
      case "--graph-edit":
        args.graphEdit = takeValue(tokens, ++i, token);
        break;
      case "--undo": {
        const raw = takeValue(tokens, ++i, token);
        const number = Number(raw);
        if (!Number.isInteger(number) || number < 1) {
          throw new UsageError(
            `--undo takes the number of the edit to revert, counting from 1. Got '${raw}'`,
          );
        }
        args.undo = number;
        break;
      }
      case "--author": {
        const author = takeValue(tokens, ++i, token);
        if (!(EDIT_AUTHORS as readonly string[]).includes(author)) {
          throw new UsageError(`--author must be ${EDIT_AUTHORS.join(" or ")}. Got '${author}'`);
        }
        args.author = author as EditAuthor;
        break;
      }
      case "--json":
        args.json = true;
        break;
      default:
        throw new UsageError(`unknown option '${token}' for edit`);
    }
  }
  // One edit at a time, through one path. `--graph-edit` and the flag edits
  // change different things by different rules, and an `--undo` reverts rather
  // than applies: a command asking for two of them means something this cannot
  // tell, and picking one would apply an edit nobody asked for.
  const asked = [
    args.graphEdit !== null ? "--graph-edit" : null,
    args.undo !== null ? "--undo" : null,
    args.outcome !== null ||
    args.criteria.length > 0 ||
    args.paths.length > 0 ||
    args.prohibited.length > 0
      ? "--outcome/--criterion/--path/--prohibit"
      : null,
  ].filter((each): each is string => each !== null);
  if (asked.length > 1) {
    throw new UsageError(
      `${asked.join(" and ")} are separate edit paths, and edit applies one edit at a time`,
    );
  }
  return { key, args };
}

const IDENTITY = ["plan_id", "ticket_id", "version"] as const;

/**
 * The contract on disk, or null when a previous edit left it unparseable. An
 * editor is the way to fix that file, so the interactive path must be able to
 * open it; the non-interactive one refuses and says so.
 */
function readContractIfValid(dir: string, key: string): PlanContract | null {
  try {
    return readContract(dir, key);
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError")) {
      return null;
    }
    throw error;
  }
}

/** The editor, split on whitespace so `EDITOR="code --wait"` works, still argv. */
function editorFrom(env: NodeJS.ProcessEnv): { binary: string; args: string[] } {
  const raw = (env.VISUAL ?? "").trim() || (env.EDITOR ?? "").trim();
  if (!raw) {
    throw new UsageError(
      "no editor is set. Export VISUAL or EDITOR with the editor's path (for example: " +
        'export EDITOR=vim), or edit without one: perbo edit KEY --outcome "..." ' +
        '--criterion "what :: how it is proven" --path "src/**" --prohibit "src/generated/**"',
    );
  }
  const [binary, ...args] = raw.split(/\s+/);
  return { binary: binary!, args };
}

/** Open the file, wait, then read back what the person left there. */
function editInteractively(
  path: string,
  key: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  streams: Streams,
): PlanContract {
  const editor = editorFrom(env);
  const result = spawnSync(editor.binary, [...editor.args, path], { cwd, stdio: "inherit" });
  if (result.error) {
    throw new UsageError(
      `could not start the editor '${editor.binary}': ${result.error.message}. The contract is unchanged`,
    );
  }
  if (result.status !== 0) {
    streams.stderr(`warning: the editor exited with status ${result.status ?? "unknown"}\n`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(
      `${key}'s contract is not JSON after the edit (${error instanceof Error ? error.message : String(error)}). ` +
        `The file is left as you edited it: fix it, then run perbo edit ${key} again`,
    );
  }
  const parsed = PlanContractSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `  ${issue.path.join(".") || "(contract)"}: ${issue.message}`,
    );
    throw new UsageError(
      `${key}'s contract no longer parses after the edit (${issues.length} issue` +
        `${issues.length === 1 ? "" : "s"}):\n${issues.join("\n")}\n` +
        `The file is left as you edited it: fix it, then run perbo edit ${key} again`,
    );
  }
  return parsed.data;
}

function assertIdentityKept(before: PlanContract, after: PlanContract, key: string): void {
  const moved: string[] = IDENTITY.filter((field) => before[field] !== after[field]);
  if (JSON.stringify(before.base) !== JSON.stringify(after.base)) moved.push("base");
  if (moved.length > 0) {
    throw new UsageError(
      `${key}'s edit changed ${moved.join(", ")}, which identify the contract and the tree it was ` +
        "captured against; an edit changes the outcome, the criteria and the scope only. The file " +
        `is left as you edited it: restore those fields, then run perbo edit ${key} again`,
    );
  }
}

export async function runEditCommand(input: EditInput): Promise<number> {
  const { key, args } = parseEditArgs(input.argv);
  return runEdit({ key, args, streams: input.streams, cwd: input.cwd, now: input.now, env: input.env });
}

/**
 * The edit with its arguments already built, for a caller that holds them as
 * values rather than as a command line — the queue's endpoint, whose inputs
 * are a session's strings and must never be parsed as flags.
 */
export async function runEdit(input: {
  key: string;
  args: EditArgs;
  streams: Streams;
  cwd: string;
  now?: Date | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}): Promise<number> {
  const now = input.now ?? new Date();
  const { key, args } = input;
  const { streams } = input;
  const dir = storeDir(resolve(input.cwd, args.repo), args.store);

  const ticket = readTicket(dir, key);
  if (args.graphEdit !== null || args.undo !== null) {
    // The graph path decides for itself what approval forbids: a node's
    // criteria and paths are contract and freeze at approval, an edge is
    // approach and does not (ADR-0016, D-100).
    return runGraphEdit({ key, args, streams, cwd: input.cwd, now, dir, ticket });
  }
  if (ticket.approved_at !== null) {
    throw new UsageError(
      `${key} was approved at ${ticket.approved_at}, and an approved contract is immutable ` +
        "(ADR-0016). A change to it is new work: admit it",
    );
  }
  if (ticket.state !== "plan_review") {
    throw new UsageError(`${key} is ${ticket.state}; only a ticket in plan_review may be edited`);
  }
  const interactive =
    args.outcome === null &&
    args.criteria.length === 0 &&
    args.paths.length === 0 &&
    args.prohibited.length === 0;
  const path = contractPathFor(dir, key);

  // What the edit is measured against: the contract as it stands, or — when a
  // previous edit left the file unparseable — the copy in the draft snapshot,
  // which admission and every edit since have kept in step with it and which
  // carries the same identity and base.
  //
  // A draft file that is there and does not parse is read as no snapshot at
  // all, and this command writes a new one over it. It has to: this is the
  // command approval sends a person to when the pair is broken, including when
  // what broke it was a text editor that left the JSON invalid, and a remedy
  // that fails on the state it is the remedy for is not one. What is lost with
  // it — how the contract was drafted, what earlier edits changed — is said out
  // loud rather than dropped quietly.
  const onDisk = readContractIfValid(dir, key);
  const draft = readDraftSnapshotFile(dir, key);
  if (draft.kind === "unreadable") {
    streams.stderr(
      `warning: ${key}.draft.json cannot be read: ${draft.reason}. It is replaced by this edit, ` +
        "and what it recorded about the drafting is lost; restore it from version control first " +
        "if you want it back.\n",
    );
  }
  const snapshot = draft.kind === "snapshot" ? draft.snapshot : null;
  const before = onDisk ?? snapshot?.contract ?? null;
  if (onDisk) assertContractMatches(ticket, onDisk);
  if (before === null) {
    throw new UsageError(
      `${key}'s contract does not parse and no draft snapshot exists to measure an edit against; ` +
        "restore the file from version control",
    );
  }
  if (onDisk === null && !interactive) {
    throw new UsageError(
      `${key}'s contract does not parse after an earlier edit; open it to fix it: perbo edit ${key}`,
    );
  }

  let outcome: string;
  let criteria: AcceptanceCriterion[];
  let scope: Scope;
  let requested: PlanLevel | null;
  let edited: PlanContract;
  /** The graph's nodes as this edit leaves them; absent for a flat plan. */
  let nodes: readonly PlanNode[] | undefined;
  /**
   * The graph this edit carries forward: the one the draft snapshot vouches
   * for, since that is where every graph edit is recorded (D-100). With no
   * snapshot nothing vouches for a graph, so the file may carry none.
   */
  const sealedNodes = snapshot ? planNodes(snapshot.contract) : [];
  const assertNodesVouched = (found: readonly PlanNode[], mismatch: string): void => {
    if (JSON.stringify(found) === JSON.stringify(sealedNodes)) return;
    if (!snapshot) {
      throw new UsageError(
        `${key}'s contract file carries nodes, and ${key}.draft.json, which vouches for a graph, ` +
          "is missing or unreadable. Restore it from version control, or drop nodes from the file " +
          `and build the graph again with perbo edit ${key} --graph-edit once this edit has written the pair`,
      );
    }
    throw new UsageError(mismatch);
  };
  if (interactive) {
    edited = editInteractively(path, key, input.env ?? process.env, input.cwd, streams);
    assertIdentityKept(before, edited, key);
    if (!hasAcceptanceCriteria(edited)) {
      throw new UsageError(
        `${key}'s edit set level P0, which carries no acceptance criteria, so nothing could ` +
          `review it. The file is left as you edited it: restore a level, then run perbo edit ${key} again`,
      );
    }
    outcome = edited.outcome;
    criteria = edited.acceptance_criteria;
    scope = edited.scope;
    // The graph changes through --graph-edit and nothing else (D-100): that is
    // the path that validates each edit whole and records it so it can be
    // undone. A change to `nodes` left in the file is refused, not discarded,
    // and it is measured against the counter-seal rather than the file, which
    // a refused edit was left as.
    assertNodesVouched(
      planNodes(edited),
      `${key}'s edit changed nodes, which change only through perbo edit ${key} --graph-edit ` +
        `(D-100). The file is left as you edited it: restore nodes, then run perbo edit ${key} again`,
    );
    nodes = edited.nodes;
    // A level left as it was is not a request — the scope decides again. A
    // level raised above what stood is a raise; one written below it is an
    // attempt to lower, which the derivation refuses unless the new scope
    // genuinely derives that low.
    const movement = compareLevels(edited.level, before.level);
    requested =
      movement !== 0
        ? edited.level
        : ticket.admission.level_source === "raised"
          ? before.level
          : null;
  } else {
    edited = before;
    if (!hasAcceptanceCriteria(before)) {
      throw new UsageError(`${key} is ${before.level}, which cannot be edited into a reviewable contract`);
    }
    const manual: ManualVerifier = { reviewer: args.manualReviewer, reason: args.manualReason };
    outcome = args.outcome ?? before.outcome;
    criteria =
      args.criteria.length > 0
        ? args.criteria.map((raw, index) => parseCriterion(raw, index, manual))
        : before.acceptance_criteria;
    scope = {
      ...before.scope,
      ...(args.paths.length > 0 ? { paths_allowed: args.paths } : {}),
      ...(args.prohibited.length > 0 ? { paths_prohibited: args.prohibited } : {}),
    };
    // A file whose nodes differ from the counter-seal was changed by hand
    // and left that way; a flag edit re-seals the file, and must not seal a
    // graph that no edit made (D-100).
    assertNodesVouched(
      planNodes(before),
      `${key}'s contract file carries nodes that differ from its counter-seal, which only ` +
        `perbo edit ${key} --graph-edit changes (D-100). Restore nodes in the file, or the file ` +
        `from version control, then run this edit again`,
    );
    // A graph groups the criteria it was drawn over, and --criterion replaces
    // them all; on a plan with a graph the criteria change node by node
    // through --graph-edit instead (D-100), which keeps the graph in step.
    if (args.criteria.length > 0 && sealedNodes.length > 0) {
      throw new UsageError(
        `${key}'s plan groups its criteria into nodes, and --criterion replaces them all. ` +
          `Change one with perbo edit ${key} --graph-edit '{"op":"set_criterion",...}', add or ` +
          "delete them with add_node and delete_node, and the graph follows; deleting the last " +
          "node makes the plan flat again",
      );
    }
    nodes = before.nodes;
    // A level a person raised stays raised; a derived one is derived again.
    requested = ticket.admission.level_source === "raised" ? before.level : null;
  }

  const level = chooseLevel(scope, requested);
  let contract: PlanContract;
  try {
    contract = assembleContract({
      identity: { plan_id: before.plan_id, version: before.version, ticket_id: before.ticket_id },
      level,
      outcome,
      criteria,
      scope,
      ...(nodes === undefined ? {} : { nodes }),
      base: {
        ...before.base,
        context_manifest_hash: contextManifestHash({ base_commit: before.base.base_commit, ...scope }),
      },
      existing: edited,
    });
  } catch (error) {
    // The one way a flag edit fails the schema: --path narrowed the scope
    // below a node's paths. The editor path has already been validated whole.
    if (!(error instanceof ZodError) || interactive) throw error;
    const issues = error.issues.map((issue) => `  ${issue.path.join(".") || "(contract)"}: ${issue.message}`);
    throw new UsageError(
      `${key}'s edit leaves its graph outside the new scope (${issues.length} issue` +
        `${issues.length === 1 ? "" : "s"}):\n${issues.join("\n")}\n` +
        `Nothing is changed: narrow the node's paths first with perbo edit ${key} --graph-edit ` +
        `'{"op":"set_node_paths",...}', or keep those paths in --path`,
    );
  }
  // A criterion records the requirement it was drafted from (D-103). What a
  // spec carries is read from the spec itself, at the path admission recorded,
  // never from a contract file this command has just rewritten: a refused edit
  // is left on disk for the person to fix, and a second run refuses it again.
  // A contract with no spec behind it cites nothing.
  assertRequirementsCarried(
    contract,
    specRequirementIds(resolve(input.cwd, args.repo), ticket),
    ticket.admission.spec?.path ?? null,
    `. The file is left as you edited it: drop the citation, then run perbo edit ${key} again`,
  );
  // Read before anything is written, as the graph edit reads it: a record
  // that is not JSON or names another plan refuses the edit here, with the
  // pair untouched, rather than after the contract has been rewritten.
  const approach = readApproachRecord(dir, key, contract);
  // Read before the first write, so an edit whose spec cannot be read lands nowhere.
  const pages = readNodePageInputs({ repositoryRoot: resolve(input.cwd, args.repo), ticket, contract });
  writeContract(dir, ticket, contract);
  // The approach record keeps the order between nodes. A plan left with no
  // nodes has no order to keep, so the record goes with the graph, and stays
  // only where the spec's No-Gos still need it, with no edges.
  if (approach !== null && planNodes(contract).length === 0) {
    if (approach.no_gos.length === 0) deleteApproachRecord(dir, key);
    else if (approach.edges.length > 0) writeApproachRecord(dir, key, { ...approach, edges: [] });
  }

  // The draft file is re-sealed with the same contract, and what this edit
  // changed is appended to it. Both halves matter: `approve` refuses a ticket
  // whose two contracts differ, so an edit that wrote only one of them would
  // make this command the thing that breaks the ticket; and with the two held
  // in step, the record kept here is the only remaining evidence of what a
  // person changed, which `admission.edit_count` is read from.
  //
  // A ticket that has never been counter-sealed — admitted before the pair was
  // kept in step, and possibly edited by that version too — is sealed here, so
  // it is sealed from its first edit onwards rather than never. Whatever its
  // contract had already drifted from the snapshot is written in first, at the
  // time the ticket was last touched: for such a store that difference is what
  // the earlier edits did, it is the number that version reported, and starting
  // the count from zero here would lose it.
  const diff = contractEditCount(before, contract);
  const applied = flagEdit(now.toISOString(), diff.changes, args.author);
  const earlier =
    snapshot && ticket.admission.counter_sealed_at === null
      ? contractEditCount(snapshot.contract, before).changes
      : [];
  const resealed: DraftSnapshot = snapshot
    ? {
        ...snapshot,
        contract,
        edits: [
          ...snapshot.edits,
          // What an earlier version of this command changed without recording
          // it, attributed to the person, because that is who ran it.
          ...(earlier.length > 0 ? [flagEdit(ticket.updated_at, earlier, "you")] : []),
          applied,
        ],
      }
    : {
        schema_version: DRAFT_SNAPSHOT_VERSION,
        key,
        rendered_at: ticket.admitted_at,
        criteria_source: ticket.admission.criteria_source,
        contract,
        edits: [applied],
        // Nothing to record: whatever the model proposed, if a model did, was
        // not kept, and inventing a provenance here would be worse than the
        // absence it is standing in for.
        draft: null,
      };
  writeDraftSnapshot(dir, resealed);

  const updated: Ticket = TicketSchema.parse({
    ...ticket,
    title: contract.outcome,
    updated_at: now.toISOString(),
    admission: {
      ...ticket.admission,
      // Read back from the record just written, so the count a person sees
      // before approval is the one `approve` will report: every field edited at
      // least once, across every edit this ticket has had.
      edit_count: recordedEdits(resealed).count,
      // Both files have just been written from `contract`. From here approval
      // and execution require them to agree.
      counter_sealed_at: now.toISOString(),
      level_source: level.source,
      derived_level: level.derivation.level,
    },
  });
  writeTicket(dir, updated);
  // The node pages state what the spec and the graph say, so they are rewritten
  // whenever either moves (D-103).
  pages?.write();

  if (args.json) {
    streams.stdout(`${JSON.stringify({ ticket: updated, contract, changes: diff.changes }, null, 2)}\n`);
    return EXIT_CODES.approve;
  }
  const levelNote =
    contract.level === before.level
      ? ""
      : `  level     ${before.level} -> ${contract.level} (${level.derivation.reasons.join("; ")})\n`;
  streams.stderr(
    `${key} edited: ${diff.count} change${diff.count === 1 ? "" : "s"}` +
      (diff.count > 0 ? ` (${diff.changes.join(", ")})` : "") +
      "\n" +
      levelNote +
      `\nRead it once more, then approve it:\n  perbo approve ${key}\n`,
  );
  return EXIT_CODES.approve;
}

/**
 * `perbo edit KEY --graph-edit '<json>'` and `perbo edit KEY --undo <n>`:
 * the one validated path a plan's execution graph changes through (D-100).
 *
 * An edit is applied to a copy, validated whole, and recorded with the entity
 * keys it touched and their values either side. A refused edit writes nothing
 * and says why. An `--undo` replays one edit's recorded `before` values, and is
 * refused when a later edit still in force touched any of the same keys.
 */
async function runGraphEdit(input: {
  key: string;
  args: EditArgs;
  streams: Streams;
  cwd: string;
  now: Date;
  dir: string;
  ticket: Ticket;
}): Promise<number> {
  const { key, args, streams, dir, now, ticket } = input;
  if (ticket.state !== "plan_review" && ticket.approved_at === null) {
    throw new UsageError(`${key} is ${ticket.state}; only a ticket in plan_review may be edited`);
  }
  const contract = readContract(dir, key);
  assertContractMatches(ticket, contract);
  const draft = readDraftSnapshotFile(dir, key);
  // The file the edit starts from is the one the counter-seal vouches for, as
  // approve and run require: a hand edit left on disk, refused or not, is not
  // a state a graph edit builds on or re-seals.
  assertContractSealed(ticket, contract, draft, "edited");
  if (draft.kind !== "snapshot") {
    throw new UsageError(
      `${key} has no draft snapshot to record a graph edit against` +
        (draft.kind === "unreadable" ? `: ${draft.reason}` : "") +
        ". Restore it from version control, or run perbo edit " +
        `${key} --outcome "..." once to write one`,
    );
  }
  const snapshot = draft.snapshot;
  const approach = readApproachRecord(dir, key, contract) ?? emptyApproach(contract);
  const state = { contract, approach };

  const applied =
    args.undo !== null
      ? undo(key, snapshot.edits, args.undo, state)
      : {
          outcome: applyGraphEdit(state, parseGraphEdit(args.graphEdit!), reservedIds(snapshot)),
          undoes: null as number | null,
        };
  const { outcome } = applied;
  if (ticket.approved_at !== null && !outcome.approachOnly) {
    throw new UsageError(
      `${key} was approved at ${ticket.approved_at}, and a node's criteria and paths are ` +
        "contract, which is immutable from approval (ADR-0016). The order between nodes and the " +
        "spec's No-Gos are approach and may still change: add_edge and remove_edge are what is " +
        "left. A change to the contract is new work: admit it",
    );
  }
  // An undo puts whole criteria back from the log, citations included, so what
  // it restores is held to the spec as a hand edit is (D-103). The eight
  // operations carry no citation and need no check; an edge's undo moves no
  // criterion.
  if (applied.undoes !== null && !outcome.approachOnly) {
    assertRequirementsCarried(
      outcome.contract,
      specRequirementIds(resolve(input.cwd, args.repo), ticket),
      ticket.admission.spec?.path ?? null,
      `. Nothing is changed: leave edit ${applied.undoes} as it is, or restore the criterion by hand ` +
        `with perbo edit ${key}`,
    );
  }

  const changes = [
    ...contractEditCount(state.contract, outcome.contract).changes,
    ...graphChanges(state, outcome),
  ];
  const entry: AppliedEdit = {
    at: now.toISOString(),
    changes,
    author: args.author,
    summary: applied.undoes === null ? outcome.summary : `undid edit ${applied.undoes}`,
    keys: outcome.keys,
    before: outcome.before,
    after: outcome.after,
    undone: false,
    replaced: false,
    undoes: applied.undoes,
  };
  const edits = snapshot.edits.map((each, index) =>
    applied.undoes !== null && index + 1 === applied.undoes ? { ...each, undone: true } : each,
  );
  const resealed: DraftSnapshot = {
    ...snapshot,
    contract: outcome.contract,
    edits: [...edits, entry],
  };

  // Read before the first write, so an edit whose spec cannot be read lands nowhere.
  const pages = readNodePageInputs({
    repositoryRoot: resolve(input.cwd, args.repo),
    ticket,
    contract: outcome.contract,
  });
  // Both files together where the contract moved, so the counter-seal holds;
  // the approach on its own where it did not, which is the case an approved
  // ticket is in.
  if (!outcome.approachOnly) writeContract(dir, ticket, outcome.contract);
  writeDraftSnapshot(dir, resealed);
  // A plan with a graph, or a spec with No-Gos, carries the approach record;
  // one left with neither carries none, as a flat plan admitted from an issue.
  if (planNodes(outcome.contract).length === 0 && outcome.approach.no_gos.length === 0) {
    deleteApproachRecord(dir, key);
  } else {
    writeApproachRecord(dir, key, outcome.approach);
  }

  const updated: Ticket = TicketSchema.parse({
    ...ticket,
    updated_at: now.toISOString(),
    admission:
      ticket.approved_at !== null
        ? ticket.admission
        : {
            ...ticket.admission,
            edit_count: recordedEdits(resealed).count,
            ...(outcome.approachOnly ? {} : { counter_sealed_at: now.toISOString() }),
          },
  });
  writeTicket(dir, updated);
  pages?.write();

  if (args.json) {
    streams.stdout(
      `${JSON.stringify(
        { ticket: updated, contract: outcome.contract, approach: outcome.approach, edit: entry },
        null,
        2,
      )}\n`,
    );
    return EXIT_CODES.approve;
  }
  streams.stderr(
    `${key}: ${entry.summary}\n` +
      `  edit ${resealed.edits.length} by ${entry.author}` +
      (entry.keys.length > 0 ? `, touching ${entry.keys.join(", ")}` : "") +
      "\n" +
      (ticket.approved_at === null
        ? `\nRead it once more, then approve it:\n  perbo approve ${key}\n`
        : `\nThe approach may change while the work runs; the contract may not.\n`),
  );
  return EXIT_CODES.approve;
}

/** `--graph-edit` as JSON, refused as a usage error rather than a stack. */
function parseGraphEdit(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new UsageError(
      `--graph-edit is not JSON (${error instanceof Error ? error.message : String(error)}). ` +
        `It takes one edit, for example: --graph-edit '{"op":"add_edge","from":"node_1","to":"node_2"}'`,
    );
  }
}

/** Every node and criterion id any earlier edit mentioned, so none is reused. */
function reservedIds(snapshot: DraftSnapshot): string[] {
  return snapshot.edits
    .flatMap((edit) => edit.keys)
    .filter((key) => key.startsWith("node:") || key.startsWith("criterion:"))
    .map((key) => key.slice(key.indexOf(":") + 1));
}

/**
 * Revert one recorded edit, under D-100's rule: an edit is undoable unless a
 * later edit that is still in force changed the same node, edge or criterion.
 * {@link blockingEdit} decides that; everything else here is what this store
 * knows and a pane does not.
 */
function undo(
  key: string,
  edits: readonly AppliedEdit[],
  number: number,
  state: { contract: PlanContract; approach: ApproachRecord },
): { outcome: ReturnType<typeof undoGraphEdit>; undoes: number } {
  const target = edits[number - 1];
  if (!target) {
    throw new UsageError(
      `${key} has ${edits.length} recorded edit${edits.length === 1 ? "" : "s"}, so there is no ` +
        `edit ${number} to undo`,
    );
  }
  if (target.undone) {
    throw new UsageError(`${key}'s edit ${number} (${target.summary ?? "no summary"}) is already undone`);
  }
  // The contract that edit changed no longer exists: the plan was re-drafted
  // from the spec over the top of it (D-103). There is nothing to put the
  // recorded values back into, so an undo cannot reach across the re-draft.
  if (target.replaced) {
    throw new UsageError(
      `${key}'s edit ${number} (${target.summary ?? "no summary"}) was made to a plan that has ` +
        "since been re-drafted from the spec, so there is no contract left for it to be undone " +
        `from. Edit the plan as it now stands: perbo edit ${key} --graph-edit`,
    );
  }
  // Undoing an undo would put the original edit's effect back while the log
  // still marked it undone, and the two would disagree from then on. The way
  // back is forward: the edit is applied again, and recorded again.
  if (target.undoes !== null) {
    throw new UsageError(
      `${key}'s edit ${number} undid edit ${target.undoes}, and an undo is not undone. To put that ` +
        `change back, apply it again with perbo edit ${key} --graph-edit`,
    );
  }
  const blocking = blockingEdit(edits, number);
  if (blocking) {
    throw new UsageError(
      `${key}'s edit ${number} cannot be undone: edit ${blocking.at} ` +
        `(${edits[blocking.at - 1]?.summary ?? "no summary"}) changed ${blocking.keys.join(", ")} ` +
        `after it. Undo edit ${blocking.at} first, or leave both as they are (D-100)`,
    );
  }
  if (Object.keys(target.before).length === 0 && target.keys.length === 0) {
    throw new UsageError(
      `${key}'s edit ${number} was recorded before edits carried what they changed, so there is ` +
        "nothing to put back. Edit the contract to what you want instead",
    );
  }
  return { outcome: undoGraphEdit(state, target.before), undoes: number };
}

/** What a graph edit changed that `contractEditCount` cannot see: nodes and edges. */
function graphChanges(
  before: { contract: PlanContract; approach: ApproachRecord },
  after: { contract: PlanContract; approach: ApproachRecord },
): string[] {
  const changes: string[] = [];
  const was = new Map(planNodes(before.contract).map((node) => [node.id, JSON.stringify(node)]));
  const now = new Map(planNodes(after.contract).map((node) => [node.id, JSON.stringify(node)]));
  for (const [id, value] of now) {
    if (!was.has(id)) changes.push(`${id} added`);
    else if (was.get(id) !== value) changes.push(`${id} changed`);
  }
  for (const id of was.keys()) if (!now.has(id)) changes.push(`${id} removed`);

  const edge = (one: { from: string; to: string }) => `${one.from} -> ${one.to}`;
  const wasEdges = new Set(before.approach.edges.map(edge));
  const nowEdges = new Set(after.approach.edges.map(edge));
  for (const one of nowEdges) if (!wasEdges.has(one)) changes.push(`edge +${one}`);
  for (const one of wasEdges) if (!nowEdges.has(one)) changes.push(`edge -${one}`);
  return changes;
}

/**
 * One flag edit as the log records it. The fields a graph edit fills are empty
 * here: there is nothing to undo key by key, because this path replaces whole
 * fields rather than moving entities between them.
 */
function flagEdit(at: string, changes: readonly string[], author: EditAuthor): AppliedEdit {
  return {
    at,
    changes: [...changes],
    author,
    summary: null,
    keys: [],
    before: {},
    after: {},
    undone: false,
    replaced: false,
    undoes: null,
  };
}

/**
 * The requirement ids a criterion of this ticket may cite: the ones its spec
 * carries, read from the repository at the path admission recorded, or none
 * where nothing was drafted from a spec.
 */
function specRequirementIds(repositoryRoot: string, ticket: Ticket): string[] {
  const spec = ticket.admission.spec;
  if (spec === null) return [];
  try {
    return readSpecFile(resolve(repositoryRoot, spec.path)).spec.requirements.map(
      (requirement) => requirement.id,
    );
  } catch (error) {
    const reason = error instanceof PlanningError ? error.message : String(error);
    throw new UsageError(
      `${ticket.key} was drafted from ${spec.path}, and a criterion's requirement id is checked ` +
        `against that spec, which cannot be read now: ${reason}`,
    );
  }
}
