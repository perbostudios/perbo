import { z } from "zod";
import {
  GithubCredentialSchema,
  StopAnswerSchema,
  StopAnswererSchema,
  StopRoutingSchema,
  UNCHECKED,
  addRolls,
  commitCarriesArm,
  costOf,
  deliveryChecksState,
  dollarAmount,
  failedChecks,
  readD073Verdicts,
  redactCredentials,
  rollCosts,
  ticketSourceLabel,
  type CostBasis,
  type DeliveredCheck,
  type DeliveryArm,
  type DeliveryChecksState,
  type ExecutionAttempt,
  type MergeMode,
  type ObservedStop,
  type PlanContractWithCriteria,
  type ReviewArtifact,
  type StopAnswer,
  type StopAnswerer,
  type StopRouting,
  type TicketSource,
} from "@perbo/contracts";
import { gh, git, isAttemptBranch } from "@perbo/workspace";
import { requireGithubCredential } from "./github-credential.js";

/**
 * Publishing a pull request through local `git` and `gh` (SCP-020).
 *
 * The property that matters: **the runner holds the credential and performs
 * the push and the pull-request creation itself.** The
 * agent's environment never contains a token, `gh` is on its deny list, and
 * these functions run in the runner's process with the runner's environment.
 *
 * Nothing here merges. D-077 gave the loop a merge of its own for the
 * integration branch, behind a switch that defaults to a person, and it lives
 * in `merge.ts` beside this module rather than in it — the same division the
 * two files already had, where this one opens a pull request and `merge-up.ts`
 * keeps its branch level. D-041 still stands for `main` and for any customer
 * repository, and `self_merge` is still on the executor's prohibited list: the
 * agent never merges, whichever way the switch is set.
 */

export class DeliveryError extends Error {
  readonly detail: string;

  constructor(message: string, detail: string) {
    super(message);
    this.name = "DeliveryError";
    this.detail = detail;
  }
}

const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * What one answer read here may say, past which only its tail arrives.
 *
 * Every `gh` read below is parsed and every git read is counted, and a cut
 * answer is shaped exactly like a whole one: JSON that will not parse reads as
 * "GitHub said nothing", and a cut listing reads as a shorter list. The
 * ceiling is the size of an answer rather than the size of output nobody
 * reads.
 */
const MAX_ANSWER_BYTES = 64 * 1024 * 1024;

/**
 * The credential a git command that reaches GitHub presents.
 *
 * Over an HTTPS remote git asks a credential helper for the password, and the
 * helper `gh auth setup-git` writes — `gh auth git-credential` — reads the
 * token out of the environment git started it in. A machine whose GitHub
 * credential is `GH_TOKEN` rather than a stored login is one this product
 * supports, and on it the environment is the only place the token is: without
 * this the push has nothing to present and fails with the attempt already
 * sealed and reviewed. The environment the repository module builds for git
 * carries no token, because a token is not something git itself needs; the two
 * commands here that speak to GitHub add it and the local reads beside them do
 * not.
 *
 * A name this machine does not set is left unset rather than emptied: an empty
 * `GH_TOKEN` is a credential `gh` reads as none.
 */
function githubCredentialOverlay(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    // The helper is a `gh` process, where a prompt is the same hang it is anywhere else.
    GH_PROMPT_DISABLED: "1",
    ...(base.GH_TOKEN ? { GH_TOKEN: base.GH_TOKEN } : {}),
    ...(base.GITHUB_TOKEN ? { GITHUB_TOKEN: base.GITHUB_TOKEN } : {}),
  };
}

/** What is read off a pull request to say whether one stands on the branch. */
const PULL_REQUEST_FIELDS = ["number", "url", "state"];

export interface PushRequest {
  worktree: string;
  branch: string;
  remote?: string;
  timeoutMs?: number;
  /** Where the push says what it did to a branch it found already there. */
  onProgress?: (message: string) => void;
}

/**
 * The attempt's branch, pushed to the remote.
 *
 * A run that pushes and then fails before its pull request opens leaves the
 * branch behind. The name is a digest of the outcome, so the next run on the
 * same outcome mints the same name over a different commit and its push is
 * rejected non-fast-forward — and stays rejected on every later run until the
 * branch is deleted. The loop owns the `prb/` and `ayo/` namespaces, so a
 * leftover there with no open pull request standing on it is the loop's own to
 * replace, under a lease on the tip it read: a branch that moved between the
 * read and the push is not overwritten.
 *
 * `prohibited.ts` refuses a force-push. That rule governs the **agent's**
 * commands inside the attempt, where nothing may rewrite what the loop
 * published; this is the loop's own delivery, on a branch the loop minted and
 * holds the credential for.
 */
export async function pushAttemptBranch(request: PushRequest): Promise<{ pushed: boolean; detail: string }> {
  // Prohibited action 4: the push goes to the attempt's own branch and nowhere
  // else. That is the branch provisioning chose — derived from the plan, or one
  // already recorded for this ticket under its own id (`recordedBranch`) — and
  // never anything the agent produced. This check reads only the namespace: it
  // is what keeps the replacement below to `prb/` and `ayo/`, since nothing
  // else ever reaches the push at all.
  if (!isAttemptBranch(request.branch)) {
    throw new DeliveryError(
      "refusing to push",
      `${request.branch} is not an attempt branch (prb/<ticket id>/<slug> or ayo/<ticket id>/<slug>)`,
    );
  }
  const remote = request.remote ?? "origin";
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const leftover = await leftoverToReplace({
    worktree: request.worktree,
    branch: request.branch,
    remote,
    timeoutMs,
  });
  const result = await git.run(
    request.worktree,
    [
      "push",
      ...(leftover ? [`--force-with-lease=${request.branch}:${leftover}`] : []),
      "--set-upstream",
      remote,
      `${request.branch}:${request.branch}`,
    ],
    { timeoutMs, overlay: githubCredentialOverlay() },
  );
  if (result.code !== 0) {
    throw new DeliveryError("git push failed", (result.stderr || result.stdout).trim().slice(-800));
  }
  if (leftover) {
    request.onProgress?.(
      `replaced ${remote}/${request.branch} at ${leftover.slice(0, 12)} — ` +
        "left by an earlier run; no pull request stood on it",
    );
  }
  return { pushed: true, detail: result.stderr.trim().split("\n").slice(-1)[0] ?? "" };
}

