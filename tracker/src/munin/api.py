"""JSON API for the web UI. It acts as the human; there's no login, so munin only listens locally."""

import asyncio
from datetime import UTC, datetime
from email.errors import HeaderParseError
from email.header import decode_header, make_header
from importlib.metadata import version
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import AfterValidator, BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from munin import agents as agent_svc
from munin import issues as svc
from munin import record as record_svc
from munin import updates
from munin import usage as usage_svc
from munin.issues import Actor, Invalid
from munin.push import PushError
from munin.models import Agent, Comment, Event, Issue, Project, utcnow

router = APIRouter(prefix="/api")


def session(request: Request):
    with request.app.state.sessions() as s:
        yield s


def human(request: Request) -> Actor:
    return Actor(name=request.app.state.settings.user, kind="human")


DB = Annotated[Session, Depends(session)]
Human = Annotated[Actor, Depends(human)]


# Response shapes

# The database keeps UTC without a timezone; say so on the way out ("...Z").
UTCDateTime = Annotated[datetime, AfterValidator(lambda moment: moment.replace(tzinfo=UTC))]


class ProjectOut(BaseModel):
    key: str
    name: str
    description: str
    counts: dict[str, int]


class OptionOut(BaseModel):
    label: str
    detail: str = ""


class CommentOut(BaseModel):
    id: int
    author: str
    author_kind: str
    body: str
    asks_human: bool
    # Answers a question offers; the human can pick one or write their own.
    options: list[OptionOut] | None = None
    created_at: UTCDateTime


class EventOut(BaseModel):
    id: int
    actor: str
    actor_kind: str
    kind: str
    old: str | None
    new: str | None
    created_at: UTCDateTime


class IssueBriefOut(BaseModel):
    id: str
    title: str
    status: str
    assignee: str | None


class CostOut(BaseModel):
    cost: float
    tokens: int
    agents: dict[str, float]


class IssueOut(BaseModel):
    id: str
    project: str
    title: str
    description: str
    status: str
    priority: str
    assignee: str | None
    position: float
    created_by: str
    created_at: UTCDateTime
    updated_at: UTCDateTime
    # When the issue entered its status; older issues fall back to their last update.
    status_changed_at: UTCDateTime
    waiting_on_human: bool
    # Ids of the issues this one waits for that aren't done yet.
    blocked_by: list[str]
    # Its questions are out of your inbox until then.
    snoozed_until: UTCDateTime | None = None
    # What agents reported spending. Only set on the issue list and a single issue.
    cost: CostOut | None = None


class PullRequestOut(BaseModel):
    id: int
    url: str
    repo: str
    number: int
    title: str | None
    state: str | None  # open, merged, closed, or None until GitHub has been asked


class IssueDetailOut(IssueOut):
    pull_requests: list[PullRequestOut] = []
    waits_for: list[IssueBriefOut]
    blocks: list[IssueBriefOut]
    comments: list[CommentOut]
    events: list[EventOut]


class InboxItemOut(BaseModel):
    issue: IssueOut
    question: CommentOut


class ActivityOut(EventOut):
    issue: IssueBriefOut
    project: str
    text: str


class AgentOut(BaseModel):
    name: str
    # The harness it runs in, for its mark: one of agents.PROVIDERS, or None.
    provider: str | None = None
    token_hint: str
    created_at: UTCDateTime
    last_seen_at: UTCDateTime | None
    revoked: bool
    # Issues the agent has in progress right now.
    working_on: list[IssueBriefOut]


class NewAgentOut(AgentOut):
    token: str


class ProjectShareOut(BaseModel):
    key: str
    issues: int


class RecordOut(BaseModel):
    """What an agent has done in the tracker (record.py), for its profile."""

    name: str
    shipped: int
    sent_to_review: int
    sent_back: int
    reviewed: int
    projects: list[ProjectShareOut]
    last_shipped: IssueBriefOut | None
    last_shipped_at: UTCDateTime | None
    since: UTCDateTime | None


def _project_out(project: Project, counts: dict[str, int]) -> ProjectOut:
    return ProjectOut(key=project.key, name=project.name, description=project.description, counts=counts)


def _comment_out(comment: Comment) -> CommentOut:
    return CommentOut.model_validate(comment, from_attributes=True)


def _event_out(event: Event) -> EventOut:
    return EventOut.model_validate(event, from_attributes=True)


def _brief_out(issue: Issue) -> IssueBriefOut:
    return IssueBriefOut(id=issue.ref, title=issue.title, status=issue.status, assignee=issue.assignee)


