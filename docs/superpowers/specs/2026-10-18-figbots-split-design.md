# Spin figbots out of munin

Date: 2026-10-18

## Why

munin started as an issue tracker for agentic development and grew a second product inside it: figbots, munin's own agents (the `runtime/` service, its views, meetings, setup, models, Google, apps). The two have become unrelated features. munin should be a focused issue tracker that any agent uses (Claude Code, Codex, GLM, pi, figbots, anything that speaks MCP), and figbots should be a product of its own that uses munin through MCP like any other agent.

The architecture already points this way: the runtime has its own process, database and API, and talks to the tracker only over MCP (`docs/architecture.md`: "The tracker stays agent-agnostic. It doesn't know the runtime exists"). What still ties them together is the shared browser app in `web/`, which reads the runtime directly, the shared deploy, and `munin demo`.

## Goals

1. A new repo, `figbots`, holding the runtime and its own web app, at `~/Developer/figbots`, pushed to a new GitHub repo `ExManubis/figbots`.
2. munin with no trace of the runtime: no figbot views, no meetings, no runtime calls from the browser, no runtime in deploy or demo.
3. Cost per issue survives, agent-agnostic: any agent reports what it spent over MCP, and munin shows it whoever the agent is.
4. The user's running deploy (on their Mac, `~/munin`, launchd jobs `munin.tracker` and `munin.runtime`) moves over without losing figbots' data: agents, conversations, memory, keys, Google link.

## Non-goals

- Live step logs on issues. munin loses the live-run view and nothing replaces it for now (decided by the user).
- Avatars. Replacing the pixel faces with dithered agent logos (Claude, Codex, pi, …) is a separate, later project. Until then munin keeps today's avatar code, minus its runtime lookups.
- New figbot features. figbots moves as it is.
- A shared package between the two repos. Code both need is copied; they're free to drift.

## Anti-goals

- munin knowing about figbots in any form: no special-casing names, no "own agents", no runtime URL, no figbot copy in docs beyond, at most, a mention as one example of an agent.
- Losing the user's figbots (their data in `~/.munin`) in the move.
- A window where the user's Mac runs neither figbots nor a working munin.

## Part 1: the figbots repo

**Making it.** Create `~/Developer/figbots` from munin's history, keeping the history of `runtime/` (e.g. `git filter-repo`), with `runtime/`'s contents at the repo root or under a sensible layout of the builder's choosing. Figbot web files and design files are copied in as a fresh commit (their history is interleaved with munin's and isn't worth untangling). Create `ExManubis/figbots` on GitHub, **public like munin** (my call; the user said create and push), and push `main`.

**What moves** (from munin, then deleted there):
- `runtime/` (src, test, tools, package files).
- Web: `web/runtime/*` (client, mock, roles, costs, live, tracker-link), `web/views/agents.js`, `conversation.js`, `profile.js`, `new-agent.js`, `meetings.js`, `web/setup.js`, `web/intro.js`, `web/model-picker.js`, `web/diff.js`, `web/push/runtime/sw.js`.
- The runtime-only Settings sections: models and providers, Google, apps, code repos and sandbox, setup, dummy data.
- Docs and design: `docs/runtime-api.md`, the runtime parts of `docs/architecture.md` and `docs/server.md`, the README's runtime section, `design/08`–`15`, `design/brief-agents.md`, `design/figbot/`.
- Deploy: `deploy/munin-runtime.service`, `deploy/mac/munin.runtime.plist`, the runtime halves of `install.sh` / `install-mac.sh`.

**Its own web app.** figbots gets a standalone browser app made of the views above plus copies of what they need from munin's base: `ui.js`, `style.css` (or the part of it they use), `markdown.js`, `cards.js`, `dialogs.js`, `palette.js`, `store.js`, `notify.js`, `push/worker.js`, `figbot.js`, `claude-mark.js` if used, brand fonts and logo. It needs its own shell (an `app.js` with its routes: agents, conversation, profile, new agent, meetings, setup, settings, and its own waiting/inbox for runtime questions). The runtime serves it as static files itself; today it serves only `/runtime/api`. Branding, the shell's look and how much of munin's style it keeps are the builder's call, staying close to what the views look like today.

**Naming.** Rename `MUNIN_*` runtime variables to `FIGBOTS_*` (`FIGBOTS_DB`, `FIGBOTS_HOST`, `FIGBOTS_PORT`, `FIGBOTS_AGENTS_DIR`, …). The tracker's address becomes `FIGBOTS_MUNIN_MCP` (or similar). The data home moves from `~/.munin` to `~/.figbots`. Its API can drop the `/runtime` prefix. Port stays 7779 unless that's awkward. Exact names are the builder's call.

**Connecting to munin: MCP only, no special status.** figbots is an outside agent to munin like any other, and munin adds nothing for it (decided by the user). Concretely:
- Today munin's browser mints and revokes a token per figbot (`web/runtime/tracker-link.js`). That goes. Instead, turning on a figbot's Tracker ability (in new agent, profile, setup) asks for munin's MCP URL and a token the user created in munin's Settings, "Connect an outside agent", one per figbot, so each figbot stays its own agent in munin (my call: simplest thing that keeps identities apart). Existing figbots keep the tokens they already have through the data copy.
- figbots never calls munin's REST API, only MCP with the figbot's token.
- Questions a figbot asks on an issue are answered in munin. The figbot picks up the reply itself over MCP (its routines already poll `events`); `syncTrackerAnswers` in munin's browser goes away. figbots' conversation view shows such a question with a link to the issue in munin instead of an answer box.
- The figbot profile's track record (`api.agentRecord`) and project pickers (`store.projects`) either come from MCP (`list_issues`, `list_projects`) through the runtime or are dropped; builder's call, keep it light.
- figbots must keep working with no munin connected (talk, meetings), as the runtime does today without a tracker.

