import argparse
import re
import sys
import tempfile
import threading
import webbrowser
from dataclasses import replace
from datetime import datetime
from importlib.metadata import version
from pathlib import Path

from munin import agents
from munin import issues as svc
from munin.config import Settings
from munin.db import connect
from munin.issues import MuninError
from munin.models import utcnow
from munin.run import CLAUDE, run_agents

# The brand kit's dithered mark, kept here so the CLI draws it without the frontend.
MARK = Path(__file__).parent / "raven.svg"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="munin", description="An issue tracker for you and your agents.")
    parser.add_argument("--version", action="version", version=f"munin {version('munin')}")
    commands = parser.add_subparsers(dest="command", required=True)

    serve = commands.add_parser("serve", help="run the tracker (API and MCP, and the web UI)")
    serve.add_argument("--host", help="address to listen on (default 127.0.0.1)")
    serve.add_argument("--port", type=int, help="port to listen on (default 7777)")
    serve.add_argument("--open", action="store_true", help="open the web UI in your browser")

    commands.add_parser("status", help="what's waiting on you and what agents are doing")

    run = commands.add_parser("run", help="start agents on a project and watch them work (munin serve must be running)")
    run.add_argument("project", help="project key, like MUN")
    run.add_argument("--agents", type=int, default=1, help="how many agents to start (default 1)")
    run.add_argument(
        "--cmd",
        dest="template",
        default=CLAUDE,
        help="how to start one agent. Placeholders: {project} {prompt} {mcp_config} {url} {token} {name}. "
        "MUNIN_TOKEN and MUNIN_URL are also set. Default: Claude Code",
    )
    run.add_argument("--name", help="agents are named NAME-1, NAME-2, … (default: the command's program, like claude)")
    run.epilog = "Arguments after -- go to every agent, like: munin run MUN -- --model sonnet"

    demo = commands.add_parser("demo", help="look around with a sample project, in a throwaway database")
    demo.add_argument("--port", type=int, default=7778, help="port to listen on (default 7778)")
    demo.add_argument("--no-open", action="store_true", help="don't open the web UI in your browser")

    agent = commands.add_parser("agent", help="manage agent tokens").add_subparsers(dest="action", required=True)
    agent_add = agent.add_parser("add", help="create an agent and print its token (or a new token for an existing one)")
    agent_add.add_argument("name", help="name the agent shows up as, like claude-code")
    agent_add.add_argument("--provider", choices=agents.PROVIDERS, help="the harness it runs in, for its mark")
    agent.add_parser("list", help="list agents")
    agent_revoke = agent.add_parser("revoke", help="stop an agent's token working and remove the agent")
    agent_revoke.add_argument("name")

    project = commands.add_parser("project", help="manage projects").add_subparsers(dest="action", required=True)
    project_add = project.add_parser("add", help="create a project")
    project_add.add_argument("key", help="short key that prefixes issue ids, like MUN")
    project_add.add_argument("name")
    project_add.add_argument("--description", default="", help="what the project is, for agents and you")
    project.add_parser("list", help="list projects")

    # Everything after -- belongs to the agents munin run starts, not to munin.
    argv = list(sys.argv[1:] if argv is None else argv)
    argv, extra = (argv[: argv.index("--")], argv[argv.index("--") + 1 :]) if "--" in argv else (argv, [])
    args = parser.parse_args(argv)
    if extra and args.command != "run":
        parser.error("arguments after -- only go with munin run")
    settings = Settings.from_env()
    try:
        if args.command == "serve":
            return _serve(settings, args)
        if args.command == "demo":
            return _demo(settings, args)
        if args.command == "run":
            sessions = connect(settings.db_path)
            return run_agents(settings, sessions, args.project, args.agents, args.template, args.name, extra)
        with connect(settings.db_path)() as s:
            if args.command == "status":
                return _status(s)
            if args.command == "agent":
                return _agent(s, settings, args)
            return _project(s, args)
    except MuninError as error:
        print(f"munin: {error}", file=sys.stderr)
        return 1


def _serve(settings: Settings, args: argparse.Namespace) -> int:
    settings = replace(settings, host=args.host or settings.host, port=args.port or settings.port)
    try:
        settings.check()
    except ValueError as error:
        print(f"munin: {error}", file=sys.stderr)
        return 2
    return _run(settings, f"database {settings.db_path}", open_browser=args.open)


