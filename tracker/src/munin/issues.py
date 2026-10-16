"""Projects, issues and comments. The MCP tools and the web API both go through here."""

import re
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import and_, case, exists, func, select, update
from sqlalchemy.orm import Session, aliased

from munin.models import OPEN_STATUSES, STATUSES, Comment, Event, Issue, Project, utcnow

KEY_PATTERN = re.compile(r"^[A-Z][A-Z0-9]{1,9}$")
UNASSIGNED = ("", "none", "null", "nobody", "unassigned")
FILLER_WORDS = {"add", "and", "the", "for", "with", "from", "into", "make", "update", "fix", "create", "new"}
REF_PATTERN = re.compile(r"^\s*([A-Za-z][A-Za-z0-9]*)-(\d+)\s*$")
CLOSED_STATUSES = ("done", "cancelled")


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
    """A project by its key (MUN), or by its name, since agents sometimes use that."""
    wanted = key.strip()
    project = s.scalar(select(Project).where(Project.key == wanted.upper()))
    project = project or s.scalar(select(Project).where(func.lower(Project.name) == wanted.lower()))
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
    query: str | None = None,
) -> list[Issue]:
    """Issues in pile order. Without a status, only open issues (todo, in progress, in review).

    query matches an issue id exactly, or words in titles and descriptions.
    """
    statement = select(Issue).join(Project)
    if project:
        statement = statement.where(Issue.project_id == get_project(s, project).id)
    if status is None:
        statement = statement.where(Issue.status.in_(OPEN_STATUSES))
    elif status != "all":
        statement = statement.where(Issue.status == _check_status(status))
    if assignee is not None:
        assignee = clean_assignee(assignee)
        statement = statement.where(Issue.assignee == assignee if assignee else Issue.assignee.is_(None))
    if query and query.strip():
        statement = statement.where(_matches(query.strip()))
    statement = statement.order_by(_status_order(), Issue.position, Issue.id)
    if limit:
        statement = statement.limit(limit)
    return list(s.scalars(statement))


def _matches(query: str):
    """An issue id matches that issue; otherwise every word must be in the title or description."""
    if match := REF_PATTERN.match(query):
        return and_(Project.key == match.group(1).upper(), Issue.number == int(match.group(2)))
    text = func.lower(Issue.title + " " + Issue.description)
    return and_(*(text.contains(word, autoescape=True) for word in query.lower().split()))


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
    blocked_by: list[str] | None = None,
) -> Issue:
    proj = get_project(s, project)
    if not title.strip():
        raise Invalid("An issue needs a title.")
    status = _check_status(status)
    assignee = clean_assignee(assignee)
    if status == "in_progress" and actor.is_agent and assignee is None:
        assignee = actor.name
    blockers = _resolve(s, blocked_by or [])
    if actor.is_agent and status == "in_progress" and (waiting_for := _open(blockers)):
        raise Conflict(f"It would be blocked by {_refs(waiting_for)}, which isn't done yet. Create it as todo.")
    bottom = s.scalar(select(func.max(Issue.position)).where(Issue.project_id == proj.id))
    issue = Issue(
        project=proj,
        number=proj.next_number,
        title=title.strip(),
        description=description,
        status=status,
        assignee=assignee,
        position=(bottom or 0.0) + 1.0,
        created_by=actor.name,
        blocked_by=blockers,
    )
    proj.next_number += 1
    s.add(issue)
    now = utcnow()
    _record(issue, actor, now, "created", new=status)
    if blockers:
        _record(issue, actor, now, "blocked_by", new=_refs(blockers))
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
    blocked_by: list[str] | None = None,
) -> Issue:
    """Change an issue.

    Two rules for agents: they can't change the status or assignee of an issue another agent
    has in progress, and they can't start an issue whose blockers aren't done. Moving an issue
    to in_progress without naming an assignee makes the agent its assignee, which is how an
    agent takes an issue.

    Status and assignee are only written over what was read, so a change someone else made in
    the meantime is never silently undone: the second writer gets a Conflict instead.
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
        values["assignee"] = clean_assignee(assignee)
    if position is not None:
        values["position"] = float(position)
    blockers = _check_blockers(s, issue, blocked_by) if blocked_by is not None else None

    held_by_other = issue.status == "in_progress" and issue.assignee not in (None, actor.name)
    if actor.is_agent and held_by_other and ("status" in values or "assignee" in values):
        raise Conflict(f"{issue.ref} is in progress by {issue.assignee}. Pick another issue.")
    already_mine = issue.status == "in_progress" and issue.assignee == actor.name
    if actor.is_agent and values.get("status") == "in_progress" and not already_mine:
        waiting_for = open_blockers(issue) if blockers is None else _open(blockers)
        if waiting_for:
            raise Conflict(f"{issue.ref} is blocked by {_refs(waiting_for)}, which isn't done yet. Take another issue.")

    now = utcnow()
    before = {field: getattr(issue, field) for field in ("title", "description", "status", "assignee")}
    old_blockers = list(issue.blocked_by)
    changes = {field: new for field, new in values.items() if field in before and new != before[field]}
    blockers_changed = blockers is not None and set(blockers) != set(old_blockers)
    if values:
        statement = update(Issue).where(Issue.id == issue.id)
        if "status" in values or "assignee" in values:
            # Checked in the same statement as the write: if someone else changed status or
            # assignee since we read it (another agent took it, the human cancelled it), stop.
            statement = statement.where(Issue.status == before["status"], Issue.assignee == before["assignee"])
        if "status" in changes:
            values["status_changed_at"] = now
        if changes or blockers_changed:  # reordering the pile isn't an update to the issue
            values["updated_at"] = now
        result = s.execute(statement.values(**values).execution_options(synchronize_session=False))
        if result.rowcount == 0:
            s.rollback()
            s.refresh(issue)
            if actor.is_agent and issue.status == "in_progress" and issue.assignee not in (None, actor.name):
                raise Conflict(f"{issue.ref} is in progress by {issue.assignee}. Pick another issue.")
            held = f", assigned to {issue.assignee}" if issue.assignee else ""
            raise Conflict(f"{issue.ref} changed just now: it's {issue.status}{held}. Look at it again.")

    for field in ("status", "assignee", "title"):
        if field in changes:
            _record(issue, actor, now, field, before[field], changes[field])
    if "description" in changes:
        _record(issue, actor, now, "description")
    if blockers_changed:
        issue.blocked_by = blockers
        if "updated_at" not in values:
            issue.updated_at = now
        _record(issue, actor, now, "blocked_by", _refs(old_blockers) or None, _refs(blockers) or None)
        # The write lock is ours from here on, so this sees everyone else's committed blockers:
        # two people adding opposite dependencies at once can't make a loop.
        s.flush()
        s.expire_all()
        loop = next((blocker for blocker in blockers if _waits_for(blocker, issue)), None)
        if loop is not None:
            s.rollback()
            raise Invalid(f"{loop.ref} already waits for {issue.ref}, so {issue.ref} can't wait for it.")
    s.commit()
    s.refresh(issue)
    return issue


def open_blockers(issue: Issue) -> list[Issue]:
    """The issues this one waits for that aren't done (or cancelled) yet."""
    return _open(issue.blocked_by)


