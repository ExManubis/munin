"""Pull requests on GitHub linked to issues, against a stand-in for GitHub's API."""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from fastapi.testclient import TestClient

from munin import issues as svc
from munin.app import create_app
from munin.db import connect
from munin.github import GitHub, GitHubError, parse_pull_url, refresh

from conftest import HUMAN


@pytest.fixture
def fake_github(monkeypatch):
    """GitHub's pulls API: `pulls` maps "owner/repo#n" to {title, state, merged_at}; `seen` the requests."""
    pulls, seen = {}, []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            seen.append((self.path, self.headers.get("Authorization")))
            _, _, owner, repo, _, number = self.path.split("/")
            pull = pulls.get(f"{owner}/{repo}#{number}")
            body = json.dumps(pull or {"message": "Not Found"}).encode()
            self.send_response(200 if pull else 404)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("MUNIN_GITHUB_API", f"http://127.0.0.1:{server.server_address[1]}")
    yield pulls, seen
    server.shutdown()


def test_pull_request_urls():
    assert parse_pull_url("https://github.com/ExManubis/munin/pull/12") == ("ExManubis/munin", 12, "https://github.com/ExManubis/munin/pull/12")
    assert parse_pull_url(" https://github.com/a/b.c/pull/3/files#diff ")[2] == "https://github.com/a/b.c/pull/3"
    for bad in ["https://github.com/a/b/issues/3", "http://github.com/a/b/pull/3", "https://gitlab.com/a/b/pull/3", "nope"]:
        with pytest.raises(GitHubError, match="isn't a pull request on GitHub"):
            parse_pull_url(bad)


def test_linking_a_pull_request_shows_its_title_and_state(settings, fake_github):
    pulls, seen = fake_github
    pulls["ExManubis/munin#12"] = {"title": "Retry on 429", "state": "open", "merged_at": None}
    with TestClient(create_app(settings), base_url="http://localhost") as client:
        client.post("/api/projects", json={"key": "MUN", "name": "munin"})
        client.post("/api/issues", json={"project": "MUN", "title": "Retry"})

        linked = client.post("/api/issues/MUN-1/pull-requests", json={"url": "https://github.com/ExManubis/munin/pull/12"}).json()
        assert [(p["repo"], p["number"], p["title"], p["state"]) for p in linked["pull_requests"]] == [("ExManubis/munin", 12, "Retry on 429", "open")]
        assert [e["kind"] for e in linked["events"]][-1] == "pull_request"
        again = client.post("/api/issues/MUN-1/pull-requests", json={"url": "https://github.com/ExManubis/munin/pull/12/files"}).json()
        assert len(again["pull_requests"]) == 1, "the same pull request once"
        assert client.post("/api/issues/MUN-1/pull-requests", json={"url": "https://github.com/x/y/issues/1"}).status_code == 422

        # One GitHub doesn't know (private, without a token): linked, not checked.
        unknown = client.post("/api/issues/MUN-1/pull-requests", json={"url": "https://github.com/secret/repo/pull/1"}).json()
        assert unknown["pull_requests"][1]["state"] is None
        pull_id = unknown["pull_requests"][1]["id"]
        assert len(client.delete(f"/api/issues/MUN-1/pull-requests/{pull_id}").json()["pull_requests"]) == 1

        # A token: used, never sent back, kept readable by the tracker only.
        assert client.get("/api/github").json() == {"token": None}
        assert client.put("/api/github", json={"token": "ghp_secret1234"}).json() == {"token": {"hint": "1234"}}
        assert (settings.db_path.parent / "github.json").stat().st_mode & 0o777 == 0o600
        client.post("/api/issues/MUN-1/pull-requests", json={"url": "https://github.com/ExManubis/munin/pull/99"})
        assert seen[-1] == ("/repos/ExManubis/munin/pulls/99", "Bearer ghp_secret1234")

    # Merged on GitHub: the next look says so; a finished issue's pull requests aren't asked about.
    pulls["ExManubis/munin#12"] = {"title": "Retry on 429", "state": "closed", "merged_at": "2026-10-17T12:00:00Z"}
    sessions = connect(settings.db_path)
    assert refresh(GitHub(settings.db_path.parent / "github.json"), sessions) == 1
    with sessions() as s:
        assert [pr.state for pr in svc.get_issue(s, "MUN-1").pull_requests][0] == "merged"
        svc.update_issue(s, HUMAN, "MUN-1", status="done")
        assert svc.pulls_to_check(s) == []


