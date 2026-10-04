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

**The Codespace is the default.** Everything runs in a GitHub Codespace in your browser: the app,
the replay model, Node and the three coding-agent CLIs (Claude Code, Codex, Antigravity) are prebaked, the app is running when it
opens, and nothing is installed on your laptop. You need a **GitHub account** (sign-in is required
to launch a Codespace; the free hours every personal account has cover the afternoon) and a browser
that can reach github.com. The link is on your seat card and here:
[codespaces.new/focused-dot-io/o11ydays-london-app/tree/checkpoint-0](https://codespaces.new/focused-dot-io/o11ydays-london-app/tree/checkpoint-0).

VS Code asks **"Do you trust the authors of the files in this folder?"** the first time: click
**Trust Folder & Continue**. Until you do, the terminal cannot open and the app may not start; a
few seconds after the click the terminal prints `app: started` or `app: running`, and port 3000 is up.

**Next, raise your Codespace idle timeout** (GitHub Settings → Codespaces →
Default idle timeout, up to 240 minutes) so it survives the 3:00 break. The default is 30 minutes,
which is exactly the length of the break.

### Running it on your own laptop (optional, macOS and Linux)

Opt in only if the verify script printed PASS before the day. You need git, Node 22.13 or newer
(24 is fine), Docker Compose or Podman, and your coding agent already installed and signed in.
Windows means the Codespace, unless you already run Docker under WSL and are happy to support
yourself.

```bash
git clone https://github.com/focused-dot-io/o11ydays-london-app.git
cd o11ydays-london-app
./verify-setup.sh
```

`verify-setup.sh` checks, stopping at the first problem and printing the fix:

- Node is 22.13 or newer;
- a container engine is running: Docker (`docker compose`) or Podman (`podman compose`);
- `npm ci` installs the dependencies;
- `docker compose build` builds the app image (this pulls the pinned `node:22.22.0-alpine` base);
- your network can open TLS to `api.honeycomb.io:443` (no key needed; it sends nothing).

The last line is **`PASS`** when you are ready. It never switches branches; if you are on `main`
it tells you to run `npm run catchup -- 0`.

PASS proves the laptop is ready. It is not a first trace: that happens in Module 0.

### Which lane are you in?

| Lane | You are | On the day |
|---|---|---|
| **Codespace** (default) | Anyone with a GitHub account | Open the link above; the app is already running. Module 0 below from step 1 |
| **Local** (opt-in) | `./verify-setup.sh` printed PASS before the day | Module 0 below, then wire your coding agent from [`telemetry/`](telemetry/README.md) |
| **Stuck in either** | A check fails, a locked-down laptop, no Docker | A helper gives you 5 minutes, then a local seat moves to the Codespace. No second attempt at local |

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

4. **Find it.** Click the `Open:` link that `first-trace` printed; it goes straight to your trace in
   the workshop environment (`https://ui.honeycomb.io/focusedlabs-4f/environments/o11ydays-london`,
   dataset **`roast-judge-<seat>`**). If the link doesn't work, open that environment, choose your
   dataset (e.g. `roast-judge-17`) and search for the trace ID. If your URL shows `ui.eu1`, you are in
   the EU region and will see nothing: the workshop team is in the US region. The waterfall shows a
   root span for `POST /judge` with child spans under it.

**No OpenAI or Codex account needed.** The app talks to the local replay model on port 4200 (the
`POST` to `localhost:4200` in your trace). It uses the official `openai` client pointed at that fake,
which is why the `chat gpt-4.1-mini` spans you add in Module 2 name an OpenAI model. Nothing goes to
OpenAI. Codex only shows up here as one of the coding agents you can use; it has nothing to do with
the app's model. See [Model modes](#architecture) if you want to point it at a real model.

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
| `npm run first-trace` | Send one corpus roast to the app; print its trace ID, your dataset name and a direct link to the trace in Honeycomb |
| `npm run load` | Background load generator: one run every 4 s (`LOAD_INTERVAL_MS`), about 30% through all three turns, always on the replay model; survives app restarts. Ctrl-C to stop |
| `npm run prompt` | Show the current prompt version |
| `npm run prompt v1` / `npm run prompt v2` | Switch the judge's system prompt at runtime, no restart (Module 3's flip and rollback). Held in memory: any app restart goes back to `v1` |
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
`checkpoint-2-cut`), `checkpoint-3`, `checkpoint-4`. `main` is the finished reference. **Each
checkpoint is also the solution to the exercise before it:** exercises are time-boxed (about 20
minutes for the long ones), then the front names the next branch and everyone catches up, so the
whole room starts the next module in the same place. Switching to the branch is the plan, not a
failure. Behind, or starting a new module clean?

