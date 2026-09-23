# `perbo list --json`

The machine-readable projection of the local ticket store. This page records what that output *is*,
so the shape is a decision somebody made rather than whatever the code happened to serialise.

The human rendering it mirrors is `perbo list`: a flat list of admitted work, deliberately not a
backlog. `--json` is that same listing, under the same filter, for a reader
that is not a person.

## What is decided here

1. **One document, one write.** `perbo list --json` writes a single JSON value to stdout and
   nothing else: no table, no column headings, no colour, no prose. The bytes are
   `JSON.stringify(document, null, 2)` followed by one newline, so `perbo list --json | jq` and
   `perbo list --json > tickets.json` both hold a complete document.
2. **The container is an object, not an array.** A bare array can carry the tickets and nothing about the listing: not which store was
   read, not whether `--all` was in force, not how many tickets the filter hid. Those are facts the
   caller would otherwise have to reconstruct from the argv it passed. They are added as sibling
   keys, which is a change consumers survive; widening a top-level array is not.
3. **A ticket entry is the stored ticket, verbatim.** Every field of the ticket record, not a
   projection of the five columns the table draws. A projection would be a second field list to
   keep in step with the ticket schema, and it is exactly how the two renderings come to disagree.
4. **Nothing in this output is derived.** No computed status, no rollup, no "blocked" that is not a
   stored state. Both renderings read the same field, so there is no second answer to disagree with.
5. **Diagnostics stay on stderr.** The advice printed when nothing is admitted and the warning
   naming files in the store that are not readable tickets are written to stderr in both modes.
   The count line is table mode's alone: in `--json` mode the count travels in `counts`, and
   stderr is empty on a clean listing. Stdout carries the document alone.
6. **Exit status is the flag's business not at all.** A successful listing exits `0` whether or not
   `--json` was passed, an empty store included — an empty store yields a document with an empty
   `tickets` array, never empty stdout.

## The document

| field | what it carries |
|---|---|
| `schema_version` | `1`. Incremented when an existing field changes meaning or leaves; adding a sibling key does not increment it. |
| `store` | Absolute path of the ticket store the listing was read from — `<repo>/.perbo` unless `--store` overrode it. |
| `filter` | The filter this listing was taken under: `{ "all": false }` for the default active-only listing, `{ "all": true }` under `--all`. |
| `counts` | `{ "shown": <n>, "total": <n> }` — `shown` equals `tickets.length`, `total` is the store before the filter. Equal under `--all`. |
| `tickets` | The tickets the table would print, in the order it would print them: oldest `admitted_at` first. |

```json
{
  "schema_version": 1,
  "store": "/home/lian/acme/.perbo",
  "filter": { "all": false },
  "counts": { "shown": 1, "total": 3 },
  "tickets": [
    {
      "schema_version": 1,
      "ticket_id": "ticket_9f1c0f7b2a4d8e13",
      "key": "PRB-1",
      "title": "Activation email goes out within 60 seconds.",
      "state": "ready",
      "priority": "normal",
      "labels": [],
      "depends_on": [],
      "scheduling": { "waits_on": [], "decided_at": null },
      "source": { "kind": "none", "reference": null, "url": null, "title_at_admission": null },
      "repository_root": "/home/lian/acme",
      "plan_id": "plan_3c2b1a0908070605",
      "plan_version": 1,
      "approved_at": "2026-09-02T10:14:02.000Z",
      "admitted_at": "2026-09-02T10:11:47.000Z",
      "updated_at": "2026-09-02T10:14:02.000Z",
      "admission": {
        "elapsed_ms": 41,
        "criteria_source": "typed",
        "criteria_count": 1,
        "drafted_at": null,
        "human_elapsed_ms": 135000,
        "edit_count": 0,
        "level_source": "derived",
        "derived_level": "P1"
      },
      "delivery": {
        "branch": null,
        "pull_request_url": null,
        "pull_request_number": null,
        "state": "none",
        "observed_at": null,
        "opened_by": null
      },
      "history": [
        { "at": "2026-09-02T10:11:47.000Z", "from": null, "to": "plan_review", "note": "admitted" },
        { "at": "2026-09-02T10:14:02.000Z", "from": "plan_review", "to": "ready", "note": "contract approved" }
      ]
    }
  ]
}
```