/**
 * The remote tip to take a lease on, or null where the push is the plain one.
 *
 * Null unless the remote already holds this branch at a commit that is not the
 * one being published and no open pull request stands on it. Where `gh` cannot
 * say, the answer is unknown and nothing is replaced.
 */
async function leftoverToReplace(request: {
  worktree: string;
  branch: string;
  remote: string;
  timeoutMs: number;
}): Promise<string | null> {
  const options = { timeoutMs: request.timeoutMs, maxOutputBytes: MAX_ANSWER_BYTES };
  const listed = await git.run(
    request.worktree,
    ["ls-remote", "--heads", request.remote, request.branch],
    { ...options, overlay: githubCredentialOverlay() },
  );
  if (listed.code !== 0 || listed.truncated) return null;
  const tip = listed.stdout
    .split("\n")
    .map((line) => /^([0-9a-f]{40,64})\s+refs\/heads\/(.+)$/.exec(line.trim()))
    .find((match) => match?.[2] === request.branch)?.[1];
  if (tip === undefined) return null;

  const local = await git.run(
    request.worktree,
    ["rev-parse", "--verify", `${request.branch}^{commit}`],
    options,
  );
  if (local.code !== 0 || local.stdout.trim() === tip) return null;

  return (await standingPullRequest(request)) === "none" ? tip : null;
}

/**
 * Whether an open pull request stands on the branch — the same read
 * `createPullRequest` makes.
 *
 * `unknown` is not `none`: no `gh` on the machine, no credential, no network
 * and output that will not parse are all answers `gh` did not give, and a
 * branch nothing can speak for is left where it is.
 */
async function standingPullRequest(request: {
  worktree: string;
  branch: string;
  timeoutMs: number;
}): Promise<"open" | "none" | "unknown"> {
  let viewed;
  try {
    viewed = await gh.viewPullRequest(request.worktree, request.branch, PULL_REQUEST_FIELDS, {
      timeoutMs: request.timeoutMs,
      maxOutputBytes: MAX_ANSWER_BYTES,
    });
  } catch {
    return "unknown";
  }
  // An answer only part of which arrived is one `gh` did not give.
  if (viewed.truncated) return "unknown";
  if (viewed.code === 0) {
    try {
      return (JSON.parse(viewed.stdout) as { state?: string }).state === "OPEN" ? "open" : "none";
    } catch {
      return "unknown";
    }
  }
  // `gh` reports a branch that carries no pull request by failing, in its own
  // words. Every other failure is one it did not answer.
  return /no pull requests found/i.test(`${viewed.stderr}\n${viewed.stdout}`) ? "none" : "unknown";
}

/**
 * The pull-request body (SCP-020 criterion 1): ticket, source, plan version,
 * attempt, criteria coverage, rollout and cost.
 *
 * Written from the plan, the attempt record and the review artifact. Nothing in
 * it is prose the agent produced, which is the same rule as everywhere else and
 * matters more here because this text is what a human reads before merging.
 */
