# Spin figbots out of munin: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** figbots (today's `runtime/` plus its web views) becomes its own repo, `ExManubis/figbots`, talking to munin over MCP only; munin loses every trace of it and gains an agent-agnostic `report_usage` MCP tool so cost per issue keeps working.

**Architecture:** Three tracks in a fixed order, so munin never breaks: (A) an additive munin change (`report_usage`, cost on issues from the tracker's own data) that ships to staging first and changes nothing visible; (B) the figbots repo, built from a history-preserving split of `runtime/` plus a copy of `web/` cut down to figbots' parts, installed on the user's Mac beside munin; (C) only once figbots runs on its own, munin's removal of the runtime from its web app, demo, docs and deploy.

**Tech Stack:** munin tracker: Python 3.13, uv, FastAPI, SQLAlchemy/SQLite, `mcp` SDK, pytest. figbots runtime: Node ≥22.19, ES modules, `node --test`. Web: plain JS modules, no build step.

**Spec:** `docs/superpowers/specs/2026-10-18-figbots-split-design.md`

## Global Constraints

- **munin must keep working at every step** (user's words: "its very important that munin keeps working"). Every munin PR leaves `uv run pytest` green and every tracker screen loading with no console errors.
- munin's removal PR (Task 9, 10) is **not merged into `staging` until Task 8 is done** (figbots running on the user's Mac on its own).
- munin work: one MUN issue per munin task, branch `claude/<topic>` off `origin/staging`, PR `--base staging`, merged into staging by the agent once checked; never merge into `main` (the user does releases).
- figbots: `~/Developer/figbots`, GitHub `ExManubis/figbots`, **public**, pushed to `main`; later figbots changes go straight to `main`.
- figbots talks to munin **over MCP only** with each figbot's own token. No munin REST calls from figbots, nothing figbots-specific in munin.
- No live step log in munin; the live-run view goes with no replacement.
- Avatars in munin stay as they are (white pixel face; Claude's spark for `claude*` names) minus runtime lookups. The logo work is a later project.
- Never read `.env` files, `~/.munin/environment` or `~/.munin/secrets` content into the conversation; scripts may copy them.
- Don't run anything on the user's Mac deploy (`~/munin`, launchd, tailscale serve) without the user saying so (Task 8).

## Review Focus

1. **The user's real data in munin.** munin (after Tasks 1 and 9) started on a *copy* of `~/.munin/munin.db` must create the new `usage` table and show every screen. Pinned in Task 1 (old-schema test) and Task 9 (smoke run on a copy).
2. **A browser that used munin with figbots before.** `localStorage` still holds `munin:section-path` = `/agents/heimdal` or `/meetings/…` and `munin:runtime-url`, and a service worker from `push/runtime/sw.js` is registered. munin must land on the inbox, not an error, and unregister the stale worker. Pinned in Task 9.
3. **Bad `report_usage` calls:** unknown issue, negative or absurd cost, negative tokens, a revoked token. Clear errors, nothing stored. Pinned in Task 1.
4. **figbots with munin unreachable or older than `report_usage`.** A run must never fail because reporting cost failed; unreported cost waits for the next flush. Pinned in Task 6.
5. **figbots' data after the move.** Agents' stored folders (`agent.folder`, `agent.work.folder`) are absolute paths under `~/.munin/agents`; after copying to `~/.figbots` they must point at the new place. Pinned in Task 3 (rehome test) and Task 7 (migration script dry run).

---

## Track A: munin, additive

### Task 1: `report_usage` and cost on issues (munin)

MUN issue: "Cost per issue from any agent: report_usage over MCP". Branch `claude/mun-<n>-report-usage` off `origin/staging`.

**Files:**
- Modify: `tracker/src/munin/models.py` (new `Usage` model after `PullRequest`)
- Create: `tracker/src/munin/usage.py` (service functions)
- Modify: `tracker/src/munin/mcp_server.py` (tool after `add_comment`; mention in server instructions)
- Modify: `tracker/src/munin/api.py` (`CostOut`; `cost` on `IssueOut`; filled in `list_issues`, `get_issue`)
- Test: `tracker/tests/test_usage.py`, `tracker/tests/test_mcp.py` (tool list), `tracker/tests/test_db.py` (old schema)

**Interfaces:**
- Produces model `Usage` (`__tablename__ = "usage"`): `id`, `issue_id` (FK issues.id), `agent: str(100)`, `cost_usd: float`, `tokens_in: int|None`, `tokens_out: int|None`, `model: str(200)|None`, `created_at`.
- Produces `usage.report(s, actor: Actor, ref: str, cost_usd: float, tokens_in: int|None=None, tokens_out: int|None=None, model: str|None=None) -> Usage`. Raises `NotFound` for unknown issue, `Invalid` when `cost_usd < 0 or cost_usd > 1000`, or tokens `< 0 or > 100_000_000`, or `actor.kind != "agent"`.
- Produces `usage.totals(s, issue_ids: list[int]) -> dict[int, dict]` → `{issue_id: {"cost": float, "tokens": int, "agents": {name: float}}}`, one grouped query, issues with no usage absent. `tokens` = sum of `tokens_in + tokens_out` (None as 0).
- Produces MCP tool `report_usage(issue: IssueRef, cost_usd: float, tokens_in: int|None, tokens_out: int|None, model: str|None) -> str`.
- Produces API: `IssueOut.cost: CostOut | None` with `CostOut{cost: float, tokens: int, agents: dict[str, float]}`, the same shape the web views read today (`issue.cost.cost`, `.tokens`, `.agents`). Set on `GET /api/issues` and `GET /api/issues/{ref}`; `None` elsewhere.

- [ ] **Step 1: Write failing tests in `tracker/tests/test_usage.py`**

```python
def test_reports_add_up_per_issue_and_agent(s):
    issue = svc.create_issue(s, HUMAN, "MUN", "Thing")  # after create_project fixture/helper like other tests
    usage.report(s, CLAUDE, issue.ref, 0.25, tokens_in=1000, tokens_out=200, model="claude-opus-5-5")
    usage.report(s, CLAUDE, issue.ref, 0.10)
    usage.report(s, CODEX, issue.ref, 0.05, tokens_in=10)
    assert usage.totals(s, [issue.id]) == {issue.id: {"cost": pytest.approx(0.40), "tokens": 1210,
                                                      "agents": {"claude-code": pytest.approx(0.35), "codex": pytest.approx(0.05)}}}

@pytest.mark.parametrize("cost,tokens", [(-0.01, None), (1000.01, None), (0.1, -1), (0.1, 100_000_001)])
def test_rejects_bad_reports(s, cost, tokens): ...  # raises Invalid, nothing stored

def test_unknown_issue(s): ...  # NotFound for "MUN-999"
def test_humans_dont_report(s): ...  # Invalid for HUMAN
def test_issue_api_shows_cost(client, ...):  # GET /api/issues/MUN-1 → cost == {"cost": 0.25, "tokens": 1200, "agents": {"claude-code": 0.25}}; GET /api/issues → same; issue without reports → cost is None
def test_report_usage_over_mcp(server):  # run(url, tokens["claude-code"], ("report_usage", {"issue": "MUN-1", "cost_usd": 0.5})) → not error, text contains "$0.50" and "MUN-1"; negative cost → is_error
```

In `test_mcp.py::test_tools_and_instructions` add `"report_usage"` to the expected names right after `"add_comment"`. In `test_db.py` add `test_old_database_gets_usage_table`: create a SQLite file with today's tables minus `usage` (e.g. `Base.metadata.create_all` then `DROP TABLE usage`), call `connect()`, assert `usage.report` works.

- [ ] **Step 2: Run them, expect failures**

Run: `cd tracker && uv run pytest tests/test_usage.py tests/test_mcp.py tests/test_db.py -q`
Expected: FAIL (`usage` module / tool missing).

- [ ] **Step 3: Implement** model, `usage.py`, tool, API fields as in Interfaces. Tool reply: `Recorded $0.50 on MUN-1 (now $0.90 in all).` Tool docstring: "Report what your model spent on an issue, if your client tells you. Each call adds to the issue's total; call it when you finish a stretch of work, not after every step." Add one sentence to the server instructions' step 4 ("When you're done…"): "If you know what you spent, report it with report_usage." Reports don't create `Event`s (agents shouldn't hear of them). `create_all` already adds the new table to old databases.

- [ ] **Step 4: Run the whole suite**

Run: `cd tracker && uv run pytest -q && uv run ruff check src tests` (ruff via `uvx ruff` if not in the env)
Expected: all pass.

- [ ] **Step 5: Smoke against a copy of the user's database**

Run: `cp ~/.munin/munin.db /tmp/munin-copy.db && cd tracker && MUNIN_DB=/tmp/munin-copy.db MUNIN_PORT=7790 uv run munin serve` (check `config.py` for the exact variable names), open `http://localhost:7790`, look at the inbox, a project and an issue.
Expected: screens load; `sqlite3 /tmp/munin-copy.db .tables` lists `usage`. Stop the server, delete the copy.

- [ ] **Step 6: Commit, PR to staging, merge, comment on the MUN issue, link the PR**

```bash
git commit -am "Cost per issue from any agent: report_usage over MCP"
gh pr create --base staging --fill
```

The web views still read costs from the runtime at this point; that changes in Task 9.

---

## Track B: the figbots repo

### Task 2: Make the repo, with runtime history

**Files:**
- Create: `~/Developer/figbots/` (from `git subtree split`), with `web/`, `design/`, `docs/runtime-api.md`, `brand/` copied in.
- Modify: `test/soul.test.js:14`, `test/memory.test.js:13`, `test/soul-history.test.js:14`, `test/face.test.js:12`, `tools/lineup.mjs:22` (imports `../../web/…` → `../web/…`).

**Interfaces:**
- Produces layout: repo root = today's `runtime/` contents (`src/`, `test/`, `tools/`, `package.json`, `package-lock.json`), plus `web/` (a full copy of munin's `web/` for now), `docs/`, `design/`, `brand/`, `deploy/` (added in Task 7).

- [ ] **Step 1: Split with history**

```bash
cd ~/Developer/munin && git subtree split --prefix=runtime -b figbots-history origin/staging
mkdir ~/Developer/figbots && cd ~/Developer/figbots && git init -b main && git pull ~/Developer/munin figbots-history
cd ~/Developer/munin && git branch -D figbots-history
```

Expected: `git log --oneline | wc -l` in figbots ≈ 45; `ls` shows `src test tools package.json`.

- [ ] **Step 2: Copy the rest in** from `~/Developer/munin` (at `origin/staging`): `web/` (all of it), `brand/`, `docs/runtime-api.md`, `design/08*`–`design/15*`, `design/brief-agents.md`, `design/figbot/`, `.gitignore` (add `node_modules/`). Fix the five test/tool imports.

- [ ] **Step 3: Tests pass in the new place**

Run: `npm ci && npm test` (or `node --test test/` if there's no `test` script; check `package.json`).
Expected: all 21 test files pass.

- [ ] **Step 4: Commit** `"figbots: munin's agent runtime, on its own"`.

### Task 3: figbots' own names and home, and moving agents' folders

**Files:**
- Modify: `src/config.js`, any `MUNIN_*` reads in `src/` (`grep -rn MUNIN_ src tools`), `package.json` (`"name": "figbots"`)
- Modify: `src/runtime.js` (rehome at start)
- Test: `test/config.test.js` (create or extend), `test/rehome.test.js`

**Interfaces:**
- Produces env names (old → new): `MUNIN_RUNTIME_DB`→`FIGBOTS_DB`, `MUNIN_RUNTIME_HOST`→`FIGBOTS_HOST`, `MUNIN_RUNTIME_PORT`→`FIGBOTS_PORT`, `MUNIN_AGENTS_DIR`→`FIGBOTS_AGENTS_DIR`, `MUNIN_REPOS_DIR`→`FIGBOTS_REPOS_DIR`, `MUNIN_OLLAMA_URL`→`FIGBOTS_OLLAMA_URL`, `MUNIN_AGENT_ENV`→`FIGBOTS_AGENT_ENV`, `MUNIN_AGENT_SANDBOX`→`FIGBOTS_AGENT_SANDBOX`, `MUNIN_AGENT_IMAGE`→`FIGBOTS_AGENT_IMAGE`, `MUNIN_AGENT_NETWORK`→`FIGBOTS_AGENT_NETWORK`, `MUNIN_TRACKER_MCP`→`FIGBOTS_MUNIN_MCP`, `MUNIN_PUBLIC_URL`→`FIGBOTS_PUBLIC_URL`, `MUNIN_USERS`→`FIGBOTS_USERS`, `MUNIN_USER`→`FIGBOTS_USER`. `OPENROUTER_API_KEY`, `GH_TOKEN` unchanged. Default home `~/.figbots` (was `~/.munin`). Port default stays 7779.
- Produces `rehome(agents, agentsDir) -> boolean` in `src/workspace.js` (or a small `src/rehome.js`): for each agent whose `folder` isn't under `agentsDir`, set `folder = join(agentsDir, basename(folder))` and rewrite `work.folder` with the same old→new prefix; returns whether anything changed. Called once at runtime start, saving agents if it returns true.

- [ ] **Step 1: Failing tests**: config reads each `FIGBOTS_*` name and defaults the DB to `join(homedir(), '.figbots', 'runtime.sqlite')`; rehome:

```js
test('rehome moves folders under the new agents dir', () => {
  const agents = [{ name: 'heimdal', folder: '/Users/x/.munin/agents/heimdal', work: { folder: '/Users/x/.munin/agents/heimdal/MUN-3' } },
                  { name: 'vera', folder: '/Users/x/.figbots/agents/vera', work: null }];
  assert.equal(rehome(agents, '/Users/x/.figbots/agents'), true);
  assert.equal(agents[0].folder, '/Users/x/.figbots/agents/heimdal');
  assert.equal(agents[0].work.folder, '/Users/x/.figbots/agents/heimdal/MUN-3');
  assert.equal(agents[1].folder, '/Users/x/.figbots/agents/vera');
  assert.equal(rehome(agents, '/Users/x/.figbots/agents'), false);
});
```

- [ ] **Step 2: Run, expect FAIL.** `node --test test/config.test.js test/rehome.test.js`
- [ ] **Step 3: Implement**; update user-facing strings in `src/` that say "munin's runtime"/"munin" about itself to "figbots" (strings about the tracker keep "munin").
- [ ] **Step 4: Full suite passes.** `npm test`
- [ ] **Step 5: Commit** `"figbots: its own settings names and home, ~/.figbots"`.

### Task 4: figbots serves its own app, API at `/api`

**Files:**
- Modify: `src/server.js` (route prefix `/runtime/api` → `/api`; static files from `../web` for every other GET; Google callback path `/api/google/callback`)
- Modify: `web/runtime/index.js` (no discovery: the runtime is the page's own origin; `?mock` still uses `mock.js`), `web/runtime/client.js` (base `/api`)
- Modify: `docs/runtime-api.md` (paths)
- Test: `test/server.test.js` (extend or create)

**Interfaces:**
- Produces: `GET /` → `web/index.html`; `GET /app.js` etc. → files from `web/` with correct `Content-Type` (`.js` `text/javascript`, `.css`, `.svg`, `.png`, `.ico`, `.webmanifest`, `.woff2`, `.html`); paths with `..` → 404; unknown file → 404. `GET /api/me` → today's `/runtime/api/me` body. The same Host/edge checks that guard the API guard static files.

- [ ] **Step 1: Failing tests:** start the server on port 0 in-process like existing server tests; assert `/` 200 `text/html`, `/app.js` 200 `text/javascript`, `/api/me` 200 with `kind: 'runtime'`, `/runtime/api/me` 404, `/../package.json` 404.
- [ ] **Step 2: Run, FAIL.** `node --test test/server.test.js`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Full suite passes.**
- [ ] **Step 5: Commit** `"figbots serves its own web app; API at /api"`.

### Task 5: figbots' web app without the tracker; munin over MCP only

**Files:**
- Delete: `web/views/inbox.js`, `web/views/project.js`, `web/views/issue.js`, `web/api.js`, `web/runtime/costs.js`, `web/runtime/live.js`, `web/push/tracker/`, `web/history.js`, `web/search.js` if only tracker views use them (check imports), `web/claude-mark.js` if unused afterwards.
- Modify: `web/app.js` (sections `agents`, `meetings`, `settings`; home `#/agents`; no tracker sidebar, `/api/stream` EventSource or `api.*`; keep runtime subscription), `web/store.js` (drop `projects`, `inbox`, `agents`, `snoozed`; keep runtime fields), `web/waiting.js` (runtime items only; drop `syncTrackerAnswers`), `web/notify.js` (runtime push only), `web/palette.js`, `web/dialogs.js` (no tracker actions/shortcuts), `web/ui.js` (`agentAvatar` from `store.runtimeAgents` only), `web/views/settings.js` (runtime sections only), `web/views/profile.js` (no track record), `web/views/conversation.js` (tracker questions: link, no answer box), `web/runtime/tracker-link.js`, `web/views/new-agent.js`, `web/setup.js` (token paste), `web/index.html`, `web/site.webmanifest`, title strings (`· figbots`)
- Modify: `src/server.js`, `src/tracker.js` (two routes below)
- Test: `test/tracker-routes.test.js`

**Interfaces:**
- Produces `POST /api/tracker/check` body `{url, token}` → `{ok: true, projects: [{key, name}]}` by calling munin's `list_projects` over MCP with that token, or `{ok: false, error}` (bad token, unreachable). Used when you connect a figbot.
- Produces `GET /api/tracker/projects` → `[{key, name}]` via any connected figbot's token (as `createTracker().connect()` already picks one), `[]` with none. Replaces `store.projects` in pickers (new agent, settings' code repos).
- Produces `GET /api/me` adds `muninMcp: settings.trackerMcp` (from `FIGBOTS_MUNIN_MCP`) to prefill the URL field.
- `connectToTracker(name, {url, token, projects})` in `tracker-link.js`: calls `/api/tracker/check`, then `runtime.updateAgent(name, { tracker: { url, token, projects } })`. `disconnectFromTracker(name)` only clears `tracker`; revoking the token is the user's job in munin. No import of `api.js` anywhere in `web/`.
- Connect UI (profile's Tracker ability, new agent, setup's tracker step): two fields, "munin's MCP address" (prefilled from `muninMcp`) and "Token", with a hint: "In munin: Settings → Connect an outside agent, named after this figbot." Then the project picker from `check`'s `projects`.
- Conversation: a figbot's question on a munin issue shows "Answer it in munin" linking to `<munin origin>/#/issues/<ID>`, origin = the figbot's tracker URL without `/mcp`.

- [ ] **Step 1: Failing route tests** with a fake MCP tracker (reuse whatever `test/tracker.test.js` uses to fake the tracker): `check` with a good token returns its projects; with a token the fake rejects returns `ok: false`; `projects` with no connected figbot returns `[]`.
- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Implement routes and `muninMcp`; tests pass.** `npm test`
- [ ] **Step 4: Cut the web app down** per Files. Check no dangling imports:

Run: `node -e "for (const f of require('child_process').execSync('git ls-files web/*.js web/**/*.js').toString().trim().split('\n')) for (const m of require('fs').readFileSync(f,'utf8').matchAll(/from '(\.[^']+)'/g)) { const p = require('path').resolve(require('path').dirname(f), m[1]); if (!require('fs').existsSync(p)) console.log(f, '->', m[1]); }"`
Expected: no output. And `grep -rn "api\.\(comment\|agents\|addAgent\|revokeAgent\|agentRecord\|issues\)\|/api/stream\|store\.projects\|store\.inbox" web` → nothing.

- [ ] **Step 5: Look at it.** `FIGBOTS_DB=:memory: FIGBOTS_PORT=7791 node src/main.js`, open `http://localhost:7791/?mock` and `http://localhost:7791/` (real, empty). Walk: setup, figbots list, new figbot, conversation, profile, meetings list/new/room, settings, palette (⌘K), the shortcuts sheet (`?`), phone width (390px). Use chrome-devtools: `list_console_messages` must show no errors.
- [ ] **Step 6: Commit** `"figbots' app on its own: munin over MCP only"`.

### Task 6: figbots reports cost to munin

**Files:**
- Modify: `src/runtime.js` (`countFor` ~line 606 also adds to a pending map; flush at the end of each run and in `onStatus` when an agent moves an issue on), `src/tracker.js` (`reportUsage`)
- Test: `test/usage-report.test.js`

**Interfaces:**
- Consumes munin's `report_usage(issue, cost_usd, tokens_in, tokens_out, model)` (Task 1).
- Produces `tracker.reportUsage(agent, issueId, { cost, tokensIn, tokensOut, model }) -> Promise<boolean>` (true when munin took it; false on any failure, never throws).
- Pending is per `(agent name, issue id)`, summed; cost rounded to 4 decimals with the existing `rounded()`; `model` is the agent's model id when one model did all of it, else omitted. Flushed entries are removed only after `true`; a zero-cost entry isn't sent. Pending lives in memory (lost on restart is acceptable).

- [ ] **Step 1: Failing tests** with the fake tracker: a run on MUN-1 that costs 0.012 + 0.003 → one `report_usage` call `{issue: 'MUN-1', cost_usd: 0.015, …}` at run end; fake tracker failing (or lacking the tool) → run still completes, the next successful flush sends the sum of both runs; an agent with no tracker token → no call, no error.
- [ ] **Step 2: Run, FAIL.** **Step 3: Implement.** **Step 4: `npm test` passes.**
- [ ] **Step 5: Commit** `"figbots report what they spend to munin"`.

### Task 7: figbots' deploy, moving the user's data, README, GitHub

**Files:**
- Create: `deploy/install-mac.sh`, `deploy/install.sh`, `deploy/mac/figbots.plist` (label `figbots.runtime`), `deploy/figbots.service`, `deploy/environment.example`, `deploy/mac/environment.example`, `deploy/move-from-munin.sh`, `README.md`
- Source material: munin's `deploy/install-mac.sh`, `deploy/install.sh`, `deploy/mac/munin.runtime.plist`, `deploy/munin-runtime.service`, `deploy/environment.example` (runtime halves only), README's "Run the agent runtime" section.

**Interfaces:**
- `install-mac.sh`: same checks and style as munin's (bash 3.2, `render`, `need`), runtime parts only: `npm ci --omit=dev`, `~/.figbots/{environment,secrets,logs}`, Docker image pull, the launchd job, waits for `http://127.0.0.1:$FIGBOTS_PORT/api/me`, then `tailscale serve --bg --https=8443 http://127.0.0.1:$PORT` (its own port, so it never touches munin's `/`), and verifies serve took it. `FIGBOTS_PUBLIC_URL=https://<host>:8443`. It never touches `munin.*` launchd jobs or munin's serve paths.
- `move-from-munin.sh` (Mac and Linux), run once, before the first `install-mac.sh`: refuses if `~/.figbots/runtime.sqlite` exists; `launchctl bootout gui/$UID/munin.runtime` (systemd: `systemctl stop munin-runtime`) so the database is still; **copies** `runtime.sqlite`, `-wal`, `-shm` (if present), `keys.json`, `google.json`, `agents/`, `repos/` (if present), `secrets` from `~/.munin` to `~/.figbots`; writes `~/.figbots/environment` from the runtime's `MUNIN_*` lines of `~/.munin/environment` renamed per Task 3 (`MUNIN_TRACKER_MCP` → `FIGBOTS_MUNIN_MCP`, paths under `~/.munin` → `~/.figbots`, `MUNIN_PUBLIC_URL` → `FIGBOTS_PUBLIC_URL` with `:8443`); runs `git worktree repair` in each repo under `~/.figbots/repos/*` and `~/.figbots/agents/*/*`; never copies `push.json` and never deletes anything in `~/.munin`. Prints what it copied. `--dry-run` prints the plan only.
- README: what figbots is, that it uses munin (or any MCP tracker) as an outside agent, run locally (`npm ci && node src/main.js`), deploy, connecting a figbot to munin (token per figbot), what figbots reports (`report_usage`).

- [ ] **Step 1: Dry-run the move on the real Mac (read-only)**: `deploy/move-from-munin.sh --dry-run`. Expected: lists the files above from `~/.munin`; writes nothing (check `ls ~/.figbots` → no such directory).
- [ ] **Step 2: Shell checks**: `bash -n deploy/*.sh && shellcheck deploy/*.sh` (shellcheck if installed).
- [ ] **Step 3: Commit** `"figbots: deploy, moving from munin, README"`.
- [ ] **Step 4: Publish**

```bash
cd ~/Developer/figbots && gh repo create ExManubis/figbots --public --source . --push --description "Agents with characters of their own, that work in munin over MCP"
```

Expected: `gh repo view ExManubis/figbots` shows `main` with the history.

---

## Track C: switching the user's Mac, then munin without the runtime

### Task 8: Move the user's Mac to figbots (with the user)

No code. Ask the user before running; give them the commands if they'd rather.

- [ ] **Step 1:** `git clone git@github.com:ExManubis/figbots.git ~/figbots && ~/figbots/deploy/move-from-munin.sh && ~/figbots/deploy/install-mac.sh`
- [ ] **Step 2: Check figbots:** `launchctl list | grep figbots.runtime` → running; `launchctl list | grep munin.runtime` → gone; `https://<host>:8443` shows heimdal (and any other figbots) with their conversations; a message to a figbot gets an answer.
- [ ] **Step 3: Check munin is untouched:** `https://<host>/` loads; inbox, projects, issues fine; `launchctl list | grep munin.tracker` running. munin's web app still has a Figbots tab looking for `/runtime/api`; it now finds nothing and hides the tab (today's no-runtime behaviour). That's expected until Task 9 ships.
- [ ] **Step 4: Connect figbots to munin**: existing figbots kept their tokens through the copy; in figbots, check a figbot with the Tracker ability lists munin's projects. Set `FIGBOTS_MUNIN_MCP=http://127.0.0.1:7777/mcp` if the move didn't.
- [ ] **Step 5:** Tell the user `~/.munin`'s old runtime files are theirs to delete once happy, and the old `munin.runtime` coder containers can be removed (`docker ps -a`).