```bash
npm run catchup -- 2
```

It fetches, parks any uncommitted work on a branch called `my-work-<timestamp>` (nothing is lost),
and checks out `checkpoint-2` fresh. Your `.env` and coding-agent settings are gitignored and stay
put. If `npm run dev` is running (the Codespace starts it for you; locally, in another terminal),
catchup restarts it on the new code and prints `app: restarted on checkpoint-N`; if it is not
running, catchup prints a reminder to start it. Docker reloads on its own. Any restart puts the
judge back on prompt `v1`, so re-run `npm run prompt v2` if you were mid-flip. What each checkpoint contains, and how `verify` and
`check-spans` behave on each, is in [docs/checkpoints.md](docs/checkpoints.md).

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
| `HONEYCOMB_TEAM_SLUG`, `HONEYCOMB_ENV_SLUG` | `focusedlabs-4f`, `o11ydays-london` | The shared workshop team and environment; `first-trace` builds its link from them. Not secrets, same for every seat |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | `false` | `true` puts prompts and completions on the chat spans (Module 4 track a) |
| `ROASTJUDGE_URL` | `http://localhost:3000` | Where `first-trace`, `load` and `prompt` send requests |

## Where things are

- [`telemetry/`](telemetry/README.md): wire Claude Code, Codex or Antigravity CLI to send to the workshop
  environment (Act 1), plus the calculated fields that normalise them.
- [`tasks/act1.md`](tasks/act1.md): the scripted coding-agent task for Act 1.
- [`tasks/module3.md`](tasks/module3.md): Module 3's hunt for the bad prompt, the queries and BubbleUp.
- [`tracks/`](tracks/): Module 4's self-serve cards,
  [a: content capture](tracks/a-content-capture.md),
  [b: cost and SLO](tracks/b-cost-and-slo.md),
  [c: Agent Timeline](tracks/c-agent-timeline.md).
- [`docs/old-names.md`](docs/old-names.md): legacy GenAI attribute names you will meet in the wild.
- [`docs/checkpoints.md`](docs/checkpoints.md): the checkpoint branches, `verify` and `check-spans`.

## End of the day

The last instruction, on screen and on the seat card:

1. Run `/logout` in your coding agent (Claude Code, Codex and Antigravity CLI all have it). The agent's
   sign-in is not tied to the Codespace, so without this a signed-in agent sits in a stopped Codespace.
2. Stop your Codespace (github.com/codespaces → … → Stop), or `Ctrl-C` the local `npm run dev`.

The workshop ingest keys are revoked after the day.

## For the facilitator

- **Default branch.** For the workshop window, set the GitHub repo's **default branch** to
  `checkpoint-0` (Settings → General → Default branch), so fresh clones and new Codespaces land on
  Module 0's start. Set it back to `main` afterwards. (The devcontainer also moves a clean `main` to
  `checkpoint-0` on creation.)
- **Codespaces prebuilds.** Set up for `checkpoint-0` (Settings → Codespaces → Prebuild
  configuration: every push, Europe West only, 2 versions kept). The prebuild bakes in `npm ci` and
  the three CLIs because they run from `onCreateCommand` (prebuilds never run `postCreateCommand`),
  so a Codespace opens in seconds. Two gotchas: a prebuild run takes ~30 minutes and a push to
  `checkpoint-0` (e.g. `build-checkpoints.sh`) starts one, during which new Codespaces say
  "Prebuild in progress" and build from scratch, so freeze `checkpoint-0` the night before and check
  the run is green (Settings → Codespaces → See output); and the prebuild is only for Europe West,
  so an attendee whose GitHub picks another region gets a cold build.
- **Seat 0, the fallback dataset.** Run your own app as seat 0 (`npm run setup -- --seat 0 --key K`,
  then `npm run dev` and `npm run load`) all afternoon on your machine. `roast-judge-0` is the Module 3
  hunt for anyone whose app died over the break.
- **The flip.** At ~2:50 run `npm run prompt v2` on seat 0 at the same moment as the room; roll back
  with `npm run prompt v1` in Module 3 part 2.
- **Regenerating checkpoints** after changing `src/agent.js` or `src/telemetry.js`: see the
  maintainers section of [docs/checkpoints.md](docs/checkpoints.md).
