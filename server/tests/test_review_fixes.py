"""Regressions for bugs an independent review found (each reproduced before it was fixed)."""

import io
import sys
import threading
import time

import pytest

from munin import agents
from munin import issues as svc
from munin.db import connect
from munin.issues import Conflict, Invalid, MuninError
from munin.mcp_server import _look_for_work
from munin.models import utcnow
from munin.run import _free_names, run_agents

from conftest import CLAUDE, HUMAN
from test_mcp import run as mcp


@pytest.fixture
def project(s):
    return svc.create_project(s, "MUN", "munin")


def test_agents_cannot_create_an_issue_in_progress_while_it_is_blocked(s, project):
    first = svc.create_issue(s, HUMAN, "MUN", "First")
    with pytest.raises(Conflict, match="blocked by MUN-1"):
        svc.create_issue(s, CLAUDE, "MUN", "API", status="in_progress", blocked_by=[first.ref])


def test_one_blocker_spelled_two_ways_is_one_blocker(s, project):
    first = svc.create_issue(s, HUMAN, "MUN", "First")
    second = svc.create_issue(s, HUMAN, "MUN", "Second", blocked_by=["MUN-1", "mun-1", " MUN-1 "])
    assert [b.ref for b in second.blocked_by] == [first.ref]
    third = svc.create_issue(s, HUMAN, "MUN", "Third")
    assert [b.ref for b in svc.update_issue(s, HUMAN, third.ref, blocked_by=["MUN-1", "mun-1"]).blocked_by] == ["MUN-1"]


def test_a_change_made_in_the_meantime_is_not_undone(settings, s, project):
    issue = svc.create_issue(s, HUMAN, "MUN", "Work")
    sessions = connect(settings.db_path)
    with sessions() as agent_session:
        seen = svc.get_issue(agent_session, issue.ref)  # the agent reads it while it's still todo…
        assert seen.status == "todo"
        with sessions() as human_session:
            svc.update_issue(human_session, HUMAN, issue.ref, status="cancelled")  # …then the human cancels it
        with pytest.raises(Conflict, match="MUN-1 changed just now: it's cancelled"):
            svc.update_issue(agent_session, CLAUDE, issue.ref, status="in_progress")
    s.expire_all()
    assert svc.get_issue(s, issue.ref).status == "cancelled"