export function pullRequestBody(args: {
  contract: PlanContractWithCriteria;
  attempt: ExecutionAttempt;
  review: ReviewArtifact;
  attempts: readonly ExecutionAttempt[];
  /**
   * Where the work was admitted from, named as its kind names it: a tracker
   * reference, or the file a `--from-file` admission read. Null, or absent, for
   * work that started here — the line is then left out rather than printed
   * empty, because "no source" is a fact and "source: —" is a gap.
   */
  source?: TicketSource | null;
  /** Every closure-verification cost, so the total counts each round's rather than one. */
  verification_costs?: ReadonlyArray<{
    cost_micros: number;
    cost_basis: CostBasis;
  }>;
  /**
   * D-065: findings the executor declared no-determinable-practice for. They
   * are routed findings it could not close, so they are the person's decisions
   * and are listed with the declared reason.
   */
  declines?: ReadonlyArray<{ finding_key: string; reason: string }>;
  /**
   * SCP-202: which of the two merges this pull request is waiting for, so the
   * closing line says the true one. Defaults to a person, which is what every
   * pull request this body has ever described was waiting for.
   */
  merge?: MergeMode;
}): string {
  const { contract, attempt, review } = args;
  const coverage = review.coverage
    .map((entry) => {
      const criterion = contract.acceptance_criteria.find((item) => item.id === entry.criterion_id);
      const provenance = entry.authored_in_response_to
        ? ` · evidence written in answer to finding ${entry.authored_in_response_to.slice(0, 12)}`
        : "";
      return (
        `| \`${entry.criterion_id}\` | ${entry.status} | ${entry.verification_strength}${provenance} | ` +
        `${(criterion?.text ?? "").replace(/\|/g, "\\|")} |`
      );
    })
    .join("\n");

  const declinedReasons = new Map((args.declines ?? []).map((d) => [d.finding_key, d.reason]));
  const blocking = review.findings.filter((finding) => finding.blocking);
  const remediable = review.findings.filter(
    (finding) => finding.routing === "remediable" && !declinedReasons.has(finding.key),
  );
  const declined = review.findings.filter((finding) => declinedReasons.has(finding.key));

  /**
   * What needs a person, in the words the review used for it.
   *
   * A routed finding is not among them: the executor closed it and the closure
   * was verified before this was opened, so it is counted beside the verdict
   * and read in the record. What blocks, what escalates and what the executor
   * declared no practice for is here, because each one is waiting on somebody.
   *
   * Every statement is redacted first. Finding statements demonstrably carry
   * credentials — 6 of 6 runs in the secret-control result — and a pull request
   * body is published to a remote service, so listing them raw would trade a
   * local disclosure for a public one. This is not D-063 being decided: that
   * decision governs the review **artifact**, which the corpus measures. This is
   * a different surface, with no measurement attached, where withholding the
   * value is unambiguously right.
   */
  let redactions = 0;
  const describe = (finding: (typeof review.findings)[number]): string => {
    const statement = redactCredentials(finding.statement);
    redactions += statement.count;
    const where = finding.file ? ` \`${finding.file}${finding.line ? `:${finding.line}` : ""}\`` : "";
    return `- \`${finding.rule_id}\`${where} — ${statement.text.replace(/[\r\n]+/g, " ")}`;
  };

  /**
   * D-060, measured live: every stop carries two task-list boxes a person
   * ticks in the pull-request UI, and `pollPullRequest` reads the ticks back.
   * The visible text is the pinned question in the person's own words. The
   * comment carries the finding key, so the answer survives any rewording, and
   * the rule id and routing, so the record `perbo sync` writes needs nothing
   * but the body. The rule id is reduced to marker-safe characters first: it
   * is model output, and must not be able to close the comment.
   */
  const stopBoxes = (finding: (typeof review.findings)[number], routing: StopRouting): string => {
    const marker = (answer: StopAnswer) =>
      `<!-- perbo:stop key=${finding.key} answer=${answer} rule=${markerSafe(finding.rule_id)} routing=${routing} -->`;
    return [
      `  - [ ] I wanted to be asked before this was fixed ${marker("endorse")}`,
      `  - [ ] The agent should have fixed this on its own ${marker("override")}`,
    ].join("\n");
  };
  const describeStop = (finding: (typeof review.findings)[number]): string =>
    `${describe(finding)}\n${stopBoxes(finding, finding.routing === "escalates" ? "escalates" : "blocks")}`;

  const section = (
    title: string,
    note: string,
    items: readonly (typeof review.findings)[number][],
    render: (finding: (typeof review.findings)[number]) => string = describe,
  ) => (items.length === 0 ? [] : ["", `### ${title}`, "", note, "", ...items.map(render)]);

  const describeDeclined = (finding: (typeof review.findings)[number]): string => {
    const reason = redactCredentials(declinedReasons.get(finding.key) ?? "");
    redactions += reason.count;
    return (
      `${describe(finding)}\n  - the executor declares **no determinable practice**: ${reason.text.replace(/[\r\n]+/g, " ")}\n` +
      stopBoxes(finding, "declined")
    );
  };
  const findingSections = [
    ...(declined.length === 0
      ? []
      : [
          "",
          "### No determinable practice — for you to decide",
          "",
          "The executor searched for an established practice and reports there is none: these are " +
            "product calls, left for you with its reason. Its brief was to change nothing for " +
            "them; the diff above is the authority on what changed.",
          "",
          ...declined.map(describeDeclined),
        ]),
    ...section(
      "For you to decide",
      "The review stopped on these. Nothing here has been changed on your behalf.",
      blocking,
      describeStop,
    ),
    ...section(
      "Advisory",
      "Reported and not acted on.",
      review.findings.filter((finding) => !finding.blocking && finding.routing !== "remediable"),
    ),
  ];
  const rollout =
    "rollout" in contract ? contract.rollout : "reversible change; rollback is `git revert`";
  const carried = attempt.prior_commits ?? [];

  const executionRoll = rollCosts(
    args.attempts.map((one) =>
      costOf({
        micros: one.usage.cost_micros,
        basis: one.usage.cost_basis,
        // An attempt the runner stopped carries the transport total or list-rate
        // estimate available by the stop, so the sum below is a floor rather
        // than a total.
        partial: one.usage.cost_partial === true,
      }),
    ),
  );
  const reviewRoll = rollCosts([
    costOf({ micros: review.cost_micros, basis: review.model.cost_basis }),
  ]);
  const verificationRoll = rollCosts(
    (args.verification_costs ?? []).map((one) =>
      costOf({ micros: one.cost_micros, basis: one.cost_basis }),
    ),
  );
  const cost = [executionRoll, reviewRoll, verificationRoll].reduce(addRolls);
  const unavailableCosts = cost.unavailable;
  const reportedCosts = cost.reported;
  const estimatedCosts = cost.estimated;
  const partialCosts = cost.partial;
  const partialNote =
    partialCosts === 0
      ? ""
      : ` ${partialCosts} component(s) are partial: the attempt was stopped before its ` +
        "transport reported a final total, so the figure is a floor.";
  /**
   * The remediation rounds this attempt came after, from the attempt's own
   * count rather than from how many attempts the run made. The two parted
   * company when a transport failure started a further attempt in the same
   * round (SCP-172): counting attempts would credit the run with a remediation
   * round nobody ran, and a body that names a round the record does not hold is
   * the contradiction a person merging cannot check.
   */
  const rounds = attempt.remediation_round;
  const costLines =
    unavailableCosts === 0
      ? [
          `Execution ${dollarAmount(executionRoll.micros, 4)} USD across ${args.attempts.length} attempt${args.attempts.length === 1 ? "" : "s"}; ` +
            `review ${dollarAmount(reviewRoll.micros, 4)} USD; ` +
            `closure verification ${dollarAmount(verificationRoll.micros, 4)} USD; ` +
            `total ${dollarAmount(cost.micros, 4)} USD.`,
          `Cost coverage complete: ${reportedCosts} transport-reported and ${estimatedCosts} ` +
            `provider-list-estimated component(s).${partialNote}`,
        ]
      : [
          `Known priced subtotal ${dollarAmount(cost.micros, 4)} USD ` +
            `(execution ${dollarAmount(executionRoll.micros, 4)} + review ${dollarAmount(reviewRoll.micros, 4)} + ` +
            `closure verification ${dollarAmount(verificationRoll.micros, 4)}).`,
          `Known priced components: ${reportedCosts} transport-reported and ${estimatedCosts} ` +
            "provider-list-estimated component(s).",
          `Full all-in cost unavailable: ${unavailableCosts} of ${cost.components} ` +
            `model-cost component(s) have no defensible dollar basis.${partialNote}`,
        ];

  const sourceLabel = args.source ? ticketSourceLabel(args.source) : null;

  return [
    `Ticket: \`${contract.ticket_id}\``,
    ...(sourceLabel === null ? [] : [`Source: ${sourceLabel}`]),
    `Plan: \`${contract.plan_id}\` v${contract.version} (${contract.level}, actual_risk ${review.actual_risk}${review.escalated ? ", escalated" : ""})`,
    `Attempt: \`${attempt.attempt_id}\`${rounds > 0 ? ` after ${rounds} remediation round${rounds === 1 ? "" : "s"}` : ""}`,
    `Base: \`${attempt.base_commit}\` → head \`${attempt.head_commit ?? "none"}\``,
    // The pull request is the whole range, so a person merging is told which
    // part of it this attempt did not write.
    ...(carried.length === 0
      ? []
      : [
          `${carried.length} commit${carried.length === 1 ? " was" : "s were"} sealed before this ` +
            `attempt: ${carried
              .map((commit) => `\`${commit.sha.slice(0, 12)}\`${commit.attempt_id ? ` (\`${commit.attempt_id}\`)` : ""}`)
              .join(", ")}.`,
        ]),
    "",
    `## Outcome`,
    "",
    contract.outcome,
    "",
    `## Acceptance criteria`,
    "",
    `| criterion | status | how it was established | text |`,
    `|---|---|---|---|`,
    coverage,
    "",
    `## Review`,
    "",
    `Verdict **${review.decision}** · ${blocking.length} blocking · ${remediable.length} returned to the executor · ` +
      (declined.length > 0 ? `${declined.length} for you to decide · ` : "") +
      `${review.findings.length - blocking.length - remediable.length - declined.length} advisory`,
    // The count and where to read them, and no more: the executor closed each
    // one and the closure was verified before this opened, so nothing here is
    // waiting on the person reading it.
    ...(remediable.length === 0
      ? []
      : [
          "",
          `${remediable.length} finding${remediable.length === 1 ? " was" : "s were"} returned to the ` +
            "executor and verified closed before this was opened; " +
            `\`perbo inspect ${contract.ticket_id}\` lists them.`,
        ]),
    ...findingSections,
    ...(redactions > 0
      ? [
          "",
          `> ${redactions} credential-shaped value${redactions === 1 ? " was" : "s were"} **redacted** ` +
            `from the text above before it left this machine. The findings are otherwise verbatim.`,
        ]
      : []),
    "",
    `## Rollout`,
    "",
    rollout,
    "",
    `## Cost`,
    "",
    ...costLines,
    "",
    "---",
    "",
    // The closing line is read on the repository the run was pointed at, by
    // somebody who holds none of this repository's decision records: it says
    // what merging waits on and names no document of ours.
    (args.merge ?? "person") === "loop"
      ? "Opened by Perbo. **The loop merges this**, and only when a separate review run has " +
        "approved this head by name, the checks on it are green, GitHub reports it mergeable, " +
        "every commit carries the loop's attempt trailer and a verified signature, and nothing " +
        "outside the loop has touched the branch since the approval. Any of those missing is a " +
        "stop that names itself and comes to you."
      : "Opened by Perbo. **A human merges this.** The executor and the reviewer are the same " +
        "system, so auto-merge would collapse the independence the verification gate depends on.",
    "",
    `<!-- perbo:stops n=${blocking.length + declined.length} ticket=${contract.ticket_id} -->`,
    // Invisible to a reader and read by nothing: the convention is written
    // beside the boxes so that whoever answers them — a person clicking, or the
    // stand-in editing the body through `gh` — meets the rule where the boxes
    // are rather than in a document they do not have.
    `<!-- perbo:answered-by-convention ${ANSWERED_BY_CONVENTION} -->`,
  ].join("\n");
}

