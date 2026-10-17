# The agent runtime's API

What the frontend needs from the agent runtime, worked out by building the Agents screens on a mock first. The mock is `web/runtime/mock.js`; every function it exports is listed here with the HTTP endpoint the runtime serves for it. The runtime is in `runtime/`, and `web/runtime/client.js` calls it. `web/runtime/index.js` picks the runtime when it answers and the mock when it doesn't; both have the same functions, so the screens don't care which. It looks on port 7779 of the page's host and at the page's own address; `munin:runtime-url` in the browser's localStorage points it somewhere else.

The runtime serves this under `/runtime/api`, behind the same edge as the tracker (see `architecture.md`), which lets in only the people in `MUNIN_USERS` (`server.md`). Times are ISO 8601 in UTC. Errors are `{"detail": "…"}` with 400, 404, 409 or 422, like the tracker's. [What this version does](#what-this-version-does) says which parts are real yet.

## Agents

| Mock | HTTP | Does |
|---|---|---|
| `me()` | `GET /runtime/api/me` | The runtime's version, its providers, where coders run (`sandbox`: `{kind: "docker", image}`, or `null` for this machine), what agents call you (`name`: from setup, or else `MUNIN_USER`), and where setup is (`setup`: `null` when it hasn't asked yet, `"started"`, or `"done"`; a runtime with agents and no answer counts as `"done"`). The frontend shows the Agents tab only when this answers, and setup until `setup` is `"done"` |
| `updateMe(patch)` | `PATCH /runtime/api/me` | `{name}` (empty to go back to `MUNIN_USER`) and/or `{setup: "started" \| "done"}`. Returns `me()`. Agents' prompts use the name from their next turn |
| `agents()` | `GET /runtime/api/agents` | Every agent, as a summary |
| `agent(name)` | `GET /runtime/api/agents/{name}` | One agent in full |
| `createAgent(fields)` | `POST /runtime/api/agents` | `{name, role, colour, provider, model, brief, tracker}` |
| `updateAgent(name, patch)` | `PATCH /runtime/api/agents/{name}` | Any of `role, colour, provider, model, thinking, brief, abilities, apps, budget`, `askFirst` as `{rule: on}`, and `tracker` (below) |
| `deleteAgent(name)` | `DELETE /runtime/api/agents/{name}` | With its conversation, routines and memory |
| `pause(name)`, `resume(name)` | `POST /runtime/api/agents/{name}/pause`, `/resume` | A paused agent reads and does nothing |

A **summary**, for the sidebar and lists:

```jsonc
{
  "name": "forge", "role": "coder", "roleName": "Coder", "colour": "ember",
  "state": "working",            // working | idle | asks | paused | failed: the Figbot's expression
  "waiting": 1,                  // open questions and approvals
  "preview": "Telegram caps a message at 4,096…",  // the open question, what it's doing, or its last message
  "lastAt": "2026-10-16T13:30:00Z",
  "typing": false,               // writing a reply right now
  "provider": "openrouter", "model": "anthropic/claude-opus-5.5"
}
```

**In full**, for the conversation's ABOUT panel and the profile, it adds:

```jsonc
{
  "brief": "You're forge, a coder on munin…", "thinking": "medium",
  "abilities": { "code": true, "tracker": true, "web": true },   // apps, web, code, tracker, images
  "apps": ["GitHub"],                                            // MCP servers it can use
  "askFirst": [{ "id": "push_main", "label": "Pushing to main", "what": "push to main", "third": "pushes to main", "on": true }],
  "routines": [Routine],
  "memory": [{ "id": "m1", "text": "Mikkel prefers small PRs." }], "memoryCount": 9,
  "usage": { "today": 1.92, "week": 9.4, "month": 31.2, "tokens": 640000 },  // dollars; tokens today
  "budget": 60,                                                   // pauses at this much a month, or null
  "worksIn": { "folder": "~/.munin/agents/forge/MUN-46", "branch": "mun-46-stream-tool-output",  // when it can code
               "issue": Issue, "detached": false,                         // detached: reviewing someone's branch
               "sandbox": "docker" },                                     // or null: on the runtime's machine
  "tracker": { "projects": ["MUN", "WEB"], "takes": "issues",                // when it uses the tracker
               "connected": true, "reachable": true },                     // has a token; the tracker answers
  "createdAt": "…",
  "run": { "id": "i42", "issue": Issue, "startedAt": "…", "step": "Editing gateway/telegram.py" }  // or null
}
```

