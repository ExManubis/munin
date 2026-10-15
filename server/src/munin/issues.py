"""Projects, issues and comments. The MCP tools and the web API both go through here."""

import re
from dataclasses import dataclass

from sqlalchemy import case, exists, func, or_, select, update
from sqlalchemy.orm import Session, aliased

from munin.models import OPEN_STATUSES, STATUSES, Comment, Issue, Project, utcnow

KEY_PATTERN = re.compile(r"^[A-Z][A-Z0-9]{1,9}$")
REF_PATTERN = re.compile(r"^\s*([A-Za-z][A-Za-z0-9]*)-(\d+)\s*$")


@dataclass(frozen=True)
class Actor:
    name: str
    kind: str  # "agent" or "human"

    @property
    def is_agent(self) -> bool:
        return self.kind == "agent"


class MuninError(Exception):
    pass


class NotFound(MuninError):
    pass


class Conflict(MuninError):
    pass


class Invalid(MuninError):
    pass


_UNSET = object()


# Projects


def list_projects(s: Session) -> list[Project]:
    return list(s.scalars(select(Project).order_by(Project.key)))


def get_project(s: Session, key: str) -> Project:
    project = s.scalar(select(Project).where(Project.key == key.strip().upper()))
    if project is None:
        raise NotFound(f"No project with key {key!r}.")
    return project


def create_project(s: Session, key: str, name: str, description: str = "") -> Project:
    key = key.strip().upper()
    if not KEY_PATTERN.match(key):
        raise Invalid("A project key is 2-10 letters or digits and starts with a letter, like MUN.")
    if not name.strip():
        raise Invalid("A project needs a name.")
    if s.scalar(select(Project).where(Project.key == key)):
        raise Conflict(f"Project {key} already exists.")
    project = Project(key=key, name=name.strip(), description=description)
    s.add(project)
    s.commit()
    return project


def update_project(s: Session, key: str, *, name: str | None = None, description: str | None = None) -> Project:
    project = get_project(s, key)
    if name is not None:
        if not name.strip():
            raise Invalid("A project needs a name.")
        project.name = name.strip()
    if description is not None:
        project.description = description
    s.commit()
    return project


def issue_counts(s: Session) -> dict[str, dict[str, int]]:
    """Issue counts per project key and status."""
    counts: dict[str, dict[str, int]] = {}
    rows = s.execute(
        select(Project.key, Issue.status, func.count(Issue.id)).join(Issue).group_by(Project.key, Issue.status)
    )
    for key, status, count in rows:
        counts.setdefault(key, {})[status] = count
    return counts


# Issues


def _status_order():
    return case(
        {status: rank for rank, status in enumerate(("in_progress", "in_review", "todo", "done", "cancelled"))},
        value=Issue.status,
    )


def list_issues(
    s: Session,
    project: str | None = None,
    status: str | None = None,
    assignee: str | None = None,
    limit: int | None = None,
) -> list[Issue]:
    """Issues in pile order. Without a status, only open issues (todo, in progress, in review)."""
    query = select(Issue).join(Project)
    if project:
        query = query.where(Issue.project_id == get_project(s, project).id)
    if status is None:
        query = query.where(Issue.status.in_(OPEN_STATUSES))
    elif status != "all":
        query = query.where(Issue.status == _check_status(status))
    if assignee is not None:
        query = query.where(Issue.assignee == assignee) if assignee else query.where(Issue.assignee.is_(None))
    query = query.order_by(_status_order(), Issue.position, Issue.id)
    if limit:
        query = query.limit(limit)
    return list(s.scalars(query))


def get_issue(s: Session, ref: str) -> Issue:
    match = REF_PATTERN.match(ref or "")
    if not match:
        raise Invalid(f"{ref!r} is not an issue id. Issue ids look like MUN-12.")
    key, number = match.group(1).upper(), int(match.group(2))
    issue = s.scalar(select(Issue).join(Project).where(Project.key == key, Issue.number == number))
    if issue is None:
        raise NotFound(f"No issue {key}-{number}.")
    return issue


