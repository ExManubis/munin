# How munin fits together

munin is one app for you and your agents: one frontend and several backend services. munin's own agents each have a role: some are coders, some assistants, some just fun to talk to. Coders work on projects in the tracker alongside any MCP client (Claude Code, Codex, a local model). The goal is for munin to live on a server on your tailnet, with the agents working there too, and for you to check in from your laptop or phone.

## The pieces

```
https://munin.<tailnet>.ts.net
│  edge: tailscale serve. HTTPS, knows who you are, routes by path
│
├─ /              web            the frontend, static files, served by the tracker
├─ /api, /mcp     tracker        127.0.0.1:7777
└─ /runtime/api   agent runtime  127.0.0.1:7779

agent runtime ──MCP──▶ tracker ◀──MCP── Claude Code, Codex, any MCP client
```

| Piece | What it does | Built with | Status |
|---|---|---|---|
| **web** | The one frontend for all of munin: a topbar with AGENTS and TRACKER, each with its own sidebar | Plain JS modules, no build step | Built; the Agents part uses the runtime when it answers, and hides when it doesn't (`munin demo` and `?mock` use a mock) |
| **tracker** | Projects, issues, comments, history, questions for you, agent tokens. An API for the frontend, MCP for agents | Python, FastAPI, SQLAlchemy, SQLite | Built; see `tracker.md` |
| **agent runtime** | munin's own agents: their conversations, roles, models, routines and memory; keeps them working and survives restarts | Node, pi-durable and pi-ai, its own SQLite | A first version; `runtime-api.md` says what it does and what's next |
| **edge** | One HTTPS address on the tailnet; says who you are; sends each path to its service | `tailscale serve` | Built: `deploy/install.sh` sets it up; see `server.md` |

## Rules

1. **The tracker stays agent-agnostic.** It doesn't know the runtime exists. munin's own agents use the same MCP tools and the same kind of token as Claude Code or Codex. When the runtime needs something from the tracker, that becomes an MCP feature every agent can use, never a private path between the two.
2. **Services don't call each other.** Agents calling the tracker over MCP is the only exception. The frontend joins services together, acting for you.
3. **Each service owns its data** in its own database. They share no tables.
4. **One frontend.** Every screen lives in `web/`. Services provide APIs, not pages. When a service isn't running, the frontend hides its parts and the rest still works.
5. **Only the edge faces the network.** Services listen on 127.0.0.1.

## Who owns what

| | Tracker | Agent runtime |
|---|---|---|
| Projects, issues, comments, history | ✓ | |
| Questions about issues, and your answers | ✓ | links its own to them |
| Agent names and tokens | ✓ issues them | keeps its own agents' tokens |
| Agents' roles, briefs, models, abilities, ask-first rules | | ✓ |
| Conversations: messages, runs, questions, approvals | | ✓ |
| Routines and memory | | ✓ |
| Where each project's code is, and agents' worktrees | | ✓ |
| Provider keys, tokens used, cost | | ✓ |

## How the frontend joins services

- **The topbar's parts are the services.** AGENTS is the runtime's part and TRACKER the tracker's; each part has its own sidebar. Settings, behind your square, holds both services' settings.
- **An agent's name links the two.** An agent in the runtime is the agent of the same name in the tracker. Its face is drawn in its colour everywhere, the tracker's screens included.
- **A question about an issue lives in the tracker.** The runtime ties its agent's question to the tracker's copy (`trackerQuestion`), so the question shows in both the conversation and the tracker inbox, and answering it in either answers both. The waiting count lists it once.
- **Adding an agent:** the frontend creates the agent in the runtime, then, for one with the Tracker ability, gets it a token from the tracker and hands that to the runtime. The tracker only ever hears from the runtime's agents over MCP, each with its own token. Deleting the agent, or turning the ability off, revokes the token.
- **Finding services:** each service answers on a known path: `/api/me` for the tracker, and `/runtime/api/me` for the runtime. The frontend looks for the runtime at its own address (behind the edge) and on port 7779 of the same host (on a laptop, where the runtime lets in pages from 127.0.0.1). When it doesn't answer, the Agents part hides and munin is the tracker plus outside agents: Settings keeps GitHub, outside agents and notifications, and setup, which is about munin's own agents, isn't offered. The frontend keeps looking, after 10 seconds and then less often, down to once a minute, and the Agents part appears when the runtime does. `munin demo` (the tracker says `demo` in `/api/me`) and `?mock` in the address use the mock instead, so the screens can be shown and worked on without a runtime.
- **Live updates:** each service has its own event stream, and the frontend listens to every one that's present. Events are numbered: a client that reconnects with `Last-Event-ID` gets what it missed, or a `reset` (reload everything) when it missed too much.

## The edge

`tailscale serve` is the only way in from the network (`server.md`). From its source (`ipn/ipnlocal/serve.go`):

- **Paths:** it strips the mount path and joins the rest onto the target's path, so `--set-path /runtime/api http://127.0.0.1:7779/runtime/api` passes `/runtime/api/me` on unchanged. Only `/runtime/api` goes to the runtime: the frontend's own files under `/runtime/` come from the tracker, with the rest of the frontend.
- **Host:** it keeps the browser's, munin's public name, so both services accept that name (`MUNIN_PUBLIC_URL`), MCP's own Host check included.
- **Who:** it removes any `Tailscale-User-*` headers the caller sent and sets them from Tailscale's own record of who's calling, so requests to munin's public name can be checked against `MUNIN_USERS`. Tagged devices and funnel traffic carry no identity, and are turned away. `/mcp` needs an agent token instead.

## Who's who

