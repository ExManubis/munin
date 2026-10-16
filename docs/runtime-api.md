# The agent runtime's API

What the frontend needs from the agent runtime, worked out by building the Agents screens on a mock first. The mock is `web/runtime/mock.js`; every function it exports is listed here with the HTTP endpoint the real runtime should serve for it. `web/runtime/index.js` is where the frontend picks the mock or the real client. Both have the same functions, so the screens don't change when the runtime arrives.

The runtime serves this under `/runtime/api`, behind the same edge as the tracker (see `architecture.md`). Times are ISO 8601 in UTC. Errors are `{"detail": "…"}` with 404, 409 or 422, like the tracker's.

## Agents

| Mock | HTTP | Does |
|---|---|---|
| `me()` | `GET /runtime/api/me` | The runtime's version and its providers. The frontend shows the Agents tab only when this answers |
| `agents()` | `GET /runtime/api/agents` | Every agent, as a summary |
| `agent(name)` | `GET /runtime/api/agents/{name}` | One agent in full |
| `createAgent(fields)` | `POST /runtime/api/agents` | `{name, role, colour, provider, model, brief}` |
| `updateAgent(name, patch)` | `PATCH /runtime/api/agents/{name}` | Any of `role, colour, provider, model, thinking, brief, abilities, apps, budget`, and `askFirst` as `{rule: on}` |
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
  "provider": "openrouter", "model": "opus-5.5"
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
  "worksIn": { "folder": "~/agents/forge/munin", "branch": "mun-46-stream" },  // when it can code
  "tracker": { "projects": ["MUN", "WEB"], "takes": "issues" },              // when it uses the tracker
  "createdAt": "…",
  "run": { "id": "i42", "issue": Issue, "startedAt": "…", "step": "Editing gateway/telegram.py" }  // or null
}
```

An agent's name is also its name in the tracker. That's how the frontend joins the two.

## Conversations

| Mock | HTTP | Does |
|---|---|---|
| `conversation(name)` | `GET /runtime/api/agents/{name}/conversation` | `{agent, items}`, oldest first. The real one pages with `?before=` |
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
| `addRoutine(name, routine)` | `POST /runtime/api/agents/{name}/routines` | |
| `updateRoutine(name, id, fields)` | `PATCH /runtime/api/agents/{name}/routines/{id}` | |
| `deleteRoutine(name, id)` | `DELETE /runtime/api/agents/{name}/routines/{id}` | |
| `forget(name, noteId)` | `DELETE /runtime/api/agents/{name}/memory/{id}` | |
| `providers()` | `GET /runtime/api/providers` | `[{id, name, connected, detail}]`; setting one up is still to design |

A **routine** starts on a schedule or a trigger:

```jsonc
{ "id": "r3", "name": "Paul first", "trigger": "mail",            // schedule | mail | calendar | tracker
  "when": "When mail from Paul Eriksen arrives", "does": "Tell me right away and draft a reply.",
  "next": null, "last": "…" }                                     // next for schedules, last for triggers
```

Roles, abilities, apps, providers and models are fixed lists in `web/runtime/roles.js` for now. The runtime should serve them, at `GET /runtime/api/roles` and `GET /runtime/api/models`, so a new provider's models show up without a frontend change.

## Live updates

`GET /runtime/api/stream` is a server-sent event stream that says `changed`, like the tracker's `/api/stream`; the mock calls `subscribe(fn)` instead. It should number its events so a reconnecting client can ask for what it missed (`Last-Event-ID`). The Claudewitz daemon does this, and it matters on a phone that keeps dropping off.

## What the tracker needs for this

The screens need a few things from the tracker. Every agent can use all of them, so it stays agent-agnostic:

1. **Questions with options.** `add_comment(…, ask_human=true)` takes optional `options` (label and detail), and the tracker inbox shows them as option cards, like the conversation does. Today the inbox only takes free text.
2. **The question's id back.** `add_comment` returns the comment's id, so an agent (or the runtime) can tie its question to the tracker's copy. That's `trackerQuestion` above; the mock fakes it.
3. **An event feed over MCP.** Routines that start "when an issue moves", and agents hearing your answer without polling `wait_for_work`, both need one. It would be a tool or a resource that returns events after a given id.

## Building it on pi-durable

Most of this maps straight onto pi-durable:

- **A conversation** is a pi-durable conversation, one per agent, in the runtime's SQLite file.
- **Messages and runs** come from its entries and tasks.
  - `pi.user` and `pi.assistant` text become messages.
  - A run is the generation and tool tasks from one input to its answer.
  - Each tool call becomes a step, and the tool's `details` give the step's detail line.
- **Actions** are tool calls the agent's extension marks as worth showing (sent mail, took an issue), written as entries of munin's own kind, like `munin.action`.
- **Questions and approvals** are munin entry kinds too.
  - An approval comes from a `beforeTool` hook that blocks a tool switched on under "ask me first" and waits for the decision.
  - "Always allow" switches that rule off for later calls.
- **Steering:** `send` while a run is going is `submit({ whenBusy: "steer" })`.
- **Usage** comes from the conversation's `pi.usage` document. The budget is a hook that pauses the agent at the limit.
- **Brief, model and abilities** live in the conversation's `pi.agent` document (instructions, model, extensions).