def _issue_out(issue: Issue) -> IssueOut:
    return IssueOut(
        id=issue.ref,
        project=issue.project.key,
        title=issue.title,
        description=issue.description,
        status=issue.status,
        priority=issue.priority or "normal",
        assignee=issue.assignee,
        position=issue.position,
        created_by=issue.created_by,
        created_at=issue.created_at,
        updated_at=issue.updated_at,
        status_changed_at=issue.status_changed_at or issue.updated_at,
        waiting_on_human=svc.waiting_on_human(issue),
        blocked_by=[blocker.ref for blocker in svc.open_blockers(issue)],
        snoozed_until=issue.snoozed_until if issue.snoozed_until and issue.snoozed_until > utcnow() else None,
    )


def _cost_out(total: dict | None) -> CostOut | None:
    return CostOut(**total) if total else None


def _pull_out(pull) -> PullRequestOut:
    return PullRequestOut(id=pull.id, url=pull.url, repo=pull.repo, number=pull.number, title=pull.title, state=pull.state)


def _issue_detail_out(issue: Issue) -> IssueDetailOut:
    return IssueDetailOut(
        **_issue_out(issue).model_dump(),
        pull_requests=[_pull_out(pull) for pull in issue.pull_requests],
        waits_for=[_brief_out(blocker) for blocker in issue.blocked_by],
        blocks=[_brief_out(blocked) for blocked in issue.blocks],
        comments=[_comment_out(c) for c in issue.comments],
        events=[_event_out(e) for e in issue.events if e.kind != "comment"],
    )


def _agent_out(agent: Agent, working_on: list[Issue]) -> AgentOut:
    return AgentOut(
        name=agent.name,
        provider=agent.provider,
        token_hint=agent.token_hint,
        created_at=agent.created_at,
        last_seen_at=agent.last_seen_at,
        revoked=agent.revoked_at is not None,
        working_on=[_brief_out(issue) for issue in working_on if issue.assignee == agent.name],
    )


# Request shapes


class ProjectIn(BaseModel):
    key: str
    name: str
    description: str = ""


class ProjectPatch(BaseModel):
    name: str | None = None
    description: str | None = None


class IssueIn(BaseModel):
    project: str
    title: str
    description: str = ""
    status: str = "todo"
    assignee: str | None = None
    blocked_by: list[str] = []
    priority: str = "normal"


class IssuePatch(BaseModel):
    title: str | None = None
    description: str | None = None
    status: str | None = None
    assignee: str | None = None
    position: float | None = None
    blocked_by: list[str] | None = None
    priority: str | None = None


class CommentIn(BaseModel):
    body: str


class AgentIn(BaseModel):
    name: str
    provider: str | None = None


# Routes


@router.get("/me")
def me(request: Request) -> dict:
    # Behind the edge, agents elsewhere reach /mcp at munin's public address. Otherwise the address
    # this page was opened on also reaches it, even when munin listens on 0.0.0.0.
    settings = request.app.state.settings
    base = settings.public_url or str(request.base_url).rstrip("/")
    return {
        "name": settings.user,
        "you": _you(request),
        "mcp_url": f"{base}/mcp",
        "version": version("munin"),
    }


def _you(request: Request) -> dict | None:
    """Who's looking, behind the edge: tailscale serve says, having removed whatever the caller sent, on
    requests to munin's public name. `name` stays the one your comments get; this is only who's at the screen."""
    settings = request.app.state.settings
    if not settings.public_host or (request.url.hostname or "").lower() != settings.public_host:
        return None
    login = request.headers.get("tailscale-user-login", "").strip()
    if not login:
        return None
    return {"name": _header_text(request.headers.get("tailscale-user-name", "")) or login.split("@")[0], "login": login}


def _header_text(value: str) -> str:
    """Serve sends a name with letters outside ASCII encoded, like =?utf-8?q?Mikkel_N=C3=B8rgaard?=."""
    try:
        return str(make_header(decode_header(value))).strip()
    except (HeaderParseError, LookupError, UnicodeDecodeError):
        return value.strip()


@router.get("/projects")
def list_projects(s: DB) -> list[ProjectOut]:
    counts = svc.issue_counts(s)
    return [_project_out(p, counts.get(p.key, {})) for p in svc.list_projects(s)]


@router.post("/projects", status_code=201)
def create_project(body: ProjectIn, s: DB) -> ProjectOut:
    return _project_out(svc.create_project(s, body.key, body.name, body.description), {})


@router.patch("/projects/{key}")
def update_project(key: str, body: ProjectPatch, s: DB) -> ProjectOut:
    project = svc.update_project(s, key, name=body.name, description=body.description)
    return _project_out(project, svc.issue_counts(s).get(project.key, {}))


