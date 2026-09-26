import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { decidable, type LimitsTableSchema, type PlanContract } from "@perbo/contracts";
import type { Detail, Draft, RequestOf, Settings, TaskModels } from "../../shared/protocol.js";
import { decisionQuestions } from "../../shared/decisions.js";
import type { FindingsOnRecord } from "../records.js";

/**
 * Every argv the host runs the CLI with, built here from the person's own
 * request and this host's own records.
 *
 * Nothing a model returned reaches an argument
 * ([ADR-0023](../../../../../docs/adr/0023-untrusted-context-boundary.md) §4):
 * what a person typed travels as one element of the array, so a value holding
 * a space, a quote or a `$(…)` is that value and not a command.
 */

/** Which binary the loop starts for the executor, from the provider it was given. */
const agentBinary = (provider: TaskModels["executorProvider"]): string =>
  provider === "codex-cli" ? "codex" : "claude";

export function draftArgs(draft: Draft): string[] {
  // The CLI's non-interactive edit syntax has a delimiter; reject ambiguous text instead of silently splitting it.
  for (const criterion of draft.criteria)
    if (criterion.text.includes("::") || criterion.assertion.includes("::"))
      throw new Error(
        "Use a single colon in a criterion. The CLI reserves a double colon for its verification separator.",
      );
  return [
    "--outcome",
    draft.outcome,
    ...draft.criteria.flatMap((entry) => [
      "--criterion",
      `${entry.text} :: ${entry.assertion} :: ${entry.kind}`,
    ]),
    ...draft.paths.flatMap((path) => ["--path", path]),
    ...draft.prohibited.flatMap((path) => ["--prohibit", path]),
    "--json",
  ];
}

/** Every edit the Graph pane makes, applied and recorded by the CLI (D-100). */
export function graphEditArgs(
  key: string,
  request: RequestOf<"graphEdit"> | RequestOf<"graphUndo">,
): string[] {
  return [
    "edit",
    key,
    ...(request.kind === "graphUndo"
      ? ["--undo", String(request.edit)]
      : ["--graph-edit", JSON.stringify(request.edit)]),
    "--author",
    "you",
    "--json",
  ];
}

export function doctorConfig(settings: Settings): object {
  return {
    agent_binary: agentBinary(settings.executorProvider),
    agent_provider: settings.executorProvider,
    model: settings.executorModel,
    reviewer_provider: settings.reviewerProvider,
    reviewer_model: settings.reviewerModel,
  };
}

export function doctorArgs(configPath: string, writeConfig: boolean): string[] {
  return ["doctor", "--json", "--config", configPath, ...(writeConfig ? ["--write-config"] : [])];
}

/**
 * `admit --from-spec`, with `--keep-title` where the person gave the spec the
 * title it states: the ticket takes their name and the spec keeps it (D-127).
 */
export function admitFromSpecArgs(
  spec: string,
  startOver: string | null,
  keepTitle: boolean,
  provider: string,
  model: string,
): string[] {
  return [
    "admit",
    "--prefix",
    "PRB",
    "--from-spec",
    spec,
    ...(startOver === null ? [] : ["--start-over", startOver]),
    ...(keepTitle ? ["--keep-title"] : []),
    "--provider",
    provider,
    "--model",
    model,
    "--json",
  ];
}

export function admitDraftArgs(draft: Draft): string[] {
  return ["admit", "--prefix", "PRB", ...draftArgs(draft)];
}

export function editArgs(key: string, draft: Draft): string[] {
  return [
    "edit",
    key,
    ...draftArgs(draft),
    // An empty list and an absent flag are the same on a command line, and the
    // edit replaces only what it is given: without this, unmarking the last
    // prohibited path would be written and then quietly ignored. Admission
    // needs no such flag — it writes the whole scope rather than replacing
    // part of one.
    ...(draft.prohibited.length === 0 ? ["--no-prohibit"] : []),
  ];
}

export function approveArgs(key: string): string[] {
  return ["approve", key, "--json"];
}

export function principleArgs(answer: string): string[] {
  return ["principle", "add", answer];
}

/**
 * A person's answer to one finding the review routed to them, recorded on the
 * finding (D-132). `--replace`
 * because answering again after a later review is a new answer to the same
 * key, and the earlier one stays on the record, superseded.
 */
