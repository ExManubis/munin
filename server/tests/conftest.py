import pytest
from fastapi.testclient import TestClient

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
