import argparse
import sys

from munin import agents
from munin import issues as svc
from munin.config import Settings
from munin.db import connect
from munin.issues import MuninError


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="munin", description="An issue tracker for you and your agents.")
    commands = parser.add_subparsers(dest="command", required=True)

    serve = commands.add_parser("serve", help="run the server (web UI, API and MCP)")
    serve.add_argument("--host", help="address to listen on (default 127.0.0.1)")
    serve.add_argument("--port", type=int, help="port to listen on (default 7777)")

    agent = commands.add_parser("agent", help="manage agent tokens").add_subparsers(dest="action", required=True)
    agent_add = agent.add_parser("add", help="create an agent and print its token (or a new token for an existing one)")
    agent_add.add_argument("name", help="name the agent shows up as, like claude-code")
    agent.add_parser("list", help="list agents")
    agent_revoke = agent.add_parser("revoke", help="stop an agent's token working")
    agent_revoke.add_argument("name")

    project = commands.add_parser("project", help="manage projects").add_subparsers(dest="action", required=True)
    project_add = project.add_parser("add", help="create a project")
    project_add.add_argument("key", help="short key that prefixes issue ids, like MUN")
    project_add.add_argument("name")
    project_add.add_argument("--description", default="", help="what the project is, for agents and you")
    project.add_parser("list", help="list projects")

    args = parser.parse_args(argv)
    settings = Settings.from_env()
    try:
        if args.command == "serve":
            return _serve(settings, args)
        with connect(settings.db_path)() as s:
            if args.command == "agent":
                return _agent(s, settings, args)
            return _project(s, args)
    except MuninError as error:
        print(f"munin: {error}", file=sys.stderr)
        return 1


def _serve(settings: Settings, args: argparse.Namespace) -> int:
    import uvicorn

    from munin.app import create_app

    settings = Settings(
        db_path=settings.db_path,
        host=args.host or settings.host,
        port=args.port or settings.port,
        user=settings.user,
    )
    print(f"munin on {settings.url} · database {settings.db_path}")
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port)
    return 0


def _agent(s, settings: Settings, args: argparse.Namespace) -> int:
    if args.action == "add":
        agent, token = agents.add_agent(s, args.name)
        print(f"Token for {agent.name} (shown once):\n\n  {token}\n")
        print("Claude Code:")
        print(f'  claude mcp add --transport http munin {settings.url}/mcp --header "Authorization: Bearer {token}"')
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