### Task 9: munin's web app without the runtime

MUN issue: "Spin figbots out: munin's web app without the runtime". Branch `claude/mun-<n>-no-runtime` off `origin/staging` (after Task 1 is merged). Don't merge until Task 8 is done.

**Files:**
- Delete: `web/runtime/` (all), `web/views/agents.js`, `conversation.js`, `profile.js`, `new-agent.js`, `meetings.js`, `web/setup.js`, `web/intro.js`, `web/model-picker.js`, `web/diff.js`, `web/push/runtime/`, `runtime/` (whole dir), `docs/runtime-api.md`, `design/08*`–`design/15*`, `design/brief-agents.md`, `design/figbot/`
- Modify: `web/app.js` (one section, the tracker, plus settings; no section tabs or Figbots/Meetings tab bar items; home `#/inbox`; no `runtime.*`; drop the `figbot` import if only the tab bar used it; keyboard: drop G-then-A/F/M, N), `web/store.js` (drop `meetings`, `runtimeAgents`, `waiting`, `human`), `web/ui.js` (`avatar`/`agentState`/`agentAvatar` without `store.runtimeAgents`: white face or Claude spark, state from the tracker), `web/waiting.js` (tracker inbox only), `web/notify.js` (tracker subscription only; on start, unregister any service worker whose `scope` ends in `/push/runtime/`), `web/palette.js`, `web/dialogs.js` (no figbot actions/shortcuts), `web/views/settings.js` (GitHub, outside agents and connect, notifications), `web/views/issue.js` (no `liveWork`; cost from `issue.cost` returned by the API), `web/views/project.js` (cost from the API, drop `withCosts`), `web/push/worker.js` (comment), `web/style.css` (drop selectors only deleted views use)
- Move: `dollars()` from `web/runtime/costs.js` into `web/ui.js`