def test_opposite_dependencies_at_the_same_moment_cannot_make_a_loop(settings, s, project, monkeypatch):
    a = svc.create_issue(s, HUMAN, "MUN", "A")
    b = svc.create_issue(s, HUMAN, "MUN", "B")
    both_checked = threading.Barrier(2)
    check = svc._check_blockers

    def check_then_wait(*args):
        blockers = check(*args)
        both_checked.wait()  # both pass the early check before either writes
        return blockers

    monkeypatch.setattr(svc, "_check_blockers", check_then_wait)
    sessions = connect(settings.db_path)
    errors = []

    def depend(ref, on):
        with sessions() as session:
            try:
                svc.update_issue(session, HUMAN, ref, blocked_by=[on])
            except Invalid as error:
                errors.append(str(error))

    threads = [threading.Thread(target=depend, args=pair) for pair in ((a.ref, b.ref), (b.ref, a.ref))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(errors) == 1 and "already waits for" in errors[0]
    s.expire_all()
    assert not (svc.get_issue(s, a.ref).blocked_by and svc.get_issue(s, b.ref).blocked_by)


def test_unchanged_blockers_do_not_count_as_an_update(s, project):
    first = svc.create_issue(s, HUMAN, "MUN", "First")
    second = svc.create_issue(s, HUMAN, "MUN", "Second", blocked_by=[first.ref])
    before = second.updated_at
    assert svc.update_issue(s, HUMAN, second.ref, blocked_by=[first.ref]).updated_at == before


def test_questions_waiting_on_the_human_are_not_offered_to_take(s, project):
    issue = svc.create_issue(s, HUMAN, "MUN", "Work")
    svc.update_issue(s, CLAUDE, issue.ref, status="in_progress")
    svc.add_comment(s, CLAUDE, issue.ref, "Which database?", asks_human=True)
    svc.update_issue(s, CLAUDE, issue.ref, status="todo", assignee="none")  # gave up until the human answers
    assert svc.available_work(s, "codex", "MUN").take == []


def test_unassigned_work_in_progress_is_worth_waiting_for(settings, s, project):
    first = svc.create_issue(s, HUMAN, "MUN", "First")
    svc.create_issue(s, HUMAN, "MUN", "Second", blocked_by=[first.ref])
    svc.update_issue(s, HUMAN, first.ref, status="in_progress")  # the human is on it, unassigned
    answer, going_on = _look_for_work(connect(settings.db_path), "claude-code", "MUN")
    assert answer is None and going_on.startswith("MUN-1 [in_progress] First")


def test_me_means_the_agent_when_assigning(server):
    url, tokens, _ = server
    results = mcp(
        url,
        tokens["claude-code"],
        ("update_issue", {"issue": "MUN-1", "status": "in_progress", "assignee": "me"}),
        ("create_issue", {"project": "MUN", "title": "Mine", "assignee": "me"}),
        ("update_issue", {"issue": "MUN-1", "status": "in_review"}),
    )
    assert results[0][1] == "Updated MUN-1 [in_progress] First (assignee: claude-code)"
    assert not results[2][0]


def test_issue_history_keeps_a_take_whole(server):
    url, tokens, settings = server
    with connect(settings.db_path)() as s:
        svc.update_issue(s, CLAUDE, "MUN-1", status="in_progress")
        for n in range(11):
            svc.update_issue(s, CLAUDE, "MUN-1", title=f"First, take {n}")
    ((_, text),) = mcp(url, tokens["codex"], ("get_issue", {"issue": "MUN-1"}))
    history = text.split("History:\n")[1].split("\n\n")[0]
    assert "claude-code took it" in history and "assigned it to claude-code" not in history


def test_run_survives_output_that_is_not_utf8(server):
    _, _, settings = server
    noisy = f"{sys.executable} -c \"import sys; sys.stdout.buffer.write(b'\\\\xff\\\\n' + b'x' * 200000)\""
    started = time.monotonic()
    code = run_agents(settings, connect(settings.db_path), "MUN", 1, noisy, prefix="noisy", out=io.StringIO())
    assert code == 0 and time.monotonic() - started < 10


@pytest.mark.parametrize(
    ("template", "message"),
    [
        ("no-such-agent-cli {prompt}", "Couldn't start no-such-agent-cli"),
        ('echo --settings \'{"model": "x"}\' {prompt}', "placeholder munin doesn't know"),
        ("echo 'unclosed", "Can't read the agent command"),
    ],
)
def test_run_explains_a_bad_command(server, template, message):
    _, _, settings = server
    with pytest.raises(MuninError, match=message):
        run_agents(settings, connect(settings.db_path), "MUN", 1, template, out=io.StringIO())


def test_run_needs_at_least_one_agent(server):
    _, _, settings = server
    with pytest.raises(MuninError, match="at least one agent"):
        run_agents(settings, connect(settings.db_path), "MUN", 0, "echo", out=io.StringIO())


def test_run_leaves_agents_that_are_still_working_alone(s):
    _, token = agents.add_agent(s, "claude-1")
    agents.authenticate(s, token)  # claude-1 is busy right now
    agents.add_agent(s, "claude-2")  # claude-2 has never been seen
    assert _free_names(s, "claude", 2) == ["claude-2", "claude-3"]
    stale = agents.list_agents(s)[0]
    stale.last_seen_at = utcnow().replace(year=2020)
    s.commit()
    assert _free_names(s, "claude", 1) == ["claude-1"]