An agent's name is also its name in the tracker. That's how the frontend joins the two.

**In the tracker.** An agent with the Tracker ability works there like any MCP client, with a token of its own. The frontend gets the token from the tracker (`POST /api/agents`) and hands it over as `tracker: {url, token, projects}`, with `url` the tracker's MCP address from its `/api/me`. A patch merges, so `{tracker: {projects: ["MUN"]}}` changes only the projects; `tracker: null` forgets the token, and the frontend revokes it in the tracker. The runtime never shows the token again. When you delete an agent, or turn its Tracker ability off, the frontend revokes its token.

## Conversations

| Mock | HTTP | Does |
|---|---|---|
| `conversation(name)` | `GET /runtime/api/agents/{name}/conversation` | `{agent, items}`, oldest first. It should page with `?before=`; it doesn't yet |
| `send(name, text)` | `POST /runtime/api/agents/{name}/messages` | A message from you. While a question is open, it answers the newest one instead. While the agent works, it steers |
| `answer(name, id, {option} or {text})` | `POST /runtime/api/agents/{name}/items/{id}/answer` | Answers a question |
| `decide(name, id, decision)` | `POST /runtime/api/agents/{name}/items/{id}/decide` | `once`, `always` or `deny` on an approval. `always` switches the matching ask-first rule off |
| `undo(name, id)` | `POST /runtime/api/agents/{name}/items/{id}/undo` | Takes back an `always` for 8 seconds; the rule asks first again |
| `stopRun(name, id)` | `POST /runtime/api/agents/{name}/runs/{id}/stop` | Stops after the step it's on |
| `waiting()` | `GET /runtime/api/waiting` | Every open question and approval, as `{agent: Summary, item}`, oldest first |

An **item** is one of:

```jsonc
{ "id": "i7", "kind": "message", "at": "…", "from": "agent", "text": "Markdown, with > quotes" }        // from: agent | human
{ "id": "i8", "kind": "action", "at": "…", "verb": "sent mail", "object": "Re: Offsite → Paul",
  "issue": Issue, "actor": "vera" }                                // issue and actor are optional; actor when it isn't the agent
{ "id": "i9", "kind": "run", "at": "…", "number": 2, "issue": Issue, "status": "running",              // running | done | stopped
  "startedAt": "…", "endedAt": null, "steps": [{ "at": "…", "text": "Ran pytest gateway/", "detail": "41 passed" }] }
{ "id": "i10", "kind": "question", "at": "…", "text": "Move the dentist to which slot?",
  "options": [{ "label": "Thursday 10:00", "detail": "Your morning is clear." }],
  "status": "open", "answer": null, "answeredAt": null,          // answered: { option } or { text }
  "issue": Issue, "trackerQuestion": 412 }                       // a question about an issue, and the tracker's comment id for it
{ "id": "i11", "kind": "approval", "at": "…", "permission": "send_mail", "what": "send mail", "third": "sends mail",
  "label": "Sending mail", "target": "Re: Planning call → Paul Eriksen",
  "status": "open", "answeredAt": null, "undoUntil": null }     // open | once | always | denied
```

`Issue` is `{id, title}`. Time rules ("TODAY · 09:15") and grouping are the frontend's job; the runtime only sends items.

## Routines, memory and providers

