import { DECISION_OPTION_MAX_CHARS, DecisionOptionsVerdictSchema, type DecisionOptionsVerdict } from "@perbo/planning/browser";
import { interviewModelFor } from "../../shared/contract-editing.js";
import { untilItRuns } from "../../shared/reading-retry.js";
import { redact, requireSuccess } from "../process.js";
import type { Cli } from "../cli.js";
import type { ModelCatalogs } from "../providers/catalogs.js";
import type { RegisteredRepository } from "../profile/store.js";
import type { Settings, TaskModels } from "../../shared/protocol.js";

export interface DecisionOptionsDeps {
  cli: Pick<Cli, "run">;
  catalogs: Pick<ModelCatalogs, "known">;
  /** The models this ticket runs on: its own where the contract page chose them, else the settings'. */
  models(repoId: string, key: string): TaskModels | Settings;
  /** The wait between tries of an asking that did not run; tests make it instant. */
  pause(ms: number): Promise<void>;
}

/** What `perbo options` is run with: the ticket, the findings and the Architect's provider and model. */
export function decisionOptionsArgs(key: string, findings: readonly string[], provider: string, model: string): string[] {
  return ["options", key, ...findings.flatMap((finding) => ["--finding", finding]), "--provider", provider, "--model", model, "--json"];
}

/**
 * The Architect's answers to the findings a ticket's last review left for a
 * person (D-NEW-decision-options), as `perbo options` prints them: the answers
 * kept beside the ticket for that review, and a model asked only for a finding
 * not yet answered there.
 *
 * On the Architect's own provider and model, as the chat chooses them (D-102):
 * the planning's drafting provider, and the Architect model the person chose or
 * else the Architect's rule over the catalog the pickers last read. The
 * person's credential reaches the command through the environment it inherits
 * and is written nowhere.
 *
 * Tried until it runs, as a reading is (D-NEW-basic-and-epic-flows): a command
 * that exits with an error or prints something that is not the answers is run
 * again after each pause, and the last failure is what the card says.
 *
 * Each answer is redacted again with what this host's environment knows and
 * flattened onto its line, as the drift reading is: an answer that redaction
 * lengthens past what one may hold, or empties, fails the asking rather than
 * being cut or dropped (D-NEW-nothing-shown-is-cut).
 */
export async function decisionOptions(
  deps: DecisionOptionsDeps,
  repo: RegisteredRepository,
  key: string,
  findings: readonly string[],
): Promise<DecisionOptionsVerdict> {
  const models = deps.models(repo.id, key);
  const offered =
    models.draftingProvider === "claude-cli"
      ? ((await deps.catalogs.known("claude-cli"))?.models.map((row) => row.id) ?? null)
      : null;
  const args = decisionOptionsArgs(key, findings, models.draftingProvider, interviewModelFor(models, offered));
  let printed: DecisionOptionsVerdict;
  try {
    printed = await untilItRuns(
      async () => DecisionOptionsVerdictSchema.parse(JSON.parse(requireSuccess(await deps.cli.run(args, repo)))),
      (ms) => deps.pause(ms),
    );
  } catch (error) {
    // The command's own words, redacted: they are shown behind the card's `i`.
    throw new Error(redact(error instanceof Error ? error.message : String(error)).trim(), { cause: error });
  }
  return {
    ...printed,
    findings: printed.findings.map((finding) => ({
      finding_key: finding.finding_key,
      options: finding.options.map((option) => {
        const text = redact(option.text).replace(/\s+/g, " ").trim();
        if (text.length === 0 || text.length > DECISION_OPTION_MAX_CHARS)
          throw new Error(
            `An answer the Architect offered is ${text.length === 0 ? "empty" : `longer than the ${DECISION_OPTION_MAX_CHARS} characters it may hold`} once a secret in it is redacted, and is not shown cut short.`,
          );
        return { text, recommended: option.recommended };
      }),
    })),
  };
}