/** Only what the stop marker's regex accepts; anything else becomes `_`. */
const markerSafe = (value: string): string => value.replace(/[^A-Za-z0-9_.:-]/g, "_");

/**
 * One task-list line carrying a stop marker. The regex is the whole of what
 * is read from a body: the tick state, the marker's four fields in the order
 * `pullRequestBody` writes them, and whatever follows the marker on that line,
 * which is where a signature may sit. Nothing else in the body is
 * interpreted — it is content read back from GitHub, and it is data.
 */
const STOP_LINE =
  /^\s*[-*]\s+\[([ xX])\]\s.*<!--\s*perbo:stop\s+key=([0-9a-f]{64})\s+answer=(endorse|override)\s+rule=([A-Za-z0-9_.:-]+)\s+routing=(blocks|escalates|declined)\s*-->(.*)$/;

/**
 * A tick signed by whoever made it (D-058). The GitHub UI writes no such
 * marker, which is the point: a person clicking the box leaves an unsigned
 * tick, and the AI stand-in answering through `gh` writes
 * `<!-- perbo:answered-by who=stand_in -->` on the line it ticks so that its
 * answer can be told from a person's and kept out of every partner reading.
 *
 * A body is untrusted text, so what it may do is bounded, and the bound is
 * about what a *tick* can claim rather than about who typed it: `stand_in`
 * takes a stop out of the partner number, and `person` says only that the
 * person whose pull request this is answered it themselves — the claim an
 * unsigned tick already makes, spelled out so that a stop the stand-in
 * previously signed can be taken back (see {@link ANSWERED_BY_CONVENTION}).
 * Neither value can conjure an answer: a box nobody ticked is unanswered
 * however its line is signed, and the exclusion is counted and printed wherever
 * a partner number is, so a body that signs its whole population away shrinks
 * a visible count rather than a silent one.
 */
const ANSWERED_BY_MARKER = /<!--\s*perbo:answered-by\s+who=(person|stand_in)\s*-->/;

/**
 * The convention itself, written into the body beside the boxes so that whoever
 * answers them meets the rule where the boxes are.
 *
 * Both halves are stated, because both are things somebody has to be able to
 * do: the stand-in signs the line it ticks so its answer is not counted as a
 * person's, and a person whose stop was recorded as the stand-in's signs the
 * line as their own to take it back. A signature is never cleared by silence —
 * an answer edited back to an unsigned tick keeps the answerer already recorded
 * against it, or deleting a comment would erase who answered — so saying so is
 * the only way back into the partner population short of changing the answer.
 */
export const ANSWERED_BY_CONVENTION =
  "an AI standing in for a person, answering these boxes on their behalf, marks the line it " +
  "ticks with an perbo:answered-by who=stand_in HTML comment, so that its answer is recorded " +
  "as the machine's and left out of every number reported as a person's. An unsigned tick is " +
  "a person's. A tick already recorded as the stand-in's stays the stand-in's until somebody " +
  "says otherwise: mark the line with an perbo:answered-by who=person HTML comment to record " +
  "it as your own answer.";