@router.get("/issues")
def list_issues(
    s: DB,
    project: str | None = None,
    status: str | None = None,
    assignee: str | None = None,
    q: Annotated[str | None, Query(description="An issue id, or words in titles and descriptions")] = None,
    limit: Annotated[int | None, Query(ge=1, le=500)] = None,
) -> list[IssueOut]:
    found = svc.list_issues(s, project, status, assignee, limit, q)
    costs = usage_svc.totals(s, [issue.id for issue in found])
    return [_issue_out(issue).model_copy(update={"cost": _cost_out(costs.get(issue.id))}) for issue in found]


@router.post("/issues", status_code=201)
def create_issue(body: IssueIn, s: DB, actor: Human) -> IssueDetailOut:
    issue = svc.create_issue(
        s, actor, body.project, body.title, body.description, body.status, body.assignee, body.blocked_by, body.priority
    )
    return _issue_detail_out(issue)


@router.get("/issues/{ref}")
def get_issue(ref: str, s: DB) -> IssueDetailOut:
    issue = svc.get_issue(s, ref)
    cost = usage_svc.totals(s, [issue.id]).get(issue.id)
    return _issue_detail_out(issue).model_copy(update={"cost": _cost_out(cost)})


@router.patch("/issues/{ref}")
def update_issue(ref: str, body: IssuePatch, s: DB, actor: Human) -> IssueDetailOut:
    changes = body.model_dump(exclude_unset=True)
    return _issue_detail_out(svc.update_issue(s, actor, ref, **changes))


@router.post("/issues/{ref}/comments", status_code=201)
def add_comment(ref: str, body: CommentIn, s: DB, actor: Human) -> IssueDetailOut:
    comment = svc.add_comment(s, actor, ref, body.body)
    return _issue_detail_out(comment.issue)


@router.get("/inbox")
def inbox(s: DB, snoozed: bool = False) -> list[InboxItemOut]:
    """Questions waiting on you, or (`snoozed`) the ones put off till later."""
    return [InboxItemOut(issue=_issue_out(c.issue), question=_comment_out(c)) for c in svc.inbox(s, snoozed)]


class SnoozeIn(BaseModel):
    until: datetime | None  # None wakes it now


@router.put("/issues/{ref}/snooze")
def snooze(ref: str, body: SnoozeIn, s: DB) -> IssueOut:
    return _issue_out(svc.snooze(s, ref, body.until))


@router.get("/activity")
def activity(s: DB, project: str | None = None, limit: Annotated[int, Query(ge=1, le=200)] = 50) -> list[ActivityOut]:
    """What happened lately, newest first."""
    return [_activity_out(s, event) for event in svc.recent_events(s, limit, project)]


# How many missed events a reconnecting client is sent before it's told to reload instead.
REPLAY_LIMIT = 500


def _activity_out(s: Session, event: Event) -> ActivityOut:
    return ActivityOut(
        **_event_out(event).model_dump(),
        issue=_brief_out(event.issue),
        project=event.issue.project.key,
        text=svc.describe_event(event),
    )


def _sse(kind: str, data: str, id: int | None = None) -> str:
    return (f"id: {id}\n" if id is not None else "") + f"event: {kind}\ndata: {data}\n\n"


@router.get("/stream")
async def stream(request: Request) -> StreamingResponse:
    """Server-sent events, numbered by the tracker's event ids: a "changed" event for each event (an
    issue created, moved, assigned, edited or commented on), with what happened as JSON, and one
    without an id for any other change. A client that reconnects with Last-Event-ID gets the events it
    missed, or a "reset" when it missed too many to send, which means: reload everything."""
    changes = request.app.state.changes
    sessions = request.app.state.sessions

    def newest() -> int:
        with sessions() as s:
            return s.scalar(select(func.max(Event.id))) or 0

    def after(last: int, limit: int) -> list[tuple[int, str]]:
        with sessions() as s:
            return [
                (event.id, _sse("changed", _activity_out(s, event).model_dump_json(), event.id))
                for event in svc.events_after(s, last, limit)
            ]

    header = request.headers.get("last-event-id", "")
    resumed = int(header) if header.isdigit() else None

    async def events():
        seen, quiet = changes.revision, 0.0
        yield "retry: 3000\n\n"
        if resumed is None:
            last = await asyncio.to_thread(newest)
            yield f"id: {last}\n\n"  # numbered from here, so a reconnect can say where it was
        else:
            missed = await asyncio.to_thread(after, resumed, REPLAY_LIMIT + 1)
            last = await asyncio.to_thread(newest)
            if len(missed) > REPLAY_LIMIT:
                yield _sse("reset", "{}", last)
            else:
                for _, line in missed:
                    yield line
                if not missed:
                    yield f"id: {last}\n\n"
        while not await request.is_disconnected():
            if changes.revision != seen:
                seen, quiet = changes.revision, 0.0
                fresh = await asyncio.to_thread(after, last, REPLAY_LIMIT)
                for last, line in fresh:
                    yield line
                if not fresh:
                    yield _sse("changed", "{}")  # a change that isn't an issue's: a project, a token
            elif quiet >= 15:
                quiet = 0.0
                yield ": still here\n\n"
            await asyncio.sleep(0.25)
            quiet += 0.25

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


