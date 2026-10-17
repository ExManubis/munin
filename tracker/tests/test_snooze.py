"""Snoozing an issue's questions: out of your inbox until a time, unknown to agents."""

from datetime import UTC, datetime, timedelta

from munin import issues as svc
from munin.db import connect

from conftest import HUMAN


def test_a_snoozed_question_leaves_the_inbox_until_its_time(client, settings, monkeypatch):
    agent = svc.Actor("claude-code", "agent")
    with connect(settings.db_path)() as s:
        svc.create_project(s, "MUN", "munin", "")
        svc.create_issue(s, HUMAN, "MUN", "Colours")
        svc.create_issue(s, HUMAN, "MUN", "Fonts")
        svc.add_comment(s, agent, "MUN-1", "Red or blue?", asks_human=True)
        svc.add_comment(s, agent, "MUN-2", "Serif?", asks_human=True)
        events = len(svc.events_after(s, 0, 200))

    later = datetime.now(UTC) + timedelta(hours=3)
    snoozed = client.put("/api/issues/MUN-1/snooze", json={"until": later.isoformat()}).json()
    assert snoozed["snoozed_until"].startswith(later.strftime("%Y-%m-%dT%H:%M"))
    assert [i["issue"]["id"] for i in client.get("/api/inbox").json()] == ["MUN-2"]
    assert [i["issue"]["id"] for i in client.get("/api/inbox?snoozed=true").json()] == ["MUN-1"]
    with connect(settings.db_path)() as s:
        assert len(svc.events_after(s, 0, 200)) == events, "agents aren't told"
        assert svc.waiting_on_human(svc.get_issue(s, "MUN-1")), "the agent's question still waits"

    assert client.put("/api/issues/MUN-1/snooze", json={"until": "2020-01-01T00:00:00Z"}).status_code == 422

    # Its time comes.
    monkeypatch.setattr(svc, "utcnow", lambda: datetime.now(UTC).replace(tzinfo=None) + timedelta(hours=4))
    assert [i["issue"]["id"] for i in client.get("/api/inbox").json()] == ["MUN-1", "MUN-2"]
    monkeypatch.undo()

    # Woken early by hand, and by a new question.
    client.put("/api/issues/MUN-2/snooze", json={"until": later.isoformat()})
    assert client.put("/api/issues/MUN-2/snooze", json={"until": None}).json()["snoozed_until"] is None
    client.put("/api/issues/MUN-2/snooze", json={"until": later.isoformat()})
    with connect(settings.db_path)() as s:
        svc.add_comment(s, agent, "MUN-2", "Or sans?", asks_human=True)
    assert "MUN-2" in [i["issue"]["id"] for i in client.get("/api/inbox").json()]
