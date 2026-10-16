"""A believable project to look around in: `munin demo` serves it from a throwaway database."""

from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from munin import agents
from munin import issues as svc
from munin.issues import Actor
from munin.models import Agent, Comment, Event, Issue, utcnow

CLAUDE = Actor("claude-code", "agent")
CODEX = Actor("codex", "agent")
FIGBOT = Actor("figbot", "agent")
# munin's own agents, from the frontend's sample cast; in the tracker they're agents like any other
FORGE = Actor("forge", "agent")
VERA = Actor("vera", "agent")


def seed(s: Session, user: str) -> None:
    me = Actor(user, "human")
    for agent in (CLAUDE, CODEX, FIGBOT, FORGE, VERA):
        agents.add_agent(s, agent.name)

    svc.create_project(
        s,
        "MUN",
        "munin",
        "An agent framework in the spirit of Hermes. This project is its core: tools, memory and gateways.\n\n"
        "How work is delivered: one branch per issue, named after it (mun-12). The reviewer merges it into main.\n"
        "Run tests with: pytest",
    )
    svc.create_project(s, "WEB", "website", "munin.dev: the landing page and docs. Plain HTML and CSS.")

    def issue(project, title, description="", by=me, **kwargs):
        return svc.create_issue(s, by, project, title, description, **kwargs).ref

    shell = issue(
        "MUN",
        "Sandbox the shell tool",
        "Run shell commands inside a sandbox so a bad command can't touch the host.\n\n"
        "Done when:\n- commands run under `sandbox-exec` on macOS\n- Linux keeps using bubblewrap\n"
        "- tests cover a command that tries to write outside the workdir",
    )
    stream = issue(
        "MUN",
        "Stream tool output to Telegram",
        "Long-running tools go silent in Telegram until they finish. Stream their output into the chat "
        "as it arrives, editing one message in place.",
    )
    memory = issue("MUN", "Persist memory to SQLite", "Memory lives in a JSON file today. Move it to SQLite.")
    redact = issue("MUN", "Redact secrets in logs", "API keys and tokens end up in debug logs. Mask them.")
    retry = issue("MUN", "Retry rate-limited calls with jitter", "On a 429, back off with jitter, up to 3 times.")
    gateway = issue("MUN", "Telegram gateway reconnect loop", "The gateway reconnects forever when the token is bad.")
    status_cmd = issue("MUN", "/status command for the gateway", "Shows what the agent is doing right now.")
    manifest = issue("MUN", "Skill manifest schema v2", "Skills need a version and a list of required tools.")
    issue("MUN", "Load skills from a git URL", "", blocked_by=[manifest])
    issue("MUN", "Context budget per skill", "", blocked_by=[manifest])
    issue("MUN", "Drop the legacy YAML config", status="done")
    landing = issue("WEB", "Landing page hero with the raven", "Use the dither lockup from the brand kit.")
    issue("WEB", "Quickstart page", "Install, connect Claude Code, first project.", blocked_by=[landing])

    def take(actor, ref):
        svc.update_issue(s, actor, ref, status="in_progress")

    def finish(actor, ref, summary):
        svc.add_comment(s, actor, ref, summary)
        svc.update_issue(s, actor, ref, status="in_review")

    take(CODEX, shell)
    svc.add_comment(
        s,
        CODEX,
        shell,
        "Read `core/tools/shell.py`. sandbox-exec runs fine on 15.1 and prints one deprecation warning.",
    )
    svc.add_comment(
        s,
        CODEX,
        shell,
        "sandbox-exec is deprecated on macOS 15 but still works. Should the shell tool keep using it, or "
        "require Docker for isolation?\n\nWhat I found:\n- sandbox-exec runs fine on 15.1 with one warning\n"
        "- Docker isolates properly, but adds a 2 GB install and a running daemon\n"
        "- Linux already uses bubblewrap, so only macOS is affected",
        asks_human=True,
        options=[
            {"label": "Keep sandbox-exec", "detail": "Works today with no setup. Revisit when Apple removes it."},
            {"label": "Require Docker", "detail": "Real isolation. Every macOS user needs Docker running."},
            {"label": "Support both", "detail": "Default to sandbox-exec, choose in config."},
        ],
    )

    take(CLAUDE, memory)
    finish(CLAUDE, memory, "Done on branch mun-3: memory now lives in `memory.db`. Migration from JSON runs once.")
    svc.add_comment(s, CODEX, memory, "Reviewed mun-3: works, but the migration deletes the JSON file. Keep a backup.")
    svc.update_issue(s, CODEX, memory, status="todo")
    take(CLAUDE, memory)
    finish(CLAUDE, memory, "The migration now keeps `memory.json.bak`. Added a test for it.")
    svc.add_comment(
        s,
        CLAUDE,
        memory,
        "PR #212 is ready. Should I keep the JSON importer for one release, or drop it now?",
        asks_human=True,
    )

    take(CODEX, redact)
    finish(CODEX, redact, "Masks anything that looks like a key or token in log lines. 14 tests.")

    take(FORGE, retry)
    finish(FORGE, retry, "On a 429 it now backs off with jitter, up to 3 times. Tests cover the backoff.")
    svc.add_comment(s, VERA, retry, "Reviewed and merged into main.")
    svc.update_issue(s, VERA, retry, status="done")

    take(FORGE, stream)
    svc.add_comment(s, FORGE, stream, "Plan: buffer output and edit one message every 1.5 s to stay under the limit.")
    svc.add_comment(s, me, stream, "Use the sandbox bot for testing. Spam it as much as you like.")
    svc.add_comment(
        s,
        FORGE,
        stream,
        "Telegram caps a message at 4,096 characters. When output runs past that, start a new message or "
        "attach the rest as a file?",
        asks_human=True,
        options=[
            {"label": "Start a new message", "detail": "Easy to read on the phone."},
            {"label": "Attach as a file", "detail": "One message, but you have to open it."},
        ],
    )

    take(FIGBOT, gateway)
    svc.add_comment(s, FIGBOT, gateway, "Gave up after 3 attempts. The gateway test times out on CI only.")
    svc.update_issue(s, FIGBOT, gateway, status="todo", assignee="none")

    svc.update_issue(s, me, status_cmd, assignee="figbot")
    svc.update_issue(s, me, manifest, status="in_progress", assignee=me.name)
    take(CODEX, landing)

    _spread_over_days(s, days=3)
    for agent in s.scalars(select(Agent)):
        agent.last_seen_at = utcnow() - (timedelta(hours=1) if agent.name == "figbot" else timedelta(minutes=1))
    s.commit()


def _spread_over_days(s: Session, days: int) -> None:
    """Make history look lived in: spread events and comments over the last few days, in order."""
    rows = [(e.created_at, e.id, Event) for e in s.scalars(select(Event))]
    rows += [(c.created_at, c.id, Comment) for c in s.scalars(select(Comment))]
    rows.sort(key=lambda row: row[:2])
    moments = sorted({created for created, _, _ in rows})  # events from one change share a moment
    start, end = utcnow() - timedelta(days=days), utcnow() - timedelta(minutes=2)
    step = (end - start) / max(len(moments) - 1, 1)
    spread = {moment: start + step * n for n, moment in enumerate(moments)}
    for created, row_id, model in rows:
        s.execute(update(model).where(model.id == row_id).values(created_at=spread[created]))
    s.expire_all()
    for issue in s.scalars(select(Issue)):
        times = [e.created_at for e in issue.events] + [c.created_at for c in issue.comments]
        issue.created_at, issue.updated_at = min(times), max(times)
        issue.status_changed_at = max(e.created_at for e in issue.events if e.kind in ("created", "status"))
    s.commit()
