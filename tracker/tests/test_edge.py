"""munin behind the edge: tailscale serve passes requests on with munin's public name as the Host, and says
who's calling in Tailscale-User-Login, having removed any the caller sent."""

from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from munin import agents
from munin.app import create_app
from munin.config import Settings
from munin.db import connect

PUBLIC = "https://munin.tail1234.ts.net"


@pytest.fixture
def edge(settings):
    behind = replace(settings, public_url=PUBLIC, users=("mikkel@example.com",))
    with TestClient(create_app(behind), base_url=PUBLIC) as client:
        yield client


def as_person(login=None):
    return {"Tailscale-User-Login": login} if login else {}


def test_people_in_munin_users_get_in_through_the_edge(edge):
    me = edge.get("/api/me", headers=as_person("Mikkel@Example.com"))
    assert me.status_code == 200
    assert me.json()["mcp_url"] == f"{PUBLIC}/mcp", "agents elsewhere reach MCP at the public address"
    assert edge.get("/", headers=as_person("mikkel@example.com")).status_code == 200


def test_the_square_shows_who_is_looking(edge, settings):
    named = {**as_person("mikkel@example.com"), "Tailscale-User-Name": "=?utf-8?q?Mikkel_N=C3=B8rgaard?="}
    you = edge.get("/api/me", headers=named)
    assert you.json()["you"] == {"name": "Mikkel Nørgaard", "login": "mikkel@example.com"}
    assert you.json()["name"] == settings.user, "comments still go out under MUNIN_USER"
    nameless = edge.get("/api/me", headers=as_person("mikkel@example.com")).json()["you"]
    assert nameless == {"name": "mikkel", "login": "mikkel@example.com"}
    behind = replace(settings, public_url=PUBLIC, users=("mikkel@example.com",))
    with TestClient(create_app(behind), base_url="http://127.0.0.1") as local:
        said = local.get("/api/me", headers=as_person("mikkel@example.com"))
        assert said.json()["you"] is None, "only Serve says who"


def test_anyone_else_through_the_edge_is_turned_away(edge):
    stranger = edge.get("/api/projects", headers=as_person("someone@example.com"))
    assert stranger.status_code == 403
    assert "someone@example.com isn't one of munin's people" in stranger.json()["detail"]
    nobody = edge.post("/api/projects", json={"key": "X", "name": "x"})
    assert nobody.status_code == 403, "a tagged device or funnel traffic carries no identity"
    assert "Tailscale didn't say who you are" in nobody.json()["detail"]


def test_this_machine_and_other_names_are_as_before(settings):
    behind = replace(settings, public_url=PUBLIC, users=("mikkel@example.com",))
    with TestClient(create_app(behind), base_url="http://127.0.0.1") as local:
        assert local.get("/api/me").status_code == 200, "the server's own command line and checks"
    with TestClient(create_app(behind), base_url="http://evil.example") as rebound:
        assert rebound.get("/api/me").status_code == 400, "other names are still refused"


def test_agents_use_mcp_through_the_edge_with_their_tokens_alone(edge, settings):
    with connect(settings.db_path)() as s:
        _, token = agents.add_agent(s, "claude-code")
    hello = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}},
    }
    accept = {"Accept": "application/json, text/event-stream"}
    assert edge.post("/mcp", json=hello, headers=accept).status_code == 401, "no token, no entry"
    ok = edge.post("/mcp", json=hello, headers={**accept, "Authorization": f"Bearer {token}"})
    assert ok.status_code == 200, "MCP's own Host check knows munin's public name"
    assert ok.json()["result"]["serverInfo"]["name"] == "munin"


def test_a_public_address_needs_people_to_let_in(settings):
    with pytest.raises(ValueError, match="MUNIN_USERS"):
        create_app(replace(settings, public_url=PUBLIC))
    with pytest.raises(ValueError, match="isn't a URL"):
        replace(settings, public_url="munin", users=("a@b.c",)).check()


def test_settings_from_the_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("MUNIN_DB", str(tmp_path / "m.db"))
    monkeypatch.setenv("MUNIN_PUBLIC_URL", f"{PUBLIC}/")
    monkeypatch.setenv("MUNIN_USERS", "Mikkel@Example.com, paul@example.com")
    loaded = Settings.from_env()
    assert loaded.public_url == PUBLIC
    assert loaded.public_host == "munin.tail1234.ts.net"
    assert loaded.users == ("mikkel@example.com", "paul@example.com")