def _demo(settings: Settings, args: argparse.Namespace) -> int:
    from munin.demo import seed

    db_path = Path(tempfile.mkdtemp(prefix="munin-demo-")) / "demo.db"
    with connect(db_path)() as s:
        seed(s, settings.user)
    settings = replace(settings, db_path=db_path, host="127.0.0.1", port=args.port)
    note = "a sample project in a throwaway database; your own data isn't touched"
    return _run(settings, note, open_browser=not args.no_open)


def _run(settings: Settings, note: str, open_browser: bool) -> int:
    import uvicorn

    from munin.app import create_app

    print("\n".join(raven()))
    print(f"\n  munin {version('munin')} · {settings.url}\n  {note}\n")
    if open_browser:
        threading.Timer(1.0, webbrowser.open, [settings.url]).start()
    # Open live streams from the web UI shouldn't hold up Ctrl+C.
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, timeout_graceful_shutdown=2)
    return 0


def raven() -> list[str]:
    """The pixel raven from the brand kit, two pixel rows to a line of half blocks."""
    runs = re.findall(r"M(\d+) (\d+)h(\d+)v1h-\d+z", MARK.read_text())
    pixels = {(int(x) + i, int(y)) for x, y, width in runs for i in range(int(width))}
    if not pixels:
        return []
    xs, ys = [x for x, _ in pixels], [y for _, y in pixels]
    blocks = {(True, True): "█", (True, False): "▀", (False, True): "▄", (False, False): " "}
    lines = []
    for y in range(min(ys), max(ys) + 1, 2):
        row = "".join(blocks[(x, y) in pixels, (x, y + 1) in pixels] for x in range(min(xs), max(xs) + 1))
        lines.append("  " + row.rstrip())
    return lines


def _status(s) -> int:
    questions = svc.inbox(s)
    working = svc.list_issues(s, status="in_progress")
    reviewing = svc.list_issues(s, status="in_review")
    print(f"Waiting on you ({len(questions)})")
    for question in questions:
        first_line = question.body.splitlines()[0]
        print(f"  {question.issue.ref:<8} {question.author}: {_clip(first_line, 70)}  · {_ago(question.created_at)}")
    print(f"\nIn progress ({len(working)})")
    for issue in working:
        since = _ago(issue.status_changed_at or issue.updated_at)
        print(f"  {issue.ref:<8} {_clip(issue.title, 50)} · {issue.assignee or 'nobody'} · {since}")
    print(f"\nIn review ({len(reviewing)})")
    for issue in reviewing:
        print(f"  {issue.ref:<8} {_clip(issue.title, 50)} · by {issue.assignee or 'nobody'}")
    return 0


def _clip(text: str, length: int) -> str:
    return text if len(text) <= length else text[: length - 1] + "…"


def _ago(moment: datetime) -> str:
    minutes = int((utcnow() - moment).total_seconds() // 60)
    if minutes < 1:
        return "just now"
    if minutes < 60:
        return f"{minutes}m"
    if minutes < 48 * 60:
        return f"{minutes // 60}h"
    return f"{minutes // (24 * 60)}d"


def _agent(s, settings: Settings, args: argparse.Namespace) -> int:
    if args.action == "add":
        agent, token = agents.add_agent(s, args.name, args.provider)
        print(f"Token for {agent.name} (shown once):\n\n  {token}\n")
        print("Claude Code:")
        # Behind the edge, agents on other machines reach munin at its public address.
        url = settings.public_url or settings.url
        print(f'  claude mcp add --transport http munin {url}/mcp --header "Authorization: Bearer {token}"')
        print("\nThen tell it: /mcp__munin__continue <project key>")
    elif args.action == "list":
        for agent in agents.list_agents(s):
            state = "revoked" if agent.revoked_at else f"last seen {agent.last_seen_at or 'never'}"
            print(f"{agent.name}  mun_…{agent.token_hint}  {state}")
    else:
        agents.revoke_agent(s, args.name)
        print(f"Revoked {args.name}.")
    return 0


def _project(s, args: argparse.Namespace) -> int:
    if args.action == "add":
        created = svc.create_project(s, args.key, args.name, args.description)
        print(f"Created {created.key}: {created.name}")
    else:
        for p in svc.list_projects(s):
            print(f"{p.key}  {p.name}")
    return 0
