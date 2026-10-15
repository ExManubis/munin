from munin import issues as svc
from munin.db import connect

from conftest import CLAUDE


def test_project_and_issue_round_trip(client):
    assert client.post("/api/projects", json={"key": "mun", "name": "munin"}).status_code == 201
    created = client.post("/api/issues", json={"project": "MUN", "title": "First", "description": "Body"})
    assert created.status_code == 201
    issue = created.json()
    assert (issue["id"], issue["status"], issue["created_by"], issue["comments"]) == ("MUN-1", "todo", "me", [])

    patched = client.patch("/api/issues/MUN-1", json={"status": "in_review", "assignee": "codex"}).json()
    assert (patched["status"], patched["assignee"]) == ("in_review", "codex")
    unassigned = client.patch("/api/issues/MUN-1", json={"assignee": None}).json()
    assert unassigned["assignee"] is None

    projects = client.get("/api/projects").json()
    assert projects == [{"key": "MUN", "name": "munin", "description": "", "counts": {"in_review": 1}}]
    assert [i["id"] for i in client.get("/api/issues", params={"project": "MUN"}).json()] == ["MUN-1"]


def test_errors_map_to_status_codes(client):
    client.post("/api/projects", json={"key": "MUN", "name": "munin"})
    assert client.post("/api/projects", json={"key": "MUN", "name": "again"}).status_code == 409
    assert client.get("/api/issues/MUN-7").status_code == 404
    response = client.post("/api/issues", json={"project": "MUN", "title": " "})
    assert response.status_code == 422
    assert response.json() == {"detail": "An issue needs a title."}


def test_answering_a_question_clears_the_inbox(client, settings):
    client.post("/api/projects", json={"key": "MUN", "name": "munin"})
    client.post("/api/issues", json={"project": "MUN", "title": "Work"})
    with connect(settings.db_path)() as s:
        svc.add_comment(s, CLAUDE, "MUN-1", "Which database?", asks_human=True)

    inbox = client.get("/api/inbox").json()
    assert [(item["issue"]["id"], item["question"]["body"]) for item in inbox] == [("MUN-1", "Which database?")]
    assert inbox[0]["issue"]["waiting_on_human"] is True

    issue = client.post("/api/issues/MUN-1/comments", json={"body": "SQLite"}).json()
    assert [(c["author"], c["author_kind"]) for c in issue["comments"]] == [("claude-code", "agent"), ("me", "human")]
    assert client.get("/api/inbox").json() == []


def test_agent_tokens_are_shown_once_and_can_be_revoked(client):
    created = client.post("/api/agents", json={"name": "claude-code"}).json()
    assert created["token"].startswith("mun_")
    assert created["token_hint"] == created["token"][-4:]
    listed = client.get("/api/agents").json()
    assert [(a["name"], a["revoked"]) for a in listed] == [("claude-code", False)]
    assert "token" not in listed[0]

    assert client.delete("/api/agents/claude-code").json()["revoked"] is True
    assert client.delete("/api/agents/nobody").status_code == 404


def test_other_host_names_are_refused(client):
    # A page using DNS rebinding reaches munin under its own host name.
    assert client.get("/api/projects", headers={"Host": "evil.example:7777"}).status_code == 400
    assert client.get("/api/projects", headers={"Host": "127.0.0.1:7777"}).status_code == 200


def test_me(client):
    assert client.get("/api/me").json() == {"name": "me", "mcp_url": "http://127.0.0.1:7777/mcp"}


def test_agent_names_that_mean_something_else_are_refused(client):
    for name in ("me", "none", "Null"):
        assert client.post("/api/agents", json={"name": name}).status_code == 422
