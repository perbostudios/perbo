import { existsSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { branchName, recordedBranch } from "@perbo/workspace";
import type { PlanContract, Ticket } from "@perbo/contracts";
import { readAttempts } from "../records.js";
import { attemptsPath } from "../repository/layout.js";
import { worktreeForBranch, type Execute } from "../repository/git.js";
import type { RegisteredRepository } from "../profile/store.js";
import type { Detail } from "../../shared/protocol.js";

/** What this module reads of a ticket: its listing and the contract it carries. */
export interface TicketRecords {
  list(repo: RegisteredRepository): Promise<{ tickets: Ticket[] }>;
  contract(repo: RegisteredRepository, key: string): { contract: PlanContract };
}

/**
 * The folder this task's changes are materialized in, as a path on this
 * machine (D-098).
 *
 * A branch the ticket's records already name is kept; a name is derived only
 * where none is. What is opened is the worktree Git says holds that branch,
 * canonically: a worktree that resolves to the primary checkout is refused,
 * because opening it would show the person their own working tree as if it
 * were the task's.
 */
export async function ticketWorktree(
  deps: { tickets: TicketRecords; execute: Execute },
  repo: RegisteredRepository,
  key: string,
): Promise<string> {
  const { contract } = deps.tickets.contract(repo, key);
  const ticket = (await deps.tickets.list(repo)).tickets.find((entry) => entry.key === key);
  const attempts = readAttempts(attemptsPath(repo, contract.ticket_id)).attempts;
  const branch =
    "refs/heads/" +
    (recordedBranch(
      {
        delivery: ticket?.delivery.branch,
        attempt: attempts.at(-1)?.branch,
      },
      contract.ticket_id,
    ) ??
      branchName({
        ticket_key: ticket?.key ?? key,
        ticket_id: contract.ticket_id,
        outcome: contract.outcome,
      }));
  const path = await worktreeForBranch(deps.execute, repo.path, branch);
  if (!path || !isAbsolute(path) || !existsSync(path))
    throw new Error(
      "This task has no materialized worktree available. Its retained changes remain in the run record.",
    );
  const canonical = realpathSync(path);
  if (canonical === repo.path)
    throw new Error("The task's worktree resolves to the primary checkout.");
  return canonical;
}

/**
 * The pull request this task was delivered through, as a URL a browser is
 * given. Only a GitHub pull-request URL is opened: the record is written by
 * `perbo sync` off the forge, and anything else shaped like a link is not one
 * this host hands to the person's browser.
 */
export function pullRequestUrl(detail: Detail): string {
  const url = detail.ticket.delivery.pull_request_url;
  if (
    !url ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(url)
  )
    throw new Error("This task has no supported GitHub pull-request URL.");
  return url;
}