def _open(blockers: list[Issue]) -> list[Issue]:
    return [blocker for blocker in blockers if blocker.status not in CLOSED_STATUSES]


def _resolve(s: Session, refs: list[str]) -> list[Issue]:
    """Issues for refs, once each however they're spelled (MUN-1, mun-1, " MUN-1")."""
    return list({issue.id: issue for issue in (get_issue(s, ref) for ref in refs)}.values())


def _check_blockers(s: Session, issue: Issue, refs: list[str]) -> list[Issue]:
    blockers = _resolve(s, refs)
    for blocker in blockers:
        if blocker.id == issue.id:
            raise Invalid(f"{issue.ref} can't block itself.")
        if _waits_for(blocker, issue):
            raise Invalid(f"{blocker.ref} already waits for {issue.ref}, so {issue.ref} can't wait for it.")
    return blockers


def _waits_for(issue: Issue, target: Issue) -> bool:
    """Whether issue is blocked by target, directly or through other issues."""
    seen, stack = set(), list(issue.blocked_by)
    while stack:
        current = stack.pop()
        if current.id == target.id:
            return True
        if current.id not in seen:
            seen.add(current.id)
            stack.extend(current.blocked_by)
    return False


def _refs(issues: list[Issue]) -> str:
    return ", ".join(issue.ref for issue in issues)


def _record(
    issue: Issue, actor: Actor, at: datetime, kind: str, old: str | None = None, new: str | None = None
) -> None:
    """Add a line of history. Events from one change share their time, so a take (moved and assigned) reads as one."""
    issue.events.append(Event(actor=actor.name, actor_kind=actor.kind, kind=kind, old=old, new=new, created_at=at))


def clean_assignee(assignee: str | None) -> str | None:
    """None for "nobody", however an agent spells it ("", '""', "none", "null")."""
    name = (assignee or "").strip().strip("\"'").strip()
    return None if name.lower() in UNASSIGNED else name


