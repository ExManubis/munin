# munin

An agent framework in the spirit of Hermes: you and your agents work on projects together, with agents running on your own server and you checking in from any device on your tailnet.

munin is one app with one frontend and several backend services. The first service is the tracker, an issue tracker for agents: any MCP client (Claude Code, Codex, figbot…) can pick up issues, ask for input and report back, and you see what's waiting on you in one inbox. The second is the agent runtime, for munin's own agents: coders, assistants, or just someone fun to talk to, each on a model from OpenRouter or another gateway. A first version runs on pi-durable (`runtime/`); when it isn't running, the Agents screens fall back to a mock with a sample cast (`web/runtime/mock.js`). `docs/architecture.md` has the plan and `docs/runtime-api.md` what the runtime serves.

![munin's inbox: an agent's question waiting for an answer, and what agents have been doing lately](docs/screenshot.png)

The designs live in the Paper file "munin", with snapshots in `design/`. They set the look; `docs/tracker.md` describes what the tracker does.

## Run the tracker

It needs Python 3.13 and [uv](https://docs.astral.sh/uv/). To look around first, `cd tracker && uv run munin demo` opens munin with a sample project in a throwaway database. The Agents tab's sample agents work with that project: forge asks about one of its issues, and answering in either place answers both. Their conversations live in your browser; Settings starts them over.

```bash
cd tracker
uv run munin project add MUN munin --description "What the project is, for agents and you"
uv run munin agent add claude-code      # prints the agent's token, shown once
uv run munin serve --open               # http://127.0.0.1:7777
```

The tracker serves the frontend from `web/` too, so this is all you need locally. The web UI has your inbox, the projects and their issues, and agent tokens; you can also create projects and tokens there, and it walks you through connecting your first agent. It updates live as agents work. The data lives in `~/.munin/munin.db`.

`uv run munin status` shows what's waiting on you and what agents are doing, without leaving the terminal.

The web UI and its API have no login, so munin only listens on 127.0.0.1. `--host 0.0.0.0` makes it reachable from your phone, and from everyone else on that network.

Settings come from environment variables: `MUNIN_DB` (database file), `MUNIN_HOST`, `MUNIN_PORT`, `MUNIN_USER` (the name your comments get, `me` by default) and `MUNIN_WEB` (the frontend to serve, `web/` in this repository by default; empty serves only the API and MCP).

### Connect an agent

Each agent gets its own token, so you can revoke one without touching the others. MCP clients connect to `http://127.0.0.1:7777/mcp` and send the token as `Authorization: Bearer <token>`.

Claude Code:

```bash
claude mcp add --transport http munin http://127.0.0.1:7777/mcp --header "Authorization: Bearer mun_…"
```

Codex, in `~/.codex/config.toml`, with the token in the `MUNIN_TOKEN` environment variable:

```toml
[mcp_servers.munin]
url = "http://127.0.0.1:7777/mcp"
bearer_token_env_var = "MUNIN_TOKEN"
```

Other clients (Pi, local models through an MCP-capable harness) need the same URL and header in their own config format.

Then put it to work. In Claude Code, munin adds two slash commands:

```
/mcp__munin__continue MUN      pick up the project and keep going
/mcp__munin__work_on MUN-12    do one issue
```

Any other agent: "You have access to munin, an issue tracker. Continue the MUN project. Keep going until there is nothing left for you to do." The server tells agents the workflow when they connect, and each project's description is their brief, including how work gets delivered (which branch, who merges). Headless works too: `claude -p "/mcp__munin__continue MUN"`.

### Let munin start the agents

```bash
cd your-repo
uv run --project path/to/munin/tracker munin run MUN --agents 2 -- --model sonnet
```

`munin run` gives each agent its own token (`claude-1`, `claude-2`, …), starts them on the project with Claude Code, and prints what they do as they do it: who took what, what they said, what they sent back from review. Arguments after `--` go to every agent; use them for the model and for what the agents may do. Headless Claude Code only uses tools it's allowed: munin's own are allowed already, and you add the rest, for example `-- --allowedTools Read Edit Write "Bash(git:*)" "Bash(npm test:*)"` or `--permission-mode acceptEdits`. For another agent CLI, pass a template with `--cmd`, using `{prompt}`, `{project}`, `{mcp_config}`, `{url}`, `{token}` and `{name}`; `MUNIN_TOKEN` and `MUNIN_URL` are set too, so Codex works with the config above: `--cmd 'codex exec {prompt}'`. munin has to be running (`munin serve`).

### Tests

```bash
cd tracker
uv run pytest
```

## Run the agent runtime

It needs Node 22.19 or later. Next to `munin serve`:

```bash
cd runtime
npm install
npm start                               # http://127.0.0.1:7779/runtime/api
```

Reload munin and the Agents tab uses it instead of the mock: the frontend looks for the runtime on port 7779 of the same host, or at its own address behind the edge. Make an agent with N and talk to it.

Without a provider, agents run on a stand-in that answers without a model, so you can try everything but the thinking. Give the runtime `OPENROUTER_API_KEY` in its environment for OpenRouter's models, or `MUNIN_OLLAMA_URL` (like `http://127.0.0.1:11434`) for an Ollama server's, then pick a model on the agent's profile.

Coders get a folder of their own under `~/.munin/agents/<name>`, with a shell and file tools. They ask before pushing to git or deleting files; their profile has the rest of the ask-first rules.

Coders and reviewers also work in the tracker, as any MCP client does: munin gets each one a token of its own when you make it, and you pick its projects. Start one with "Work on it" next to a project in its conversation, or just tell it what to do. Its questions about an issue show in the conversation and in the tracker's inbox, and answering in either place answers both. Agents and their conversations live in `~/.munin/runtime.sqlite` and survive a restart.

Settings come from environment variables: `MUNIN_RUNTIME_DB`, `MUNIN_RUNTIME_HOST`, `MUNIN_RUNTIME_PORT`, `MUNIN_AGENTS_DIR`, `MUNIN_OLLAMA_URL` and `MUNIN_USER` (your name, as agents call you). Like the tracker, it has no login: it listens on 127.0.0.1 and only lets in pages from this machine.

`npm test` runs its tests.

## Layout

```
brand/        logo, the Munin Block font and the scripts that draw them
  final/      the asset pack to use: SVG, PNG, favicons, app icons, social cards
  logo/       earlier explorations and treatments
  tools/      generators that render everything from the master bitmaps
design/       each screen from Paper as PNG, JSX and HTML
docs/         how munin fits together (architecture.md), what the tracker does (tracker.md)
              and the runtime's API (runtime-api.md)
runtime/      the agent runtime: munin's own agents on pi-durable, and its HTTP API
  src/
  test/
tracker/      the tracker: FastAPI server, API, MCP endpoint and CLI
  src/munin/  the Python package
  tests/
web/          the frontend for all of munin (plain JS, no build step)
  runtime/    the agent runtime as the frontend sees it: the HTTP client, and the mock
  views/      one module per screen
```

## Brand assets

`brand/final/README.md` has the rules. To rebuild the pack:

```bash
cd brand/tools
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python export_final.py
```
