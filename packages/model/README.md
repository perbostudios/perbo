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
| `failure.ts` | `ProviderError` and its kinds, and how much of a transport's own error text a record may carry |
| `anthropic.ts` | The call over the Anthropic SDK |
| `claude-cli.ts` | The same call over a locally installed `claude` binary, one session per conversation |
| `codex-cli.ts` | The same call over a locally installed `codex` binary, one ephemeral thread |
| `opencode.ts` | The same call over a locally installed `opencode` binary's ACP server, one session holding no tool it can use |
| `structured.ts` | The one turn schema the CLI transports read |
| `strict-schema.ts` | `strictSchemaViolations`: the one rule every schema sent to a provider keeps, and where a schema breaks it |
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
([D-134](../../docs/11-open-decisions.md)). A read or a command its model reaches for is refused,
never allowed, and the turn carries on with the model told that no tool is available, its usage
counted in the turn, until it answers or has had `REVIEWER_REFUSED_TOOL_CALLS` (three) calls refused
and reaches for a fourth, which fails the turn `provider_unavailable`.

## What a schema may be

The transports disagree on what a schema may be, so every schema Perbo sends keeps the strictest
rule any of them enforces, and the same bytes go to every transport with nothing rewritten at send
time: every key in an object's `properties` is in its `required`, every object says
`additionalProperties: false`, and a value that may be missing is nullable in the schema and read as
absent by the caller's parse. `strictSchemaViolations` names every place a schema breaks the first
two clauses; it runs in tests, never at send time — over this package's own schemas in
`strict-schema.test.ts`, and over every caller's submit schema, the review's included, in
`apps/cli/src/provider-schemas.test.ts`, which also fails for a sender it does not list.

## When a provider refuses the request

A provider refusing the request Perbo built fails the turn `request_refused`, never
`provider_unavailable`, read from the provider's structured error and never its prose: the API's
HTTP 400 or `invalid_request_error`, Claude Code's result envelope carrying `api_error_status` 400,
Codex's failed turn whose `codexErrorInfo` is `badRequest` or carries `httpStatusCode` 400, or a
JSON-RPC invalid-request or invalid-params answer from its app-server, and OpenCode's ACP server
failing a request with `data.errorName` `provider.invalid-request` — OpenCode's own class for an
upstream `invalid_request_error`, an HTTP 4xx it puts in no other class, and a prompt past the
model's context — or with JSON-RPC's invalid-request or invalid-params code. The same request is
refused the same way, so nothing retries it and nothing tells a person to try again.

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
