# Product thesis

Perbo is an open-source operating plane for intuitively getting your work done, no matter the scale of work ([D-001](11-open-decisions.md)). It runs a person's own coding agents on their repository, and brings back only what needs them.

## The problem

Coding agents write the code. What a person still does by hand is everything around it:
- saying what "done" means;
- checking that the agent did it, and catching what it broke;
- relaying what review finds back to the agent;
- keeping several pieces of work from colliding, and deciding what to merge.

Doing that by reading the agent's summary and skimming the diff is free and fast, and it fails silently.

## What changes for the person

| | Without Perbo | With Perbo |
|---|---|---|
| What "done" means | In the person's head, or one sentence in an issue | A contract drafted from the issue and approved in a minute: outcome, criteria and scope |
| Checking the work | Read the agent's summary, skim the diff | Checks, then an independent reviewer that sees the contract, the diff and the checks, and never the agent's summary |
| Whether a test proves anything | Assumed | Each criterion is marked `directly_verified`, `proxy` or `asserted_only` |
| Acting on what review finds | The person relays it to the agent | The agent fixes what it can, each fix is verified, and the person sees only what needs them |
| Several pieces of work at once | Branches drift and collide | The queue keeps branches level and holds overlapping work back |
| Retrying | The previous attempt is gone | Every attempt is kept, with its diff, findings and usage |

## Who it is for

Developers who already work with Claude Code or Codex, alone or on a team ([D-002](11-open-decisions.md)).

## What it is not

- Not an editor: Perbo reads code and never edits it ([D-015](11-open-decisions.md)).
- Not an organisation of agents with job titles ([ADR-0011](adr/0011-control-loop-not-agent-organisation.md)).
- Not a review product for other people's pull requests: review is the loop's step ([D-088](11-open-decisions.md)).
- Not a service that holds your code: everything runs on your machine, under your own logins ([D-075](11-open-decisions.md)).
- Not a system that treats a generated summary as a fact.

## Principles

- **The contract is the authority.** A model may draft, and only a person's approval lets work start ([D-072](11-open-decisions.md), [D-071](11-open-decisions.md)).
- **Review is independent.** It never sees the executor's account, and deterministic checks outrank any model claim ([D-037](11-open-decisions.md), [D-035](11-open-decisions.md)).
- **Fix, then ask.** What the agent can close by the established practice, it closes. A person is asked only what no practice answers ([D-065](11-open-decisions.md)).
- **The person keeps the merge,** unless they hand it to the loop for a repository ([D-041](11-open-decisions.md)). Some actions are never taken, whoever asks ([D-022](11-open-decisions.md)).
- **Real use is the evidence** ([D-099](11-open-decisions.md)).

## The commercial product

Perbo is open source. What a team shares across people and machines is the control plane, sold on top of it ([D-016](11-open-decisions.md), [docs/17](17-commercial-open-source-and-validation.md)).