/**
 * The answers a pull-request body carries (D-060, measured live). One entry
 * per finding key in the order the body lists them: `endorse` or `override`
 * when that box alone is ticked, `conflict` when both are, `null` when neither.
 *
 * An entry carries `answered_by` only where the body signs the tick. An
 * unsigned tick leaves the field off rather than reporting `null`, because
 * absent is what this function knows: the body said nothing about who ticked.
 * What that silence means is decided once, where the record is written
 * ({@link reconcileStopVerdicts}), rather than twice. `stand_in` wins over
 * `person` on a key whose two lines disagree, for the same reason `conflict`
 * is not an answer: the reading that removes the stop from the partner number
 * is the one that cannot overstate it.
 */
export function parseStopAnswers(body: string): ObservedStop[] {
  const seen = new Map<
    string,
    {
      rule_id: string;
      routing: StopRouting;
      endorse: boolean;
      override: boolean;
      answered_by: StopAnswerer | null;
    }
  >();
  for (const line of body.split(/\r?\n/)) {
    const match = STOP_LINE.exec(line);
    if (!match) continue;
    const [, tick, key, answer, rule, routing, tail] = match;
    const entry = seen.get(key!) ?? {
      rule_id: rule!,
      routing: StopRoutingSchema.parse(routing),
      endorse: false,
      override: false,
      answered_by: null,
    };
    if (tick !== " ") {
      entry[StopAnswerSchema.exclude(["conflict"]).parse(answer)] = true;
      const signature = ANSWERED_BY_MARKER.exec(tail ?? "");
      const who = signature === null ? null : StopAnswererSchema.parse(signature[1]);
      if (who === "stand_in" || (who !== null && entry.answered_by === null)) entry.answered_by = who;
    }
    seen.set(key!, entry);
  }
  return [...seen.entries()].map(([finding_key, entry]) => ({
    finding_key,
    rule_id: entry.rule_id,
    routing: entry.routing,
    answer:
      entry.endorse && entry.override ? "conflict" : entry.endorse ? "endorse" : entry.override ? "override" : null,
    ...((entry.endorse || entry.override) && entry.answered_by !== null
      ? { answered_by: entry.answered_by }
      : {}),
  }));
}

export interface CreatePullRequestRequest {
  worktree: string;
  branch: string;
  base_ref: string;
  title: string;
  body: string;
  draft?: boolean;
  timeoutMs?: number;
}

export async function createPullRequest(
  request: CreatePullRequestRequest,
): Promise<{ url: string; number: number | null }> {
  if (!isAttemptBranch(request.branch)) {
    throw new DeliveryError("refusing to open a pull request", `${request.branch} is not an attempt branch`);
  }

  // A retry lands on the branch its predecessor used, so by the time delivery
  // runs again there may already be a pull request open on it. Creating
  // unconditionally would fail the run over one that already says what it needs
  // to, which is the opposite of the idempotence M1 asks for. The existing one
  // is returned untouched — rewriting its body would overwrite a description a
  // person may have edited.
  const existing = await existingPullRequest({
    worktree: request.worktree,
    branch: request.branch,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  });
  if (existing !== null) return existing;

  const argv = [
    "pr",
    "create",
    "--head",
    request.branch,
    "--base",
    request.base_ref,
    "--title",
    request.title,
    "--body",
    request.body,
    ...(request.draft ? ["--draft"] : []),
  ];
  const result = await gh.run(request.worktree, argv, {
    timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: MAX_ANSWER_BYTES,
  });
  if (result.code !== 0) {
    throw new DeliveryError("gh pr create failed", (result.stderr || result.stdout).trim().slice(-800));
  }
  const url = result.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  const number = /\/pull\/(\d+)/.exec(url)?.[1];
  return { url, number: number ? Number(number) : null };
}

/**
 * The ticket record (SCP-020 criterion 2), read through local `git`/`gh`.
 *
 * The poller writes the whole record every time from what `gh` reports.
 */
