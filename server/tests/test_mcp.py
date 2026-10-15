"""Talks to a real munin over HTTP with the MCP SDK's client, the way an agent would."""

import socket
import threading
import time

import anyio
import httpx2
import pytest
import uvicorn
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client

from munin import agents
from munin import issues as svc
from munin.app import create_app
from munin.config import Settings
from munin.db import connect

from conftest import HUMAN


@pytest.fixture
def server(tmp_path):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    settings = Settings(db_path=tmp_path / "munin.db", port=port)
    uv = uvicorn.Server(uvicorn.Config(create_app(settings), host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=uv.run, daemon=True)
    thread.start()
    while not uv.started:
        time.sleep(0.01)
    with connect(settings.db_path)() as s:
        svc.create_project(s, "MUN", "munin", "The tracker itself")
        svc.create_issue(s, HUMAN, "MUN", "First")
        svc.create_issue(s, HUMAN, "MUN", "Second")
        tokens = {name: agents.add_agent(s, name)[1] for name in ("claude-code", "codex")}
    yield f"http://127.0.0.1:{port}/mcp", tokens, settings
    uv.should_exit = True
    thread.join()


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
    assert names == ["list_projects", "list_issues", "get_issue", "create_issue", "update_issue", "add_comment"]


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
    assert text.startswith("Continue the MUN project in munin.")


def test_the_web_ui_hears_about_changes(server):
    url, tokens, _ = server
    base = url.removesuffix("/mcp")

    with httpx2.stream("GET", f"{base}/api/stream", timeout=5) as response:
        lines = response.iter_lines()
        assert next(lines) == "retry: 3000"
        run(url, tokens["claude-code"], ("add_comment", {"issue": "MUN-1", "body": "Hello"}))
        assert [next(lines) for _ in range(3)][1] == "event: changed"
