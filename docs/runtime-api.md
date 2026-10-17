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
| `createAgent(fields)` | `POST /runtime/api/agents` | `{name, role, colour, provider, model, brief, examples, tracker}`. An empty brief is the role's soul; examples left out are the role's while the brief is its soul |
| `updateAgent(name, patch)` | `PATCH /runtime/api/agents/{name}` | Any of `role, colour, provider, model, thinking, brief, examples, proactivity, abilities, apps, budget` (with `why` for the soul's history when the brief or examples change), `askFirst` as `{rule: on}`, and `tracker` (below). An empty brief is ignored; empty examples clear them |
| `deleteAgent(name)` | `DELETE /runtime/api/agents/{name}` | With its conversation, routines and memory |
| `pause(name)`, `resume(name)` | `POST /runtime/api/agents/{name}/pause`, `/resume` | A paused agent reads and does nothing. `resume` is a 409 while the agent is over its budget for the month |

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
  "brief": "You like code that's boring to read…", "thinking": "medium",   // who it is, then how it works
  "examples": "You: Can you make the inbox faster?\nforge: Faster to load…",  // how it talks; "You:" is you
  "proactivity": "off",                                           // off, matters or chatty: whether it speaks up on its own
  "soulHistory": [{ "at": "…", "by": "forge", "why": "…", "brief": "…", "examples": "…" }],  // newest first; by: you, the agent, munin, or null (before history)
  "expression": { "pose": "excited", "until": "…" },               // a passing expression for a minute, or null (in the summary too)
  "journal": [{ "at": "…", "text": "Moved the dentist to Thursday…" }],  // newest first
  "abilities": { "code": true, "tracker": true, "web": true },   // apps, web, code, tracker, images
  "apps": ["calendar"],                                          // ids of the apps it uses (apps())
  "askFirst": [{ "id": "push_main", "label": "Pushing to main", "what": "push to main", "third": "pushes to main", "on": true }],
  "routines": [Routine],
  "memory": [{ "id": "m1", "kind": "you", "text": "Mikkel prefers small PRs." }], "memoryCount": 9,  // kind: you, work or self
  "memoryRoom": { "you": { "used": 620, "cap": 1500 }, "work": { "used": 0, "cap": 1500 }, "self": { "used": 0, "cap": 1000 } },  // characters
  "skills": [{ "id": "s3f2a9c1d", "name": "run-gateway-tests", "description": "…", "body": "## When to use…", "text": "---\nname: …",  // its own and those shared with it
               "owner": "forge", "mine": true, "sharedWith": [], "uses": 6, "lastUsed": "…", "stale": false, "createdAt": "…", "updatedAt": "…" }],
  "usage": { "today": 1.92, "week": 9.4, "month": 31.2, "tokens": 640000 },  // dollars; week is 7 days, month this calendar month; tokens today
  "budget": 60,                                                   // pauses at this much a calendar month, or null
  "pausedFor": null,                                              // while paused: "you", or "budget"
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
| `conversation(name, {before, limit})` | `GET /runtime/api/agents/{name}/conversation?before=&limit=` | `{agent, items, more}`: the newest `limit` items (100 by default, at most 500), oldest first, or those just before the item `before`. `more` says whether there are older ones; an unknown `before` is a 422. The thread shows the newest 100 and "Show earlier" adds 100 more |
| `send(name, text)` | `POST /runtime/api/agents/{name}/messages` | A message from you. While a question is open, it answers the newest one instead. While the agent works, it steers |
| `answer(name, id, {option} or {text})` | `POST /runtime/api/agents/{name}/items/{id}/answer` | Answers a question |
| `decide(name, id, decision)` | `POST /runtime/api/agents/{name}/items/{id}/decide` | `once`, `always` or `deny` on an approval. `always` switches the matching ask-first rule off |
| `undo(name, id)` | `POST /runtime/api/agents/{name}/items/{id}/undo` | Takes back an `always` for 8 seconds; the rule asks first again |
| `stopRun(name, id)` | `POST /runtime/api/agents/{name}/runs/{id}/stop` | Stops after the step it's on |
| `waiting()` | `GET /runtime/api/waiting` | Every open question and approval, as `{agent: Summary, item}`, oldest first |
| `issueCosts(ids?)` | `GET /runtime/api/issue-costs?issues=MUN-1,MUN-2` | What each issue cost: `{"MUN-12": {cost, tokens, agents: {forge: cost}}}`, dollars. A model response counts towards the issue its agent is on: the one it took or opened a worktree for, until it moves that issue on (to review, done, or back to the pile). Responses on no issue count only in the agent's own usage, which has every response. The tracker knows nothing of cost; the frontend joins the two on the issue page and in the project's list. Without `issues`, every issue counted so far |

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

## Meetings

Figbots talk in turns, with you able to join (meetings.js). A meeting has a title, participants (agent names, plus `null` for you), a transcript of speeches, and a status `open` or `closed`. Meetings live in a session doc of their own (`munin.meetings`), with who has been asked to speak, so a turn asked before a restart is still answered after it. Each figbot takes its turns in a session of its own for that meeting, a conversation apart from its chats with you: it keeps its model and who it is, but not its code, tracker, apps or the web, and its own conversation gets one "went to a meeting" line. A turn carries only what was said since that figbot's last turn (at most 24 speeches and 16,000 characters, saying how many were left out), with the meeting's rules: speak only when there's something new, don't repeat, and never reveal anything from private conversations. After a meeting is created, or after anyone speaks, the participants speak in round-robin, one turn at a time: munin asks each agent's turn as an input of its own kind, and the agent answers with `speak_in_meeting` (its text; calling it with none, or with blank words, passes; `meeting` says which one when it was asked in several). A turn the agent ends without the tool still counts: what it said is its speech, and nothing (or a failed turn) is a pass. Nobody speaks twice in a row, so a lone agent waits for you after it speaks. Guards end a meeting that goes nowhere: after 12 agent turns in a row without you it waits for you, and after 2 passes in a row it waits too. You speaking keeps it going, and frees a turn whose answer never came within 10 minutes.

| Mock | HTTP | Does |
|---|---|---|
| `meetings()` | `GET /runtime/api/meetings` | Every meeting, newest first, each without its transcript, with `last`: `{from, pass, at}` of its last speech |
| `createMeeting(fields)` | `POST /runtime/api/meetings` | `{title, participants, first?}`; `participants` are agent names plus `null` for you; `first` is your opening speech. 422 without a title or without anyone to speak |
| `meeting(id)` | `GET /runtime/api/meetings/{id}` | One in full, transcript included |
| `speakInMeeting(id, text)` | `POST /runtime/api/meetings/{id}/speech` | Your speech; the round goes on afterwards. A closed meeting is a 409 |
| `closeMeeting(id)` | `POST /runtime/api/meetings/{id}/close` | Ends it; turns already asked finish, no new ones start |

A speech is `{id, from, at, pass, text}`, `from` an agent's name or `null` for you, `text` null on a pass. In the mock the transcript is stored but agents don't discuss: it's for the screens.

## Routines, memory and providers

| Mock | HTTP | Does |
|---|---|---|
| `addRoutine(name, routine)` | `POST /runtime/api/agents/{name}/routines` | `{name, trigger, when, does}`; returns the routine, with `when` in munin's words. A `when` it doesn't understand is a 422 with examples |
| `updateRoutine(name, id, fields)` | `PATCH /runtime/api/agents/{name}/routines/{id}` | Any of those; returns the routine |
| `deleteRoutine(name, id)` | `DELETE /runtime/api/agents/{name}/routines/{id}` | |
| `runRoutine(name, id)` | `POST /runtime/api/agents/{name}/routines/{id}/run` | Runs it now, whatever starts it |
| `addSkill(name, text)` | `POST /runtime/api/agents/{name}/skills` | `{text}`, a SKILL.md. 422 when it isn't one or reads like a log, 409 when the agent has one of that name. Returns the agent |
| `updateSkill(name, id, patch)` | `PATCH /runtime/api/agents/{name}/skills/{id}` | `{text}` and/or `{sharedWith}`: `["*"]` for every agent, or their names. Only the skill's owner changes it (404 otherwise). Returns the agent |
| `deleteSkill(name, id)` | `DELETE /runtime/api/agents/{name}/skills/{id}` | Its owner's only. Returns the agent |
| `changeNote(name, noteId, patch)` | `PATCH /runtime/api/agents/{name}/memory/{id}` | `{text, kind}`, either. It has to fit its kind's room, like the agent's own notes (422 when it doesn't). Returns the agent |
| `forget(name, noteId)` | `DELETE /runtime/api/agents/{name}/memory/{id}` | |
| `providers()` | `GET /runtime/api/providers` | `[{id, name, connected, detail, takesKey, key}]`. `takesKey` when a key can be pasted in Settings (OpenRouter); `key` says where the one in use came from, never the key itself: `{from: "settings", hint: "a1b2"}` (its last four characters), `{from: "environment"}`, or `null`. Ollama comes from `MUNIN_OLLAMA_URL` |
| `setKey(provider, key)` | `PUT /runtime/api/providers/{id}/key` | `{key}`. Asks the provider whether it takes it (422 when it says no; kept when it can't be reached), keeps it in `keys.json` next to the runtime's database, and uses it from the next turn, in place of the environment's. Returns the provider |
| `removeKey(provider)` | `DELETE /runtime/api/providers/{id}/key` | Back to the environment's key, or off. Returns the provider |
| `models()` | `GET /runtime/api/models` | The models to pick from: `[{id, name, models: [{id, name, maker, input, output, day, favourite}]}]`, with `input` and `output` in dollars per million tokens and `day` a rough cost for a day of steady use. OpenRouter's are your favourites, then any other an agent is on (`favourite: false`) |
| `recommendedModels()` | `GET /runtime/api/models/recommended` | What setup recommends from OpenRouter, key or not: `{cheap: [model], frontier: [model]}` |
| `searchModels(q)` | `GET /runtime/api/models/search?q=` | OpenRouter's models with every word of `q` in their id or name, from its whole catalog, leaving out batch-only ones: `{total, models}`, twenty at most |
| `setFavourites(models)` | `PUT /runtime/api/favourites` | `{models: [id]}`: the OpenRouter models agents pick from, in your order (Claude Haiku 5.5 and Claude Opus 5.5 until you choose). A model OpenRouter doesn't have is a 422. Returns `models()` |
| `apps()` | `GET /runtime/api/apps` | The apps added in Settings: `[{id, name, url, token: {hint} \| null, connected, tools, detail}]`. `detail` is "2 tools", or why it doesn't answer. Tokens never come back |
| `addApp(fields)` | `POST /runtime/api/apps` | `{name, url, token?}`: an MCP server reached over HTTP. 201 with the app, connected or not; a missing name, a URL that isn't http(s), or a name that's taken is a 422 |
| `removeApp(id)` | `DELETE /runtime/api/apps/{id}` | Agents that had it lose its tools; an unknown id is a 404 |
| `google()` | `GET /runtime/api/google` | `{client: {configured, id?}, account: {email, services, organise, working, problem} \| null, redirect}`; `organise` says whether the sign-in includes `gmail.modify`. `redirect` is the runtime's callback as you reach it, to add to your Google client. Tokens and the client secret never come back |
| `setGoogleClient(json)` | `PUT /runtime/api/google/client` | `{json}`: the OAuth client JSON from Google Cloud (a "Web application" client). A new client signs the old account out |
| `googleSignIn(fields)` | `POST /runtime/api/google/signin` | `{services: ["gmail", "calendar"], back}`: `{url}`, Google's consent page. `back` must be munin's own page |
| — | `GET /runtime/api/google/callback` | Where Google sends the browser: trades the code for tokens, then redirects to `back` with `?google=ok\|failed&message=…` |
| `googleSignOut()` | `DELETE /runtime/api/google` | Forgets the sign-in and revokes it at Google |
| `push()` | `GET /runtime/api/push` | `{key, devices}`: the key a device subscribes with (applicationServerKey), and how many devices get the runtime's pushes. The tracker has the same at `/api/push`, with keys of its own |
| `subscribePush(subscription)` | `POST /runtime/api/push` | `{subscription}`: a browser's PushSubscription as JSON |
| `forgetPush(endpoint)` | `DELETE /runtime/api/push` | `{endpoint}` |
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

`GET /runtime/api/stream` is a server-sent event stream, at most ten events a second; the mock calls `subscribe(fn)` instead. Every commit in the runtime is a numbered event, `<boot>.<n>`, and changes within 100ms go out as one `changed` event with the newest id and the agents they were about: `data: {"agents": ["pip"]}`. A fresh stream starts with the newest id. A client that reconnects with `Last-Event-ID` gets what it missed as one `changed` event. If the id is from before the runtime restarted, or older than the last 1,000 events, it gets `reset` instead: reload everything. The tracker's `/api/stream` works the same way, numbered by its event ids, with each event as JSON (what `/api/activity` lists), up to 500 missed events. The frontend reloads on `changed` and `reset`, and when a stream comes back.

## What the tracker added for this

The screens needed three things from the tracker. Every agent can use them, so it stays agent-agnostic:

1. **Questions with options.** `add_comment(…, ask_human=true, options=[{label, detail}])` offers 2 to 6 answers, and the tracker's inbox shows them as option cards, like the conversation does. Picking one answers with its label; you can still write your own.
2. **The question's id back.** `add_comment` returns the comment's id, so the runtime ties its agent's question to the tracker's copy. That's `trackerQuestion` above; the mock finds it by agent and issue instead.
3. **An event feed over MCP.** The `events` tool lists what happened after an event id, comments included. Routines that start "when an issue moves" read it, and so can an agent that wants your answer without `wait_for_work`.

## How the runtime does it

The runtime (`runtime/src/`) is a thin layer over pi-durable:

- **A conversation** is a pi-durable conversation, one per agent, in the runtime's SQLite file. The agents' settings are one session document next to them (`munin.agents`).
- **The prompt** (`prompt.js`) opens with who the agent is, as plain facts: its name and role, that it works for you, and that it's talking with you right now in munin, which is private to you. It doesn't explain where messages come from, because agents told that started doubting who they were talking to. Then comes what no munin agent sounds like (a help desk, filler), kept short so agents don't all sound the same, then the agent's own **brief and examples**. A role's brief is a soul written as behaviour, the way Hermes Agent's SOUL.md is: who the agent is (what it cares about, how it disagrees, what annoys it), then how it works. Its examples are two made-up exchanges that show how it talks, since a few lines of an agent talking show its voice better than any description (character cards' `mes_example`). They're written from your side, "You:" for you and the agent's name for it; in the prompt your lines get your name and its lines become "You:", because lines under its own name taught it to start replies with its name, and it's told they didn't happen, because agents brought their content up as if it had. Then **what it can do**: one section built from its real setup every turn, so it can answer "what can you do?" and "can you…?". It lists each ability and app that works right now and what it's for (Gmail's line says whether it can organise), how it reaches you (with notifications on, a phone gets what agents that don't code say, and every agent's questions and approvals), routines with the "when" phrases munin understands, what asks you first (from its own rules), what it could have if something were switched on (an ability that's off, an app it doesn't have, an app waiting for a sign-in, and who switches it on), and what munin can't do yet for anyone (make pictures). Then **its team**: the other agents, what each does, the issue a coder last took and who's paused, so it can say whose job something is. That section leaves out whether an agent is busy this minute, since a section that changes is sent again, which defeats the provider's prompt cache. What it remembers follows, in its three kinds (Memory, below). With no name from setup it says "the person you work for", since `MUNIN_USER`'s default, `me`, isn't a name, and the agent asks once. When the runtime starts, briefs made from a role's older words get its soul, and an agent from before examples gets its role's while its brief is still the role's soul.
- **Apps** (`apps.js`, `mcp.js`). An app is an MCP server reached over HTTP (streamable HTTP, JSON or server-sent answers, with its session kept and started again when the server forgets it), with an optional bearer token. The runtime keeps them in `apps.json` next to its database, readable by its own user only, and connects to each in the background, trying again every minute when one doesn't answer. An agent with the Apps ability gets the tools of its apps that answer, named `<app>__<tool>` (`calendar__list_events`), and its prompt names them. Calls go out from the runtime with the app's token, so agents never see it, and show in the conversation as steps ("calendar: list events"). The tracker's tools go through the same client.
- **Google** (`google.js`, `googleapps.js`). You bring the OAuth client, a "Web application" client from your own Google Cloud project, and sign in from Settings: Google's consent page (PKCE, offline access), then the runtime's callback, which keeps the client and the tokens in `google.json` next to its database (mode 600), renews the access token itself, and says when a sign-in stops working. **Gmail** and **Google Calendar** come with munin as apps (`builtin` in `apps()`), on Google's regular APIs: they answer while you're signed in, and agents pick them like any app. Gmail searches, reads threads (HTML mail as text), drafts (in a thread, as a reply) and sends, and organises: lists labels, labels threads by name (making missing labels), archives, marks read or unread, and moves to the bin, up to 50 threads at a time. Organising needs `gmail.modify`, which munin asks for at sign-in but doesn't need for the rest, so an older sign-in keeps Gmail and is asked to sign in again. Calendar lists events in its time zone, creates, changes and deletes them, and answers invitations. Each tool says what kind of change it makes, and Gmail has an ask-first rule per kind: sending mail (on), moving mail to the bin (on), and labelling, archiving and marking read (off, since it's reversible). Calendar has one rule for any change. Reading and drafting need no asking. Headers are kept to one line, so a subject can't add a recipient. An External app in Google's "Testing" status gets sign-ins that last 7 days; an Internal one (Google Workspace) doesn't.
- **The web** (`web.js`). An agent with the Web ability gets `read_page`: the runtime fetches the page itself (never a coder's container), refuses this machine, private and link-local networks and the tailnet (checking every address a name resolves to, and every redirect), reads at most 2 MB of text, HTML or JSON, and hands back up to 20,000 characters of readable text. An agent on an OpenRouter model also gets `web_search`, which never runs: every request to OpenRouter goes through `withWebSearch` (via pi-ai's `onPayload`), which swaps it for OpenRouter's `openrouter:web_search` server tool, so the model searches as it answers (native search on Anthropic, Google, OpenAI, Perplexity and xAI models; Exa on the rest), at most 5 searches of 5 results an answer. OpenRouter bills the searches (about $0.007 each on Exa), but pi-ai works out cost from tokens, so **search fees aren't in munin's usage or budgets yet**. Agents on other providers are told to ask for links.
- **Mail and calendar routines** (`googlewatch.js`). A routine can start on mail ("When new mail arrives", "When mail from ann@example.com arrives", "When mail about invoices arrives", "When mail matching is:important arrives") or the calendar ("Before each meeting", "15 minutes before each event", "When an invitation arrives"), once the agent has Gmail or Google Calendar. About once a minute munin asks Gmail for its history id, which costs nothing; only when it changed does each mail routine run its search (in the inbox, last two days) and compare with what it saw, and the agent wakes only for new threads, told who sent what. The calendar is looked at for what starts within each routine's lead time (a meeting is an event with other people in it) and for new invitations awaiting an answer. Each thread, meeting and invitation wakes a routine once, and the first look only notes what's already there.
- **Routines agents set up** (`runtime.js`). Every agent has `list_routines`, `add_routine`, `change_routine` and `remove_routine`, so "give me a morning brief at 7:30 on weekdays" is something you just say. They go through the same checks as the profile (a "when" munin doesn't understand comes back with examples), find a routine by name or id, and each change is an action line in the conversation ("added routine Morning brief: Weekdays 07:30"). Every agent has an ask-first rule, "Setting up its own routines", which is **off**; switch it on to approve each one.
- **Push notifications** (`push.js`, and the tracker's `push.py`). Each service has its own VAPID keys and devices in `push.json` next to its database (mode 600) and pushes its own things: the tracker an agent's question and work an agent sends to review; the runtime an agent's question (unless it's about a tracker issue, which the tracker pushes), an approval it waits for, and what agents that don't code say (a morning brief, an answer), so coders' chatter stays in munin. A device the push service says is gone (404, 410) is forgotten. In the browser, a service worker per service (`web/push/tracker/sw.js`, `web/push/runtime/sw.js`) shows a push, silently while munin is in front of you, and tapping it opens munin at what it's about. Push needs HTTPS (or localhost); on an iPhone, munin added to the home screen.
- **Reading a conversation** goes through the entries the runtime keeps in memory: each read asks pi-durable only for the entries after the last one it has (`minEntryId`), since entries never change once written, and one agent's reads go one at a time. Its items are rebuilt only when something's new.
- **Budgets.** An agent's budget is dollars per calendar month. The runtime keeps a running total of what its model responses cost this month: it reads the total from the conversation the first time it's needed, then adds each response's cost in a `GenerationTask` `afterResponse` hook. When the total reaches the budget, the agent pauses itself (`pausedFor: "budget"`) and its conversation says "paused at its $10 budget for October". The turn it's in isn't cut off: its next tool calls are blocked, so it answers once more and stops. A bigger budget doesn't resume it by itself, and neither does a new month; `resume` does, once it's under budget.
- **Messages and runs** come from its entries (`items.js`).
  - `pi.user` and `pi.assistant` text become messages.
  - A run is the tool calls from one input to the answer. Each call is a step, and its result gives the step's detail line: the last line a command printed, or `failed`.
  - A reply that fails or is stopped becomes an action.
- **Questions, answers, approvals, decisions and actions** are entries of munin's own kinds (`munin.question`, `munin.answer`, `munin.approval`, `munin.decision`, `munin.action`).
  - Agents ask with an `ask_human` tool, with options or without.
  - An answer goes to the agent as an input, so it steers a running agent.
- **Ask-first rules** are a `beforeTool` hook. A call a rule covers is blocked and an approval written. The decision goes to the agent as a message, and "once" lets the next such call through. "Always" switches the rule off; undo switches it back on. Each app an agent has gets a rule of its own (`app:<id>`, "Calendar: sending, changing or deleting"), on until you turn it off, which covers the app's tools that change something: those the server doesn't mark `readOnlyHint`, or, without annotations, those whose names don't start like `list_`, `get_` or `search_`. Its approval says the call in plain words: "add event · title: Lunch with Ann · when: 12:00". Taking the app away takes its rule with it.
- **Steering:** `send` while a run is going is `submit({ whenBusy: "steer" })`.
- **Brief, model and abilities** are the conversation's agent settings: instructions, model and extensions. Coders get pi-durable's coding tools (read, write, edit, bash) in their own folder.
- **Skills** (`skills.js`) are what an agent knows how to do here, each a SKILL.md (agentskills.io, which Claude Code reads too): a name and a description, then When to use, Steps, Pitfalls and How to check. The runtime keeps them in its own database, not in a coder's folder, so a coder can't skip asking by writing files. The prompt lists the agent's skills by name and description, its own and those shared with it (`vera's`), and tells it to read one with `read_skill` when it fits, which counts a use; uses aren't in the prompt, since a section that changes every turn is sent again. It saves one with `save_skill` when it has worked out how to do something it'll do again, got out of a dead end or been corrected, and one with a name it has changes it. One that reads like a log (an issue id, a date, a pull request number, "yesterday") is turned back before it reaches you: lessons, not logs. Every agent has an ask-first rule, "Saving its own skills", which is **on**: `save_skill` asks by itself, with the skill on the approval card, and when you allow it munin saves it, so the agent doesn't send it again. A skill unused for 30 days shows as stale. Deleting an agent deletes its skills and takes it off others' shares.
- **Speaking up and the journal** (`rhythm.js`) are munin's own inputs, sent from the routines' timer to an agent that isn't doing anything, as entries of munin's own kinds (`munin.heartbeat`, `munin.journal`), so the conversation never shows them as your messages. An agent's `proactivity` is `off` (only when asked), `matters` or `chatty`: new companions start chatty, new assistants on matters, everyone else and every agent from before this off. A **heartbeat** comes every two hours between 08:00 and 21:00 in the runtime's time zone, only after two hours of quiet (counted from the agent's making when it hasn't said anything yet), and not again after it spoke up until you've answered. It asks the agent to say something worth saying, or reply `NO_REPLY`: a reply like that shows nothing in the conversation (the heartbeat's run goes too, unless it asked something) and sends no push. The **journal** is written once a day after 21:00, on a day the agent had messages, once the conversation has been quiet for half an hour: the agent keeps what it learned with its own memory and skill tools, then replies with three or four sentences written to you as "you" (told they were for you and itself, Haiku wrote about you in the third person and guessed a pronoun). The reply goes in its `journal` (the last 60, newest first, on its profile), shows in the conversation as "wrote in its journal" with its first sentence, and is the sidebar's line while the agent is idle. Both cost what the turn costs, towards its budget.
- **Telling agents apart** (`tools/lineup.mjs`, `tools/prompt-share.mjs`). The line-up runs six agents, one per role, on the models you give it, sends them the same five messages, anonymises and shuffles the replies, and has judges (three, on Sonnet 5.5 by default) match each to a role and rate how distinct the voices are, 1 to 5; it also measures how many word pairs the replies to each message share. In October 2026 (MUN-40), with judges matching every role in every run:

  | Line-up | Distinctness (of 5) | Word overlap between agents |
  |---|---|---|
  | All on Haiku 5.5 | 2.3 and 3.0 | 0.07 |
  | All on Haiku, with a lean capabilities section that made the soul 24% of the prompt instead of 16% | 3.0 | 0.07 |
  | Each role on its default model | 3.0 | 0.04 |
  | A different model family per role | 4.0 | 0.02 |

  So the model, not the prompt, is what sets voices apart, and new agents start on a maker the team doesn't use yet (`startingModel` in `web/runtime/roles.js`). The prompt stayed as it was.
- **The soul's history** (`soul.js`). Every version of an agent's brief and examples is kept, newest first, the last 30: who changed it (`you`; the agent; `munin`, for a role's newer words on start; or `null`, the version from before munin kept history), when and why. An agent proposes a change to its own with `propose_soul_change` (the whole new brief or examples, and why). It always asks, on an approval card of munin's own kind (`soul`, with what it was and what it would be) that has no "always": allowing it applies it and keeps a version by the agent; denying it leaves it. A proposal can only touch the brief and examples, has to stay under 2,000 and 1,500 characters, has to change something, and waits while another is open. Going back is `updateAgent` with an older version's brief and examples, and a `why`.
- **A passing expression**: an agent's `set_expression` tool puts `excited`, `happy` or `worried` on its Figbot for a minute, as `expression: { pose, until }` in its summary (null otherwise). Each change is an entry of munin's own kind (`munin.expression`), so the frontend hears of it, and one clears it after the minute. The frontend's `faceOf` (`web/figbot.js`) shows it in place of the status pose, except while the agent asks you something or is paused. The tool's calls aren't steps: the face is where it shows. On Sonnet 5.5 an agent set `worried` when told the build broke and nothing in small talk; Haiku 5.5 didn't use it in the same seven turns.
- **A reminder of who the agent is**: once a conversation has 40 messages, each request ends with a system message, for that request only, repeating the agent's name, role and the first paragraph of its brief, since a persona drifts as attention leaves the system prompt.
- **Decisions on approvals** reach the agent as entries of munin's own kind (`munin.decided`), so the card shows your decision and the conversation doesn't also show it as a message from you.
- **Memory** (`memory.js`) is notes in four kinds: about you (`you`), about how the work is done (`work`: commands, conventions, where things live), about how the agent works best (`self`), and about a teammate (`team`, with `about` naming them, 1,000 characters). Team notes show under each teammate in the prompt's team section, with a line asking the agent to judge a teammate's work on evidence, not on how sure they sound, and go when the teammate is deleted. `remember` takes a note and its kind; `change_note` and `forget_note` change or drop one by its id. Each kind has room for so many characters (1,500 for you and work, 1,000 for self, and one note under 300), and a note that doesn't fit is turned away with how full the kind is and how to make room: say two notes in one, or forget one that matters less. It says the notes are the agent's own to tidy, without asking, since Haiku told only how asked you which note to drop. That's how Hermes Agent's memory works, and it never rewrites a whole kind at once, since a model rewriting all of a memory can collapse it (ACE). Notes from before kinds are about you. All of them go into the agent's system prompt, each kind under its own heading with how full it is and each note with its id. The tools' calls show as action lines (remembered, changed a note, forgot), not as steps.
- **Routines** (`routines.js`, `schedule.js`, `watch.js`) run on a timer. A routine that's due becomes an input of munin's own kind (`munin.routine`), queued behind whatever the agent is doing (`whenBusy: "followUp"`), and shows in the conversation as "ran routine". A routine whose last run is still queued isn't queued again, a paused agent skips its routines, and a run the runtime missed while it was down still happens if it's less than 15 minutes late. For tracker triggers, the runtime reads the tracker's `events` feed every half minute with the agent's own token, starting from the moment the routine is first watched, and matches its lines without asking a model. A routine on `my issue` asks the tracker whose issue it is.
- **The tracker** (`tracker.js`) is an extension of the tracker's own MCP tools. The runtime lists them once, with any connected agent's token, and installs them; until the tracker answers, the extension is empty and agents are told it's away, and the runtime asks again every half minute. Each call goes out with the calling agent's token, so the tracker sees the agent by its name. The tracker's instructions and the agent's projects go into its system prompt. A few calls also land in the conversation:
  - `add_comment(…, ask_human=true)` becomes a question card with `trackerQuestion` set, so the frontend lists it once and an answer in either place answers both;
  - `update_issue` to a new status becomes an action line (took, sent to review, moved to Done, sent back, put back, cancelled), and a run started while the agent has an issue in progress belongs to that issue;
  - `create_issue` becomes "filed".
- **Worktrees** (`workspace.js`). The runtime keeps a clone of each project's repository, the hub (`MUNIN_REPOS_DIR`, `~/.munin/repos/<KEY>`), and each agent gets a clone of the hub in its own folder (`~/.munin/agents/forge/.repos/MUN`, objects copied rather than hardlinked). Before an agent opens a worktree, the hub fetches the project and collects every agent's issue branches (`mun-*`), and the agent's clone fetches them from it as `munin/<branch>`; pushes from an agent's clone go to the project. When a coder takes an issue, the runtime adds a worktree of its own clone in the agent's folder (`~/.munin/agents/forge/MUN-46`) on a branch named after the issue (`mun-46-stream-tool-output`), from the fetched base, and moves the agent's shell and file tools there before the agent reads the tracker's answer. Taking an issue again picks its branch up as the agent left it, and taking one someone else started carries on from their branch. A worktree from before agents had clones of their own belonged to the hub, so it moves to the agent's clone the next time it's opened, with anything uncommitted committed as "Work in progress" first. Commits in a worktree are the agent's (`user.name` is its name). An `open_worktree` tool goes back to one of the agent's own worktrees, or opens a detached copy of someone else's branch to review it, so a reviewer's commits never land on it. When an agent takes its next issue, its worktrees with nothing uncommitted whose branch is already in the base are removed. Agents' shells run with `GIT_PAGER=cat` and no prompts, since nobody is at their terminal. How work gets delivered (push, pull request, merge) is up to the project's brief.
- **Where coders' tools run** (`sandbox.js`). pi-durable asks the runtime for each tool call's environment. Without a sandbox it's `NodeExecutionEnv` on this machine, and munin's own `coding-tools` extension (pi-durable's, with the shell's environment chosen by a `prepare` hook) gives the shell harmless variables, `LC_*` and those named in `MUNIN_AGENT_ENV`, never the runtime's own. With `MUNIN_AGENT_SANDBOX=docker`, each coder gets a container (`MUNIN_AGENT_IMAGE`, `buildpack-deps:bookworm-scm` by default; `MUNIN_AGENT_NETWORK` to pick its network), started at its first tool call, running as your user id, with only its own folder mounted, at its own path, and pi-env's daemon inside: not munin's clones, nor other agents' folders. It shares the network of a firewall container (`<name>-net`, `alpine:3.20` with `NET_ADMIN`), whose rules reject this machine's addresses (the container's gateway, and `host.docker.internal` and `gateway.docker.internal` on Docker Desktop) and the tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48), but not the internet. The coder's container has no `NET_ADMIN` and runs as your user, so it can't undo them. A stopped firewall container is made again with its coder's, and `MUNIN_AGENT_NETWORK=none` skips it. pi-env's `RemoteExecutionEnv` reaches the daemon through `docker exec`, so reads, writes, edits and commands all happen in the container. Deleting the agent removes its container.
- **Usage** adds up the cost and tokens on each reply.
- **Models:** OpenRouter with a key pasted in Settings or `OPENROUTER_API_KEY`, an Ollama server with `MUNIN_OLLAMA_URL`, and always the stand-in, which answers without a model. An agent on a model the runtime can't reach runs on the stand-in until it can.

## What this version does

Real: agents and their settings, conversations with runs, questions with options, ask-first approvals with undo, coding tools, a worktree and a branch per issue, the tracker for coders and reviewers, routines on a schedule or a tracker trigger, memory, meetings (MUN-43), pause and resume, usage and cost per issue, models, the live stream, and everything surviving a restart.

An agent in the tracker starts work when you tell it to, from its projects in the ABOUT panel, or when a routine says so: "Weekdays 09:00: continue the MUN project" keeps a coder on the pile, and "When an issue moves to In review" puts a reviewer on what lands. It keeps going until `wait_for_work` says there's nothing left.

Stored but not acted on yet, next roughly in this order:

1. **Mail and calendar routines** (MUN-9). **Apps that run as a local command** (stdio MCP servers, MUN-27), not only over HTTP. **Search fees** in usage and budgets.
