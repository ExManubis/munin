# How munin fits together

munin is one app for you and your agents: one frontend and several backend services. munin's own agents each have a role: some are coders, some assistants, some just fun to talk to. Coders work on projects in the tracker alongside any MCP client (Claude Code, Codex, a local model). The goal is for munin to live on a server on your tailnet, with the agents working there too, and for you to check in from your laptop or phone.

## The pieces

```
https://munin.<tailnet>.ts.net
│  edge: tailscale serve. HTTPS, knows who you are, routes by path
│
├─ /              web            the frontend, static files
├─ /api, /mcp     tracker        127.0.0.1:7777
└─ /runtime       agent runtime  127.0.0.1:7779

agent runtime ──MCP──▶ tracker ◀──MCP── Claude Code, Codex, any MCP client
```

| Piece | What it does | Built with | Status |
|---|---|---|---|
| **web** | The one frontend for all of munin: a topbar with AGENTS and TRACKER, each with its own sidebar | Plain JS modules, no build step | Built; the Agents part uses the runtime when it answers, and a mock when it doesn't |
| **tracker** | Projects, issues, comments, history, questions for you, agent tokens. An API for the frontend, MCP for agents | Python, FastAPI, SQLAlchemy, SQLite | Built; see `tracker.md` |
| **agent runtime** | munin's own agents: their conversations, roles, models, routines and memory; keeps them working and survives restarts | Node, pi-durable and pi-ai, its own SQLite | A first version; `runtime-api.md` says what it does and what's next |
| **edge** | One HTTPS address on the tailnet; says who you are; sends each path to its service | `tailscale serve` | Planned; today everything is on 127.0.0.1 |

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
| Provider keys, tokens used, cost | | ✓ |

## How the frontend joins services

- **The topbar's parts are the services.** AGENTS is the runtime's part and TRACKER the tracker's; each part has its own sidebar. Settings, behind your square, holds both services' settings.
- **An agent's name links the two.** An agent in the runtime is the agent of the same name in the tracker. Its face is drawn in its colour everywhere, the tracker's screens included.
- **A question about an issue lives in the tracker.** The runtime ties its agent's question to the tracker's copy (`trackerQuestion`), so the question shows in both the conversation and the tracker inbox, and answering it in either answers both. The waiting count lists it once.
- **Adding an agent:** the frontend creates the agent in the tracker and gets its token, then creates it in the runtime with that token. The tracker only ever hears from the runtime's agents over MCP. (Not yet: today the runtime's agents don't use the tracker.)
- **Finding services:** each service answers on a known path: `/api/me` for the tracker, and `/runtime/api/me` for the runtime. The frontend looks for the runtime at its own address (behind the edge) and on port 7779 of the same host (on a laptop, where the runtime lets in pages from 127.0.0.1). When it doesn't answer, the Agents part runs on the mock for now; later it hides, and munin is the tracker plus outside agents.
- **Live updates:** each service has its own event stream, and the frontend listens to every one that's present.

## Who's who

- **You.** Today there's no login: the tracker listens on 127.0.0.1 and refuses other host names. On the server, `tailscale serve` provides two things:
  - **HTTPS with a real certificate on the ts.net name.** Browsers only allow notifications and installing the app over HTTPS, and a tailnet IP over plain HTTP doesn't count.
  - **Who you are,** in headers such as `Tailscale-User-Login`.
- **Agents** each have their own token from the tracker. Revoking one stops just that agent.
- **Agents must not be able to act as you.** Today the tracker treats every request that reaches its API as you. That's fine on a laptop. On a server, agents run shell commands on the same machine and could reach 127.0.0.1 too. There are two ways out, to settle before agents run on the server:
  - run agents in containers, so the server's 127.0.0.1 isn't theirs, and give them only the MCP address;
  - or have the API check who's calling.

## Where it runs

- **On your laptop:** `munin serve` in `tracker/` serves the API, MCP and the frontend, so one command runs munin.
- **On the server:** each service is its own systemd unit or container, restarted when it fails, with `tailscale serve` in front.
  - **Agents** run on the same server, each in its own folder (a git worktree) or container, as a separate user.
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
3. **Put munin on a server:** systemd units, `tailscale serve`, Tailscale identity, and agents kept from acting as you. Live updates get replay on reconnect.
4. **Build the agent runtime** against the API the dummy frontend settled (`runtime-api.md`). Started:
   - the tracker's three additions for it are done: questions with options, a question's id back from `add_comment`, and an event feed over MCP;
   - the runtime's first version runs agents on pi-durable with OpenRouter, Ollama or a stand-in model, with questions, ask-first approvals, coding tools and memory, and the frontend uses it when it's running;
   - next: the tracker for coders, routines that run, apps and the web as tools, and a budget that pauses.
5. **Then:** live agent output, cost per issue, approvals, push notifications, and maybe the Claudewitz iPhone app as a client.

## Open questions

- **Routing at the edge:** whether `tailscale serve` passes path prefixes through unchanged, or a small proxy such as Caddy sits behind it.
- **Your answers and running agents:** the runtime can read the tracker's `events` feed to hear answers at once instead of polling `wait_for_work`; how often, and whether the tracker should push instead, is still open.
- **Costs:** budgets per project or per agent, and what happens at the limit.
- **The command line:** one `munin` command for every service, or one per service. Today `munin` is the tracker's.
