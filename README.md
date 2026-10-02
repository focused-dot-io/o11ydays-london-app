# Roast Judge

The demo app for the Focused workshop at Honeycomb o11ydays London, Tue 6 Oct 2026.

Roast Judge is a small AI agent that judges Sunday roasts. You describe the roast you had (where,
what was on the plate, how it was) and the agent investigates: it scores each part of the plate
against a fixed rubric, looks the pub up in a separate pub-guide service, compares the scores with
past verdicts in a SQLite table, and returns a score out of 10, a label (`banging`, `decent`,
`disappointing` or `a crime`) and a one-line reason. You can then appeal, and ask for a final,
binding ruling. All the pubs are made up.

Out of the box it runs against a **replay model**: a local, deterministic, OpenAI-compatible fake
LLM, so nobody needs a model key and nothing goes over the venue wifi except your telemetry. During
the afternoon you instrument the agent with the OpenTelemetry GenAI conventions, break it with a
prompt change, find the break in Honeycomb, and roll it back.

```bash
curl -s localhost:3000/judge -H 'content-type: application/json' \
  -d '{"text":"The Gravy Boat, £24, beef. Yorkshire the size of a hubcap but soggy underneath, gravy clearly from granules, roasties crisp."}'
```

```json
{
  "conversation_id": "8ac6c049-dafd-4cb1-9296-79e0241f69bf",
  "trace_id": "0c37676083859ca0dc245aa7c4bf1536",
  "verdict": {
    "score": 5.5,
    "label": "disappointing",
    "reason": "Scored meat 6, roasties 7, yorkshire 4.5, gravy 4.5; mean 5.5."
  },
  "components_scored": 4,
  "prompt_version": "v1"
}
```

## Before the day

You need git, Node 22.13 or newer, and Docker Desktop (or another Docker with `docker compose`).

```bash
git clone https://github.com/focused-dot-io/o11ydays-london-app.git
cd o11ydays-london-app
./verify-setup.sh
```

`verify-setup.sh` checks, stopping at the first problem and printing the fix:

- Node is 22.13 or newer;
- Docker is installed and the daemon is running, and `docker compose` is available;
- `npm ci` installs the dependencies;
- `docker compose build` builds the app image (this pulls the pinned `node:22.22.0-alpine` base);
- your network can open TLS to `api.honeycomb.io:443` (no key needed; it sends nothing).

The last line is **`PASS`** when you are ready. It never switches branches; if you are on `main`
it tells you to run `npm run catchup -- 0`.

PASS proves the laptop is ready. It is not a first trace: that happens in Module 0.

### Which lane are you in?

| Lane | You are | On the day |
|---|---|---|
| **Green** | `./verify-setup.sh` printed PASS | Module 0 below, then wire your coding agent from [`telemetry/`](telemetry/README.md) |
| **Yellow** | Partly set up (some check fails) | Follow the fix it prints; a helper gives you 5 minutes, then you move to the Codespace |
| **Red** | Nothing installed, a locked-down laptop, or you gave up | Use the **Codespace** (link on your seat card): browser only, everything preinstalled, the app running on open |

