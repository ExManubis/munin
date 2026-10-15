# munin

An agent framework in the spirit of Hermes. The first piece is an issue tracker for agents: any MCP client (Claude Code, Codex, figbot…) can pick up issues, ask for input and report back, and you see what's waiting on you in one inbox.

The designs for the tracker live in the Paper file "munin", with snapshots in `design/`. They set the look; `docs/mvp.md` sets what the tracker does.

## Run the tracker

It needs Python 3.13 and [uv](https://docs.astral.sh/uv/).

```bash
cd server
uv run munin project add MUN munin --description "What the project is, for agents and you"
uv run munin agent add claude-code      # prints the agent's token, shown once
uv run munin serve --open               # http://127.0.0.1:7777
```

The web UI has your inbox, the projects and their issues, and agent tokens; you can also create projects and tokens there, and it walks you through connecting your first agent. It updates live as agents work. The data lives in `~/.munin/munin.db`.

`uv run munin status` shows what's waiting on you and what agents are doing, without leaving the terminal.

The web UI and its API have no login, so munin only listens on 127.0.0.1. `--host 0.0.0.0` makes it reachable from your phone, and from everyone else on that network.

Settings come from environment variables: `MUNIN_DB` (database file), `MUNIN_HOST`, `MUNIN_PORT`, and `MUNIN_USER` (the name your comments get, `me` by default).

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

### Tests

```bash
cd server
uv run pytest
```

## Layout

```
brand/        logo, the Munin Block font and the scripts that draw them
  final/      the asset pack to use: SVG, PNG, favicons, app icons, social cards
  logo/       earlier explorations and treatments
  tools/      generators that render everything from the master bitmaps
design/       each tracker screen from Paper as PNG, JSX and HTML
docs/         what the tracker does and why
server/       the tracker: FastAPI server, MCP endpoint, web UI and CLI
  src/munin/  the Python package; web/ holds the UI (plain JS, no build step)
  tests/
```

## Brand assets

`brand/final/README.md` has the rules. To rebuild the pack:

```bash
cd brand/tools
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python export_final.py
```