export const TicketDeliveryStateSchema = z.strictObject({
  ticket_id: z.string().min(1),
  branch: z.string().min(1),
  pull_request_url: z.string().min(1).nullable(),
  pull_request_number: z.number().int().positive().nullable(),
  state: z.enum(["none", "open", "merged", "closed"]),
  merge_state: z.string().nullable(),
  /**
   * SCP-192: whether GitHub can still merge this pull request, from `gh`'s own
   * `mergeable` field — `MERGEABLE`, `CONFLICTING` or `UNKNOWN`, normalised.
   *
   * Distinct from `merge_state`, which is the richer `mergeStateStatus` and
   * says `BLOCKED` for a pull request that is perfectly mergeable but has an
   * unmet review requirement. What a re-run needs to know is narrower: has the
   * branch stopped merging into its base. Defaulted so a record written before
   * it parses.
   */
  mergeable: z.enum(["mergeable", "conflicting", "unknown"]).nullable().default(null),
  /**
   * SCP-235: when `gh` reports this pull request closed, from its own
   * `closedAt`. Null while it is open. Defaulted so a record written before
   * this field existed still parses.
   */
  closed_at: z.iso.datetime().nullable().default(null),
  /**
   * SCP-252: the D-073 review verdicts the pull request's comments carry, read
   * by `readD073Verdicts` from the comments this poll already reads.
   *
   * Labels, like everything else here: the model that reviewed, the verdict it
   * gave and the head it named. The comment bodies they came from are not
   * recorded and never leave — the same rule `finding_outcomes` below follows,
   * and it is why this is read here rather than by handing the bodies on.
   *
   * `perbo sync` reads it to decide where a ticket behind a closed pull
   * request goes (D-083). Defaulted so a record written before it parses.
   */
  d073_verdicts: z
    .array(
      z.strictObject({
        model: z.string().min(1),
        verdict: z.string().min(1),
        head: z.string().min(1),
      }),
    )
    .default([]),
  /**
   * SCP-196: whether any commit `gh` lists on this pull request was authored
   * outside the arm that opened it, from each commit's own message rather than
   * who git records as its author — `commitCarriesArm` against
   * `messageHeadline` and `messageBody` together, under the arm the caller
   * named (SCP-206). Null where `gh` named no commits: no pull request, or a
   * `gh` too old to answer.
   */
  commits_outside_loop: z.boolean().nullable().default(null),
  /**
   * SCP-200: which credential path `gh` was read through for this observation
   * — `GH_TOKEN` from the reading process's own environment, or the machine's
   * shared `gh` login. Never the token itself.
   *
   * Null on a record nothing observed this on: one written before the field
   * existed, or a poll that never reached `gh`.
   */
  github_credential: GithubCredentialSchema.nullable().default(null),
  checks: z.array(
    z.strictObject({
      name: z.string().min(1),
      status: z.string().min(1),
      conclusion: z.string().nullable(),
    }),
  ),
  /**
   * Whether `gh` answered at all.
   *
   * Without this the caller cannot tell "there is no pull request" from "the
   * token expired", because both arrive as the same all-null record — and a
   * caller that wrote it onto a ticket erased a pull request URL it had already
   * recorded.
   */
  observed: z.boolean().default(true),
  /**
   * Labels only. A human's review verdict and the outcome of each finding key
   * are recorded; the comment bodies that produced them never are.
   */
  human_review_verdicts: z.array(z.enum(["approved", "changes_requested", "commented", "dismissed"])),
  finding_outcomes: z.record(z.string(), z.enum(["fixed", "dismissed", "waived", "superseded", "unknown"])),
  /** A human comment matching no finding key: a candidate the reviewer missed. */
  candidate_missed_recall: z.number().int().min(0),
  /** What makes post-merge escape rate computable at all. */
  reverted_by: z.string().nullable(),
  fixed_by: z.string().nullable(),
  /** Attempts, appended. A retry never overwrites its predecessor's history. */
  attempts: z.array(z.string().min(1)),
  observed_at: z.iso.datetime(),
  /**
   * D-060, measured live: the tick state of each stop's task-list boxes in the
   * pull-request body, by finding key. Labels only — the body they were read
   * from is not recorded. Defaulted so a record written before the boxes
   * existed still parses.
   */
  stop_answers: z
    .array(
      z.strictObject({
        finding_key: z.string().regex(/^[0-9a-f]{64}$/),
        rule_id: z.string().min(1),
        routing: StopRoutingSchema,
        answer: StopAnswerSchema.nullable(),
        /**
         * Who the tick was signed by, where it was signed (D-058) — a label,
         * like every other field here, and not the line it was read from.
         * Optional in both directions: absent is an unsigned tick, which is
         * every record written before signatures existed and every tick a
         * person clicks in the GitHub UI today.
         */
        answered_by: StopAnswererSchema.nullable().optional(),
      }),
    )
    .default([]),
});
export type TicketDeliveryState = z.infer<typeof TicketDeliveryStateSchema>;

interface GhPullRequest {
  number?: number;
  url?: string;
  state?: string;
  body?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  /** SCP-235: null while open; when `gh` closed it, merged or not. */
  closedAt?: string | null;
  statusCheckRollup?: RollupEntry[];
  reviews?: Array<{ state?: string }>;
  comments?: Array<{ body?: string }>;
  /** SCP-196: each commit's own message, never its author — see `commits_outside_loop`. */
  commits?: Array<{ oid?: string; messageHeadline?: string; messageBody?: string }>;
}

/**
 * The open pull request on a branch, or null where `gh` reports none, reports
 * one that is not open, or cannot be asked.
 *
 * What a re-level reads (SCP-227): the branch already has its pull request,
 * and what the run needs is its number for the merge step, never a second one.
 */
export async function existingPullRequest(request: {
  worktree: string;
  branch: string;
  timeoutMs?: number;
}): Promise<{ url: string; number: number | null } | null> {
  const viewed = await gh.viewPullRequest(request.worktree, request.branch, PULL_REQUEST_FIELDS, {
    timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: MAX_ANSWER_BYTES,
  });
  // Null is "there is none to return", and the caller opens one on it. An
  // answer only part of which arrived says nothing about whether one stands,
  // so it is refused rather than read as none.
  if (viewed.truncated) {
    throw new DeliveryError(
      "could not read the pull request already on the branch",
      `\`gh pr view ${request.branch}\` answered more than ${MAX_ANSWER_BYTES} bytes`,
    );
  }
  if (viewed.code !== 0) return null;
  try {
    const found = JSON.parse(viewed.stdout) as { number?: number; url?: string; state?: string };
    if (found.url && found.state === "OPEN") return { url: found.url, number: found.number ?? null };
  } catch {
    // Unparseable output is not an existing pull request.
  }
  return null;
}

