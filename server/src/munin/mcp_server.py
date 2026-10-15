"""The MCP server agents connect to. Tools return short plain text, to keep agents' context small."""

import functools
import inspect
import time
from collections.abc import Callable
from datetime import timedelta
from typing import Annotated, Literal

import anyio
import anyio.to_thread
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import Field
from sqlalchemy.orm import Session, sessionmaker

from munin import agents
from munin import issues as svc
from munin.issues import Actor, MuninError
from munin.models import Comment, Issue, utcnow

INSTRUCTIONS = """\
Munin is an issue tracker shared by you, other agents and a human.

How to work:
1. Call list_projects first. It tells you your name in munin, and each project's description
   is the brief: what to build and how work is delivered, for example which branch to commit to.
2. Take the top issue from the pile: list_issues(project, status="todo") lists the pile in order.
   Take one that's unassigned or assigned to you with update_issue(issue, status="in_progress").
   If another agent already has it, munin says so; take the next one.
3. Do the work. Comment on the issue when something's worth recording.
4. When you're done, add a comment saying what you did, then set status="in_review".
5. Review issues other agents finished: check the work, commit it and set status="done",
   or comment what's missing and set status="todo" so its author picks it up again.
   Don't review your own work.

Planning: when the pile is empty, you can create issues that move the project toward its
description. Check list_issues(project, status="all") first so you don't duplicate anything.
When one issue needs another finished first, set blocked_by: nobody can take it until its
blockers are done, so agents working in parallel don't trip over each other.
Set duplicates and issues that aren't needed to status="cancelled".

The human reads munin, not your session. To ask them something, use
add_comment(issue, question, ask_human=true) and work on something else meanwhile; their reply
appears in the issue's comments. If you give up on an issue, comment why and set status="todo"
and assignee="none".

Before you stop: if nothing is available to you right now but other agents are still working on
the project, call wait_for_work(project). It returns as soon as there's something for you (an
issue to take, work to review, an answer from the human), and tells you when there's nothing
left worth waiting for.
"""
# How long the project can sit still before wait_for_work stops suggesting more waiting.
QUIET_FOR = timedelta(minutes=15)
# Another agent seen this recently might still review your work or take what's queued for it.
OTHERS_AROUND = timedelta(minutes=5)

Status = Literal["todo", "in_progress", "in_review", "done", "cancelled"]
IssueRef = Annotated[str, Field(description="Issue id, like MUN-12")]


