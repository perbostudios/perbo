import type { PermissionProfile, SecretIndex } from "@perbo/contracts";
import type { MaterializedWorkspace } from "@perbo/workspace";
import { AgentConfigurationPresentError, type AgentResult } from "../adapter.js";
import { AttemptCeilings } from "../ceilings.js";
import { buildAgentEnvironment } from "../profile.js";
import { quarantine, release } from "../quarantine.js";
import type { Brief } from "./brief.js";
import type { TicketRunConfig } from "./config.js";
import type { LoopPorts } from "./context.js";
import type { RoundState, Stop } from "./state.js";

/**
 * The handover: the executor runs here and nowhere else.
 */

/** What the executor left behind, and what measured it while it ran. */
export interface Executed {
  result: AgentResult;
  ceilings: AttemptCeilings;
  environment: ReturnType<typeof buildAgentEnvironment>;
}

/**
 * Run one attempt's executor, with the repository's own agent configuration
 * quarantined around it (ADR-0030 requirement 2).
 *
 * The configuration is put back whatever the attempt does, a throw included,
 * and what was withheld is written onto the invocation the record keeps. A
 * configuration the runner could not move out of the way is not an attempt at
 * all: the run stops with what the adapter refused over.
 */
export async function execute(args: {
  config: TicketRunConfig;
  state: RoundState;
  brief: Brief;
  attemptId: string;
  /** When the attempt started; the quarantine journal is stamped with it. */
  at: Date;
  profile: PermissionProfile;
  materialized: MaterializedWorkspace;
  secrets: SecretIndex;
  agent: LoopPorts["agent"];
  progress: (message: string) => void;
}): Promise<{ executed: Executed } | Stop> {
  const { config, state, brief, secrets, progress } = args;
  // ADR-0030 requirement 2, around every handover including remediation.
  const journal = quarantine({
    worktree: state.workspace.path,
    store: config.quarantine_root,
    attempt_id: args.attemptId,
    now: args.at,
  });
  const environment = buildAgentEnvironment({
    base: process.env,
    profile: args.profile,
    worktree: state.workspace.path,
    ports: args.materialized.ports,
    database_schema: args.materialized.database_schema,
  });
  const ceilings = new AttemptCeilings(config.limits, Date.now, {
    // D-092: a remediation round closes findings that already name a file
    // and a line, briefed with the previous attempt's account, so the
    // counter it is tested against is `round_iterations` where an attempt
    // building the ticket is tested against `attempt_iterations`. A
    // conflict round is neither: it is not remediation, and it keeps the
    // attempt's counter. Neither counter is set unless the repository sets
    // it (D-096), and then this is which of the two it reads.
    ...(state.kind === "remediate" ? { iterations: "round_iterations" as const } : {}),
  });

  let result: AgentResult;
  try {
    result = await args.agent({
      binary: config.agent_binary,
      worktree: state.workspace.path,
      prompt: brief.prompt,
      brief_records: brief.briefRecords,
      model: config.model,
      profile: args.profile,
      ceilings,
      env: environment.env,
      paths_allowed: brief.pathsAllowed,
      paths_prohibited: brief.pathsProhibited,
      spec_folder: config.specs,
      onProgress: progress,
      redact: (text) => secrets.redact(text).text,
    });
  } catch (error) {
    release(journal, config.quarantine_root);
    if (error instanceof AgentConfigurationPresentError) {
      return { next: "stop", end: { outcome: "terminated", detail: error.message } };
    }
    throw error;
  }
  release(journal, config.quarantine_root);
  result.invocation.neutralisation.withheld_from_worktree = journal.entries.map(
    (entry) => entry.relative_path,
  );
  return { executed: { result, ceilings, environment } };
}