def create_issue(
    s: Session,
    actor: Actor,
    project: str,
    title: str,
    description: str = "",
    status: str = "todo",
    assignee: str | None = None,
) -> Issue:
    proj = get_project(s, project)
    if not title.strip():
        raise Invalid("An issue needs a title.")
    status = _check_status(status)
    if status == "in_progress" and actor.is_agent and assignee is None:
        assignee = actor.name
    bottom = s.scalar(select(func.max(Issue.position)).where(Issue.project_id == proj.id))
    issue = Issue(
        project=proj,
        number=proj.next_number,
        title=title.strip(),
        description=description,
        status=status,
        assignee=assignee or None,
        position=(bottom or 0.0) + 1.0,
        created_by=actor.name,
    )
    proj.next_number += 1
    s.add(issue)
    s.commit()
    return issue


def update_issue(
    s: Session,
    actor: Actor,
    ref: str,
    *,
    title: str | None = None,
    description: str | None = None,
    status: str | None = None,
    assignee: str | None | object = _UNSET,
    position: float | None = None,
) -> Issue:
    """Change an issue.

    The one rule: an agent can't change the status or assignee of an issue another
    agent has in progress. Moving an issue to in_progress without naming an assignee
    makes the agent its assignee, which is how an agent takes an issue.
    """
    issue = get_issue(s, ref)
    values: dict = {}
    if title is not None:
        if not title.strip():
            raise Invalid("An issue needs a title.")
        values["title"] = title.strip()
    if description is not None:
        values["description"] = description
    if status is not None:
        values["status"] = _check_status(status)
        if status == "in_progress" and assignee is _UNSET and actor.is_agent:
            assignee = actor.name
    if assignee is not _UNSET:
        values["assignee"] = assignee or None
    if position is not None:
        values["position"] = float(position)
    if not values:
        return issue

    statement = update(Issue).where(Issue.id == issue.id)
    if actor.is_agent and ("status" in values or "assignee" in values):
        # Checked in the same statement as the write, so two agents can't both take an issue.
        statement = statement.where(
            or_(Issue.status != "in_progress", Issue.assignee.is_(None), Issue.assignee == actor.name)
        )
    result = s.execute(statement.values(**values, updated_at=utcnow()).execution_options(synchronize_session=False))
    if result.rowcount == 0:
        s.rollback()
        s.refresh(issue)
        raise Conflict(f"{issue.ref} is in progress by {issue.assignee}. Pick another issue.")
    s.commit()
    s.refresh(issue)
    return issue


def _check_status(status: str) -> str:
    if status not in STATUSES:
        raise Invalid(f"Unknown status {status!r}. Use one of: {', '.join(STATUSES)}.")
    return status


# Comments and the inbox


def add_comment(s: Session, actor: Actor, ref: str, body: str, asks_human: bool = False) -> Comment:
    issue = get_issue(s, ref)
    if not body.strip():
        raise Invalid("A comment needs a body.")
    comment = Comment(
        issue=issue,
        author=actor.name,
        author_kind=actor.kind,
        body=body.strip(),
        asks_human=asks_human and actor.is_agent,
    )
    issue.updated_at = utcnow()
    s.add(comment)
    s.commit()
    return comment


def _unanswered():
    """Questions for the human with no human comment after them on the same issue."""
    reply = aliased(Comment)
    return exists().where(reply.issue_id == Comment.issue_id, reply.author_kind == "human", reply.id > Comment.id)


def inbox(s: Session) -> list[Comment]:
    """Open questions from agents, oldest first."""
    query = (
        select(Comment)
        .join(Issue)
        .where(Comment.asks_human, ~_unanswered(), Issue.status.not_in(("done", "cancelled")))
        .order_by(Comment.id)
    )
    return list(s.scalars(query))


def waiting_on_human(issue: Issue) -> bool:
    last_question = max((c.id for c in issue.comments if c.asks_human), default=None)
    if last_question is None or issue.status in ("done", "cancelled"):
        return False
    return not any(c.author_kind == "human" and c.id > last_question for c in issue.comments)