def build_mcp(sessions: sessionmaker[Session]) -> MCPServer:
    mcp = MCPServer(name="munin", instructions=INSTRUCTIONS)

    def tool(fn: Callable) -> Callable:
        """Register fn as a tool, with munin errors shown to the agent as tool errors."""
        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def wrapper(*args, **kwargs):
                try:
                    return await fn(*args, **kwargs)
                except MuninError as error:
                    raise ToolError(str(error)) from error
        else:

            @functools.wraps(fn)
            def wrapper(*args, **kwargs):
                try:
                    return fn(*args, **kwargs)
                except MuninError as error:
                    raise ToolError(str(error)) from error

        # Plain text only: a structured copy of each result would double what agents read.
        mcp.add_tool(wrapper, structured_output=False)
        return wrapper

    @tool
    def list_projects(ctx: Context) -> str:
        """List projects with their descriptions, which are the brief for working on them.

        A project's key prefixes its issue ids, like MUN in MUN-12. Also says what your name is in munin.
        """
        you = f"You are {_actor(ctx).name} in munin."
        with sessions() as s:
            projects = svc.list_projects(s)
            if not projects:
                return f"{you}\nNo projects yet. Ask the human to create one."
            return "\n\n".join([you, *(f"{p.key}: {p.name}\n{p.description.strip()}".strip() for p in projects)])

    @tool
    def list_issues(
        ctx: Context,
        project: Annotated[str | None, Field(description="Project key, like MUN. Omit for all projects.")] = None,
        status: Annotated[
            Status | Literal["all"] | None,
            Field(description="Only issues with this status. Omit for open issues (todo, in progress, in review)."),
        ] = None,
        assignee: Annotated[
            str | None, Field(description='Only issues assigned to this name. "me" is you, "none" is unassigned.')
        ] = None,
        query: Annotated[
            str | None, Field(description="Words to look for in titles and descriptions, or an issue id.")
        ] = None,
        limit: Annotated[int, Field(ge=1, le=200)] = 50,
    ) -> str:
        """List issues, most active first and then in pile order (the top of the pile comes first)."""
        if assignee == "me":
            assignee = _actor(ctx).name
        with sessions() as s:
            found = svc.list_issues(s, project, status, assignee, limit, query)
            if not found:
                return "No issues match."
            return "\n".join(_issue_line(issue) for issue in found)

    @tool
    def get_issue(issue: IssueRef) -> str:
        """Get an issue with its description, what it waits for, its history and comments."""
        with sessions() as s:
            return _issue_text(svc.get_issue(s, issue))

    @tool
    def create_issue(
        ctx: Context,
        project: Annotated[str, Field(description="Project key, like MUN")],
        title: str,
        description: Annotated[str, Field(description="Markdown. Say what done looks like.")] = "",
        status: Status = "todo",
        assignee: Annotated[str | None, Field(description="Agent or person to do it. Omit for anyone.")] = None,
        blocked_by: Annotated[
            list[str] | None, Field(description="Issues that must be done before anyone can start this one.")
        ] = None,
    ) -> str:
        """Create an issue. It goes to the bottom of the project's pile."""
        with sessions() as s:
            created = svc.create_issue(s, _actor(ctx), project, title, description, status, assignee, blocked_by)
            reply = f"Created {created.ref}: {created.title}"
            if similar := svc.similar_open_issues(s, created):
                reply += "\nThese open issues look similar. If it duplicates one, set it to cancelled:\n"
                reply += "\n".join(_issue_line(issue) for issue in similar)
            return reply

    @tool
    def update_issue(
        ctx: Context,
        issue: IssueRef,
        title: str | None = None,
        description: str | None = None,
        status: Status | None = None,
        assignee: Annotated[str | None, Field(description='New assignee, or "none" to unassign.')] = None,
        blocked_by: Annotated[
            list[str] | None, Field(description="Replaces what this issue waits for. [] clears it.")
        ] = None,
    ) -> str:
        """Change an issue. Setting status="in_progress" takes the issue and assigns it to you.

        Fails if another agent has the issue in progress, or if it's blocked by issues that aren't done.
        """
        changes = {"title": title, "description": description, "status": status, "blocked_by": blocked_by}
        if assignee is not None:
            changes["assignee"] = assignee
        with sessions() as s:
            updated = svc.update_issue(s, _actor(ctx), issue, **changes)
            return f"Updated {_issue_line(updated)}"

    @tool
    def add_comment(
        ctx: Context,
        issue: IssueRef,
        body: Annotated[str, Field(description="Markdown")],
        ask_human: Annotated[
            bool, Field(description="True if this is a question for the human. It shows in their inbox.")
        ] = False,
    ) -> str:
        """Comment on an issue."""
        with sessions() as s:
            comment = svc.add_comment(s, _actor(ctx), issue, body, ask_human)
            return f"Commented on {comment.issue.ref}" + (" and asked the human." if comment.asks_human else ".")

    @tool
    async def wait_for_work(
        ctx: Context,
        project: Annotated[str, Field(description="Project key, like MUN")],
        seconds: Annotated[int, Field(ge=1, le=55, description="How long to wait before returning anyway.")] = 50,
    ) -> str:
        """Wait until there's something in the project for you: an issue to take, someone else's work to
        review, or an answer from the human. Returns right away if there already is, or if nothing's left to
        wait for. Call it again to keep waiting."""
        agent = _actor(ctx).name
        deadline = time.monotonic() + seconds
        while True:
            answer, still_going = await anyio.to_thread.run_sync(_look_for_work, sessions, agent, project)
            if answer:
                return answer
            if time.monotonic() >= deadline:
                return f"Nothing for you yet. Still going on:\n{still_going}\nCall wait_for_work again to keep waiting."
            await anyio.sleep(min(2, max(0.1, deadline - time.monotonic())))

    @mcp.prompt(name="continue", description="Point this agent at a munin project and let it carry on.")
    def continue_project(project: Annotated[str, Field(description="Project key, like MUN")]) -> str:
        return (
            f"Continue the {project} project in munin. Start with list_projects to read its brief, "
            "then take, do and review issues until there's nothing left for you to do."
        )

    @mcp.prompt(name="work_on", description="Have this agent work on one munin issue.")
    def work_on(issue: IssueRef) -> str:
        return (
            f"Work on {issue} in munin. Read it with get_issue and its project's brief with list_projects, "
            "take it, do it, and move it to review when you're done."
        )

    return mcp


