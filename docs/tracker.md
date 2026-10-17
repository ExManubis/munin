# The tracker

munin's issue tracker: a simple tracker that you and any MCP client share. Agents already know how to use issue trackers, so it behaves like one and stays out of the way. It knows nothing about which agents use it or how they run; `architecture.md` says how it fits into the rest of munin.

## Workflow

1. You (or an agent) create issues in a project. Each project's Todo issues form a pile, in an order you can change.
2. An agent takes the top issue it can work on and moves it to **In progress**. That assigns it to the agent.
3. The agent does the work, commenting on the issue when something's worth recording.
4. When it's done, it says what it did in a comment and moves the issue to **In review**.
5. Another agent reviews it. If it's good, the reviewer commits it and moves it to **Done**. If not, it comments what's missing and moves it back to **Todo**, still assigned to its author.

When an agent needs you, it comments with a question flagged for you. The question shows in your inbox until you reply on the issue. Meanwhile the agent works on something else.

When nothing is available to an agent right now (everything left waits for work in progress or in review), it waits for work instead of stopping, so a chain of dependent issues keeps moving with several agents on it.

Agents can create issues in any project, so you can point an agent at a project and say "continue this project". When they plan, they say what each issue waits for, so agents working in parallel take issues in a sensible order.

## Rules the tracker enforces

- An agent can't change the status or assignee of an issue another agent has in progress. That's what stops two agents taking the same issue. The check and the write happen in one database statement, so two agents racing for an issue can't both win.
- An agent can't start an issue while it waits for issues that aren't done (or cancelled) yet.
- You can change anything, including moving an issue away from a stuck agent.

Everything else (reviewing someone else's work, unassigning yourself when you give up) is convention, described in the instructions munin sends agents when they connect.

## Data

- **Project**: a key (like `MUN`, which prefixes issue ids like `MUN-12`), a name and a description agents can read as the brief.
- **Issue**: title, description (Markdown), status (`todo`, `in_progress`, `in_review`, `done`, `cancelled`), priority (`urgent`, `high`, `normal` or `low`; an agent takes an urgent issue first, wherever it is in the pile, and urgent and high show as a chip), assignee, position in the pile, the issues it waits for, who created it, timestamps.
- **Event**: one line of an issue's history: created, moved, assigned, renamed, edited, what it waits for. Every comment is an event too, so the event feed has them in order.
- **Pull request**: a pull request on GitHub that carries an issue's work, with its title and whether it's open, merged or closed. munin asks GitHub every two minutes (`MUNIN_GITHUB_POLL`) about the pull requests of issues that aren't finished. Public repositories need no token; for private ones, add a fine-grained token with read access to pull requests in Settings. It's kept in `github.json` next to the database, readable by the tracker's user only, and never shown again.
- **Comment**: author, whether it's from an agent or you, body, whether it's a question for you, and the options it offers.
- **Agent**: a name and a hashed token. Tokens are shown once and can be revoked.

## Agent tools (MCP)

| Tool | Does |
|---|---|
| `list_projects` | Projects and their descriptions |
| `create_project` | A new project, with a key, a name and a description that's its brief. For work that belongs to none of the existing ones |
| `update_project` | Rename a project or rewrite its description, the brief every agent reads |
| `list_issues` | Issues, active first and then the pile in order. Filter by project, status, assignee (`me`, or `none` for unassigned) or a search query. Says what each issue is blocked by |
| `get_issue` | An issue with its description, what it waits for and blocks, its history and comments |
| `create_issue` | A new issue at the bottom of a project's pile, optionally waiting for others. Points out open issues with similar titles, so parallel agents notice duplicates |
| `update_issue` | Change title, description, status, assignee or what it waits for. Moving to `in_progress` takes the issue |
| `link_pull_request` | Link a pull request on GitHub to an issue, by its URL. Says its title and state when GitHub knows it |
| `add_comment` | Comment on an issue; `ask_human` puts it in your inbox, optionally with 2 to 6 `options` to pick from. Returns the comment's id |
| `events` | What happened in the tracker, oldest first: issues created, moved, assigned and edited, and comments, your answers included. Pass the last id seen as `after` for only what's new |
| `wait_for_work` | Waits up to 50 seconds for something the agent can do in a project: an issue to take, someone else's work to review, an answer from you. Says when there's nothing left worth waiting for |

Tools return short plain text to keep agents' context small. They're the same for every client: Claude Code, Codex, Pi, or a local model. Two prompts, `continue` (a project) and `work_on` (an issue), show up as slash commands in clients that support MCP prompts.

## Your side

The web UI updates live as agents work.

- **Inbox**: agents' questions, oldest first, with the issue for context. Replying on the issue answers them. Below them, "Lately": what agents have been doing, with what's new since you last looked marked.
- **Projects**: the brief agents read, then issues grouped by status with the Todo pile in order (reorder it by dragging), or as a board. "Put an agent on it" has the commands to start one.
- **Issue**: title, description, status, assignee, linked pull requests (paste a URL to link one), what it waits for and blocks, and one timeline of comments and history. An issue whose agent has gone quiet can be released.
- **Agents**: tokens (created once, revocable), and what each agent is working on.
- **Everywhere**: Ctrl/Cmd+K to jump to anything, `?` for shortcuts, the number of questions in the tab title, and opt-in push notifications that reach your devices with munin closed (in a browser without push, notifications while munin is open). It works on a phone and can be installed there.
- **Setup**: the first time munin opens, an intro and then four short steps: what agents call you, an OpenRouter key and your favourite models, your first agent, and a token for outside agents over MCP. It ends on your agent, waiting for its first message. Settings opens it again.

From a terminal:

- `munin status`: what's waiting on you and what agents are doing.
- `munin run KEY --agents 2`: start agents on a project and watch them work.
- `munin demo`: look around a sample project in a throwaway database.

## Not yet

Moving an issue when its pull requests merge, permission settings, snooze, and multiple human users.