export async function pollPullRequest(args: {
  worktree: string;
  branch: string;
  ticket_id: string;
  attempts: readonly string[];
  finding_keys: readonly string[];
  now: Date;
  timeoutMs?: number;
  /**
   * SCP-206: which arm's commits these are, so `commits_outside_loop` is
   * judged by that arm's own trailer. Defaults to the loop, which is what
   * every caller before the second arm existed meant.
   */
  arm?: DeliveryArm;
}): Promise<TicketDeliveryState> {
  // SCP-200: which credential this read goes through, decided before it goes,
  // and refused where the machine has none. Without this a `gh` with no login
  // failed at `gh pr view` and arrived here as the same non-zero exit an
  // absent pull request does — so a signed-out machine read as "there is no
  // pull request" and the caller could not tell the two apart.
  const credential = requireGithubCredential({
    env: process.env,
    what: "there is no credential to read the pull request through",
  });
  const result = await gh.viewPullRequest(
    args.worktree,
    args.branch,
    [
      "number",
      "url",
      "state",
      "body",
      "mergeable",
      "mergeStateStatus",
      "statusCheckRollup",
      "reviews",
      "comments",
      "commits",
      "closedAt",
    ],
    { timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxOutputBytes: MAX_ANSWER_BYTES },
  );

  const base: TicketDeliveryState = {
    ticket_id: args.ticket_id,
    branch: args.branch,
    pull_request_url: null,
    pull_request_number: null,
    state: "none",
    merge_state: null,
    mergeable: null,
    closed_at: null,
    d073_verdicts: [],
    commits_outside_loop: null,
    github_credential: credential.credential,
    checks: [],
    human_review_verdicts: [],
    finding_outcomes: {},
    candidate_missed_recall: 0,
    reverted_by: null,
    fixed_by: null,
    attempts: [...args.attempts],
    observed: true,
    observed_at: args.now.toISOString(),
    stop_answers: [],
  };
  // A cut answer is one `gh` did not give: it is read as unobserved rather
  // than as a pull request with whatever survived the cut.
  if (result.code !== 0 || result.truncated) {
    return TicketDeliveryStateSchema.parse({ ...base, observed: false });
  }

  let pr: GhPullRequest;
  try {
    pr = JSON.parse(result.stdout) as GhPullRequest;
  } catch {
    return TicketDeliveryStateSchema.parse(base);
  }

  const state =
    pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.state ? "open" : "none";

  // A human comment that names no finding key is a candidate the reviewer
  // missed. The count is a label; the body that produced it is not recorded.
  const keys = new Set(args.finding_keys.map((key) => key.slice(0, 12)));
  let missed = 0;
  const outcomes: TicketDeliveryState["finding_outcomes"] = {};
  // SCP-252: read off the same bodies, and the bodies go no further than this
  // loop — what the record keeps is the labels `readD073Verdicts` returns.
  const verdicts: TicketDeliveryState["d073_verdicts"] = [];
  for (const comment of pr.comments ?? []) {
    const body = comment.body ?? "";
    verdicts.push(...readD073Verdicts(body));
    const matched = [...keys].filter((key) => body.includes(key));
    if (matched.length === 0) {
      missed += 1;
      continue;
    }
    for (const key of matched) outcomes[key] = "unknown";
  }

  return TicketDeliveryStateSchema.parse({
    ...base,
    pull_request_url: pr.url ?? null,
    pull_request_number: pr.number ?? null,
    state,
    closed_at: pr.closedAt ?? null,
    d073_verdicts: verdicts,
    // Anything `gh` reports that is not one of the two settled answers is
    // "not computed yet", which is what GitHub means by returning it.
    mergeable:
      pr.mergeable === "MERGEABLE"
        ? "mergeable"
        : pr.mergeable === "CONFLICTING"
          ? "conflicting"
          : pr.mergeable === undefined
            ? null
            : "unknown",
    merge_state: pr.mergeStateStatus ?? null,
    // SCP-196: `gh` names no commits on a pull request it could not answer
    // this field for — an old `gh`, or a race with the pull request closing —
    // and an empty list is not evidence that every commit is the loop's.
    commits_outside_loop:
      pr.commits === undefined || pr.commits.length === 0
        ? null
        : pr.commits.some(
            (commit) =>
              !commitCarriesArm(
                `${commit.messageHeadline ?? ""}\n${commit.messageBody ?? ""}`,
                args.arm ?? "loop",
              ),
          ),
    checks: (pr.statusCheckRollup ?? []).map((check) => ({
      name: check.name ?? check.context ?? "check",
      status: check.status ?? check.state ?? "UNKNOWN",
      // Null where nothing has concluded, which every reader of this record
      // writes down as `unchecked`. An empty conclusion is not one.
      conclusion: checkConclusion(check),
    })),
    human_review_verdicts: (pr.reviews ?? [])
      .map((review) => (review.state ?? "").toLowerCase())
      .filter((value): value is TicketDeliveryState["human_review_verdicts"][number] =>
        ["approved", "changes_requested", "commented", "dismissed"].includes(value),
      ),
    finding_outcomes: outcomes,
    candidate_missed_recall: missed,
    stop_answers: parseStopAnswers(pr.body ?? ""),
  });
}

/**
 * The checks GitHub ran on the head a pull request was opened over.
 *
 * A run opened its pull request from a worktree holding the whole history and
 * a clean install, and CI runs it on a shallow checkout of a fresh machine.
 * The two disagree, and when they do the disagreement is the head's build
 * check going red minutes after the gate that opened the pull request said the
 * change was approved. A check that fails only there must not be invisible to
 * that gate, so the gate waits for it and writes down what it said.
 *
 * Nothing here fixes anything: the reading is recorded, the body says it, and
 * the run's outcome line names the check that failed.
 */

/** How long the reader sits between two reads of the rollup. */
export const DELIVERED_CHECKS_POLL_INTERVAL_MS = 15_000;

/**
 * The default ceiling on the whole read: fifteen minutes, which is above this
 * repository's own CI and short enough that a repository with no CI at all
 * does not hold a run open for an hour.
 */
export const DEFAULT_DELIVERED_CHECKS_BOUND_MS = 900_000;