export function decisionArgs(
  key: string,
  decision: RequestOf<"decide">["decisions"][number],
  author: string,
): string[] {
  return [
    "verdict",
    key,
    "--decide",
    decision.findingKey,
    "--choice",
    decision.choice.replace(/_/g, "-"),
    "--note",
    decision.answer,
    "--author",
    author,
    "--replace",
    "--json",
  ];
}

export function syncArgs(key: string): string[] {
  return ["sync", key];
}

export function verdictArgs(request: RequestOf<"verdict">, author: string): string[] {
  return [
    "verdict",
    request.key,
    `--${request.decision}`,
    request.findingKey,
    "--note",
    request.note,
    "--author",
    author,
    "--json",
  ];
}

/**
 * The configuration one run is started with. Publication authority and
 * person-only merge are carried explicitly on every invocation: a run this
 * host started never merges, and only publishes where the person asked it to.
 */
export function runConfig(
  models: TaskModels | Settings,
  limits: z.infer<typeof LimitsTableSchema>,
  publish: boolean,
): object {
  return {
    agent_binary: agentBinary(models.executorProvider),
    agent_provider: models.executorProvider,
    executor_skills: models.executorSkills,
    model: models.executorModel,
    effort: models.executorEffort,
    reviewer_provider: models.reviewerProvider,
    reviewer_model: models.reviewerModel,
    reviewer_effort: models.reviewerEffort,
    limits,
    publish,
    merge: "person",
  };
}

export function runArgs(key: string, configPath: string, resumeFrom: string | null): string[] {
  return [
    "run",
    "--ticket",
    key,
    "--config",
    configPath,
    "--json",
    ...(resumeFrom === null ? [] : ["--resume-from", resumeFrom]),
  ];
}

/**
 * The branch a run retained without publishing, pushed and its pull request
 * opened, under the configuration a run of the ticket is given with publishing
 * on (D-NEW-publish-a-retained-branch-later).
 */
export function publishArgs(key: string, configPath: string): string[] {
  return ["run", "--ticket", key, "--config", configPath, "--publish-retained", "--json"];
}

/** A contract whose criteria name a person to check them is edited with the CLI, which keeps the assignment. */
export function assertEditable(contract: PlanContract): void {
  if (
    "acceptance_criteria" in contract &&
    contract.acceptance_criteria.some(
      (criterion) => criterion.expected_verification.kind === "manual",
    )
  )
    throw new Error(
      "This contract has named manual reviewers. Edit it with the CLI to preserve those assignments.",
    );
}

/** A run resumes only from a bundle this task's own attempts sealed. */
export function assertResumable(detail: Detail, bundleId: string): void {
  if (
    !detail.attempts.some((attempt) =>
      attempt.bundles.some(
        (bundle) => bundle.bundle_id === bundleId && bundle.kind === "execution",
      ),
    )
  )
    throw new Error("The recovery bundle does not belong to this task.");
}

/**
 * Every answer is one the loop acts on, checked against the review it reads
 * before any is recorded, so a refused one leaves nothing written: a finding
 * that review routed to a person, on a review that judged the whole change,
 * answered with a choice it takes
 * (D-132).
 */
export function assertDecidable(
  review: FindingsOnRecord | null,
  decisions: RequestOf<"decide">["decisions"],
): void {
  const asked = new Map(decisionQuestions(review).map((question) => [question.id, question]));
  for (const decision of decisions) {
    const question = asked.get(decision.findingKey);
    if (question === undefined || question.choices.length === 0)
      throw new Error(
        review !== null && !decidable(review)
          ? `The review ended ${review.decision}: it did not judge the whole change, so an answer would settle a finding on a change nobody finished judging, and it takes none.`
          : `Finding ${decision.findingKey.slice(0, 12)} is not one the review routed to you, so it takes no answer.`,
      );
    if (!question.choices.includes(decision.choice))
      throw new Error(
        `Finding ${decision.findingKey.slice(0, 12)} is never handed to the executor, so its only answer is Ship as it is.`,
      );
  }
}

/**
 * A file only this job reads, in the profile directory: the person's own
 * configuration and their own words, written where the CLI can be pointed at
 * them rather than passed on a command line. Written exclusively, so a job
 * never writes over another's.
 */
export function writePrivate(directory: string, name: string, content: string): string {
  const path = join(directory, name);
  writeFileSync(path, content, { mode: 0o600, flag: "wx" });
  return path;
}
