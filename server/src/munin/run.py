"""munin run: start agents on a project and show what they do as they do it.

Each agent gets its own token (named claude-1, claude-2, …) and an MCP config pointing at the
running munin. The command that starts an agent is a template, so any agent CLI works.
"""

import json
import os
import shlex
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from collections import deque
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from munin import agents
from munin import issues as svc
from munin.config import Settings
from munin.issues import MuninError
from munin.models import Comment, Event, Issue

CLAUDE = 'claude -p "/mcp__munin__continue {project}" --mcp-config {mcp_config}'
PROMPT = (
    "You have access to munin, an issue tracker. Continue the {name} project ({project}). "
    "Keep going until there is nothing left for you to do."
)


class Runner:
    """A started agent: its process and the last lines it printed."""

    def __init__(self, name: str, argv: list[str], env: dict[str, str]):
        self.name = name
        self.output: deque[str] = deque(maxlen=40)
        self.process = subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        for line in self.process.stdout:
            self.output.append(line.rstrip())

    @property
    def running(self) -> bool:
        return self.process.poll() is None


def run_agents(
    settings: Settings,
    sessions: sessionmaker[Session],
    project: str,
    count: int,
    template: str = CLAUDE,
    prefix: str | None = None,
    extra: list[str] | None = None,
    out=sys.stdout,
) -> int:
    with sessions() as s:
        found = svc.get_project(s, project)
        key, name = found.key, found.name
    _check_server(settings)
    prefix = prefix or Path(shlex.split(template)[0]).name
    configs = Path(tempfile.mkdtemp(prefix="munin-run-"))
    runners = []
    with sessions() as s:
        for n in range(1, count + 1):
            agent, token = agents.add_agent(s, f"{prefix}-{n}")
            config = configs / f"{agent.name}.json"
            config.write_text(json.dumps(_mcp_config(settings, token)))
            values = {
                "project": key,
                "prompt": PROMPT.format(project=key, name=name),
                "mcp_config": str(config),
                "url": f"{settings.url}/mcp",
                "token": token,
                "name": agent.name,
            }
            argv = [part.format(**values) for part in shlex.split(template)] + list(extra or [])
            env = {**os.environ, "MUNIN_TOKEN": token, "MUNIN_URL": values["url"]}
            runners.append(Runner(agent.name, argv, env))
            print(f"Started {agent.name}: {shlex.join(argv)}", file=out)
    print(f"Watching {key}. Ctrl+C stops the agents.\n", file=out)

    watcher = _Watcher(sessions, key)
    try:
        while any(r.running for r in runners):
            watcher.print_new(out)
            time.sleep(1)
        watcher.print_new(out)
    except KeyboardInterrupt:
        for runner in runners:
            if runner.running:
                runner.process.terminate()
        print("\nStopped the agents.", file=out)
        return 130

    failed = 0
    for runner in runners:
        code = runner.process.returncode
        failed += code != 0
        print(f"\n── {runner.name} finished" + ("" if code == 0 else f" with exit code {code}"), file=out)
        for line in list(runner.output)[-15:]:
            print(f"   {line}", file=out)
    return 1 if failed else 0


def _check_server(settings: Settings) -> None:
    try:
        with urllib.request.urlopen(f"{settings.url}/api/me", timeout=3):
            pass
    except OSError as error:
        raise MuninError(f"munin isn't running at {settings.url}. Start it with: munin serve") from error


def _mcp_config(settings: Settings, token: str) -> dict:
    server = {"type": "http", "url": f"{settings.url}/mcp", "headers": {"Authorization": f"Bearer {token}"}}
    return {"mcpServers": {"munin": server}}


class _Watcher:
    """Prints a project's new history and comments, one line each, as agents work."""

    def __init__(self, sessions: sessionmaker[Session], key: str):
        self.sessions = sessions
        self.key = key
        with sessions() as s:
            project_id = svc.get_project(s, key).id
            self.project_id = project_id
            self.last_event = s.scalar(select(Event.id).order_by(Event.id.desc()).limit(1)) or 0
            self.last_comment = s.scalar(select(Comment.id).order_by(Comment.id.desc()).limit(1)) or 0

    def print_new(self, out) -> None:
        with self.sessions() as s:
            events = list(
                s.scalars(
                    select(Event)
                    .join(Issue)
                    .where(Event.id > self.last_event, Issue.project_id == self.project_id)
                    .order_by(Event.id)
                )
            )
            comments = list(
                s.scalars(
                    select(Comment)
                    .join(Issue)
                    .where(Comment.id > self.last_comment, Issue.project_id == self.project_id)
                    .order_by(Comment.id)
                )
            )
            if events:
                self.last_event = events[-1].id
            if comments:
                self.last_comment = comments[-1].id
            lines = [(event.created_at, event.issue.ref, line) for event, line in svc.history(events)]
            for comment in comments:
                said = comment.body.strip().splitlines()[0] if comment.body.strip() else ""
                verb = "asks you" if comment.asks_human else "says"
                lines.append((comment.created_at, comment.issue.ref, f"{comment.author} {verb}: {_clip(said, 90)}"))
            for moment, ref, line in sorted(lines, key=lambda item: item[0]):
                print(f"{moment:%H:%M:%S}  {ref:<8} {line}", file=out, flush=True)


def _clip(text: str, length: int) -> str:
    return text if len(text) <= length else text[: length - 1] + "…"
