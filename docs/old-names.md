# Old names you will meet in the wild

The OpenTelemetry GenAI conventions are young and still moving. Everything under `gen_ai.*` is
**Development** status: names get renamed, split and replaced between releases. Libraries,
vendors and blog posts lag behind by months, so the same thing turns up under several names.

This workshop uses the current names. This page maps the ones you will meet elsewhere.

## GenAI semantic conventions: renamed attributes

| Old name | Current name | Where you still see the old one |
|---|---|---|
| `gen_ai.system` (e.g. `openai`) | `gen_ai.provider.name` | Older instrumentations; and **this repo's** `@opentelemetry/instrumentation-openai` 0.20 on the Chat Completions path (see below) |
| `gen_ai.usage.prompt_tokens` | `gen_ai.usage.input_tokens` | Instrumentations written against conventions before 1.27; many dashboards and blog posts |
| `gen_ai.usage.completion_tokens` | `gen_ai.usage.output_tokens` | Same |
| `gen_ai.request.model` | unchanged | Stable across versions; the request model and `gen_ai.response.model` (e.g. `gpt-4.1-mini` vs `gpt-4.1-mini-2025-04-14`) are different on purpose |
| `gen_ai.prompt` / `gen_ai.completion` (span attributes or events, indexed like `gen_ai.prompt.0.content`) | `gen_ai.input.messages` / `gen_ai.output.messages` | Older instrumentations and OpenLLMetry; earlier spec versions used per-message events such as `gen_ai.user.message` and `gen_ai.choice` |
| `gen_ai.response.finish_reasons = ["tool_calls"]` | `["tool_call"]` | Instrumentations that copy the provider's raw Chat Completions value; the spec's value is singular |

## Other vocabularies

| Name | What it is | The spec equivalent |
|---|---|---|
| `ai.generateText`, `ai.streamText`, `ai.toolCall` (span names) and `ai.*` attributes | Vercel AI SDK's own telemetry | `chat {model}` and `execute_tool {name}` spans with `gen_ai.*` attributes (the AI SDK also emits some `gen_ai.*` alongside its own) |
| `llm.request.type`, `llm.usage.total_tokens`, other `llm.*` | OpenLLMetry (Traceloop) | `gen_ai.operation.name`, `gen_ai.usage.input_tokens` + `output_tokens` |
| `traceloop.*` (e.g. `traceloop.entity.name`, `traceloop.workflow.name`) | OpenLLMetry's workflow and agent naming | `gen_ai.agent.name`, `invoke_agent` spans |
| `input_tokens`, `input_token_count`, `tool_name`, `function_name` | Coding-agent event attributes (Claude Code, Codex, Antigravity; `function_name` is retired Gemini CLI data) | Normalised with derived columns in [telemetry/README.md](../telemetry/README.md) |

## Why this app uses the Responses API

`@opentelemetry/instrumentation-openai` 0.20.0, pinned in this repo, has two code paths:

- **Chat Completions** (`client.chat.completions.create`) still emits the deprecated
  `gen_ai.system=openai` with no `gen_ai.provider.name`, and copies the raw
  `finish_reasons=["tool_calls"]`.
- **Responses** (`client.responses.create`) emits `gen_ai.provider.name=openai`,
  `server.address` / `server.port`, derived `finish_reasons` of `["tool_call"]` or `["stop"]`, and
  message content as `gen_ai.input.messages` / `gen_ai.output.messages`.

So the agent calls the Responses API and the replay model serves `POST /v1/responses`. Same library,
same version, two vocabularies, depending on which client method you call. That is what
Development status looks like in practice.

## What to do about it

- **Pin versions.** Every OTel package in `package.json` is pinned to an exact version. An upgrade
  can rename the attributes your queries, boards and triggers depend on.
- **Check what your library actually emits** before you build a board on it: open one span and read
  the attribute names.
- **Bridge with derived columns** when you have data under both names, e.g.
  `COALESCE($gen_ai.usage.input_tokens, $gen_ai.usage.prompt_tokens)`.
