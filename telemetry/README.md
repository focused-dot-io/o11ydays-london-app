# Coding-agent telemetry (Act 1)

Wire the coding agent you already use to send its telemetry to the workshop Honeycomb environment,
scoped to this repo only: nothing changes in your global agent setup, and your other projects send
nothing. One template per agent, with exactly two blanks to fill in from your seat card:

- `<SEAT>`: your seat number (e.g. `17`);
- `<KEY>`: the workshop ingest key.

Every filled-in file is **gitignored** (`.claude/settings.local.json`, `.gemini/.env`,
`.codex-home/`), so your key never gets committed and `npm run catchup` never parks it.

All three send to `https://api.honeycomb.io`, keep their default `service.name` (so each agent
lands in its own dataset), add `seat=<seat>` through `OTEL_RESOURCE_ATTRIBUTES`, send their metrics
to one shared **`agent-metrics`** dataset via the `x-honeycomb-dataset` header, and keep prompt
content off.

**Your sign-in email is visible to the room.** `user.email` is the one attribute all three agents
attach, and it is the join key for the unified view. Wire your agent on your own machine with your
own sign-in only.

## Which agent, which files

| Agent | Template | Copy it to | Lands in dataset | Notes |
|---|---|---|---|---|
| Claude Code | `claude-settings.local.json` | `.claude/settings.local.json`, then start with `claude --settings .claude/settings.local.json` | `claude-code` | Cost is informational only on Pro/Max. Traces are beta (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`). Metrics every 10 s instead of 60 s |
| Codex CLI | `codex-config.toml` + `envrc` | `.codex-home/config.toml`; `export CODEX_HOME=$PWD/.codex-home` (or copy `envrc` to `.envrc` for direnv) | `codex_cli_rs` | Metrics overridden from the `statsig` default. Cost only with an API key. Tool arguments and output previews are exported even with prompt logging off |
| Gemini CLI | `gemini-settings.json` + `gemini.env` | `.gemini/settings.json` and `.gemini/.env` | `gemini-cli` | `logPrompts` defaults to **true**; the templates turn it off. `user.email` only when signed in with a Google account |

No supported agent (or a work-account agent on a locked-down laptop)? Use **Gemini CLI on the free
tier** with a personal Google account; it is preinstalled in the Codespace.

### Claude Code

```bash
mkdir -p .claude
cp telemetry/claude-settings.local.json .claude/settings.local.json
# edit: replace <KEY> (twice) and <SEAT>
claude --settings .claude/settings.local.json
```

Why `--settings`: since v2.1.282, Claude Code **ignores** telemetry variables
(`CLAUDE_CODE_ENABLE_TELEMETRY`, the exporters, `OTEL_EXPORTER_OTLP_*` endpoints and headers) set in
a repository's `.claude/settings.json` or `.claude/settings.local.json`, so a cloned repo cannot
turn telemetry on behind your back. A file you pass with `--settings` is honoured, and it still
applies only to sessions you start that way, in this repo. `/status` shows which variables were
ignored. (Docs: <https://code.claude.com/docs/en/monitoring-usage> and
<https://code.claude.com/docs/en/settings-reference#variables-claude-code-ignores-in-env>.)

Prompt text stays off: the template does not set `OTEL_LOG_USER_PROMPTS`.

### Codex CLI

Codex deliberately ignores `[otel]` in a project's `.codex/config.toml` (it decides where your data
goes), and no environment variable turns it on. But `CODEX_HOME` moves Codex's whole home, and a
home's `config.toml` may set `[otel]`. So:

```bash
mkdir -p .codex-home
cp telemetry/codex-config.toml .codex-home/config.toml   # replace <KEY> (three times)
export CODEX_HOME=$PWD/.codex-home
export OTEL_RESOURCE_ATTRIBUTES=seat=<seat>               # your seat number
codex login                                              # once: the fresh home has no credentials
codex
```

direnv users: `cp telemetry/envrc .envrc`, fill in the seat, `direnv allow`. A fresh home also means
a separate session history. In the Codespace, use `codex login --device-auth`. The IDE extension only
sees this home if the editor was launched from that shell (`code .`), so use the CLI today.
(Docs: <https://developers.openai.com/codex/config-advanced>, the `[otel]` section.)

### Gemini CLI

```bash
mkdir -p .gemini
cp telemetry/gemini-settings.json .gemini/settings.json
cp telemetry/gemini.env .gemini/.env      # replace <KEY> (twice) and <SEAT>
gemini
```

Gemini CLI reads `.gemini/settings.json` and `.gemini/.env` from the workspace only once you
**trust the folder** (it asks on first start). `otlpProtocol: "http"` sends OTLP/JSON to
`/v1/traces`, `/v1/logs` and `/v1/metrics` under the endpoint; the headers come from `.gemini/.env`.
(Docs: <https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/telemetry.md>.)

## The unified view: derived columns

The three agents name the same things differently. Four **environment-wide** derived columns
(Environment settings → Derived columns) `COALESCE` them into one vocabulary, so one query covers
every agent in the room:

| Derived column | Claude Code | Codex | Gemini CLI |
|---|---|---|---|
| `agent.input_tokens` | `input_tokens` (on `api_request`) | `input_token_count` (on `codex.sse_event`) | `input_token_count` (on `gemini_cli.api_response`) |
| `agent.output_tokens` | `output_tokens` | `output_token_count` | `output_token_count` |
| `agent.tool` | `tool_name` | `tool_name` | `function_name` |
| `agent.session` | `session.id` | `conversation.id` | `session.id` |

Definitions to paste:

```
agent.input_tokens    COALESCE($input_tokens, $input_token_count)
agent.output_tokens   COALESCE($output_tokens, $output_token_count)
agent.tool            COALESCE($tool_name, $function_name)
agent.session         COALESCE($session.id, $conversation.id)
```

(Codex and Gemini share `input_token_count` / `output_token_count`, and Claude Code and Codex share
`tool_name`, so one `COALESCE` of two names covers all three.)

Module 1's queries, environment-wide:

1. Tokens by agent and model: `SUM(agent.input_tokens)`, `SUM(agent.output_tokens)` grouped by
   `service.name`, `model`.
2. Tool mix: `COUNT` grouped by `service.name`, `agent.tool`.
3. Turns per session: grouped by `agent.session`.
4. The limits question: tokens by `user.email` over time. Use tokens, not cost: cost is
   informational on subscription plans and missing entirely for Codex on a ChatGPT plan.

Filter to yourself with `user.email = <your sign-in email>`, or `seat = <your seat>` (Gemini on an
API key has no email).

## Status of these templates

Drafted from each agent's docs and source; they must be **cold-tested at the dry run** (the prep
TODO), for each agent: the events land in the right dataset with `seat` on them, metrics land in
`agent-metrics`, no prompt text appears, and the derived columns resolve across all three. In
particular: Claude Code's `api_request` field names are not all documented (confirm against real
data); Claude Code honouring `--settings .claude/settings.local.json` for telemetry; Gemini CLI loading
`.gemini/.env` and applying `OTEL_RESOURCE_ATTRIBUTES`; Codex picking up `OTEL_RESOURCE_ATTRIBUTES`
for its resource; and a fresh `CODEX_HOME` login on a ChatGPT plan, including device-code login in
the Codespace.