## A ticket entry

Exactly these eighteen fields, and no others. They are the ticket record as the store holds it
(`TicketSchema` in [`packages/contracts`](../../packages/contracts/src/ticket.ts)); a ticket file
carrying anything else is not a ticket, and `list` names it on stderr and steps over it rather than
emitting it.

| field | what it carries |
|---|---|
| `schema_version` | The ticket record's version, `1`. Distinct from the document's. |
| `ticket_id` | The opaque id every other contract references. |
| `key` | The human key, `PRB-118`. What the `TICKET` column prints. |
| `title` | What the ticket is called ([D-127](../11-open-decisions.md)); the outcome is in the plan contract. What the `NAME` column prints. |
| `state` | The stored lifecycle state, verbatim — the same string the `STATE` column prints. |
| `priority` | `urgent`, `high`, `normal` or `low`. |
| `labels` | The labels given at admission, as an array. |
| `depends_on` | Ticket keys that must be done first. Keys, not ids: a person wrote them. |
| `scheduling` | What `perbo serve` last decided the ticket waits on: `waits_on`, each `{ key, reason, paths, state }` with `reason` one of `depends_on` or `scope_overlap`, and `decided_at`, when that list last changed (`null` for a ticket that has never waited); and `reconciliation`, `null` or `{ base_tip, exit_code, at, reason }` for a re-level that did not level the branch, `reason` what it answered: a refusal's message, or the outcome and detail of a run that completed without levelling. Stored, not derived, so a `blocked` row carries its reason and rule 4 still holds. |
| `source` | Where the work came from: `kind`, `reference`, `url`, `title_at_admission`. |
| `repository_root` | The repository the ticket was admitted against. |
| `plan_id` | The plan contract admission drafted. The contract itself is not in this output. |
| `plan_version` | Which version of that plan the ticket is bound to. |
| `approved_at` | When the contract was frozen, or `null` while it is still `plan_review`. |
| `admitted_at` | When the ticket was admitted. The sort key of `tickets`. |
| `updated_at` | When the ticket last moved. |
| `admission` | The admission-friction record (D-072): `elapsed_ms`, `criteria_source`, `criteria_count`, `drafted_at`, `human_elapsed_ms`, `edit_count`, `level_source`, `derived_level`. A measurement not taken is `null`, never `0`. |
| `delivery` | What local `git`/`gh` last reported: `branch`, `pull_request_url`, `pull_request_number`, `state`, `observed_at`, and `opened_by` — `loop`, `hand_off` or `null` for a pull request nothing has attributed. |
| `history` | Every recorded transition, oldest first, each `{ at, from, to, note }`, and `handed_off` on a row that moved a `failed` ticket to `pr_open`. Uncollapsed: no "latest only", no count standing in for the entries. |

### State and history

`state` is a member of the lifecycle enum in
[`diagrams/ticket-lifecycle.dot`](../../diagrams/ticket-lifecycle.dot), written as stored. A caller
that wants a coarser word derives it; this output does not, because a derived word here and a stored
word in the table is two answers to one question.

`history` is the append-only transition log, whole. It is what makes `--json` worth having over the
table: how a ticket reached the state it is in — which is the question the table has no room for —
is answerable from a piped listing without opening a ticket file.

### What is not here

The plan contract, the draft snapshot and the attempt bundles. `list` projects the ticket store, and
a listing that inlined every contract would be a different command;
`perbo inspect <KEY> --json` is that command.

## Compatibility

`schema_version` is `1`. A consumer should read it and refuse a version it does not know. Adding a
new top-level key or a new ticket field that the ticket record itself gained is not a version bump —
consumers must ignore keys they do not recognise. Removing a field, renaming one, or changing what an
existing one means is, and this page is where that change gets argued before it ships.
