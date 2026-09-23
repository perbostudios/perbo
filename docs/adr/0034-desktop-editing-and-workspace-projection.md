# ADR-0034: Desktop editing sessions and workspace projections own their lifecycles

- Status: accepted
- Decision: [D-095](../11-open-decisions.md)
- Extends: [ADR-0033](0033-focrux-local-desktop-and-subscription-providers.md)

## Decision

Three modules own the desktop's lifecycles, each behind a focused interface.

- **Contract editing belongs to the host.** Its versioned local record holds incomplete form fields, a revision and the owning operation's receipt.
  - Save and submit compare revisions.
  - Submit records its identity before dispatch, and settlement records the returned ticket key before reading the resulting contract.
  - Native persistence atomically replaces a private profile file.
  - The renderer serializes saves, keeps failed writes across navigation, and flushes pending writes before closing; input stays quiescent until close succeeds or is cancelled.
  - Completed receipts do not count against the limit on unfinished editors.
- **The ticket workspace projection is a pure function** over a repository-qualified ticket, its jobs and, optionally, its detail. Home, task routing, the loop and review share its rules for activity, recovery, delivery and evidence.
  - Missing detail is unknown evidence.
  - Closure verification keeps its own provenance and never becomes fresh criterion coverage.
  - A terminal command's stale records cannot establish success or recovery while fresh records are being read.
- **Workspace refresh sits behind the query hooks.**
  - Validated progress events patch the job display without native reads.
  - Record events refresh the changed repository and the active detail, output, summary and graph queries.
  - Polling and visibility wakeups still read external CLI changes.
  - A dirty generation forces a fresh pass when a mutation overlaps a read. One module states that rule, `src/shared/read-generations.ts`, and both the host's reads and every one of the renderer's query hooks go through it.
  - The host shares in-flight reads; the selected output attempt still passes ticket, bundle, size, regular-file and hash checks.

The sample host, which the tests and the development preview run the renderer against, answers the same Request table as the host and is held to it by a conformance suite ([D-120](../11-open-decisions.md)). Neither it nor the native host changes the CLI's authority over tickets and contracts, or the runner's review, publication and merge controls.

A recorded admission result reserves its ticket while the canonical read completes. If that ticket was already open in another editor, the existing editor keeps ownership and its unfinished buffer. The submitting session keeps its fields and receipt as a visible conflict, with a link to the canonical contract. Retrying or restarting never overwrites either buffer and never repeats an admission.

## Consequences and limits

- Form recovery adds private local storage and a close handshake between renderer and host.
- A forced process exit can still lose unacknowledged input.
- The CLI store and the desktop profile are not one transaction, so an admission without a recorded result is unknown until inspected. Nothing submits it again silently.
- Polling still costs work in proportion to the connected repositories.
- A read that a mutation overlaps on every pass is refused after a bounded number of them, rather than taken again for as long as the records keep moving; the refresh that follows takes it again.