def _actor(ctx: Context) -> Actor:
    # Set by the token check in front of /mcp (see app.py).
    return Actor(name=ctx.request_context.request.state.agent, kind="agent")


def _look_for_work(sessions: sessionmaker[Session], agent: str, project: str) -> tuple[str | None, str]:
    """An answer for wait_for_work if there's work or nothing worth waiting for, else what's still going on."""
    key = project.strip().upper()
    with sessions() as s:
        available = svc.available_work(s, agent, key)
        if available:
            return _available_text(available), ""
        issues = svc.list_issues(s, key)
        others_working = [i for i in issues if i.status == "in_progress" and i.assignee not in (None, agent)]
        questions = [i for i in issues if svc.waiting_on_human(i)]
        my_reviews = [i for i in issues if i.status == "in_review" and i.assignee == agent]
        queued = [i for i in issues if i.status == "todo" and i.assignee not in (None, agent)]
        going_on = list(dict.fromkeys(others_working + questions + my_reviews + queued))
        if not going_on:
            return f"Nothing in {key} is in progress or waiting for review, so there's nothing to wait for.", ""
        others_around = any(
            a.name != agent and a.last_seen_at and utcnow() - a.last_seen_at < OTHERS_AROUND
            for a in agents.list_agents(s)
        )
        if not (others_working or questions or others_around):
            minutes = int(OTHERS_AROUND.total_seconds() // 60)
            return (
                f"No other agent has been in touch for {minutes} minutes, so nobody is around to pick these up:\n"
                + "\n".join(_issue_line(issue) for issue in going_on)
                + "\nStop here. They'll wait for the next agent (your own work needs someone else to review it)."
            ), ""
        last = svc.last_activity(s, key)
        if last and utcnow() - last > QUIET_FOR:
            minutes = int((utcnow() - last).total_seconds() // 60)
            return f"Nothing has happened in {key} for {minutes} minutes. Stop unless you know more is coming.", ""
        return None, "\n".join(_issue_line(issue) for issue in going_on)


def _available_text(available: svc.Available) -> str:
    sections = [
        ("Ready to take (top of the pile first):", available.take),
        ("Waiting for review (not your own work):", available.review),
        ("The human answered you on:", available.answered),
    ]
    return "\n\n".join(
        "\n".join([title, *(_issue_line(issue) for issue in found)]) for title, found in sections if found
    )


def _issue_line(issue: Issue) -> str:
    parts = [f"{issue.ref} [{issue.status}]", issue.title]
    if issue.assignee:
        parts.append(f"(assignee: {issue.assignee})")
    if svc.waiting_on_human(issue):
        parts.append("(waiting on the human)")
    if issue.status not in svc.CLOSED_STATUSES and (waiting_for := svc.open_blockers(issue)):
        parts.append(f"(blocked by {', '.join(blocker.ref for blocker in waiting_for)})")
    return " ".join(parts)


def _issue_text(issue: Issue) -> str:
    lines = [
        f"{issue.ref}: {issue.title}",
        f"Project: {issue.project.key} · Status: {issue.status} · Assignee: {issue.assignee or 'none'}"
        f" · Created by {issue.created_by} {_when(issue.created_at)}",
        "",
        issue.description or "(no description)",
    ]
    if issue.blocked_by:
        lines += ["", "Waits for:"] + [_issue_line(blocker) for blocker in issue.blocked_by]
    if issue.blocks:
        lines += ["", "Blocks:"] + [_issue_line(blocked) for blocked in issue.blocks]
    if issue.events:
        lines += ["", "History:"]
        lines += [f"{_when(event.created_at)}  {svc.describe_event(event)}" for event in issue.events[-12:]]
    if issue.comments:
        lines += ["", "Comments:"]
        lines += [_comment_text(comment) for comment in issue.comments]
    return "\n".join(lines)


def _comment_text(comment: Comment) -> str:
    asks = " (question for the human)" if comment.asks_human else ""
    return f"\n{comment.author} ({comment.author_kind}), {_when(comment.created_at)}{asks}:\n{comment.body}"


def _when(moment) -> str:
    return moment.strftime("%Y-%m-%d %H:%M UTC")
