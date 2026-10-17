from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Table,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

STATUSES = ("todo", "in_progress", "in_review", "done", "cancelled")
OPEN_STATUSES = ("in_progress", "in_review", "todo")
# How much an issue matters, beside its place in the pile: urgent ones go first.
PRIORITIES = ("urgent", "high", "normal", "low")


def utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class Base(DeclarativeBase):
    pass


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(10), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    next_number: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    issues: Mapped[list["Issue"]] = relationship(back_populates="project")


# "issue is blocked by blocker": the issue can't be taken until the blocker is done.
blocks_table = Table(
    "blocks",
    Base.metadata,
    Column("issue_id", ForeignKey("issues.id", ondelete="CASCADE"), primary_key=True),
    Column("blocker_id", ForeignKey("issues.id", ondelete="CASCADE"), primary_key=True),
)


class Issue(Base):
    __tablename__ = "issues"
    __table_args__ = (UniqueConstraint("project_id", "number"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"))
    number: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(300))
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default="todo")
    # One of PRIORITIES. The server default fills it in for issues from before munin kept it.
    priority: Mapped[str] = mapped_column(String(10), default="normal", server_default="normal")
    assignee: Mapped[str | None] = mapped_column(String(100), default=None)
    # Order within the pile: lower is nearer the top.
    position: Mapped[float] = mapped_column(Float, default=0.0)
    created_by: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    # When the issue entered its current status. Empty for issues from before munin kept it.
    status_changed_at: Mapped[datetime | None] = mapped_column(DateTime, default=utcnow)

    project: Mapped[Project] = relationship(back_populates="issues")
    pull_requests: Mapped[list["PullRequest"]] = relationship(
        back_populates="issue", order_by="PullRequest.id", cascade="all, delete-orphan"
    )
    comments: Mapped[list["Comment"]] = relationship(
        back_populates="issue", order_by="Comment.id", cascade="all, delete-orphan"
    )
    events: Mapped[list["Event"]] = relationship(
        back_populates="issue", order_by="Event.id", cascade="all, delete-orphan"
    )
    blocked_by: Mapped[list["Issue"]] = relationship(
        secondary=blocks_table,
        primaryjoin=lambda: Issue.id == blocks_table.c.issue_id,
        secondaryjoin=lambda: Issue.id == blocks_table.c.blocker_id,
        back_populates="blocks",
        order_by=lambda: Issue.id,
    )
    blocks: Mapped[list["Issue"]] = relationship(
        secondary=blocks_table,
        primaryjoin=lambda: Issue.id == blocks_table.c.blocker_id,
        secondaryjoin=lambda: Issue.id == blocks_table.c.issue_id,
        back_populates="blocked_by",
        order_by=lambda: Issue.id,
    )

    @property
    def ref(self) -> str:
        return f"{self.project.key}-{self.number}"


class Comment(Base):
    __tablename__ = "comments"

    id: Mapped[int] = mapped_column(primary_key=True)
    issue_id: Mapped[int] = mapped_column(ForeignKey("issues.id"))
    author: Mapped[str] = mapped_column(String(100))
    author_kind: Mapped[str] = mapped_column(String(10))  # "agent" or "human"
    body: Mapped[str] = mapped_column(Text)
    # An agent's question for the human. It stays in the inbox until a human replies on the issue.
    asks_human: Mapped[bool] = mapped_column(Boolean, default=False)
    # Answers a question can offer, as [{"label": ..., "detail": ...}]. The human can still write their own.
    options: Mapped[list | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    issue: Mapped[Issue] = relationship(back_populates="comments")


class PullRequest(Base):
    """A pull request on GitHub that carries an issue's work, with what GitHub last said about it."""

    __tablename__ = "pull_requests"
    __table_args__ = (UniqueConstraint("issue_id", "url"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    issue_id: Mapped[int] = mapped_column(ForeignKey("issues.id"))
    url: Mapped[str] = mapped_column(String(300))
    repo: Mapped[str] = mapped_column(String(200))  # owner/name
    number: Mapped[int] = mapped_column(Integer)
    title: Mapped[str | None] = mapped_column(String(300), default=None)
    # "open", "merged" or "closed" (without merging); empty until GitHub has been asked.
    state: Mapped[str | None] = mapped_column(String(10), default=None)
    checked_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    added_by: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    issue: Mapped[Issue] = relationship(back_populates="pull_requests")


class Event(Base):
    """Something that happened to an issue: created, moved, assigned, renamed, blocked."""

    __tablename__ = "events"

    id: Mapped[int] = mapped_column(primary_key=True)
    issue_id: Mapped[int] = mapped_column(ForeignKey("issues.id"))
    actor: Mapped[str] = mapped_column(String(100))
    actor_kind: Mapped[str] = mapped_column(String(10))
    # created, status, assignee, title, description or blocked_by
    kind: Mapped[str] = mapped_column(String(20))
    old: Mapped[str | None] = mapped_column(Text, default=None)
    new: Mapped[str | None] = mapped_column(Text, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    issue: Mapped[Issue] = relationship(back_populates="events")


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    token_hint: Mapped[str] = mapped_column(String(10))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
