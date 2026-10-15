from munin import issues as svc
from munin.cli import main, raven
from munin.db import connect

from conftest import CLAUDE, HUMAN


def test_raven_is_drawn_from_the_brand_mark():
    lines = raven()
    assert len(lines) == 11
    assert lines[0].strip() == "██████████████"


def test_status_shows_whats_waiting_and_whos_working(tmp_path, monkeypatch, capsys):
    db = tmp_path / "munin.db"
    monkeypatch.setenv("MUNIN_DB", str(db))
    with connect(db)() as s:
        svc.create_project(s, "MUN", "munin")
        svc.create_issue(s, HUMAN, "MUN", "Sandbox the shell tool")
        svc.create_issue(s, HUMAN, "MUN", "Persist memory")
        svc.update_issue(s, CLAUDE, "MUN-1", status="in_progress")
        svc.add_comment(s, CLAUDE, "MUN-1", "Keep sandbox-exec or require Docker?\nDetails…", asks_human=True)
        svc.update_issue(s, CLAUDE, "MUN-2", status="in_progress")
        svc.update_issue(s, CLAUDE, "MUN-2", status="in_review")

    assert main(["status"]) == 0
    out = capsys.readouterr().out
    assert "Waiting on you (1)\n  MUN-1    claude-code: Keep sandbox-exec or require Docker?  · just now" in out
    assert "In progress (1)\n  MUN-1    Sandbox the shell tool · claude-code · just now" in out
    assert "In review (1)\n  MUN-2    Persist memory · by claude-code" in out


def test_errors_are_short(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("MUNIN_DB", str(tmp_path / "munin.db"))
    assert main(["agent", "revoke", "nobody"]) == 1
    assert capsys.readouterr().err == "munin: No agent named 'nobody'.\n"


def test_demo_data_looks_lived_in(tmp_path):
    from munin.demo import seed

    with connect(tmp_path / "demo.db")() as s:
        seed(s, "me")
        assert [p.key for p in svc.list_projects(s)] == ["MUN", "WEB"]
        assert [c.issue.ref for c in svc.inbox(s)] == ["MUN-1", "MUN-3"]
        statuses = {i.ref: i.status for i in svc.list_issues(s, status="all")}
        assert statuses["MUN-3"] == "in_review" and statuses["MUN-6"] == "todo" and statuses["MUN-11"] == "done"
        assert [b.ref for b in svc.open_blockers(svc.get_issue(s, "MUN-9"))] == ["MUN-8"]
        history = svc.recent_events(s, limit=500)
        assert history[-1].created_at < history[0].created_at  # spread out, oldest first in time
        assert all(i.created_at <= i.updated_at for i in svc.list_issues(s, status="all"))
