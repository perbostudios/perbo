# ADR-NEW-command-line-edge: A command is a typed function; argv lives at the edge

- Status: accepted
- Decision: [D-NEW-cli-grammar](../11-open-decisions.md)
- Extends: [ADR-0023](0023-untrusted-context-boundary.md)

## Context

`perbo` is the whole product's surface: a person types at it, the desktop spawns it, and three modules inside the CLI — the queue's endpoint, the interview and the queue itself — ask other commands to do things while a process is already running ([docs/04](../04-ticket-workspace-and-review.md)).

A caller inside the process that builds a command line is building a sentence out of values it did not choose. A title, an outcome, a note, a repository path and a spec folder are free text a person typed, and the desktop passes each straight through. Anything that re-reads such a value as a flag lets that text decide what the command does: an outcome can approve the ticket it is admitted with, a note can record the decision it annotates, a repository path can turn publication on. That is the same class of fault as a model's output reaching an action parameter, which [ADR-0023](0023-untrusted-context-boundary.md) §4 refuses, and it needs the same kind of answer — a structural one, not a rule people remember.

## Decision

- **A command is a function over typed input.** Each command declares an input type and a run that takes it. A caller in this process — the endpoint, the interview, the queue — calls that function with values. It never builds a command line, and nothing it passes is re-read as anything.
- **Argv exists only in `apps/cli/src/command-line/`.** One grammar walks a line by the rules in [D-NEW-cli-grammar](../11-open-decisions.md); one table says which commands exist; one adapter turns a line into a command's input and its answer back into bytes. A command declares which flags it has and what each takes, beside the command, and reads its line by that grammar and no other.
- **A value is text.** `--name=value` is split in flag position only, and a value flag takes the next token verbatim. What a value has to be — an enum, an integer, a ticket key, a date — is the command's input schema, so a caller in this process is owed the same check as a person at a terminal rather than a weaker one.
- **Approval is not a field of a draft.** The input a drafting caller passes has no `approve`, so no combination of text can approve what it drafts. The endpoint, the queue's drafting tick and the interview all pass that type.
- **The boundary is enforced, not remembered.** `eslint.config.mjs` refuses an import of `command-line/` from the endpoint, and of the terminal adapter from the queue and the interview, which read their own line but run no command from one. `scripts/lint-boundaries.test.mjs` shows each rule firing on the form it forbids and silent on the form it allows.

## Consequences

- A person's text reaches a command as the text they typed, and so does the desktop's; the cases are pinned one per free-text flag value in `apps/cli/src/command-line/terminal.flag-injection.test.ts`.
- A caller in this process gets the command's own validation, because the checks live in the input rather than in the parser.
- The help and the table cannot drift apart: `usage.consistency.test.ts` checks that the help offers no flag a command does not take and names every flag it does.
- Adding a command means adding it to the table; a name the table does not answer fails to compile rather than reaching the person who typed it.
- The desktop is unaffected. It spawns the binary and passes argv, which is what the edge is for; every shape it builds is pinned in `terminal.edge-argv.test.ts`.
- A command that reads a line and also calls another command would sit on both sides of the boundary. The lint rules say which side each module is on, and a module that needs both is a module to split.

## Alternatives considered

- **A parsing library.** Generated help would replace the authored prose that documents what each flag means, and the product has to guarantee last-wins and verbatim values, which a dependency decides rather than this repository.
- **Sanitising values before building a line.** An escaping rule is a rule someone forgets at one call site, and the fault is silent when they do.
- **Leaving each command its own parser.** Seventeen loops answered the same line seventeen ways, and a caller could not know what a line would mean without reading the command it was going to.

## Reversal trigger

A caller outside this repository needs to drive a command and cannot import the package, so a line is the only interface it has.
