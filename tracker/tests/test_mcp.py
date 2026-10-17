"""Talks to a real munin over HTTP with the MCP SDK's client, the way an agent would."""

import json
import time

import anyio
import httpx2
import pytest
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client

from munin import agents, api
from munin import issues as svc
from munin.db import connect

from conftest import HUMAN


async def call(url: str, token: str | None, *calls: tuple[str, dict]) -> list[tuple[bool, str]]:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    async with httpx2.AsyncClient(headers=headers) as http:
        async with streamable_http_client(url, http_client=http) as (read, write, *_):
            async with ClientSession(read, write) as session:
                await session.initialize()
                results = []
                for name, arguments in calls:
                    result = await session.call_tool(name, arguments)
                    results.append((result.is_error, result.content[0].text))
                return results


def run(*args):
    return anyio.run(call, *args)


def test_tools_and_instructions(server):
    url, tokens, _ = server

    async def inspect():
        async with httpx2.AsyncClient(headers={"Authorization": f"Bearer {tokens['codex']}"}) as http:
            async with streamable_http_client(url, http_client=http) as (read, write, *_):
                async with ClientSession(read, write) as session:
                    init = await session.initialize()
                    tools = await session.list_tools()
                    return init.instructions, [t.name for t in tools.tools]

    instructions, names = anyio.run(inspect)
    assert "top issue from the pile" in instructions
    assert names == [
        "list_projects",
        "create_project",
        "update_project",
        "list_issues",
        "get_issue",
        "create_issue",
        "update_issue",
        "add_comment",
        "events",
        "wait_for_work",
    ]


def test_take_work_review_and_ask(server):
    url, tokens, settings = server
    results = run(
        url,
        tokens["claude-code"],
        ("list_projects", {}),
        ("list_issues", {"project": "MUN", "status": "todo"}),
        ("update_issue", {"issue": "MUN-1", "status": "in_progress"}),
        ("add_comment", {"issue": "MUN-1", "body": "Which database?", "ask_human": True}),
        ("list_issues", {"assignee": "me"}),
        ("create_issue", {"project": "MUN", "title": "Retry failed tool calls once"}),
        ("create_issue", {"project": "MUN", "title": "Retry a failed tool call once before asking"}),
        ("update_issue", {"issue": "MUN-1", "status": "in_review"}),
    )
    assert all(not is_error for is_error, _ in results), results
    texts = [text for _, text in results]
    assert texts[0] == "You are claude-code in munin.\n\nMUN: munin\nThe tracker itself"
    assert texts[1] == "MUN-1 [todo] First\nMUN-2 [todo] Second"
    assert texts[2] == "Updated MUN-1 [in_progress] First (assignee: claude-code)"
    assert texts[4] == "MUN-1 [in_progress] First (assignee: claude-code) (waiting on the human)"
    assert texts[5] == "Created MUN-3: Retry failed tool calls once"
    assert texts[6] == (
        "Created MUN-4: Retry a failed tool call once before asking\n"
        "These open issues look similar. If it duplicates one, set it to cancelled:\n"
        "MUN-3 [todo] Retry failed tool calls once"
    )

    with connect(settings.db_path)() as s:
        assert [c.body for c in svc.inbox(s)] == ["Which database?"]
        assert svc.get_issue(s, "MUN-3").created_by == "claude-code"

    is_error, text = run(url, tokens["codex"], ("get_issue", {"issue": "MUN-1"}))[0]
    assert not is_error
    assert "Status: in_review · Assignee: claude-code" in text
    assert "claude-code (agent)" in text and "(question for the human):\nWhich database?" in text


def test_an_agent_cannot_take_an_issue_another_agent_has(server):
    url, tokens, _ = server
    run(url, tokens["claude-code"], ("update_issue", {"issue": "MUN-1", "status": "in_progress"}))
    is_error, text = run(url, tokens["codex"], ("update_issue", {"issue": "MUN-1", "status": "in_progress"}))[0]
    assert is_error
    assert "MUN-1 is in progress by claude-code" in text


def test_errors_reach_the_agent(server):
    url, tokens, _ = server
    is_error, text = run(url, tokens["codex"], ("get_issue", {"issue": "MUN-99"}))[0]
    assert is_error and "No issue MUN-99." in text