export interface DeliveredChecksRequest {
  worktree: string;
  branch: string;
  /** The ceiling on the whole read, counted in the caller's own wall clock. */
  boundMs: number;
  /** The caller's clock, so the bound is counted in the run's rather than in a timer's. */
  now: () => Date;
  /** The caller's wait, so a test drives the bound rather than serving it. */
  sleep: (ms: number) => Promise<void>;
  intervalMs?: number;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

export interface DeliveredChecksReading {
  checks: DeliveredCheck[];
  state: DeliveryChecksState;
  /** How much of the bound the read spent, in the clock it was counted in. */
  waited_ms: number;
  /**
   * Whether the bound ended the read rather than every check concluding. False
   * also for a read `gh` would not answer, which stops at once: nothing is
   * gained by asking a `gh` that cannot answer sixty more times.
   */
  bounded: boolean;
}

/**
 * One entry of the status rollup, in the shape `gh` prints it. A check run
 * carries `name`, `status` and `conclusion`; a legacy status context carries
 * `context` and `state` and no `status`.
 */
interface RollupEntry {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  state?: string;
  conclusion?: string;
}

/** The states a legacy status context sits in before it has run. */
const PENDING_CONTEXT_STATES = ["PENDING", "EXPECTED"];

/**
 * What one rollup entry concluded, or null where it has not concluded at all.
 *
 * `gh` prints the conclusion of a check run that is still going as an empty
 * string rather than leaving the field out, so a conclusion counts only once
 * `status` says `COMPLETED` and the conclusion itself says something. A legacy
 * status context has no `status` and answers with `state` alone.
 *
 * Null is "not yet": the read waits on it, and the bound records it as
 * `unchecked`. It is never an empty conclusion, which would read as a failure
 * — an empty string is not one of the green conclusions — and which the record
 * cannot hold, because a recorded check must say what it concluded.
 *
 * Lowercased, so the record reads the way `gh` prints it rather than the way
 * GraphQL returns it.
 */
function checkConclusion(check: RollupEntry): string | null {
  if (check.__typename === "StatusContext" || (check.status === undefined && check.state !== undefined)) {
    const state = check.state?.trim() ?? "";
    if (state === "" || PENDING_CONTEXT_STATES.includes(state.toUpperCase())) return null;
    return state.toLowerCase();
  }
  if ((check.status?.trim().toUpperCase() ?? "") !== "COMPLETED") return null;
  const conclusion = check.conclusion?.trim() ?? "";
  return conclusion === "" ? null : conclusion.toLowerCase();
}

/**
 * One check from either half of the rollup, in the record's own words: what it
 * is called, and what it concluded. Both halves fold into one pair, because
 * "did it pass" has one answer.
 */
const concluded = (check: RollupEntry): { name: string; conclusion: string | null } => ({
  name: check.name ?? check.context ?? "check",
  conclusion: checkConclusion(check),
});

/** One read of the rollup. Null where `gh` did not answer at all. */
async function readRollup(request: {
  worktree: string;
  branch: string;
  timeoutMs: number;
}): Promise<Array<{ name: string; conclusion: string | null }> | null> {
  let viewed;
  try {
    viewed = await gh.viewPullRequest(request.worktree, request.branch, ["statusCheckRollup"], {
      timeoutMs: request.timeoutMs,
      maxOutputBytes: MAX_ANSWER_BYTES,
    });
  } catch {
    return null;
  }
  if (viewed.code !== 0 || viewed.truncated) return null;
  try {
    const parsed = JSON.parse(viewed.stdout) as { statusCheckRollup?: RollupEntry[] };
    return (parsed.statusCheckRollup ?? []).map(concluded);
  } catch {
    return null;
  }
}

/**
 * Read the head's checks until every one has concluded or the bound is spent.
 *
 * A head carrying no check at all is not settled: GitHub registers check runs
 * after the push, so an empty rollup a second after the pull request opened is
 * "not yet" rather than "this repository has no CI". Both end the same way
 * once the bound is spent — `unchecked`, which is not a pass.
 */
export async function readDeliveredChecks(
  request: DeliveredChecksRequest,
): Promise<DeliveredChecksReading> {
  const startedAt = request.now().getTime();
  const interval = request.intervalMs ?? DELIVERED_CHECKS_POLL_INTERVAL_MS;
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spent = () => request.now().getTime() - startedAt;

  for (;;) {
    const rollup = await readRollup({ worktree: request.worktree, branch: request.branch, timeoutMs });
    if (rollup === null) {
      request.onProgress?.(
        `\`gh\` would not report the checks on ${request.branch}; recording them unchecked`,
      );
      return { checks: [], state: "unchecked", waited_ms: spent(), bounded: false };
    }
    if (rollup.length > 0 && rollup.every((check) => check.conclusion !== null)) {
      const checks = rollup.map((check) => ({ name: check.name, conclusion: check.conclusion! }));
      return { checks, state: deliveryChecksState(checks), waited_ms: spent(), bounded: false };
    }
    if (spent() >= request.boundMs) {
      // What had not concluded is `unchecked`, and a head with nothing on it
      // at all is a reading of no checks — which `deliveryChecksState` reads
      // as `unchecked` too, because it is not evidence that anything passed.
      const checks = rollup.map((check) => ({ name: check.name, conclusion: check.conclusion ?? UNCHECKED }));
      request.onProgress?.(
        `${checks.filter((check) => check.conclusion === UNCHECKED).length || "no"} check(s) on ` +
          `${request.branch} had not concluded after ${Math.round(spent() / 1000)}s; recording them unchecked`,
      );
      return { checks, state: deliveryChecksState(checks), waited_ms: spent(), bounded: true };
    }
    await request.sleep(Math.min(interval, Math.max(request.boundMs - spent(), 0)));
  }
}

/**
 * The section the body carries once the checks have been read: one line per
 * check with its conclusion, and the state they add up to.
 *
 * It goes below whatever the body already holds. Nothing above it is rewritten
 * — a person may have edited it, and the reading is an addition to what the
 * pull request already said rather than a second version of it.
 */
export function deliveredChecksSection(reading: DeliveredChecksReading): string {
  const failed = failedChecks(reading.checks);
  return [
    "",
    "## Checks on the head",
    "",
    ...(reading.checks.length === 0
      ? [`- no check was reported on this head — \`${UNCHECKED}\``]
      : reading.checks.map((check) => `- \`${check.name}\` — ${check.conclusion}`)),
    "",
    reading.state === "checks_failed"
      ? `This delivery is \`checks_failed\`: ${failed
          .map((check) => `\`${check.name}\` ${check.conclusion}`)
          .join(", ")}. Nothing here has been fixed — the run recorded what the head's checks said.`
      : reading.state === "green"
        ? "Every check on this head concluded green."
        : "This delivery is `unchecked`: the run stopped waiting before every check had concluded, " +
          "which is not evidence that any of them passed.",
  ].join("\n");
}

/**
 * Replace the pull request's body with `body`.
 *
 * `false` rather than a throw where `gh` refused: the pull request is open and
 * the run has already recorded what it read, and losing that record because a
 * body edit failed would be the worse outcome. What `gh` said comes back with
 * it so the run can say so.
 */
export async function editPullRequestBody(request: {
  worktree: string;
  branch: string;
  body: string;
  timeoutMs?: number;
}): Promise<{ edited: boolean; detail: string }> {
  let result;
  try {
    result = await gh.run(request.worktree, ["pr", "edit", request.branch, "--body", request.body], {
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: MAX_ANSWER_BYTES,
    });
  } catch (error) {
    return { edited: false, detail: error instanceof Error ? error.message : String(error) };
  }
  return result.code === 0
    ? { edited: true, detail: "" }
    : { edited: false, detail: (result.stderr || result.stdout).trim().slice(-400) };
}
