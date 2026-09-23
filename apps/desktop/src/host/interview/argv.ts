import { TaskModelsSchema, INTERVIEW_NEEDS_A_TITLE } from "../../shared/protocol.js";
import { interviewProviderFor, interviewSessionArgs } from "../../shared/contract-editing.js";
import { specFolder } from "../repository/config.js";
import { safePath } from "../repository/paths.js";
import type { RegisteredRepository } from "../profile/store.js";
import type { EditingSession } from "../../shared/protocol.js";

/**
 * The interview's argv, built from the registered repository and this
 * planning's own records and from nothing a renderer sent (ADR-0023 §4).
 *
 * `--spec` is derived from the repository's spec folder and the slug the
 * session recorded, and judged where it lands rather than as it is spelled:
 * `safePath` refuses a symlink on the way and anything outside the checkout,
 * and it is the same string the command is then given, so what was checked is
 * what it acts on. `--session` appears only once an interview has reported
 * one, `--model` is the model this planning drafts with, and `--provider` is
 * the session it runs on, which is this planning's drafting choice.
 */
export function interviewArgv(
  repo: RegisteredRepository,
  session: EditingSession,
): string[] {
  const models = TaskModelsSchema.strip().parse(session.form.models);
  if (session.specSlug === null) throw new Error(INTERVIEW_NEEDS_A_TITLE);
  const spec = `${specFolder(repo)}/${session.specSlug}`;
  safePath(repo, ...spec.split("/"));
  const provider = interviewProviderFor(models);
  return [
    "interview",
    "--spec",
    spec,
    ...interviewSessionArgs(session, provider),
    "--model",
    models.executorModel,
    "--provider",
    provider,
  ];
}

/**
 * Which provider this planning's interview runs on, which is its drafting
 * choice: the same derivation {@link interviewArgv} sends, read here so the id
 * reported back is recorded as that provider's.
 */
export function interviewProvider(session: EditingSession): "claude" | "codex" {
  try {
    return interviewProviderFor(TaskModelsSchema.strip().parse(session.form.models));
  } catch {
    return "claude";
  }
}
