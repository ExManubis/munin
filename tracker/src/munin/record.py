"""What an agent has done in the tracker, read from issues and their history.

It's the same for any agent, munin's own or claude-code, and for a person: the tracker knows
names, not who runs them. Work counts as an agent's while the issue is assigned to it.
"""

from collections import Counter
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from munin.models import Event, Issue

BACK = ("todo", "in_progress")  # where work sent back from review goes


@dataclass
class Record:
    name: str
    shipped: int  # its issues that are done
    sent_to_review: int  # times it moved an issue to In review
    sent_back: int  # times someone else moved its issue from In review back to work
    reviewed: int  # times it moved someone else's issue out of In review
    projects: list[tuple[str, int]]  # where most of its issues are, most first
    last_shipped: Issue | None
    last_shipped_at: datetime | None
    since: datetime | None  # its first change to any issue


def _count(s: Session, *where) -> int:
    return s.scalar(select(func.count()).select_from(Event).join(Issue).where(Event.kind == "status", *where)) or 0


def record(s: Session, name: str) -> Record:
    mine = list(s.scalars(select(Issue).where(Issue.assignee == name)))
    done = [issue for issue in mine if issue.status == "done"]
    last = max(done, key=lambda issue: issue.status_changed_at or issue.updated_at, default=None)
    from_review = (Event.old == "in_review",)
    return Record(
        name=name,
        shipped=len(done),
        sent_to_review=_count(s, Event.actor == name, Event.new == "in_review"),
        sent_back=_count(s, *from_review, Event.new.in_(BACK), Event.actor != name, Issue.assignee == name),
        reviewed=_count(
            s,
            *from_review,
            Event.new.in_(("done", *BACK)),
            Event.actor == name,
            or_(Issue.assignee != name, Issue.assignee.is_(None)),
        ),
        projects=Counter(issue.project.key for issue in mine).most_common(3),
        last_shipped=last,
        last_shipped_at=(last.status_changed_at or last.updated_at) if last else None,
        since=s.scalar(select(func.min(Event.created_at)).where(Event.actor == name)),
    )
