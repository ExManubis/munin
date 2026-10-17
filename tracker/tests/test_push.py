"""Push notifications from the tracker: keys, devices, and what gets pushed."""

import json
import time

import pytest
from pywebpush import WebPushException

from munin import push as push_module
from munin import issues as svc
from munin.app import create_app
from munin.db import connect
from fastapi.testclient import TestClient

from conftest import HUMAN
from test_mcp import run

SUBSCRIPTION = {"endpoint": "https://push.example/send/abc", "keys": {"p256dh": "BPkey", "auth": "authsecret"}}


def test_a_device_subscribes_with_the_trackers_key(client, settings):
    status = client.get("/api/push").json()
    assert status["devices"] == 0
    assert len(status["key"]) == 87, "an uncompressed P-256 point, base64url"
    saved = settings.db_path.parent / "push.json"
    assert saved.stat().st_mode & 0o777 == 0o600
    assert "PRIVATE KEY" in json.loads(saved.read_text())["private"]

    assert client.post("/api/push", json={"subscription": {"endpoint": "http://not-a-push-service"}}).status_code == 422
    assert client.post("/api/push", json={"subscription": SUBSCRIPTION}).json()["devices"] == 1
    assert client.post("/api/push", json={"subscription": SUBSCRIPTION}).json()["devices"] == 1, "the same device once"
    assert client.request("DELETE", "/api/push", json={"endpoint": SUBSCRIPTION["endpoint"]}).json()["devices"] == 0

    with TestClient(create_app(settings), base_url="http://localhost") as again:
        assert again.get("/api/push").json()["key"] == status["key"], "the same key after a restart"


@pytest.fixture
def pushed(monkeypatch):
    sent = []

    def fake_webpush(subscription_info, data, **kwargs):
        if subscription_info["endpoint"].endswith("/gone"):
            response = type("Response", (), {"status_code": 410})()
            raise WebPushException("Gone", response=response)
        sent.append((subscription_info["endpoint"], json.loads(data), kwargs["vapid_claims"]))

    monkeypatch.setattr(push_module, "webpush", fake_webpush)
    monkeypatch.setattr(push_module, "POLL_SECONDS", 0.05)
    return sent


def wait_for(check, seconds=5):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.05)
    return False


def test_an_agents_question_and_work_for_review_are_pushed(server, pushed):
    import httpx2

    url, tokens, settings = server
    base = url.removesuffix("/mcp")
    httpx2.post(f"{base}/api/push", json={"subscription": SUBSCRIPTION})
    httpx2.post(f"{base}/api/push", json={"subscription": {**SUBSCRIPTION, "endpoint": "https://push.example/gone"}})
    time.sleep(0.2)  # the watcher starts from now

    run(url, tokens["claude-code"], ("add_comment", {"issue": "MUN-1", "body": "Which colour?\nRed or blue.", "ask_human": True}))
    assert wait_for(lambda: len(pushed) >= 1)
    endpoint, payload, claims = pushed[0]
    assert endpoint == SUBSCRIPTION["endpoint"]
    assert payload["title"] == "claude-code asks about MUN-1"
    assert payload["body"] == "Which colour?"
    assert payload["url"].startswith("#/inbox/")
    assert claims["sub"].startswith("mailto:")
    assert httpx2.get(f"{base}/api/push").json()["devices"] == 1, "the device that's gone is forgotten"

    run(url, tokens["codex"], ("update_issue", {"issue": "MUN-2", "status": "in_progress"}), ("update_issue", {"issue": "MUN-2", "status": "in_review"}))
    assert wait_for(lambda: any(p["title"] == "MUN-2 is ready for review" for _, p, _ in pushed))
    review = next(p for _, p, _ in pushed if p["title"] == "MUN-2 is ready for review")
    assert (review["body"], review["url"]) == ("codex: Second", "#/issues/MUN-2")

    # Your own comment isn't news to you.
    count = len(pushed)
    with connect(settings.db_path)() as s:
        svc.add_comment(s, HUMAN, "MUN-1", "Blue.")
    time.sleep(0.5)
    assert len(pushed) == count
