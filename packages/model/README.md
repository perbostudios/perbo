# `@perbo/model`

One model call, four wires.

Every model call this repository makes — the reviewer's, the drafter's, the closure verifier's and
the doctor's probe — goes through `Model`: one turn of a read-or-submit protocol, against a schema
the calling process supplied. Nothing else imports a provider SDK, and nothing else starts a
provider binary for a model call ([D-123](../../docs/11-open-decisions.md)).

The port exists because the callers have to run with no network and no credential in a test, and
because the same conversation reaches four different transports. It carries no policy: what a read
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
| `opencode.ts` | The same call over a locally installed `opencode` binary's ACP server, one session holding no tool it can use |
| `structured.ts` | The one turn schema the CLI transports read |
| `defaults.ts` | The model each transport calls when the caller names none; Claude Opus 5.5, preferred wherever Claude Code's catalog offers it, and the rule for the id it is offered by; and the argv Claude Code's catalog and usage are read with, which starts no turn. Its own subpath, `@perbo/model/defaults`, imports nothing, so the desktop's renderer reads it too |

## What a transport may do

The three CLI transports start a process. They are the only code here that does, they pass argv and
never a command line, and nothing a model returns becomes an argument
([ADR-0023](../../docs/adr/0023-untrusted-context-boundary.md)). No prompt is an argument
either: a file the caller opened can hold a NUL byte or more bytes than `ARG_MAX`, and argv can hold
neither, so the prompt travels on stdin, or on OpenCode as an ACP request, and the system prompt in a file
of that conversation's own.

Each CLI transport runs the provider binary in a directory of its own with the executor's
environment allow-list, every customisation suppressed, and no tool, hook, plugin or slash command
from anywhere but the user's own settings
([ADR-0030](../../docs/adr/0030-neutralise-repository-supplied-agent-configuration.md)). OpenCode
reads not even those: its reviewer runs under directories of its own, holds no tool it can use, and
answers in JSON the transport reads only whole, because ACP carries no output schema
([D-NEW-opencode-is-a-provider](../../docs/11-open-decisions.md)).

## How hard a model thinks

`createModel` takes an effort in the provider's own words (`EFFORT_LEVELS` in `@perbo/contracts`)
and refuses one the provider does not take rather than send it. Claude Code receives it as
`--effort` and, with none, is passed nothing, so the CLI's own default applies; Codex sends it as the
`turn/start` effort and starts at `medium`; the API sends it as `output_config.effort` and starts at
`high`; OpenCode takes none.

## What a turn costs

A transport that reports its own dollars is believed, because it knows the harness overhead the
token counts do not describe. Where none of them does, `resolveModelCost` estimates the whole
conversation from tokens at Claude Opus 5 list prices and says so; a transport that cannot know at
all declares `unavailable` and no figure is recorded. A cost nobody measured is not a number, and
D-010 has a threshold.

## The records

`anthropic.golden.json`, `claude-cli.golden.json`, `codex-cli.golden.json` and `opencode.golden.json`
hold the request each transport builds, byte for byte. They are read, never rewritten: a change to what reaches a provider
fails the golden beside its transport.