def test_agents_link_their_pull_requests_over_mcp(tmp_path, fake_github):
    from test_mcp import run
    import socket
    import time
    import uvicorn
    from munin.config import Settings

    pulls, _ = fake_github
    pulls["ExManubis/munin#7"] = {"title": "Stream tool output", "state": "open", "merged_at": None}
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    settings = Settings(db_path=tmp_path / "munin.db", port=port)
    uv = uvicorn.Server(uvicorn.Config(create_app(settings), host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=uv.run, daemon=True)
    thread.start()
    while not uv.started:
        time.sleep(0.01)
    try:
        from munin import agents
        with connect(settings.db_path)() as s:
            svc.create_project(s, "MUN", "munin", "")
            svc.create_issue(s, HUMAN, "MUN", "Stream it")
            token = agents.add_agent(s, "forge")[1]
        url = f"http://127.0.0.1:{port}/mcp"
        ((_, linked), (_, text)) = run(url, token,
            ("link_pull_request", {"issue": "MUN-1", "url": "https://github.com/ExManubis/munin/pull/7"}),
            ("get_issue", {"issue": "MUN-1"}))
        assert linked == "Linked ExManubis/munin#7 (open): Stream tool output to MUN-1."
        assert "Pull requests:\nhttps://github.com/ExManubis/munin/pull/7 Stream tool output (open)" in text
        assert "forge linked pull request #7" in text
    finally:
        uv.should_exit = True
        thread.join()


def test_an_issue_is_done_once_its_pull_requests_merge(settings, fake_github):
    pulls, _ = fake_github
    pulls["a/b#1"] = {"title": "Part one", "state": "open", "merged_at": None}
    pulls["a/b#2"] = {"title": "Part two", "state": "open", "merged_at": None}
    pulls["a/b#3"] = {"title": "Abandoned", "state": "open", "merged_at": None}
    sessions = connect(settings.db_path)
    github = GitHub(None)
    with sessions() as s:
        svc.create_project(s, "MUN", "munin", "")
        svc.create_issue(s, HUMAN, "MUN", "Two parts")
        svc.create_issue(s, HUMAN, "MUN", "After it", blocked_by=["MUN-1"])
        svc.create_issue(s, HUMAN, "MUN", "Given up")
        for ref, number in [("MUN-1", 1), ("MUN-1", 2), ("MUN-3", 3)]:
            svc.link_pull_request(s, HUMAN, ref, f"https://github.com/a/b/pull/{number}", github.pull("a/b", number))
        svc.update_issue(s, HUMAN, "MUN-1", status="in_review")

    # One merged, one still open: not yet.
    pulls["a/b#1"] = {**pulls["a/b#1"], "state": "closed", "merged_at": "2026-10-17T12:00:00Z"}
    refresh(github, sessions)
    with sessions() as s:
        assert svc.get_issue(s, "MUN-1").status == "in_review"

    # The other closed without merging: a comment, and with one merged the work is in.
    pulls["a/b#2"] = {**pulls["a/b#2"], "state": "closed"}
    pulls["a/b#3"] = {**pulls["a/b#3"], "state": "closed"}
    refresh(github, sessions)
    with sessions() as s:
        issue = svc.get_issue(s, "MUN-1")
        assert issue.status == "done"
        assert [(c.author, c.body) for c in issue.comments] == [("GitHub", "a/b#2 was closed without merging: https://github.com/a/b/pull/2")]
        assert svc.describe_event(issue.events[-1]) == "GitHub moved it from in_review to done"
        assert svc.open_blockers(svc.get_issue(s, "MUN-2")) == [], "what waited for it can start"

        given_up = svc.get_issue(s, "MUN-3")
        assert given_up.status == "todo", "nothing merged: nothing done"
        assert len(given_up.comments) == 1

    refresh(github, sessions)
    with sessions() as s:
        assert len(svc.get_issue(s, "MUN-3").comments) == 1, "said once"
