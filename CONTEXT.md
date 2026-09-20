# Perbo glossary

The words Perbo uses, and the ones to avoid. Decisions are in [docs/11](docs/11-open-decisions.md), and the ticket and contract are specified in [docs/04](docs/04-ticket-workspace-and-review.md).

**Operating plane**:
The open-source Perbo: everything that runs on one machine.
_Avoid_: control plane, for the open product.

**Control plane**:
The commercial product built on top of Perbo: what a team shares across people and machines ([D-016](docs/11-open-decisions.md)).

**Ticket**:
One piece of work, from admission to merge, whatever its size. Its key is `PRB-n`.
_Avoid_: epic, work item.

**Admission**:
The moment a piece of work becomes a Perbo ticket. Before it, the tracker owns the work.

**Contract**:
The part of a plan fixed at approval: outcome, acceptance criteria, scope and base.
_Avoid_: spec. A spec is the intent upstream of a contract.

**Approach**:
The part of a plan the executor may change during execution.

**Attempt**:
One run of the executor on a ticket, in its own worktree, ending in a sealed change set. A remediation **round** is a new attempt.

**Executor**:
The coding agent, Claude Code or Codex, doing the work.

**Reviewer**:
The independent model call that judges a sealed change against the contract, and never sees the executor's account of it.

**Finding**:
One thing the reviewer reports. Routing makes it **remediable** (back to the executor), **escalates** (to a person), **blocks**, or **advisory**.

**Closure verification**:
What a later round runs instead of a second review: whether each routed finding was closed.

**Stop**:
A change the loop stopped for a person's decision.

**Principle**:
A person's recorded answer to a product question no established practice settles. The executor reads principles and cannot write them.

**Queue**:
`perbo serve`, the one process that runs tickets, re-levels branches and merges in order.

**Re-level**:
Bringing an open branch up to date with the base. A conflict starts a **reconciliation round**.

**Endpoint**:
The queue's loopback tool server. A person's own session can reach it; the executor never can.

**Run bundle**:
The immutable record of one run's inputs, provenance and outputs.

**Contract editing session**:
A local working copy of contract fields, tied to one repository and optionally an unapproved ticket, together with the drafting or compilation job requested for those fields. Its identity belongs to the editing work and survives navigation away from its screen.
_Avoid_: admission draft, because the drafting command can already have admitted a ticket.

**Ticket workspace projection**:
A read-only interpretation of one repository-qualified ticket, its jobs and any loaded detail, shared by desktop views.
_Avoid_: UI lifecycle, because the ticket lifecycle already has one authority.

**Workspace refresh**:
The owner of desktop polling, scoped change events and overlapping reads. Its cache represents local records without replacing their authority.

**Prohibited path**:
A path a Ticket's executor may not change, named in the Ticket's contract scope or in the repository's standing list.
_Avoid_: No-Go (a No-Go names behaviour, not code), guardrail, off-limits path.

**No-Go**:
A behaviour deliberately excluded from a Ticket's outcome.
_Avoid_: Prohibited path (that names code), non-goal.

**Planning mode**:
The desktop surface Create opens for one piece of work in one repository, where its spec, scope and execution graph are prepared for approval.
_Avoid_: Planning workspace (workspace already names other things here), IDE.

**Interview**:
The conversation in which a person's own agent session questions them about a piece of work and writes its spec. The desktop shows it as a chat in planning mode.
_Avoid_: Grilling (the method it follows), terminal session.

**Spec**:
A document in the repository stating the intent of one Ticket, from which that Ticket's contract is drafted. Its folder also holds a page per node, generated from the spec and the graph, so that a node reads on its own.
_Avoid_: Epic, epic spec, PRD, issue (an issue lives in an external tracker).

**Execution graph**:
The nodes a Ticket's work is divided into and the suggested order between them. Each node's criteria and paths belong to the contract; the order belongs to the approach.
_Avoid_: Execution DAG, work breakdown, sub-tickets (the work stays one Ticket).

**Node**:
One part of an execution graph: a group of the Ticket's acceptance criteria and the paths expected to satisfy them.
_Avoid_: Step (steps belong to the approach), sub-ticket, subtask.

**Impact warning**:
An advisory note, shown while planning, that something outside a draft's scope is likely to be touched by it: code that imports what the draft changes or what the spec names, or a path in one of the classes `risk.ts` recognises inside a package the draft reaches.
_Avoid_: Finding (findings come from review), probe.

**Stale spec**:
A spec edited after its Ticket was approved, or one that names code which no longer exists.
_Avoid_: Broken spec.

**Size estimate**:
A description of how big a Ticket's execution graph is, from S to XL, derived from its nodes, criteria and scope. It predicts neither cost nor time.
_Avoid_: Cost estimate, forecast, appetite (nothing is budgeted).

**E1**:
The comparison a partner's use of Perbo is judged by ([D-038](docs/11-open-decisions.md)): the median time Perbo takes over ten pieces of work, divided by the median time the partner took over the same ten working agent-direct. The ten are timed from start of work to pull request opened, and sealed before the partner first uses Perbo; the pass bars are agreed in writing before the first is timed. `perbo baseline` keeps it in `.perbo/e1.json`; an AI stand-in's baseline is reported on its own and never pooled with a partner's.
_Avoid_: Pilot, trial (neither says what is measured).
