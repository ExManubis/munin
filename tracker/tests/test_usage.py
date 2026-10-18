import pytest

from munin import issues as svc
from munin import usage
from munin.issues import Invalid, NotFound
from munin.models import Usage

from conftest import CLAUDE, CODEX, HUMAN
from test_mcp import run


@pytest.fixture
def issue(s):
    svc.create_project(s, "MUN", "munin", "The tracker itself")
    return svc.create_issue(s, HUMAN, "MUN", "Thing")


def test_reports_add_up_per_issue_and_agent(s, issue):
    usage.report(s, CLAUDE, issue.ref, 0.25, tokens_in=1000, tokens_out=200, model="claude-opus-5-5")
    usage.report(s, CLAUDE, issue.ref, 0.10)
    usage.report(s, CODEX, issue.ref, 0.05, tokens_in=10)
    assert usage.totals(s, [issue.id]) == {
        issue.id: {
            "cost": pytest.approx(0.40),
            "tokens": 1210,
            "agents": {"claude-code": pytest.approx(0.35), "codex": pytest.approx(0.05)},
        }
    }


def test_issues_without_reports_are_absent(s, issue):
    assert usage.totals(s, [issue.id]) == {}
    assert usage.totals(s, []) == {}


@pytest.mark.parametrize("cost,tokens", [(-0.01, None), (1000.01, None), (0.1, -1), (0.1, 100_000_001)])
def test_rejects_bad_reports(s, issue, cost, tokens):
    with pytest.raises(Invalid):
        usage.report(s, CLAUDE, issue.ref, cost, tokens_in=tokens)
    with pytest.raises(Invalid):
        usage.report(s, CLAUDE, issue.ref, cost, tokens_out=tokens)
    assert s.query(Usage).count() == 0


def test_unknown_issue(s, issue):
    with pytest.raises(NotFound):
        usage.report(s, CLAUDE, "MUN-999", 0.1)


def test_humans_dont_report(s, issue):
    with pytest.raises(Invalid):
        usage.report(s, HUMAN, issue.ref, 0.1)
    assert s.query(Usage).count() == 0


def test_issue_api_shows_cost(client, s, issue):
    svc.create_issue(s, HUMAN, "MUN", "Untouched")
    usage.report(s, CLAUDE, issue.ref, 0.25, tokens_in=1000, tokens_out=200)
    cost = {"cost": 0.25, "tokens": 1200, "agents": {"claude-code": 0.25}}
    assert client.get("/api/issues/MUN-1").json()["cost"] == cost
    listed = {i["id"]: i["cost"] for i in client.get("/api/issues").json()}
    assert listed == {"MUN-1": cost, "MUN-2": None}
    assert client.get("/api/issues/MUN-2").json()["cost"] is None


def test_report_usage_over_mcp(server):
    url, tokens, _ = server
    results = run(
        url,
        tokens["claude-code"],
        ("report_usage", {"issue": "MUN-1", "cost_usd": 0.5}),
        ("report_usage", {"issue": "MUN-1", "cost_usd": 0.4}),
        ("report_usage", {"issue": "MUN-1", "cost_usd": -1}),
    )
    assert [error for error, _ in results] == [False, False, True]
    assert "$0.50" in results[0][1] and "MUN-1" in results[0][1]
    assert "$0.90" in results[1][1]