def similar_open_issues(s: Session, issue: Issue) -> list[Issue]:
    """Other open issues in the project whose titles share most of their words with this one.

    Words from the project's own name don't count: they turn up in most of its titles.
    """
    project_words = _title_words(f"{issue.project.name} {issue.project.key}")
    words = _title_words(issue.title) - project_words
    others = s.scalars(
        select(Issue).where(Issue.project_id == issue.project_id, Issue.id != issue.id, Issue.status.in_(OPEN_STATUSES))
    )
    similar = []
    for other in others:
        theirs = _title_words(other.title) - project_words
        shared = words & theirs
        if len(shared) >= 2 and len(shared) / min(len(words), len(theirs)) >= 0.6:
            similar.append(other)
    return similar


def _title_words(title: str) -> set[str]:
    return {word for word in re.findall(r"[a-z0-9_]+", title.lower()) if len(word) > 2} - FILLER_WORDS


def _check_status(status: str) -> str:
    if status not in STATUSES:
        raise Invalid(f"Unknown status {status!r}. Use one of: {', '.join(STATUSES)}.")
    return status


# What an agent can do next


@dataclass
class Available:
    """Open issues in a project that an agent could pick up right now."""

    take: list[Issue]  # todo, not blocked, unassigned or assigned to the agent
    review: list[Issue]  # in review and not the agent's own work
    answered: list[Issue]  # the agent's issues where the human replied after the agent last spoke

    def __bool__(self) -> bool:
        return bool(self.take or self.review or self.answered)


def available_work(s: Session, agent: str, project: str) -> Available:
    issues = list_issues(s, project)
    return Available(
        take=[
            i
            for i in issues
            if i.status == "todo" and i.assignee in (None, agent) and not open_blockers(i) and not waiting_on_human(i)
        ],
        review=[i for i in issues if i.status == "in_review" and i.assignee != agent],
        answered=[i for i in issues if i.assignee == agent and i.status == "in_progress" and _answered(i, agent)],
    )


def _answered(issue: Issue, agent: str) -> bool:
    asked = any(c.asks_human and c.author == agent for c in issue.comments)
    last_human = max((c.id for c in issue.comments if c.author_kind == "human"), default=0)
    last_own = max((c.id for c in issue.comments if c.author == agent), default=0)
    return asked and last_human > last_own


def last_activity(s: Session, project: str) -> datetime | None:
    """When anything last happened to the project's issues: a change or a comment."""
    project_id = get_project(s, project).id
    changed = s.scalar(select(func.max(Event.created_at)).join(Issue).where(Issue.project_id == project_id))
    commented = s.scalar(select(func.max(Comment.created_at)).join(Issue).where(Issue.project_id == project_id))
    return max((moment for moment in (changed, commented) if moment), default=None)


# Activity


def recent_events(s: Session, limit: int = 50, project: str | None = None) -> list[Event]:
    """What happened lately, newest first."""
    statement = select(Event).join(Issue).order_by(Event.id.desc()).limit(limit)
    if project:
        statement = statement.where(Issue.project_id == get_project(s, project).id)
    return list(s.scalars(statement))


def history(events: list[Event]) -> list[tuple[Event, str]]:
    """Each event with its line of history, where a take (moved to in_progress and assigned to
    yourself at once) is one line: "claude-code took it"."""
    lines: list[tuple[Event, str]] = []
    for event in events:
        before = lines[-1][0] if lines else None
        took = (
            before is not None
            and event.kind == "assignee"
            and before.kind == "status"
            and before.new == "in_progress"
            and event.new == event.actor == before.actor
            and (event.issue_id, event.created_at) == (before.issue_id, before.created_at)
        )
        if took:
            lines[-1] = (before, f"{event.actor} took it")
        else:
            lines.append((event, describe_event(event)))
    return lines


def describe_event(event: Event) -> str:
    """One line of history, like "claude-code moved it to in_review"."""
    who, old, new = event.actor, event.old, event.new
    match event.kind:
        case "created":
            return f"{who} created it"
        case "status":
            return f"{who} moved it from {old} to {new}"
        case "assignee":
            return f"{who} assigned it to {new}" if new else f"{who} unassigned {old}"
        case "title":
            return f"{who} renamed it from {old!r}"
        case "description":
            return f"{who} edited the description"
        case "blocked_by":
            return f"{who} set it to wait for {new}" if new else f"{who} removed what it waited for"
    return f"{who} changed {event.kind}"


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
        .where(Comment.asks_human, ~_unanswered(), Issue.status.not_in(CLOSED_STATUSES))
        .order_by(Comment.id)
    )
    return list(s.scalars(query))


def waiting_on_human(issue: Issue) -> bool:
    last_question = max((c.id for c in issue.comments if c.asks_human), default=None)
    if last_question is None or issue.status in CLOSED_STATUSES:
        return False
    return not any(c.author_kind == "human" and c.id > last_question for c in issue.comments)