**Tests.** Runtime tests that import from `web/` (`soul.test.js`, `memory.test.js`, `soul-history.test.js`, `face.test.js`, `tools/lineup.mjs`) point at figbots' own copies. All 21 test files pass in the new repo.

**Deploy.** figbots gets its own `deploy/`: systemd unit, launchd plist (label `figbots.runtime` or similar), `install.sh` / `install-mac.sh`, an `environment.example`, and its own `tailscale serve` entry. munin and figbots each own their tailscale path; figbots could be its own port (`--https=<port>`) or a path, builder's call, as long as installing one doesn't clobber the other. Its own README.

**Cost reporting.** figbots already computes cost per issue from its model responses (`runtime.js` `issueCosts`). After each run on an issue it reports that run's cost to munin through the new `report_usage` tool (part 2). It keeps its own record too, for its own screens if it wants. My call: no backfill of past costs into munin; past issues show no cost (backfilling a running total risks double counting and isn't worth the code).

## Part 2: munin without the runtime, plus usage over MCP

**Remove.** Everything in the "what moves" list, and the coupling in shared files:
- `web/app.js`: runtime imports, Meetings tab and routes, `hasAgents()` home route, runtime fetches and subscription, setup flow, figbot keyboard shortcuts.
- `web/store.js`: `meetings`, `runtimeAgents`.
- `web/ui.js`: avatar lookups in `store.runtimeAgents` (`ownNames`, runtime colour/state). Agent avatars become what outside agents get today: white pixel face, or Claude's spark for `claude*` names, state from the tracker (working, asks, idle).
- `web/views/issue.js`: the live-run view (`liveWork`) goes, no replacement.
- `web/views/issue.js`, `web/views/project.js`: costs come from the tracker's API instead of `withCosts`.
- `web/waiting.js`: tracker inbox only; `syncTrackerAnswers` goes.
- `web/notify.js`: one push subscription, the tracker's.
- `web/views/settings.js`: keeps GitHub, outside agents and connect, notifications; loses the runtime sections and the "runtime not running" state.
- `web/palette.js`, `web/dialogs.js`: figbot actions.
- Tracker: the `demo` flag in `config.py` and `/api/me`; `munin demo` still seeds a believable tracker (projects, issues, comments, some agents with plausible outside-agent names like `claude-code`, `codex`) with no runtime and no figbot-named cast.
- `style.css`: selectors only figbot views use.
- Docs and README describe munin as an agent-agnostic issue tracker; `docs/architecture.md` shrinks to the tracker (or folds into `tracker.md`).

**Add: `report_usage`.** A new MCP tool any agent can call:

```
report_usage(issue, cost_usd, tokens_in?, tokens_out?, model?)
```

- Adds to the issue's totals; one call per report, additive. Stored per report (agent, issue, cost, tokens, model, time) so totals can be broken down by agent, as the runtime's breakdown is today (`{ cost, tokens, agents }`).
- The agent is the token's agent. The issue can be any issue in a project the agent can see; no requirement that it's assigned to them.
- Rejects negative or absurd values (builder decides the bound).
- The REST API exposes the totals on issues (and per project), and the issue and project pages show cost where they show it today, with the same `dollars()` formatting.
- The tool's description and the server instructions tell agents when to call it: when they finish a stretch of work on an issue, if their client lets them know what it spent. `munin run` doesn't try to compute Claude Code's cost (my call; can come later).
- Tests in `tracker/tests` for the tool and the API totals.

## Moving the user's Mac over

The deploy runs from `~/munin` (a checkout of `main`) with launchd jobs `munin.tracker` and `munin.runtime`, and data in `~/.munin`: `munin.db*` (tracker), `push.json` (**both services use this file today**; the split ends that), and the runtime's `runtime.sqlite*`, `keys.json`, `google.json`, `agents/`, `secrets`. `environment` holds both services' settings.

Order, so nothing goes dark:
1. Ship figbots with an install script that, on a Mac that has `~/.munin/runtime.sqlite`, **copies** (not moves) the runtime's data into `~/.figbots`: `runtime.sqlite*` (with the runtime stopped, so the WAL is checkpointed), `keys.json`, `google.json`, `agents/`, `secrets`, and the runtime's settings from `environment` under the new names. figbots gets fresh push keys (browsers re-subscribe once); `push.json` stays with munin.
2. Install figbots from `~/figbots`: unload `munin.runtime`, load `figbots.runtime`, set up its tailscale entry, connect it to munin with a token.
3. Only then does the munin release (staging → main, which the user merges) reach `~/munin`; its install script stops loading `munin.runtime`, removes its plist and the `/runtime/api` serve path if present.
4. `~/.munin`'s copies of runtime data are left in place for the user to delete once happy.

The builder doesn't run steps 2–3 on the user's machine unprompted; they hand the user the commands, or run them when the user says so.

## How the work is delivered

- munin's work is tracked in munin, project MUN: one or more issues for this, worked on `claude/…` branches off `staging`, PRs into `staging`. The user merges `staging` into `main` for releases.
- figbots: initial history pushed to `ExManubis/figbots` `main`; follow-up changes there can go straight to `main` until the repo has its own workflow (my call).
- munin's removal PR shouldn't land in `staging` before figbots runs on its own, so a release can't strand the user without figbots.

## Left to the builder

Repo layout inside figbots; variable, label and path names; port vs path for figbots' tailscale entry; how much CSS to copy; how `report_usage` stores rows and its bounds; whether `docs/architecture.md` survives in munin; how to split the munin side into issues/PRs.
