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


@pytest.mark.parametrize("nobody", ["", '""', "''", "none", "None", " null "])
def test_however_an_agent_spells_nobody_it_unassigns(s, project, nobody):
    issue = svc.create_issue(s, HUMAN, "MUN", "Work", assignee="codex")
    assert svc.update_issue(s, CODEX, issue.ref, assignee=nobody).assignee is None
    assert [i.ref for i in svc.list_issues(s, "MUN", assignee=nobody)] == [issue.ref]


def test_similar_open_issues(s):
    # Titles from two agents that planned the same project at the same time.
    svc.create_project(s, "TXT", "textstats")
    word_count = svc.create_issue(s, HUMAN, "TXT", "Create textstats.py with word_count(text)")
    top_words = svc.create_issue(s, HUMAN, "TXT", "Add top_words(text, n) to textstats.py")
    readme = svc.create_issue(s, HUMAN, "TXT", "Add usage section to README")
    svc.create_issue(s, HUMAN, "TXT", "Fix tests")

    def similar(title):
        return [i.ref for i in svc.similar_open_issues(s, svc.create_issue(s, CLAUDE, "TXT", title))]

    # A hint, not a verdict: real duplicates must show up, unrelated titles mustn't.
    assert similar("Create textstats.py with word_count(text) and unit tests") == [word_count.ref]
    assert top_words.ref in similar("Add top_words(text, n) with unit tests")
    assert readme.ref in similar("Add README usage section for textstats")
    assert similar("Add tests for the parser") == []

    svc.update_issue(s, HUMAN, readme.ref, status="done")
    assert readme.ref not in similar("Usage section in the README")  # closed issues don't count


def test_history_records_what_happened(s, project):
    issue = svc.create_issue(s, HUMAN, "MUN", "Work")
    svc.update_issue(s, CLAUDE, issue.ref, status="in_progress")
    svc.update_issue(s, CLAUDE, issue.ref, title="Better title", description="Details")
    svc.update_issue(s, CLAUDE, issue.ref, status="in_review")
    svc.update_issue(s, HUMAN, issue.ref, position=-1)  # reordering isn't history

    history = [svc.describe_event(event) for event in svc.get_issue(s, issue.ref).events]
    assert history == [
        "me created it",
        "claude-code moved it from todo to in_progress",
        "claude-code assigned it to claude-code",
        "claude-code renamed it from 'Work'",
        "claude-code edited the description",
        "claude-code moved it from in_progress to in_review",
    ]
    assert [e.kind for e in svc.recent_events(s, limit=2)] == ["status", "description"]


def test_status_changed_at_moves_only_with_the_status(s, project):
    issue = svc.create_issue(s, HUMAN, "MUN", "Work")
    created = issue.status_changed_at
    svc.update_issue(s, HUMAN, issue.ref, title="Renamed")
    assert svc.get_issue(s, issue.ref).status_changed_at == created
    svc.update_issue(s, CLAUDE, issue.ref, status="in_progress")
    assert svc.get_issue(s, issue.ref).status_changed_at > created


def test_agents_cannot_start_an_issue_before_its_blockers_are_done(s, project):
    schema = svc.create_issue(s, HUMAN, "MUN", "Schema")
    api = svc.create_issue(s, CLAUDE, "MUN", "API", blocked_by=[schema.ref])
    assert [b.ref for b in svc.open_blockers(api)] == [schema.ref]
    assert [b.ref for b in svc.get_issue(s, schema.ref).blocks] == [api.ref]

    with pytest.raises(Conflict, match="MUN-2 is blocked by MUN-1"):
        svc.update_issue(s, CODEX, api.ref, status="in_progress")
    svc.update_issue(s, CLAUDE, schema.ref, status="in_progress")
    svc.update_issue(s, CLAUDE, schema.ref, status="in_review")
    with pytest.raises(Conflict):  # in review isn't done
        svc.update_issue(s, CODEX, api.ref, status="in_progress")
    svc.update_issue(s, CODEX, schema.ref, status="done")
    assert svc.update_issue(s, CODEX, api.ref, status="in_progress").assignee == "codex"


def test_cancelled_blockers_and_humans_do_not_block(s, project):
    first = svc.create_issue(s, HUMAN, "MUN", "First")
    second = svc.create_issue(s, HUMAN, "MUN", "Second", blocked_by=[first.ref])
    assert svc.update_issue(s, HUMAN, second.ref, status="in_progress").status == "in_progress"  # people decide
    svc.update_issue(s, HUMAN, second.ref, status="todo")
    svc.update_issue(s, HUMAN, first.ref, status="cancelled")
    assert svc.update_issue(s, CLAUDE, second.ref, status="in_progress").status == "in_progress"


def test_blockers_can_be_changed_but_not_made_circular(s, project):
    a = svc.create_issue(s, HUMAN, "MUN", "A")
    b = svc.create_issue(s, HUMAN, "MUN", "B", blocked_by=[a.ref])
    c = svc.create_issue(s, HUMAN, "MUN", "C", blocked_by=[b.ref])

    with pytest.raises(Invalid, match="can't block itself"):
        svc.update_issue(s, HUMAN, a.ref, blocked_by=[a.ref])
    with pytest.raises(Invalid, match="MUN-3 already waits for MUN-1"):
        svc.update_issue(s, HUMAN, a.ref, blocked_by=[c.ref])

    svc.update_issue(s, CLAUDE, c.ref, blocked_by=[a.ref, "mun-2"])
    assert [i.ref for i in svc.get_issue(s, c.ref).blocked_by] == ["MUN-1", "MUN-2"]
    svc.update_issue(s, CLAUDE, c.ref, blocked_by=[])
    assert svc.get_issue(s, c.ref).blocked_by == []
    assert svc.describe_event(svc.get_issue(s, c.ref).events[-1]) == "claude-code removed what it waited for"


def test_search(s, project):
    svc.create_issue(s, HUMAN, "MUN", "Stream tool output to Telegram", description="Edit one message in place")
    svc.create_issue(s, HUMAN, "MUN", "Retry rate-limited calls", description="Back off on a 429 with jitter")
    svc.create_issue(s, HUMAN, "MUN", "100% coverage", status="done")

    def found(query, status=None):
        return [i.title for i in svc.list_issues(s, "MUN", status=status, query=query)]

    assert found("telegram") == ["Stream tool output to Telegram"]
    assert found("JITTER 429") == ["Retry rate-limited calls"]  # every word, in title or description
    assert found("mun-2") == ["Retry rate-limited calls"]
    assert found("100%", status="all") == ["100% coverage"]
    assert found("nothing like this") == []