- **You.** There's no login. On a laptop, both services listen on 127.0.0.1 and refuse other host names. On the server, `tailscale serve` provides two things:
  - **HTTPS with a real certificate on the ts.net name.** Browsers only allow notifications and installing the app over HTTPS, and a tailnet IP over plain HTTP doesn't count.
  - **Who you are,** in `Tailscale-User-Login`. Both services let in only the logins in `MUNIN_USERS` through it, and refuse to start with a public address and nobody listed.
- **Agents** each have their own token from the tracker. Revoking one stops just that agent.
- **Agents must not be able to act as you.** The tracker and the runtime treat every request that reaches their web API as you, and an agent's shell on the same machine, as the same user, could reach that API, read munin's databases (the runtime's holds every agent's tracker token) and read the runtime's keys. No check inside munin's code can stop a program running as munin's own user, so the boundary is the operating system, as Hermes Agent's security policy says too. Two layers:
  - **Always:** agents' shells don't inherit the runtime's environment. They get a short list of harmless variables and the ones you name (`MUNIN_AGENT_ENV`), so keys stay out of casual reach. That isn't containment: the runtime's files are still readable.
  - **On a server:** `MUNIN_AGENT_SANDBOX=docker` gives each coder a container, and pi-env's `RemoteExecutionEnv` runs all its tools there, files and shell alike. It sees its own folder, with its own clones of the projects, not munin's clones, other agents' folders, the databases or the keys. A firewall container in front of it blocks the server itself and the tailnet, since Docker Desktop lets containers reach the Mac's 127.0.0.1 and any machine can reach its own tailnet address, where `tailscale serve` would let a coder in as the machine's owner. Its tracker calls still go out from the runtime with its own token, so it never needs the tracker's address.

## Where it runs

- **On your laptop:** `munin serve` in `tracker/` serves the API, MCP and the frontend, so one command runs munin.
- **On the server:** each service is its own systemd unit or container, restarted when it fails, with `tailscale serve` in front.
  - **Agents** run on the same server, each in a container of its own (`MUNIN_AGENT_SANDBOX=docker`), with a git worktree per issue.
  - **Tailscale ACLs** limit what the server can reach on the tailnet, because agents run shell commands.

## The agent runtime

The first version is in `runtime/`. It serves the API the frontend's mock (`web/runtime/mock.js`) settled, so the screens didn't change when it arrived. `runtime-api.md` lists the API, what this version does, and what comes next.

The runtime is built on [pi-durable](https://github.com/earendil-works/pi) and pi-ai:

- **Models:** pi-ai gives it OpenRouter, Vercel AI Gateway, Cloudflare AI Gateway, any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio) and the big providers directly.
- **Surviving restarts:** pi-durable commits every model turn and tool call to SQLite before showing it, so a crash or redeploy picks up where it stopped.
- **Long runs:** it can steer an agent mid-run, compacts long conversations, and counts tokens and cost per conversation.

How it works:

- **You decide what it keeps alive,** in the frontend, for example "MUN: two agents on model X".
- **The workflow runs in code.** For each issue it takes, the runtime starts a conversation. The model does the work and submits it for review, instead of driving the whole workflow from the prompt. Cheaper models handle that far more reliably.
- **Your answers reach a running agent as a steer,** so it doesn't have to poll.
- **Claude Code can stay an agent kind:** `claude -p` on your subscription, as `munin run` does today.

Ideas taken from the Claudewitz daemon:

- events are numbered, and a client that reconnects gets what it missed;
- questions wait in one place, and the first answer wins;
- push notifications go out when something is waiting and nobody is looking;
- a restart resumes work rather than losing it.

pi-durable is experimental, and its API changes between releases. Pin exact versions and keep it behind a thin layer of our own.

## Order of work

1. **Restructure into `tracker/` and `web/`.** Done.
2. **Design the whole frontend, and build a dummy version on fake data.** Done: the design is page "Agents v1" (`design/`), and the dummy is in `web/`, on the mock runtime. It includes the parts for services that don't exist yet.
   - The frontend reaches each service through one module.
   - The dummy swaps those modules for mocks that keep fake data in the browser and simulate agents at work.
   - Every mock function is something a backend has to provide. Once a screen is settled, its mock functions are the spec for the real endpoints.
3. **Put munin on a server:** systemd units, `tailscale serve`, Tailscale identity, and agents kept from acting as you. Done: `deploy/`, and `server.md`. Both services' live updates are numbered, and a client that reconnects gets what it missed.
4. **Build the agent runtime** against the API the dummy frontend settled (`runtime-api.md`). Started:
   - the tracker's three additions for it are done: questions with options, a question's id back from `add_comment`, and an event feed over MCP;
   - the runtime's first version runs agents on pi-durable with OpenRouter, Ollama or a stand-in model, with questions, ask-first approvals, coding tools and memory, and the frontend uses it when it's running;
   - coders and reviewers work in the tracker over MCP with their own tokens, and their questions about issues show in both places;
   - routines run on a schedule, or when the tracker's event feed shows a match, so agents start work by themselves;
   - each coder gets a git worktree per issue, on a branch named after it, from the runtime's clone of the project;
   - next: apps and the web as tools, and a budget that pauses.
5. **Then:** live agent output, and maybe the Claudewitz iPhone app as a client. Approvals, push notifications and cost per issue (counted by the runtime, which knows what its agents are on) are done: each service pushes its own things with keys of its own, and the frontend subscribes a device to both.

## Open questions

- **The tracker's feed, read or pushed:** the runtime reads the tracker's `events` feed every half minute for agents with tracker routines, with each agent's own token. That's simple and keeps the tracker unaware of the runtime; whether the tracker should push instead, once there are many agents, is still open.
- **Costs:** budgets per project or per agent, and what happens at the limit.
- **The command line:** one `munin` command for every service, or one per service. Today `munin` is the tracker's.