Codespace link (also on the seat card):
[codespaces.new/focused-dot-io/o11ydays-london-app/tree/checkpoint-0](https://codespaces.new/focused-dot-io/o11ydays-london-app/tree/checkpoint-0).

The Codespace needs a personal GitHub account with free Codespaces hours and a browser that can
reach github.com. **First thing after it opens: raise your Codespace idle timeout** (GitHub
Settings → Codespaces → Default idle timeout, up to 240 minutes) so it survives the 3:00 break.
The default is 30 minutes, which is exactly the length of the break.

## On the day: Module 0, your first trace

Your seat card has your seat number `N` and the workshop ingest key `K`.

1. **Configure** (writes `.env`; the key is never printed):

   ```bash
   npm run setup -- --seat N --key K
   ```

2. **Start the app**, either way:

   ```bash
   npm run dev          # three Node processes on your machine (the Codespace uses this)
   docker compose up    # or: the same three services in containers
   ```

   In the Codespace the app is already running; `npm run setup` restarts it with your `.env`.

3. **Send one request** and note the trace ID it prints:

   ```bash
   npm run first-trace
   ```

4. **Find it.** Open the workshop environment at `https://ui.honeycomb.io` (US; if your URL shows
   `ui.eu1`, you are in the EU region and will see nothing), choose dataset **`roast-judge-<seat>`** (your
   seat number, e.g. `roast-judge-17`), and search for the trace ID. The waterfall shows a root span
   for `POST /judge` with child spans under it.

That is the green sticky note. After the closing demo, start the background traffic and leave it
running all afternoon:

```bash
npm run load
```

(The Codespace starts the load generator for you.)

## Commands

| Command | What it does |
|---|---|
| `npm run setup -- --seat N --key K` | Write `.env` from `.env.example` with your seat and key; restarts `npm run dev` if it is running |
| `npm run dev` | Run all three services locally (app, pub-guide, model-replay), restart any that crash; reads `.env` |
| `docker compose up` | The same three services in Docker, with the repo bind-mounted and `node --watch`, so saving a file restarts the service |
| `npm start` | Run only the app (port 3000); you start pub-guide and model-replay yourself |
| `npm run first-trace` | Send one corpus roast to the app; print its trace ID, your dataset name and, if `HONEYCOMB_TEAM_SLUG` / `HONEYCOMB_ENV_SLUG` are set, a direct link |
| `npm run load` | Background load generator: one run every 4 s (`LOAD_INTERVAL_MS`), about 30% through all three turns, always on the replay model; survives app restarts. Ctrl-C to stop |
| `npm run prompt` | Show the current prompt version |
| `npm run prompt v1` / `npm run prompt v2` | Switch the judge's system prompt at runtime, no restart (Module 3's flip and rollback) |
| `npm run check-spans` | "Is Module 2 done?" One request against an in-memory exporter, checked against the Module 2 span set. Prints `PASS` or what is missing |
| `npm run verify` | "Is this checkpoint healthy as shipped?" Checks the expectation set named in `CHECKPOINT`; `npm run verify -- <set>` checks another set |
| `npm run catchup -- N` | Jump to checkpoint `N` (`0 1 2 2-cut 3 4`), parking your changes first |
| `npm test` | The project's own test suite (maintainers; some tests expect the finished `main`) |

`check-spans` and `verify` need no key and no network; nothing they do reaches Honeycomb.

## Architecture

```
  you / npm run load ──HTTP──▶ roast-judge :3000 ──── POST /v1/responses ───▶ model-replay :4200
                               (express, the agent,                         (fake OpenAI, no telemetry)
                                3 tools, SQLite)  ──── GET /pubs/:slug ────▶ pub-guide :4100
                                     │                                       (express, shared dataset)
                                     └──────── OTLP/HTTP ──▶ api.honeycomb.io
```

| Process | Port | Role | Honeycomb dataset |
|---|---|---|---|
| `roast-judge` | 3000 | Routes, the agent loop, the three tools, the admin endpoint | `roast-judge-<seat>` |
| `pub-guide` | 4100 | `GET /pubs/:slug`: price band and specialities for the fictional pubs | `pub-guide` (one shared dataset; filter on `seat`) |
| `model-replay` | 4200 | OpenAI-compatible `POST /v1/responses` with realistic latency, tokens and tool calls | none (kept out of traces) |

The agent uses the OpenAI Responses API through the official `openai` client, so
`@opentelemetry/instrumentation-openai` produces the `chat gpt-4.1-mini` spans. The three tools are
one of each `gen_ai.tool.type`: `score_component` (`function`, in-process), `lookup_pub`
(`extension`, an HTTP call to pub-guide) and `compare_to_benchmarks` (`datastore`, a SQLite query
with its own CLIENT span).

**Model modes.**

- **Replay (default).** Deterministic: the same roast always produces the same trace shape. Every
  25th call fails with an HTTP 500 (`REPLAY_FAIL_EVERY`, `0` turns it off), so there are errors to
  find. Chat spans carry `roastjudge.model.replay=true`.
- **Live (opt in).** Set `ROASTJUDGE_MODEL=live` and `OPENAI_API_KEY` in `.env`. The provider must
  implement `/v1/responses` (OpenAI does; other OpenAI-compatible providers vary). A request with the
  header `x-roastjudge-model: replay` always uses replay; the load generator always sends it, so it
  never spends your tokens.

**Conversations.** `POST /judge {text}` starts one and returns a `conversation_id`;
`POST /judge/<id>/appeal {text}` re-scores the disputed component; `POST /judge/<id>/final {}` gives
a binding ruling, `upheld` or `overturned`. Every response carries `trace_id` (also in the
`x-trace-id` header).

**Forcing failures.** `?fail=model` makes the replay model return a 500 for that request (the chat
span gets `error.type`, the app answers 502); `?fail=tool` makes `lookup_pub` ask pub-guide for a pub
that always errors (the tool span fails, the verdict still comes back).

**Prompt switch.** `GET /admin/prompt` returns `{"version":"v1"}`; `POST /admin/prompt
{"version":"v2"}` switches. `npm run prompt v1|v2` wraps both.

