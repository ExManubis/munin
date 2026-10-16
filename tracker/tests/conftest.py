import socket
import threading
import time

import pytest
import uvicorn
from fastapi.testclient import TestClient

from munin import agents
from munin import issues as svc
from munin.app import create_app
from munin.config import Settings
from munin.db import connect
from munin.issues import Actor

HUMAN = Actor("me", "human")
CLAUDE = Actor("claude-code", "agent")
CODEX = Actor("codex", "agent")


@pytest.fixture
def settings(tmp_path):
    return Settings(db_path=tmp_path / "munin.db", user="me")


@pytest.fixture
def s(settings):
    with connect(settings.db_path)() as session:
        yield session


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings), base_url="http://localhost") as test_client:
        yield test_client


@pytest.fixture
def server(tmp_path):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    settings = Settings(db_path=tmp_path / "munin.db", port=port)
    uv = uvicorn.Server(uvicorn.Config(create_app(settings), host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=uv.run, daemon=True)
    thread.start()
    while not uv.started:
        time.sleep(0.01)
    with connect(settings.db_path)() as s:
        svc.create_project(s, "MUN", "munin", "The tracker itself")
        svc.create_issue(s, HUMAN, "MUN", "First")
        svc.create_issue(s, HUMAN, "MUN", "Second")
        tokens = {name: agents.add_agent(s, name)[1] for name in ("claude-code", "codex")}
    yield f"http://127.0.0.1:{port}/mcp", tokens, settings
    uv.should_exit = True
    thread.join()
