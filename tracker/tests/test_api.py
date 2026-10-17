from dataclasses import replace

from fastapi.testclient import TestClient

from munin import issues as svc
from munin.app import create_app
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
    me = {"name": "me", "you": None, "mcp_url": "http://localhost/mcp", "version": "0.2.0"}
    assert client.get("/api/me").json() == me, "on this machine, nobody says who's looking"
    assert client.get("/api/me", headers={"Host": "127.0.0.1:7777"}).json()["mcp_url"] == "http://127.0.0.1:7777/mcp"


def test_times_are_utc(client):
    client.post("/api/projects", json={"key": "MUN", "name": "munin"})
    issue = client.post("/api/issues", json={"project": "MUN", "title": "Work"}).json()
    assert issue["created_at"].endswith("Z")


def test_reordering_does_not_count_as_an_update(client):
    client.post("/api/projects", json={"key": "MUN", "name": "munin"})
    before = client.post("/api/issues", json={"project": "MUN", "title": "Work"}).json()
    after = client.patch("/api/issues/MUN-1", json={"position": -5}).json()
    assert after["position"] == -5
    assert after["updated_at"] == before["updated_at"]


def test_agent_names_that_mean_something_else_are_refused(client):
    for name in ("me", "none", "Null"):
        assert client.post("/api/agents", json={"name": name}).status_code == 422


def test_dependencies_history_and_activity(client):
    client.post("/api/projects", json={"key": "MUN", "name": "munin"})
    client.post("/api/issues", json={"project": "MUN", "title": "Schema"})
    created = client.post("/api/issues", json={"project": "MUN", "title": "API", "blocked_by": ["MUN-1"]}).json()
    assert created["blocked_by"] == ["MUN-1"]
    assert created["waits_for"] == [{"id": "MUN-1", "title": "Schema", "status": "todo", "assignee": None}]
    assert [e["kind"] for e in created["events"]] == ["created", "blocked_by"]
    assert client.get("/api/issues/MUN-1").json()["blocks"][0]["id"] == "MUN-2"

    done = client.patch("/api/issues/MUN-1", json={"status": "done"}).json()
    assert done["status_changed_at"].endswith("Z")
    assert client.get("/api/issues/MUN-2").json()["blocked_by"] == []  # done blockers don't count

    activity = client.get("/api/activity", params={"limit": 2}).json()
    assert [(a["issue"]["id"], a["text"]) for a in activity] == [
        ("MUN-1", "me moved it from todo to done"),
        ("MUN-2", "me set it to wait for MUN-1"),
    ]
    assert [i["id"] for i in client.get("/api/issues", params={"q": "schema", "status": "all"}).json()] == ["MUN-1"]


def test_agents_show_what_they_are_working_on(client, settings):
    client.post("/api/projects", json={"key": "MUN", "name": "munin"})
    client.post("/api/issues", json={"project": "MUN", "title": "Work"})
    client.post("/api/agents", json={"name": "claude-code"})
    client.post("/api/agents", json={"name": "codex"})
    with connect(settings.db_path)() as s:
        svc.update_issue(s, CLAUDE, "MUN-1", status="in_progress")
    agents = {a["name"]: [i["id"] for i in a["working_on"]] for a in client.get("/api/agents").json()}
    assert agents == {"claude-code": ["MUN-1"], "codex": []}


def test_the_frontend_is_served_from_the_checkout_unless_turned_off(client, settings):
    page = client.get("/")
    assert page.status_code == 200
    assert "<title>munin</title>" in page.text
    # Checked with the server every time, so an update reaches the page on its next load.
    module = client.get("/app.js")
    assert (page.headers["cache-control"], module.headers["cache-control"]) == ("no-cache", "no-cache")
    assert client.get("/app.js", headers={"If-None-Match": module.headers["etag"]}).status_code == 304

    with TestClient(create_app(replace(settings, web_dir=None)), base_url="http://localhost") as api_only:
        assert api_only.get("/").status_code == 404
        assert api_only.get("/api/me").status_code == 200


def test_questions_carry_options_and_comments_stay_out_of_history(client, settings):
    client.post("/api/projects", json={"key": "MUN", "name": "munin"})
    client.post("/api/issues", json={"project": "MUN", "title": "Work"})
    with connect(settings.db_path)() as s:
        svc.add_comment(
            s,
            CLAUDE,
            "MUN-1",
            "Which one?",
            asks_human=True,
            options=[{"label": "A"}, {"label": "B", "detail": "The other"}],
        )
    question = client.get("/api/inbox").json()[0]["question"]
    assert question["options"] == [{"label": "A", "detail": ""}, {"label": "B", "detail": "The other"}]
    issue = client.post("/api/issues/MUN-1/comments", json={"body": "B"}).json()
    assert [c["body"] for c in issue["comments"]] == ["Which one?", "B"]
    assert [e["kind"] for e in issue["events"]] == ["created"]
    assert [a["kind"] for a in client.get("/api/activity").json()] == ["created"]
    assert client.get("/api/inbox").json() == []