## Checkpoints and catch-up

Each module starts from a branch: `checkpoint-0`, `checkpoint-1`, `checkpoint-2` (and
`checkpoint-2-cut`), `checkpoint-3`, `checkpoint-4`. `main` is the finished reference. Behind, or
starting a new module clean?

```bash
npm run catchup -- 2
```

It fetches, parks any uncommitted work on a branch called `my-work-<timestamp>` (nothing is lost),
and checks out `checkpoint-2` fresh. Your `.env` and coding-agent settings are gitignored and stay
put. Then restart `npm run dev` (Docker reloads on its own). What each checkpoint contains, and how
`verify` and `check-spans` behave on each, is in [docs/checkpoints.md](docs/checkpoints.md).

## Environment variables

`npm run setup` writes `.env` from [`.env.example`](.env.example); edit it for anything else.
`npm run dev` and `docker compose` both read it.

| Variable | Default | What it does |
|---|---|---|
| `SEAT` | `0` | Your seat; sets `service.name=roast-judge-<seat>` and the `seat` resource attribute |
| `HONEYCOMB_API_KEY` | (empty) | Workshop ingest key. Unset means spans print to the console instead, with a loud warning |
| `HONEYCOMB_ENDPOINT` | `https://api.honeycomb.io` | OTLP endpoint; the app appends `/v1/traces` |
| `ROASTJUDGE_EXPORTER` | `otlp` | `otlp` (Honeycomb), `console` (stdout) or `memory` (tests) |
| `OTEL_SERVICE_NAME` | `roast-judge-<seat>` | Override the service name |
| `REPLAY_URL` | `http://localhost:4200/v1` | The replay model's base URL |
| `PUB_GUIDE_URL` | `http://localhost:4100` | The pub-guide service |
| `ROASTJUDGE_MODEL` | `replay` | `live` to use a real model (with `OPENAI_API_KEY`) |
| `OPENAI_API_KEY` | (unset) | Only used when `ROASTJUDGE_MODEL=live` |
| `LOAD_INTERVAL_MS` | `4000` | Pause between load-generator runs |
| `REPLAY_FAIL_EVERY` | `25` | Replay fails every Nth call; `0` turns it off |
| `HONEYCOMB_TEAM_SLUG`, `HONEYCOMB_ENV_SLUG` | (unset) | Let `first-trace` print a direct link to your trace |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | `false` | `true` puts prompts and completions on the chat spans (Module 4 track a) |
| `ROASTJUDGE_URL` | `http://localhost:3000` | Where `first-trace`, `load` and `prompt` send requests |

## Where things are

- [`telemetry/`](telemetry/README.md): wire Claude Code, Codex or Gemini CLI to send to the workshop
  environment (Act 1), plus the derived columns that normalise them.
- [`tasks/act1.md`](tasks/act1.md): the scripted coding-agent task for Act 1.
- [`tracks/`](tracks/): Module 4's self-serve cards,
  [a: content capture](tracks/a-content-capture.md),
  [b: cost and SLO](tracks/b-cost-and-slo.md),
  [c: Agent Timeline](tracks/c-agent-timeline.md).
- [`docs/old-names.md`](docs/old-names.md): legacy GenAI attribute names you will meet in the wild.
- [`docs/checkpoints.md`](docs/checkpoints.md): the checkpoint branches, `verify` and `check-spans`.

## For the facilitator

- **Default branch.** For the workshop window, set the GitHub repo's **default branch** to
  `checkpoint-0` (Settings → General → Default branch), so fresh clones and new Codespaces land on
  Module 0's start. Set it back to `main` afterwards. (The devcontainer also moves a clean `main` to
  `checkpoint-0` on creation.)
- **Codespaces prebuilds.** Enable them for `checkpoint-0` (Settings → Codespaces →
  Set up prebuild), so a red-lane Codespace opens in under a minute. Prebuilds are a repo setting,
  not a file in this repo.
- **Seat 0, the fallback dataset.** Run your own app as seat 0 (`npm run setup -- --seat 0 --key K`,
  then `npm run dev` and `npm run load`) all afternoon on your machine. `roast-judge-0` is the Module 3
  hunt for anyone whose app died over the break.
- **The flip.** At ~2:50 run `npm run prompt v2` on seat 0 at the same moment as the room; roll back
  with `npm run prompt v1` in Module 3 part 2.
- **Regenerating checkpoints** after changing `src/agent.js` or `src/telemetry.js`: see the
  maintainers section of [docs/checkpoints.md](docs/checkpoints.md).
