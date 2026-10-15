"""Agent tokens. Each agent gets its own token, so one can be revoked without touching the others."""

import hashlib
import re
import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from munin.issues import UNASSIGNED, Invalid, NotFound
from munin.models import Agent, utcnow

NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
# "me" is how an agent refers to itself in list_issues; the rest mean unassigned.
RESERVED_NAMES = {"me", *UNASSIGNED}


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def list_agents(s: Session) -> list[Agent]:
    return list(s.scalars(select(Agent).order_by(Agent.name)))


def add_agent(s: Session, name: str) -> tuple[Agent, str]:
    """Create an agent and return it with its token. For an existing agent, issue a new token."""
    name = name.strip()
    if not NAME_PATTERN.match(name):
        raise Invalid("An agent name is letters, digits, dots, dashes or underscores, like claude-code.")
    if name.lower() in RESERVED_NAMES:
        raise Invalid(f"{name!r} means something else to munin. Pick another name.")
    token = "mun_" + secrets.token_urlsafe(24)
    agent = s.scalar(select(Agent).where(Agent.name == name))
    if agent is None:
        agent = Agent(name=name, token_hash=_hash(token), token_hint=token[-4:])
        s.add(agent)
    else:
        agent.token_hash, agent.token_hint, agent.revoked_at = _hash(token), token[-4:], None
    s.commit()
    return agent, token


def revoke_agent(s: Session, name: str) -> Agent:
    agent = s.scalar(select(Agent).where(Agent.name == name))
    if agent is None:
        raise NotFound(f"No agent named {name!r}.")
    agent.revoked_at = utcnow()
    s.commit()
    return agent


def authenticate(s: Session, token: str) -> Agent | None:
    agent = s.scalar(select(Agent).where(Agent.token_hash == _hash(token), Agent.revoked_at.is_(None)))
    if agent is not None:
        agent.last_seen_at = utcnow()
        s.commit()
    return agent
