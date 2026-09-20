# `@perbo/model`

One model call, three wires.

Every model call this repository makes — the reviewer's, the drafter's, the closure verifier's and
the doctor's probe — goes through `Model`: one turn of a read-or-submit protocol, against a schema
the calling process supplied. Nothing else imports a provider SDK, and nothing else starts a
provider binary for a model call ([D-NEW-model-client](../../docs/11-open-decisions.md)).

The port exists because the callers have to run with no network and no credential in a test, and
because the same conversation reaches three different transports. It carries no policy: what a read
renders to, when to force a submission and how an answer is judged belong to the caller.

## The shape

| | |
|---|---|
| `turn.ts` | The port: `Model`, one request, one turn, and the two tool names that are wire bytes |
| `usage.ts` | Token accounting, the Claude list-price card, and which basis a cost was known by |
| `failure.ts` | `ProviderError`, and how much of a transport's own error text a record may carry |
| `anthropic.ts` | The call over the Anthropic SDK |
| `claude-cli.ts` | The same call over a locally installed `claude` binary, one session per conversation |
| `codex-cli.ts` | The same call over a locally installed `codex` binary, one ephemeral thread |
| `structured.ts` | The one turn schema both structured-output CLI transports read |
| `defaults.ts` | The model each transport calls when the caller names none |

## What a transport may do

The two CLI transports start a process. They are the only code here that does, they pass argv and
never a command line, and nothing a model returns becomes an argument
([ADR-0023](../../docs/adr/0023-untrusted-context-boundary.md)). Neither prompt is an argument
either: a file the caller opened can hold a NUL byte or more bytes than `ARG_MAX`, and argv can hold
neither, so the prompt travels on stdin and the system prompt in a file of that conversation's own.

Each CLI transport runs the provider binary in a directory of its own with the executor's
environment allow-list, every customisation suppressed, and no tool, hook, plugin or slash command
from anywhere but the user's own settings
([ADR-0030](../../docs/adr/0030-neutralise-repository-supplied-agent-configuration.md)).

## What a turn costs

A transport that reports its own dollars is believed, because it knows the harness overhead the
token counts do not describe. Where none of them does, `resolveModelCost` estimates the whole
conversation from tokens at Claude Opus 5 list prices and says so; a transport that cannot know at
all declares `unavailable` and no figure is recorded. A cost nobody measured is not a number, and
D-010 has a threshold.

## The records

`anthropic.golden.json`, `claude-cli.golden.json` and `codex-cli.golden.json` hold the request each
transport builds, byte for byte. They are read, never rewritten: a change to what reaches a provider
fails the golden beside its transport.
