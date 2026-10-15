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