@pytest.mark.parametrize("token", [None, "mun_wrong"])
def test_requests_without_a_valid_token_are_refused(server, token):
    url, _, _ = server
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    response = httpx2.post(url, headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert response.status_code == 401


def test_revoked_tokens_stop_working(server):
    url, tokens, settings = server
    with connect(settings.db_path)() as s:
        agents.revoke_agent(s, "codex")
    response = httpx2.post(url, headers={"Authorization": f"Bearer {tokens['codex']}"}, json={})
    assert response.status_code == 401


def test_dependencies_through_mcp(server):
    url, tokens, _ = server
    results = run(
        url,
        tokens["claude-code"],
        ("create_issue", {"project": "MUN", "title": "Wire it up", "blocked_by": ["MUN-1", "MUN-2"]}),
        ("list_issues", {"project": "MUN", "status": "todo"}),
        ("update_issue", {"issue": "MUN-3", "status": "in_progress"}),
        ("update_issue", {"issue": "MUN-3", "blocked_by": ["MUN-1"]}),
        ("get_issue", {"issue": "MUN-3"}),
    )
    texts = [text for _, text in results]
    assert texts[1].splitlines()[-1] == "MUN-3 [todo] Wire it up (blocked by MUN-1, MUN-2)"
    assert results[2] == (
        True,
        "Error executing tool update_issue: MUN-3 is blocked by MUN-1, MUN-2, which isn't "
        "done yet. Take another issue.",
    )
    assert "Waits for:\nMUN-1 [todo] First" in texts[4]
    assert "History:" in texts[4] and "claude-code set it to wait for MUN-1" in texts[4]


def test_prompts(server):
    url, tokens, _ = server

    async def prompts():
        async with httpx2.AsyncClient(headers={"Authorization": f"Bearer {tokens['codex']}"}) as http:
            async with streamable_http_client(url, http_client=http) as (read, write, *_):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    listed = await session.list_prompts()
                    got = await session.get_prompt("continue", {"project": "MUN"})
                    return [p.name for p in listed.prompts], got.messages[0].content.text

    names, text = anyio.run(prompts)
    assert names == ["continue", "work_on"]
    assert text.startswith("Continue the munin project (MUN) in munin.")


def sse(lines, count: int) -> list[dict]:
    """The next `count` server-sent events as {id, event, data}, skipping comments and the retry line."""
    found, current = [], {}
    while len(found) < count:
        line = next(lines)
        if not line:
            if current:
                found.append(current)
            current = {}
        elif not line.startswith((":", "retry:")):
            field, _, value = line.partition(": ")
            current[field] = value
    return found


def test_the_web_ui_hears_about_changes_numbered_and_catches_up(server, monkeypatch):
    url, tokens, settings = server
    base = url.removesuffix("/mcp")
    with connect(settings.db_path)() as s:
        start = max(e.id for e in svc.events_after(s, None, 200))

    with httpx2.stream("GET", f"{base}/api/stream", timeout=5) as response:
        lines = response.iter_lines()
        assert next(lines) == "retry: 3000"
        assert sse(lines, 1) == [{"id": str(start)}], "numbered from the newest event"
        run(url, tokens["claude-code"], ("add_comment", {"issue": "MUN-1", "body": "Hello"}))
        (event,) = sse(lines, 1)
    assert (event["id"], event["event"]) == (str(start + 1), "changed")
    said = json.loads(event["data"])
    assert (said["id"], said["kind"], said["actor"], said["issue"]["id"], said["project"]) == (
        start + 1, "comment", "claude-code", "MUN-1", "MUN")

    # Missed while away: a reconnect that says where it was gets them, in order.
    run(url, tokens["codex"], ("update_issue", {"issue": "MUN-2", "status": "in_progress"}))
    headers = {"Last-Event-ID": event["id"]}
    with httpx2.stream("GET", f"{base}/api/stream", headers=headers, timeout=5) as response:
        missed = sse(response.iter_lines(), 2)
    assert [(e["id"], json.loads(e["data"])["kind"]) for e in missed] == [
        (str(start + 2), "status"), (str(start + 3), "assignee")]

    # Missed too much to send: reload everything.
    monkeypatch.setattr(api, "REPLAY_LIMIT", 1)
    with httpx2.stream("GET", f"{base}/api/stream", headers=headers, timeout=5) as response:
        (reset,) = sse(response.iter_lines(), 1)
    assert (reset["event"], reset["id"]) == ("reset", str(start + 3))


def test_wait_for_work(server):
    url, tokens, settings = server
    claude, codex = tokens["claude-code"], tokens["codex"]

    # Work is already there: it says so straight away.
    ((_, text),) = run(url, claude, ("wait_for_work", {"project": "MUN"}))
    assert text == "Ready to take (top of the pile first):\nMUN-1 [todo] First\nMUN-2 [todo] Second"

    # Nothing to take, but codex is busy: wait, and hear about its work as soon as it's ready for review.
    with connect(settings.db_path)() as s:
        svc.update_issue(s, HUMAN, "MUN-2", blocked_by=["MUN-1"])
    run(url, codex, ("update_issue", {"issue": "MUN-1", "status": "in_progress"}))
    ((_, text),) = run(url, claude, ("wait_for_work", {"project": "MUN", "seconds": 1}))
    assert text.startswith("Nothing for you yet. Still going on:\nMUN-1 [in_progress] First (assignee: codex)")

    async def wait_while_codex_finishes():
        async with anyio.create_task_group() as tasks:
            results = []

            async def waiting():
                results.extend(await call(url, claude, ("wait_for_work", {"project": "MUN", "seconds": 20})))

            tasks.start_soon(waiting)
            await anyio.sleep(1)
            await call(url, codex, ("update_issue", {"issue": "MUN-1", "status": "in_review"}))
        return results

    started = time.monotonic()
    ((_, text),) = anyio.run(wait_while_codex_finishes)
    assert time.monotonic() - started < 10
    assert text == "Waiting for review (not your own work):\nMUN-1 [in_review] First (assignee: codex)"

    # When everything's done there's nothing to wait for.
    with connect(settings.db_path)() as s:
        for ref in ("MUN-1", "MUN-2"):
            svc.update_issue(s, HUMAN, ref, status="done")
    ((_, text),) = run(url, claude, ("wait_for_work", {"project": "MUN"}))
    assert text == "Nothing in MUN is in progress or waiting for review, so there's nothing to wait for."


def test_wait_for_work_hears_answers(server):
    url, tokens, settings = server
    run(
        url,
        tokens["claude-code"],
        ("update_issue", {"issue": "MUN-1", "status": "in_progress"}),
        ("update_issue", {"issue": "MUN-2", "status": "in_progress"}),
        ("add_comment", {"issue": "MUN-1", "body": "Which database?", "ask_human": True}),
    )
    with connect(settings.db_path)() as s:
        svc.add_comment(s, HUMAN, "MUN-1", "SQLite")
    ((_, text),) = run(url, tokens["claude-code"], ("wait_for_work", {"project": "MUN"}))
    assert text == "The human answered you on:\nMUN-1 [in_progress] First (assignee: claude-code)"


def test_wait_for_work_waits_for_issues_queued_for_others(server):
    url, tokens, settings = server
    with connect(settings.db_path)() as s:
        svc.update_issue(s, HUMAN, "MUN-1", assignee="codex")  # sent back to codex after a review
        svc.update_issue(s, HUMAN, "MUN-2", blocked_by=["MUN-1"])
    run(url, tokens["codex"], ("list_projects", {}))  # codex is around
    ((_, text),) = run(url, tokens["claude-code"], ("wait_for_work", {"project": "MUN", "seconds": 1}))
    assert text.startswith("Nothing for you yet. Still going on:\nMUN-1 [todo] First (assignee: codex)")


def test_wait_for_work_stops_when_nobody_else_is_around(server):
    url, tokens, settings = server
    with connect(settings.db_path)() as s:
        svc.update_issue(s, HUMAN, "MUN-2", blocked_by=["MUN-1"])
    results = run(
        url,
        tokens["claude-code"],
        ("update_issue", {"issue": "MUN-1", "status": "in_progress"}),
        ("update_issue", {"issue": "MUN-1", "status": "in_review"}),
        ("wait_for_work", {"project": "MUN"}),
    )
    assert results[-1][1] == (
        "No other agent has been in touch for 5 minutes, so nobody is around to pick these up:\n"
        "MUN-1 [in_review] First (assignee: claude-code)\n"
        "Stop here. They'll wait for the next agent (your own work needs someone else to review it)."
    )


def test_questions_with_options_and_comment_ids(server):
    url, tokens, settings = server
    options = [{"label": "New message", "detail": "Easy to read on a phone"}, {"label": "Attach a file"}]
    results = run(
        url,
        tokens["claude-code"],
        ("add_comment", {"issue": "MUN-1", "body": "Split long output how?", "ask_human": True, "options": options}),
        ("add_comment", {"issue": "MUN-1", "body": "Plain note", "options": options}),
        ("add_comment", {"issue": "MUN-1", "body": "One way?", "ask_human": True, "options": options[:1]}),
        ("add_comment", {"issue": "MUN-1", "body": "Noted."}),
        ("get_issue", {"issue": "MUN-1"}),
    )
    (asked_err, asked), (plain_err, plain), (one_err, one), (note_err, note), (_, issue) = results
    with connect(settings.db_path)() as s:
        question, note_comment = svc.get_issue(s, "MUN-1").comments
    assert not asked_err and asked.startswith(f"Asked the human on MUN-1 (comment {question.id}).")
    assert plain_err and "Options go with a question for the human" in plain
    assert one_err and "Offer 2 to 6 options" in one
    assert not note_err and note == f"Commented on MUN-1 (comment {note_comment.id})."
    assert question.options == [
        {"label": "New message", "detail": "Easy to read on a phone"},
        {"label": "Attach a file", "detail": ""},
    ]
    assert "Options: 1. New message (Easy to read on a phone); 2. Attach a file" in issue


def test_the_event_feed_has_changes_and_comments_in_order(server):
    url, tokens, settings = server
    run(
        url,
        tokens["claude-code"],
        ("update_issue", {"issue": "MUN-1", "status": "in_progress"}),
        ("add_comment", {"issue": "MUN-1", "body": "Which database?", "ask_human": True}),
    )
    with connect(settings.db_path)() as s:
        svc.add_comment(s, HUMAN, "MUN-1", "SQLite, please.\nIt's enough.")
    is_error, latest = run(url, tokens["codex"], ("events", {"limit": 4}))[0]
    assert not is_error
    lines = latest.splitlines()
    assert [line.split("  ", 2)[2] for line in lines[:-1]] == [
        "claude-code took it",
        "claude-code asked the human: Which database?",
        "me commented: SQLite, please.",
    ]
    cursor = int(lines[-1].split("after=")[1].rstrip(")"))

    is_error, nothing = run(url, tokens["codex"], ("events", {"after": cursor}))[0]
    assert nothing == f"Nothing new after event {cursor}."
    with connect(settings.db_path)() as s:
        svc.update_issue(s, HUMAN, "MUN-2", title="Second, renamed")
    _, new = run(url, tokens["codex"], ("events", {"after": cursor, "project": "MUN"}))[0]
    assert new.splitlines()[0].endswith("MUN-2  me renamed it from 'Second'")
    assert new.splitlines()[-1] == f"Next time: events(after={cursor + 1})"


def test_agents_create_projects_and_keep_their_briefs(server):
    url, tokens, _ = server
    results = run(
        url,
        tokens["claude-code"],
        ("create_project", {"key": "web", "name": "Website", "description": "The marketing site. Commit to main."}),
        ("create_issue", {"project": "WEB", "title": "A landing page"}),
        ("list_projects", {}),
        ("create_project", {"key": "WEB", "name": "Again"}),
        ("create_project", {"key": "1x", "name": "Bad key"}),
        ("update_project", {"project": "web", "description": "The marketing site. Open a pull request per issue."}),
        ("update_project", {"project": "WEB", "name": "Site"}),
        ("list_projects", {}),
        ("update_project", {"project": "NOPE", "name": "x"}),
        ("update_project", {"project": "WEB", "name": " "}),
    )
    texts = [text for _, text in results]
    errors = [is_error for is_error, _ in results]
    assert errors == [False, False, False, True, True, False, False, False, True, True], results
    assert texts[0] == 'Created project WEB: Website. Add its issues with create_issue(project="WEB").'
    assert texts[1].startswith("Created WEB-1: A landing page")
    assert "WEB: Website\nThe marketing site. Commit to main." in texts[2]
    assert "already exists" in texts[3]
    assert "starts with a letter" in texts[4]
    assert texts[5] == "Updated project WEB: Website."
    assert "WEB: Site\nThe marketing site. Open a pull request per issue." in texts[7], "a new name keeps the brief"
    assert "needs a name" in texts[9]


def test_priorities_mark_what_matters_most(server):
    url, tokens, settings = server
    claude = tokens["claude-code"]
    results = run(
        url, claude,
        ("create_issue", {"project": "MUN", "title": "Login is down", "priority": "urgent"}),
        ("update_issue", {"issue": "MUN-2", "priority": "high"}),
        ("list_issues", {"project": "MUN", "status": "todo"}),
        ("get_issue", {"issue": "MUN-3"}),
    )
    texts = [text for _, text in results]
    assert texts[1] == "Updated MUN-2 [todo] Second (high)"
    assert texts[2] == "MUN-1 [todo] First\nMUN-2 [todo] Second (high)\nMUN-3 [todo] Login is down (urgent)", "the pile keeps its order"
    assert "Status: todo · Priority: urgent · Assignee: none" in texts[3]
    assert "claude-code made it urgent" in texts[3]
    ((is_error, text),) = run(url, claude, ("update_issue", {"issue": "MUN-1", "priority": "whenever"}))
    assert is_error
    with connect(settings.db_path)() as s:
        assert svc.get_issue(s, "MUN-2").priority == "high"
        assert [line for _, line in svc.history(svc.get_issue(s, "MUN-2").events)][-1] == "claude-code made it high"