**Interfaces:**
- Consumes `IssueOut.cost` (Task 1), shape `{cost, tokens, agents}`.
- On start, `app.js` drops a remembered `munin:section-path` / `munin:last-*` that no route matches (e.g. `/agents/heimdal`, `/meetings/…`) and removes `localStorage['munin:runtime-url']`.

- [ ] **Step 1: Cut** per Files. `docs/` and README wait for Task 10.
- [ ] **Step 2: No dangling imports or runtime references**

Run the import check from Task 5 Step 4 in munin's `web/`, then `grep -rniE "runtime|figbots?\b|meeting" web --include=*.js | grep -v "figbot\.js\|figbot("`.
Expected: no missing imports; remaining hits are only the pixel-face renderer (`figbot.js`, used for every agent's avatar) and comments you've reworded.

- [ ] **Step 3: Tracker tests still pass.** `cd tracker && uv run pytest -q`
- [ ] **Step 4: Smoke on demo data and on a copy of the real database**, with chrome-devtools, at desktop and 390px width: `uv run munin demo --no-open --port 7792`, and `MUNIN_DB=/tmp/munin-copy.db MUNIN_PORT=7793 uv run munin serve` on a fresh `cp ~/.munin/munin.db`. Visit inbox (answer a question with an option), a project (list and board), an issue (cost shows after a `report_usage` from `tracker/tests/fake_agent.py` or an MCP call with a token), settings (create an outside-agent token), ⌘K, `?`, and drag an issue. Expected: `list_console_messages` has no errors anywhere; no "Figbots"/"Meetings" text on any screen.
- [ ] **Step 5: Stale browser state:** in the devtools page, run `localStorage.setItem('munin:section-path','/agents/heimdal'); localStorage.setItem('munin:runtime-url','http://x')`, reload with no hash. Expected: lands on `#/inbox`, both keys handled as in Interfaces. Register `push/runtime/sw.js`'s scope can't be reproduced once the file's gone, so check the unregister code path by reading it, and say so in the PR.
- [ ] **Step 6: Commit** `"munin without the agent runtime: the web app"`.

### Task 10: munin's demo, deploy and docs without the runtime

Same branch and PR as Task 9.

**Files:**
- Modify: `tracker/src/munin/config.py` (drop `demo`), `api.py` (drop `"demo"` from `/api/me`), `cli.py` (`_demo` no longer sets `demo=True`), `demo.py` (agents `claude-code`, `codex`, `claude-1` instead of `figbot`, `forge`, `vera`, everything else kept), `tracker/tests/test_api.py:72` (expected `/api/me` without `demo`), `tracker/tests/test_cli.py` (if it names the old cast)
- Modify: `deploy/install-mac.sh`, `deploy/install.sh` (tracker only; no node/npm/docker needs; tailscale `/` only), `deploy/environment.example`, `deploy/mac/environment.example` (no runtime lines)
- Delete: `deploy/mac/munin.runtime.plist`, `deploy/munin-runtime.service`
- Modify: `README.md`, `docs/architecture.md` (fold what's left into `docs/tracker.md` and delete, or shrink to the tracker), `docs/tracker.md` (cost via `report_usage`; no live run), `docs/server.md` (tracker only); one line in README: "Looking for munin's own agents? They're figbots now: github.com/ExManubis/figbots."

**Interfaces:**
- `install-mac.sh` retiring the old runtime: if `~/Library/LaunchAgents/munin.runtime.plist` exists → `launchctl bootout gui/$UID/munin.runtime`, delete the plist, `tailscale serve --set-path /runtime/api off` (ignore failure), and print: "munin's agents moved to figbots (github.com/ExManubis/figbots). Their data is still in ~/.munin; see figbots' deploy/move-from-munin.sh." Same idea in `install.sh` for `munin-runtime.service`. Both still never touch `~/.munin` data.

- [ ] **Step 1: Failing test first:** update `test_api.py:72` to expect no `demo` key; extend `test_cli.py::test_demo_data_looks_lived_in` to assert no agent named `figbot`, `forge` or `vera`. Run `uv run pytest tests/test_api.py tests/test_cli.py -q` → FAIL.
- [ ] **Step 2: Implement** the tracker changes; `uv run pytest -q` → all pass.
- [ ] **Step 3: Deploy scripts:** `bash -n deploy/*.sh`; read through the retire branch once more against the Interfaces.
- [ ] **Step 4: Docs and README**; `grep -rniE "runtime|figbot|meeting" README.md docs/*.md` → only the pointer line and the avatar renderer mention.
- [ ] **Step 5: Whole-repo check:** `git grep -n "runtime/" -- . ':!docs/superpowers'` → nothing; `uv run munin demo --no-open` serves and the inbox loads.
- [ ] **Step 6: Commit** `"munin without the agent runtime: demo, deploy, docs"`; `gh pr create --base staging`; comment on the MUN issue, link the PR.
- [ ] **Step 7: Merge into staging only once Task 8 is confirmed done.** Then tell the user staging is ready for a release, and that after they merge it to `main`, `cd ~/munin && git pull && deploy/install-mac.sh` retires the old runtime job (already stopped in Task 8) and the `/runtime/api` path.
