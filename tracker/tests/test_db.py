import sqlite3

from munin import issues as svc
from munin import usage
from munin.db import connect

from conftest import CLAUDE

# The issues table as munin 0.1 created it, before status_changed_at.
OLD_SCHEMA = """
CREATE TABLE projects (id INTEGER PRIMARY KEY, key VARCHAR(10) UNIQUE, name VARCHAR(200), description TEXT,
    next_number INTEGER, created_at DATETIME);
CREATE TABLE issues (id INTEGER PRIMARY KEY, project_id INTEGER REFERENCES projects(id), number INTEGER,
    title VARCHAR(300), description TEXT, status VARCHAR(20), assignee VARCHAR(100), position FLOAT,
    created_by VARCHAR(100), created_at DATETIME, updated_at DATETIME, UNIQUE (project_id, number));
INSERT INTO projects VALUES (1, 'MUN', 'munin', '', 2, '2026-10-01 10:00:00');
INSERT INTO issues VALUES (1, 1, 1, 'Old issue', '', 'todo', NULL, 1.0, 'me', '2026-10-01 10:00:00',
    '2026-10-02 10:00:00');
"""


def test_an_older_database_is_brought_up_to_date(tmp_path):
    path = tmp_path / "old.db"
    with sqlite3.connect(path) as old:
        old.executescript(OLD_SCHEMA)

    with connect(path)() as s:
        issue = svc.get_issue(s, "MUN-1")
        assert issue.status_changed_at is None
        svc.update_issue(s, CLAUDE, "MUN-1", status="in_progress")
        assert svc.get_issue(s, "MUN-1").status_changed_at is not None
        assert [e.kind for e in svc.get_issue(s, "MUN-1").events] == ["status", "assignee"]


def test_old_database_gets_usage_table(tmp_path):
    path = tmp_path / "old.db"
    with connect(path)() as s:
        svc.create_project(s, "MUN", "munin")
        svc.create_issue(s, CLAUDE, "MUN", "Thing")
    with sqlite3.connect(path) as old:
        old.execute("DROP TABLE usage")

    with connect(path)() as s:
        usage.report(s, CLAUDE, "MUN-1", 0.5)
        assert usage.totals(s, [1])[1]["cost"] == 0.5
