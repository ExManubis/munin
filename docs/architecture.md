# How munin fits together

munin is an issue tracker shared by you and your agents. It's one service: you and any MCP client (Claude Code, Codex, pi, GLM, a local model) work on the same projects through it. It runs on your laptop, or on a server on your tailnet, and you check in from your laptop or phone.

## The pieces

```
https://munin.<tailnet>.ts.net
│  edge: tailscale serve. HTTPS, knows who you are
│
└─ /              tracker        127.0.0.1:7777
                  ├─ /api        for the web UI
                  ├─ /mcp        for agents, with their tokens
                  └─ /           the web UI, static files from web/

Claude Code, Codex, any MCP client ──MCP──▶ tracker
```

| Piece | What it does | Built with |
|---|---|---|
| **tracker** | Projects, issues, comments, history, questions for you, agent tokens. An API for the web UI, MCP for agents, and the web UI itself | Python, FastAPI, SQLAlchemy, SQLite; see `tracker.md` |
| **web** | The tracker's UI: inbox, projects, issues, settings | Plain JS modules, no build step |
| **edge** | One HTTPS address on the tailnet; says who you are | `tailscale serve`; `deploy/install.sh` sets it up, see `server.md` |

## Rules

1. **The tracker stays agent-agnostic.** It doesn't know which agents use it or how they run. Every agent uses the same MCP tools and the same kind of token. When an agent needs something from the tracker, that becomes an MCP feature every agent can use, never a private path for one of them. Cost per issue is an example: agents report it with `report_usage`.
2. **The tracker owns its data** in one SQLite database.
3. **Only the edge faces the network.** The tracker listens on 127.0.0.1.

Agents live outside munin: they use the tracker over MCP like any other client.

## The edge

`tailscale serve` is the only way in from the network (`server.md`). From its source (`ipn/ipnlocal/serve.go`):

- **Paths:** it strips the mount path and joins the rest onto the target's path. munin mounts `/`.
- **Host:** it keeps the browser's, munin's public name, so the tracker accepts that name (`MUNIN_PUBLIC_URL`), MCP's own Host check included.
- **Who:** it removes any `Tailscale-User-*` headers the caller sent and sets them from Tailscale's own record of who's calling, so requests to munin's public name can be checked against `MUNIN_USERS`. Tagged devices and funnel traffic carry no identity, and are turned away. `/mcp` needs an agent token instead.

## Who's who

- **You.** There's no login. On a laptop, the tracker listens on 127.0.0.1 and refuses other host names. On the server, `tailscale serve` provides two things:
  - **HTTPS with a real certificate on the ts.net name.** Browsers only allow notifications and installing the app over HTTPS, and a tailnet IP over plain HTTP doesn't count.
  - **Who you are,** in `Tailscale-User-Login`. The tracker lets in only the logins in `MUNIN_USERS` through it, and refuses to start with a public address and nobody listed.
- **Agents** each have their own token from the tracker. Revoking one stops just that agent.
- **Agents must not be able to act as you.** The tracker treats every request that reaches its web API as you, so an agent's shell on the same machine, as the same user, could use that API and read munin's database. No check inside munin's code can stop a program running as munin's own user, so keep agents on another user, or in a container. The tracker's `/mcp` is the way in for them.

## Where it runs

- **On your laptop:** `munin serve` in `tracker/` serves the API, MCP and the web UI, so one command runs munin.
- **On the server:** one systemd unit (`munin-tracker`), or a launchd agent on a Mac, restarted when it fails, with `tailscale serve` in front. Agents can run anywhere that reaches `/mcp`.

## Decided

- **One person:** munin is for one person for now, so comments and answers aren't attributed to people beyond `MUNIN_USER`. Who's looking, behind the edge, only shows in your square.
- **Polling, not webhooks, for GitHub:** munin sits on your tailnet where GitHub can't reach it.
