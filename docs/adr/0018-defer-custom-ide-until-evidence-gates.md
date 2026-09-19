# ADR-0018: Perbo reads code; editing stays in the person's editor

- Status: accepted
- Decision: [D-015](../11-open-decisions.md)

## Context

Rebuilding an editor, a language server, a debugger and extensions would consume the product without improving the loop.

## Decision

Perbo provides the ticket workspace, the plan, the diff, checks, review and planning surfaces, and hands off to the person's own editor at the right worktree. It never edits code itself. Its only code intelligence is a symbol and import index built for planning, which `perbo index` builds on demand from the tracked tree with TypeScript's own parser.

## Consequences

- Engineering stays on the loop.
- The experience depends on handing off to the editor well.
- Workspace contracts stay independent of any UI.

## Alternatives considered

A VS Code fork; a browser-based editor; no workspace UI at all.

## Reversal trigger

People ask to edit code inside Perbo more than they use their own editor.