class PullRequestIn(BaseModel):
    url: str


class GitHubTokenIn(BaseModel):
    token: str | None = None


@router.post("/issues/{ref}/pull-requests", status_code=201)
def link_pull_request(ref: str, body: PullRequestIn, request: Request, s: DB, actor: Human) -> IssueDetailOut:
    """Link a pull request on GitHub to the issue, asking GitHub what it's called and whether it's open."""
    from munin.github import GitHubError, parse_pull_url

    found = None
    try:
        repo, number, _ = parse_pull_url(body.url)
        found = request.app.state.github.pull(repo, number)
    except GitHubError:
        pass  # a bad URL is refused below; GitHub being away just leaves it unchecked
    svc.link_pull_request(s, actor, ref, body.url, found)
    return _issue_detail_out(svc.get_issue(s, ref))


@router.delete("/issues/{ref}/pull-requests/{pull_id}")
def unlink_pull_request(ref: str, pull_id: int, s: DB, actor: Human) -> IssueDetailOut:
    svc.unlink_pull_request(s, actor, ref, pull_id)
    return _issue_detail_out(svc.get_issue(s, ref))


@router.get("/update")
async def update_status(request: Request) -> dict:
    """What munin runs, and what's newer on GitHub."""
    settings, github = request.app.state.settings, request.app.state.github
    return await asyncio.to_thread(updates.status, settings.db_path.parent, github.api, github.token)


@router.post("/update", status_code=202)
def update_now(request: Request) -> dict:
    """Start an update. munin restarts on its way through, and is back in a minute or so."""
    data_dir = request.app.state.settings.db_path.parent
    if not updates.installed(data_dir):
        raise Invalid("This munin wasn't set up by its install script, so it can't update itself. Pull and restart it.")
    updates.request(data_dir)
    return {"started": True}


@router.get("/github")
def github_status(request: Request) -> dict:
    """Whether there's a GitHub token, by its last four characters. It's never sent back."""
    hint = request.app.state.github.hint
    return {"token": {"hint": hint} if hint else None}


@router.put("/github")
def github_token(request: Request, body: GitHubTokenIn) -> dict:
    request.app.state.github.set_token(body.token)
    return github_status(request)


class PushSubscriptionIn(BaseModel):
    subscription: dict


class PushForgetIn(BaseModel):
    endpoint: str


@router.get("/push")
def push_status(request: Request) -> dict:
    """The key a device subscribes with, and how many devices get the tracker's pushes."""
    push = request.app.state.push
    return {"key": push.key, "devices": len(push.devices)}


@router.post("/push", status_code=201)
def push_subscribe(request: Request, body: PushSubscriptionIn) -> dict:
    try:
        request.app.state.push.subscribe(body.subscription)
    except PushError as error:
        raise Invalid(str(error)) from error
    return push_status(request)


@router.delete("/push")
def push_forget(request: Request, body: PushForgetIn) -> dict:
    request.app.state.push.unsubscribe(body.endpoint)
    return push_status(request)


@router.get("/agents")
def list_agents(s: DB) -> list[AgentOut]:
    working = svc.list_issues(s, status="in_progress")
    return [_agent_out(agent, working) for agent in agent_svc.list_agents(s)]


@router.post("/agents", status_code=201)
def add_agent(body: AgentIn, s: DB) -> NewAgentOut:
    agent, token = agent_svc.add_agent(s, body.name, body.provider)
    return NewAgentOut(**_agent_out(agent, []).model_dump(), token=token)


@router.get("/agents/{name}/record")
def agent_record(name: str, s: DB) -> RecordOut:
    """What an agent has done in the tracker: any name, with or without a token here."""
    r = record_svc.record(s, name)
    return RecordOut(
        name=r.name,
        shipped=r.shipped,
        sent_to_review=r.sent_to_review,
        sent_back=r.sent_back,
        reviewed=r.reviewed,
        projects=[ProjectShareOut(key=key, issues=n) for key, n in r.projects],
        last_shipped=_brief_out(r.last_shipped) if r.last_shipped else None,
        last_shipped_at=r.last_shipped_at,
        since=r.since,
    )


@router.delete("/agents/{name}")
def revoke_agent(name: str, s: DB) -> AgentOut:
    return _agent_out(agent_svc.revoke_agent(s, name), [])
