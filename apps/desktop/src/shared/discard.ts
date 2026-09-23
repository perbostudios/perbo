/**
 * Why a piece of work stays where a delete was asked for, in the words the host
 * and the sample host both answer in (D-129), so a person meets one sentence
 * for one refusal whichever adapter answered.
 */

/** A command running in the repository may be writing what the delete would remove. */
export const DELETE_WAITS_FOR_COMMANDS =
  "Wait for the commands running in this repository to finish before deleting a contract.";

/** The ticket asked about is not among the repository's tickets. */
export const DELETE_TICKET_GONE = "This task is no longer in the repository's ticket store.";

/**
 * The one stage a delete does not reach: the pull request is on GitHub, a
 * record this machine does not own.
 */
export const deletePullRequestOpen = (key: string): string =>
  `${key} has a pull request open, and that is a record this machine does not own. Close ` +
  "or merge it on GitHub first, then delete the work.";
