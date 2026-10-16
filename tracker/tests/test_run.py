import io
import sys
from pathlib import Path

import pytest

from munin import issues as svc
from munin.db import connect
from munin.issues import MuninError
from munin.run import run_agents

FAKE_AGENT = f"{sys.executable} {Path(__file__).parent / 'fake_agent.py'}"


def test_run_starts_agents_and_shows_what_they_do(server):
    _, _, settings = server
    out = io.StringIO()
    code = run_agents(settings, connect(settings.db_path), "mun", 2, FAKE_AGENT, prefix="fake", out=out)
    text = out.getvalue()
    assert code == 0, text
    assert "Started fake-1:" in text and "Started fake-2:" in text
    assert "MUN-1    fake-1 took it" in text or "MUN-1    fake-2 took it" in text
    assert "says: Did the thing." in text
    assert "── fake-1 finished" in text and "Finished MUN-" in text
    with connect(settings.db_path)() as s:
        assert {i.status for i in svc.list_issues(s, "MUN")} == {"in_review"}


def test_run_needs_a_running_munin(tmp_path):
    from munin.config import Settings

    settings = Settings(db_path=tmp_path / "munin.db", port=9)
    sessions = connect(settings.db_path)
    with sessions() as s:
        svc.create_project(s, "MUN", "munin")
    with pytest.raises(MuninError, match="munin isn't running at http://127.0.0.1:9"):
        run_agents(settings, sessions, "MUN", 1, FAKE_AGENT, out=io.StringIO())
