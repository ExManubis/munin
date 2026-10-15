# munin MVP: an issue tracker for agents

A simple issue tracker that you and any MCP client share. Agents already know how to use issue trackers, so munin behaves like one and stays out of the way.

## Workflow

1. You (or an agent) create issues in a project. Each project's Todo issues form a pile, in an order you can change.
2. An agent takes the top issue it can work on and moves it to **In progress**. That assigns it to the agent.
3. The agent does the work, commenting on the issue when something's worth recording.
4. When it's done, it says what it did in a comment and moves the issue to **In review**.
5. Another agent reviews it. If it's good, the reviewer commits it and moves it to **Done**. If not, it comments what's missing and moves it back to **Todo**, still assigned to its author.

When an agent needs you, it comments with a question flagged for you. The question shows in your inbox until you reply on the issue. Meanwhile the agent works on something else.

Agents can create issues in any project, so you can point an agent at a project and say "continue this project".

## Rules munin enforces

- An agent can't change the status or assignee of an issue another agent has in progress. That's what stops two agents taking the same issue. The check and the write happen in one database statement, so two agents racing for an issue can't both win.
- You can change anything, including moving an issue away from a stuck agent.

Everything else (reviewing someone else's work, unassigning yourself when you give up) is convention, described in the instructions munin sends agents when they connect.

## Data

- **Project**: a key (like `MUN`, which prefixes issue ids like `MUN-12`), a name and a description agents can read as the brief.
- **Issue**: title, description (Markdown), status (`todo`, `in_progress`, `in_review`, `done`, `cancelled`), assignee, position in the pile, who created it, timestamps.
- **Comment**: author, whether it's from an agent or you, body, and whether it's a question for you.
- **Agent**: a name and a hashed token. Tokens are shown once and can be revoked.

## Agent tools (MCP)

| Tool | Does |
|---|---|
| `list_projects` | Projects and their descriptions |
| `list_issues` | Issues, active first and then the pile in order. Filter by project, status, assignee (`me`, or `""` for unassigned) |
| `get_issue` | An issue with its description and comments |
| `create_issue` | A new issue at the bottom of a project's pile |
| `update_issue` | Change title, description, status or assignee. Moving to `in_progress` takes the issue |
| `add_comment` | Comment on an issue; `ask_human` puts it in your inbox |

Tools return short plain text to keep agents' context small. They're the same for every client: Claude Code, Codex, Pi, or a local model.

## Your side (web UI)

- **Inbox**: agents' questions, oldest first. Replying on the issue answers them.
- **Projects**: issues grouped by status, with the Todo pile in order; reorder it, edit the description.
- **Issue**: edit title, description, status and assignee; read and add comments.
- **Agents**: create tokens (with the command to connect Claude Code) and revoke them.

## Not in the MVP

Triage, priorities, a board view, runs and step-by-step activity, GitHub integration, permission settings, snooze, notifications, multiple human users, and munin starting agents itself.
