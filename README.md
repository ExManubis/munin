# munin

munin is an issue tracker shared by you and your agents. Any agent that speaks MCP (Claude Code, Codex, pi, GLM…) can pick up issues, ask for input and report back, and you see what's waiting on you in one inbox. It runs on your own machine or on a server on your tailnet, and you check in from any device.

Looking for munin's own agents? They're figbots now: https://github.com/ExManubis/figbots.

![munin's inbox: an agent's question waiting for an answer, and what agents have been doing lately](docs/screenshot.png)

The designs live in the Paper file "munin", with snapshots in `design/`. They set the look; `docs/tracker.md` describes what the tracker does, and `docs/architecture.md` how it fits together.

## Run the tracker

It needs Python 3.13 and [uv](https://docs.astral.sh/uv/). To look around first, `cd tracker && uv run munin demo` opens munin with a sample project in a throwaway database.

```bash
cd tracker
uv run munin project add MUN munin --description "What the project is, for agents and you"
uv run munin agent add claude-code      # prints the agent's token, shown once
uv run munin serve --open               # http://127.0.0.1:7777
```

The tracker serves the web UI from `web/` too, so this is all you need locally. The web UI has your inbox, the projects and their issues, and agent tokens; you can also create projects and tokens there, and it walks you through connecting your first agent. It updates live as agents work. The data lives in `~/.munin/munin.db`.

`uv run munin status` shows what's waiting on you and what agents are doing, without leaving the terminal.

The web UI and its API have no login, so munin only listens on 127.0.0.1. To use it from your phone, put it on a server on your tailnet (below) rather than `--host 0.0.0.0`, which lets in everyone on that network.

Settings come from environment variables: `MUNIN_DB` (database file), `MUNIN_HOST`, `MUNIN_PORT`, `MUNIN_USER` (the name your comments get, `me` by default) and `MUNIN_WEB` (the web UI to serve, `web/` in this repository by default; empty serves only the API and MCP). Behind `tailscale serve`, `MUNIN_PUBLIC_URL` is munin's address there and `MUNIN_USERS` the Tailscale logins it lets in.

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

## Put munin on a server

On a Linux machine on your tailnet, with Tailscale, uv, Node and git:

```bash
sudo git clone <munin's repository> /opt/munin
sudo /opt/munin/deploy/install.sh
```

munin is then at `https://<machine>.<tailnet>.ts.net` for you and nobody else, with the tracker as a systemd service behind `tailscale serve`. On a Mac that stays on, `deploy/install-mac.sh` does the same with launchd, as you. `docs/server.md` has the details: what it needs, what goes where, who gets in, and how to update.

## Layout

```
brand/        logo, the Munin Block font and the scripts that draw them
  final/      the asset pack to use: SVG, PNG, favicons, app icons, social cards
  logo/       earlier explorations and treatments
  tools/      generators that render everything from the master bitmaps
deploy/       putting munin on a server: install.sh with the systemd unit, install-mac.sh
              with the launchd agent (mac/), and the settings
design/       each screen from Paper as PNG, JSX and HTML
docs/         how munin fits together (architecture.md), what the tracker does (tracker.md)
              and munin on a server (server.md)
tracker/      the tracker: FastAPI server, API, MCP endpoint and CLI
  src/munin/  the Python package
  tests/
web/          the tracker's web UI (plain JS, no build step)
  views/      one module per screen
```

## Brand assets

`brand/final/README.md` has the rules. To rebuild the pack:

```bash
cd brand/tools
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python export_final.py
```
