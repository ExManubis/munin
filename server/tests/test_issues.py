import threading

import pytest

from munin import issues as svc
from munin.db import connect
from munin.issues import Conflict, Invalid, NotFound

from conftest import CLAUDE, CODEX, HUMAN


@pytest.fixture
def project(s):
    return svc.create_project(s, "mun", "munin")


def test_project_keys_are_upper_case_and_unique(s, project):
    assert project.key == "MUN"
    with pytest.raises(Conflict):
        svc.create_project(s, "MUN", "again")
    with pytest.raises(Invalid):
        svc.create_project(s, "1X", "bad key")


def test_issues_are_numbered_per_project_and_added_to_the_bottom(s, project):
    svc.create_project(s, "WEB", "website")
    first = svc.create_issue(s, HUMAN, "MUN", "First")
    second = svc.create_issue(s, CLAUDE, "MUN", "Second")
    other = svc.create_issue(s, HUMAN, "WEB", "Elsewhere")
    assert [first.ref, second.ref, other.ref] == ["MUN-1", "MUN-2", "WEB-1"]
    assert second.position > first.position
    assert second.created_by == "claude-code"


def test_list_puts_active_work_first_then_the_pile_in_order(s, project):
    a = svc.create_issue(s, HUMAN, "MUN", "A")
    b = svc.create_issue(s, HUMAN, "MUN", "B")
    c = svc.create_issue(s, HUMAN, "MUN", "C")
    svc.create_issue(s, HUMAN, "MUN", "Old", status="done")
    svc.update_issue(s, HUMAN, c.ref, position=a.position - 1)  # move C to the top of the pile
    svc.update_issue(s, CLAUDE, b.ref, status="in_progress")

    assert [i.title for i in svc.list_issues(s, "MUN")] == ["B", "C", "A"]
    assert [i.title for i in svc.list_issues(s, "MUN", status="todo")] == ["C", "A"]
    assert len(svc.list_issues(s, "MUN", status="all")) == 4
    assert [i.title for i in svc.list_issues(s, assignee="claude-code")] == ["B"]
    assert [i.title for i in svc.list_issues(s, assignee="")] == ["C", "A"]


def test_an_agent_takes_an_issue_by_moving_it_to_in_progress(s, project):
    issue = svc.create_issue(s, HUMAN, "MUN", "Work")
    taken = svc.update_issue(s, CLAUDE, issue.ref, status="in_progress")
    assert (taken.status, taken.assignee) == ("in_progress", "claude-code")


def test_an_agent_cannot_take_or_reassign_another_agents_issue(s, project):
    issue = svc.create_issue(s, HUMAN, "MUN", "Work")
    svc.update_issue(s, CLAUDE, issue.ref, status="in_progress")

    with pytest.raises(Conflict, match="in progress by claude-code"):
        svc.update_issue(s, CODEX, issue.ref, status="in_progress")
    with pytest.raises(Conflict):
        svc.update_issue(s, CODEX, issue.ref, assignee="codex")
    with pytest.raises(Conflict):
        svc.update_issue(s, CODEX, issue.ref, status="todo")

    # Other fields and comments are still fine.
    svc.update_issue(s, CODEX, issue.ref, description="More detail")
    assert svc.get_issue(s, issue.ref).assignee == "claude-code"


def test_review_flow(s, project):
    issue = svc.create_issue(s, HUMAN, "MUN", "Work")
    svc.update_issue(s, CLAUDE, issue.ref, status="in_progress")
    svc.update_issue(s, CLAUDE, issue.ref, status="in_review")
    # Another agent reviews and sends it back; it goes back to its author.
    back = svc.update_issue(s, CODEX, issue.ref, status="todo")
    assert (back.status, back.assignee) == ("todo", "claude-code")
    svc.update_issue(s, CLAUDE, issue.ref, status="in_progress")
    svc.update_issue(s, CLAUDE, issue.ref, status="in_review")
    assert svc.update_issue(s, CODEX, issue.ref, status="done").status == "done"


def test_the_human_can_always_change_an_issue(s, project):
    issue = svc.create_issue(s, HUMAN, "MUN", "Work")
    svc.update_issue(s, CLAUDE, issue.ref, status="in_progress")
    moved = svc.update_issue(s, HUMAN, issue.ref, assignee="codex")
    assert moved.assignee == "codex"


def test_two_agents_racing_for_an_issue_only_one_gets_it(settings, s, project):
    issue = svc.create_issue(s, HUMAN, "MUN", "Contested")
    sessions = connect(settings.db_path)
    agents = [svc.Actor(f"agent-{n}", "agent") for n in range(8)]
    start = threading.Barrier(len(agents))
    winners, losers = [], []

    def take(actor):
        with sessions() as session:
            start.wait()
            try:
                svc.update_issue(session, actor, issue.ref, status="in_progress")
                winners.append(actor.name)
            except Conflict:
                losers.append(actor.name)

    threads = [threading.Thread(target=take, args=(a,)) for a in agents]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(winners) == 1
    assert len(losers) == len(agents) - 1
    s.expire_all()
    assert svc.get_issue(s, issue.ref).assignee == winners[0]


def test_bad_references(s, project):
    with pytest.raises(Invalid):
        svc.get_issue(s, "twelve")
    with pytest.raises(NotFound):
        svc.get_issue(s, "MUN-99")
    with pytest.raises(NotFound):
        svc.list_issues(s, "NOPE")
    with pytest.raises(Invalid):
        svc.create_issue(s, HUMAN, "MUN", "Bad status", status="started")


def test_questions_stay_in_the_inbox_until_the_human_replies(s, project):
    issue = svc.create_issue(s, HUMAN, "MUN", "Work")
    svc.add_comment(s, CLAUDE, issue.ref, "Just a note")
    assert svc.inbox(s) == []

    svc.add_comment(s, CLAUDE, issue.ref, "Postgres or SQLite?", asks_human=True)
    assert [c.body for c in svc.inbox(s)] == ["Postgres or SQLite?"]
    assert svc.waiting_on_human(svc.get_issue(s, issue.ref))

    svc.add_comment(s, CODEX, issue.ref, "I'd say SQLite")  # an agent's reply doesn't count
    assert len(svc.inbox(s)) == 1

    svc.add_comment(s, HUMAN, issue.ref, "SQLite")
    assert svc.inbox(s) == []
    assert not svc.waiting_on_human(svc.get_issue(s, issue.ref))

    svc.add_comment(s, CLAUDE, issue.ref, "One more thing?", asks_human=True)
    assert [c.body for c in svc.inbox(s)] == ["One more thing?"]


def test_questions_on_closed_issues_leave_the_inbox(s, project):
    issue = svc.create_issue(s, HUMAN, "MUN", "Work")
    svc.add_comment(s, CLAUDE, issue.ref, "Should I?", asks_human=True)
    svc.update_issue(s, HUMAN, issue.ref, status="cancelled")
    assert svc.inbox(s) == []


def test_only_agents_ask_the_human(s, project):
    issue = svc.create_issue(s, HUMAN, "MUN", "Work")
    comment = svc.add_comment(s, HUMAN, issue.ref, "Note to self", asks_human=True)
    assert not comment.asks_human