| Mock | HTTP | Does |
|---|---|---|
| `addRoutine(name, routine)` | `POST /runtime/api/agents/{name}/routines` | `{name, trigger, when, does}`; returns the routine, with `when` in munin's words. A `when` it doesn't understand is a 422 with examples |
| `updateRoutine(name, id, fields)` | `PATCH /runtime/api/agents/{name}/routines/{id}` | Any of those; returns the routine |
| `deleteRoutine(name, id)` | `DELETE /runtime/api/agents/{name}/routines/{id}` | |
| `runRoutine(name, id)` | `POST /runtime/api/agents/{name}/routines/{id}/run` | Runs it now, whatever starts it |
| `forget(name, noteId)` | `DELETE /runtime/api/agents/{name}/memory/{id}` | |
| `providers()` | `GET /runtime/api/providers` | `[{id, name, connected, detail, takesKey, key}]`. `takesKey` when a key can be pasted in Settings (OpenRouter); `key` says where the one in use came from, never the key itself: `{from: "settings", hint: "a1b2"}` (its last four characters), `{from: "environment"}`, or `null`. Ollama comes from `MUNIN_OLLAMA_URL` |
| `setKey(provider, key)` | `PUT /runtime/api/providers/{id}/key` | `{key}`. Asks the provider whether it takes it (422 when it says no; kept when it can't be reached), keeps it in `keys.json` next to the runtime's database, and uses it from the next turn, in place of the environment's. Returns the provider |
| `removeKey(provider)` | `DELETE /runtime/api/providers/{id}/key` | Back to the environment's key, or off. Returns the provider |
| `models()` | `GET /runtime/api/models` | The models to pick from: `[{id, name, models: [{id, name, maker, input, output, day, favourite}]}]`, with `input` and `output` in dollars per million tokens and `day` a rough cost for a day of steady use. OpenRouter's are your favourites, then any other an agent is on (`favourite: false`) |
| `recommendedModels()` | `GET /runtime/api/models/recommended` | What setup recommends from OpenRouter, key or not: `{cheap: [model], frontier: [model]}` |
| `searchModels(q)` | `GET /runtime/api/models/search?q=` | OpenRouter's models with every word of `q` in their id or name, from its whole catalog, leaving out batch-only ones: `{total, models}`, twenty at most |
| `setFavourites(models)` | `PUT /runtime/api/favourites` | `{models: [id]}`: the OpenRouter models agents pick from, in your order (Claude Haiku 5.5 and Claude Opus 5.5 until you choose). A model OpenRouter doesn't have is a 422. Returns `models()` |
| `repos()` | `GET /runtime/api/repos` | Where each project's code is: `[{project, source, base}]` |
| `setRepo(key, fields)` | `PUT /runtime/api/repos/{KEY}` | `{source, base}`: a git URL or a folder with a repository, and the branch new branches start from (the repository's default when left out). Clones it the first time |
| `removeRepo(key)` | `DELETE /runtime/api/repos/{KEY}` | Forgets it; the clone and agents' worktrees stay |

A **routine** starts on a schedule or a trigger:

```jsonc
{ "id": "r3", "name": "Fix what vera flags", "trigger": "tracker",  // schedule | tracker | mail | calendar
  "when": "When vera moves forge's issue from In review to Todo",  // as munin understood it
  "does": "Pick it back up and fix what she found.",
  "next": null, "last": "…",                                       // next for schedules; last for any
  "note": null }                                                   // why it doesn't run yet, if it doesn't
```

What the runtime understands in `when`:

- **On a schedule**, in the runtime's time zone (its `TZ`): "Weekdays 07:30", "Mondays at 9", "Mon, Wed, Fri 09:00", "Every night 02:00", "Every 2 hours, 08–18", "Every 30 minutes on weekdays". It's saved as "Weekdays 07:30", "Every 2 hours, 08:00–18:00" and so on.
- **When something happens in the tracker:** "When an issue moves to In review", "When vera sends my work back", "When an issue in MUN is created", "When someone comments on my issue", "When anything happens in MUN". An agent's own doing never starts its routines.
- **Mail and calendar** are kept as written, with a note that they wait for those apps.

The runtime serves the models, so a new provider's show up without a frontend change. Roles, abilities and apps are still fixed lists in `web/runtime/roles.js`, with the runtime's half in `runtime/src/roles.js`; the runtime should serve them too, at `GET /runtime/api/roles`.

## Live updates

`GET /runtime/api/stream` is a server-sent event stream that says `changed`, like the tracker's `/api/stream`, at most ten times a second; the mock calls `subscribe(fn)` instead. The client reloads after a reconnect, since it can't tell what it missed. The stream should number its events so a reconnecting client can ask for what it missed (`Last-Event-ID`). The Claudewitz daemon does this, and it matters on a phone that keeps dropping off.

## What the tracker added for this

The screens needed three things from the tracker. Every agent can use them, so it stays agent-agnostic:

1. **Questions with options.** `add_comment(…, ask_human=true, options=[{label, detail}])` offers 2 to 6 answers, and the tracker's inbox shows them as option cards, like the conversation does. Picking one answers with its label; you can still write your own.
2. **The question's id back.** `add_comment` returns the comment's id, so the runtime ties its agent's question to the tracker's copy. That's `trackerQuestion` above; the mock finds it by agent and issue instead.
3. **An event feed over MCP.** The `events` tool lists what happened after an event id, comments included. Routines that start "when an issue moves" read it, and so can an agent that wants your answer without `wait_for_work`.

## How the runtime does it

The runtime (`runtime/src/`) is a thin layer over pi-durable:

- **A conversation** is a pi-durable conversation, one per agent, in the runtime's SQLite file. The agents' settings are one session document next to them (`munin.agents`).
- **Who's talking.** Every agent's prompt says that the messages in its conversation are from you, the person it works for, so it talks to you as "you" and reads "my calendar" as yours. It uses the name from setup. While there's none it says "the person you work for", since `MUNIN_USER`'s default, `me`, isn't a name. Role briefs call you "the person you work for" too, so they stay right when the name changes, and the runtime updates the wording of briefs made before that, which named you, when it starts.
- **Messages and runs** come from its entries (`items.js`).
  - `pi.user` and `pi.assistant` text become messages.
  - A run is the tool calls from one input to the answer. Each call is a step, and its result gives the step's detail line: the last line a command printed, or `failed`.
  - A reply that fails or is stopped becomes an action.
- **Questions, answers, approvals, decisions and actions** are entries of munin's own kinds (`munin.question`, `munin.answer`, `munin.approval`, `munin.decision`, `munin.action`).
  - Agents ask with an `ask_human` tool, with options or without.
  - An answer goes to the agent as an input, so it steers a running agent.
- **Ask-first rules** are a `beforeTool` hook. A call a rule covers is blocked and an approval written. The decision goes to the agent as a message, and "once" lets the next such call through. "Always" switches the rule off; undo switches it back on.
- **Steering:** `send` while a run is going is `submit({ whenBusy: "steer" })`.
- **Brief, model and abilities** are the conversation's agent settings: instructions, model and extensions. Coders get pi-durable's coding tools (read, write, edit, bash) in their own folder.
- **Memory** is a `remember` tool. Notes go into the agent's system prompt.
- **Routines** (`routines.js`, `schedule.js`, `watch.js`) run on a timer. A routine that's due becomes an input of munin's own kind (`munin.routine`), queued behind whatever the agent is doing (`whenBusy: "followUp"`), and shows in the conversation as "ran routine". A routine whose last run is still queued isn't queued again, a paused agent skips its routines, and a run the runtime missed while it was down still happens if it's less than 15 minutes late. For tracker triggers, the runtime reads the tracker's `events` feed every half minute with the agent's own token, starting from the moment the routine is first watched, and matches its lines without asking a model. A routine on `my issue` asks the tracker whose issue it is.
- **The tracker** (`tracker.js`) is an extension of the tracker's own MCP tools. The runtime lists them once, with any connected agent's token, and installs them; until the tracker answers, the extension is empty and agents are told it's away, and the runtime asks again every half minute. Each call goes out with the calling agent's token, so the tracker sees the agent by its name. The tracker's instructions and the agent's projects go into its system prompt. A few calls also land in the conversation:
  - `add_comment(…, ask_human=true)` becomes a question card with `trackerQuestion` set, so the frontend lists it once and an answer in either place answers both;
  - `update_issue` to a new status becomes an action line (took, sent to review, moved to Done, sent back, put back, cancelled), and a run started while the agent has an issue in progress belongs to that issue;
  - `create_issue` becomes "filed".
- **Worktrees** (`workspace.js`). The runtime keeps a clone of each project's repository (`MUNIN_REPOS_DIR`, `~/.munin/repos/<KEY>`). When a coder takes an issue, the runtime adds a worktree of it in the agent's folder (`~/.munin/agents/forge/MUN-46`) on a branch named after the issue (`mun-46-stream-tool-output`), from the fetched base, and moves the agent's shell and file tools there before the agent reads the tracker's answer. Taking an issue again picks its branch up as the agent left it. Commits in a worktree are the agent's (`user.name` is its name). An `open_worktree` tool goes back to one of the agent's own worktrees, or opens a detached copy of someone else's branch to review it, so a reviewer's commits never land on it. When an agent takes its next issue, its worktrees with nothing uncommitted whose branch is already in the base are removed. Agents' shells run with `GIT_PAGER=cat` and no prompts, since nobody is at their terminal. How work gets delivered (push, pull request, merge) is up to the project's brief.
- **Where coders' tools run** (`sandbox.js`). pi-durable asks the runtime for each tool call's environment. Without a sandbox it's `NodeExecutionEnv` on this machine, and munin's own `coding-tools` extension (pi-durable's, with the shell's environment chosen by a `prepare` hook) gives the shell harmless variables, `LC_*` and those named in `MUNIN_AGENT_ENV`, never the runtime's own. With `MUNIN_AGENT_SANDBOX=docker`, each coder gets a container (`MUNIN_AGENT_IMAGE`, `buildpack-deps:bookworm-scm` by default; `MUNIN_AGENT_NETWORK` to pick its network), started at its first tool call, running as your user id, with its folder and munin's clones mounted at their own paths and pi-env's daemon inside. pi-env's `RemoteExecutionEnv` reaches the daemon through `docker exec`, so reads, writes, edits and commands all happen in the container. Deleting the agent removes its container.
- **Usage** adds up the cost and tokens on each reply.
- **Models:** OpenRouter with a key pasted in Settings or `OPENROUTER_API_KEY`, an Ollama server with `MUNIN_OLLAMA_URL`, and always the stand-in, which answers without a model. An agent on a model the runtime can't reach runs on the stand-in until it can.

## What this version does

Real: agents and their settings, conversations with runs, questions with options, ask-first approvals with undo, coding tools, a worktree and a branch per issue, the tracker for coders and reviewers, routines on a schedule or a tracker trigger, memory, pause and resume, usage, models, the live stream, and everything surviving a restart.

An agent in the tracker starts work when you tell it to, from its projects in the ABOUT panel, or when a routine says so: "Weekdays 09:00: continue the MUN project" keeps a coder on the pile, and "When an issue moves to In review" puts a reviewer on what lands. It keeps going until `wait_for_work` says there's nothing left.

Stored but not acted on yet, next roughly in this order:

1. **Apps and the web** as tools, through MCP servers, with ask-first rules for apps like "send mail". Mail and calendar routines start then.
2. **A budget that pauses** the agent at its limit.
3. **Faster reads.** Each read goes through an agent's whole conversation; it should keep items and page them.
4. **Numbered events** on the stream, and replay on reconnect.
5. **Tighter containers.** A container sees all of munin's clones, so a coder could change another coder's branch there; one clone per agent, or a mount of only its own worktrees' git data, would stop that.
