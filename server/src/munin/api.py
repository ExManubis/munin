"""JSON API for the web UI. It acts as the human; there's no login, so munin only listens locally."""

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from pydantic import AfterValidator, BaseModel
from sqlalchemy.orm import Session

from munin import agents as agent_svc
from munin import issues as svc
from munin.issues import Actor
from munin.models import Agent, Comment, Issue, Project

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


class CommentOut(BaseModel):
    id: int
    author: str
    author_kind: str
    body: str
    asks_human: bool
    created_at: UTCDateTime


class IssueOut(BaseModel):
    id: str
    project: str
    title: str
    description: str
    status: str
    assignee: str | None
    position: float
    created_by: str
    created_at: UTCDateTime
    updated_at: UTCDateTime
    waiting_on_human: bool


class IssueDetailOut(IssueOut):
    comments: list[CommentOut]


class InboxItemOut(BaseModel):
    issue: IssueOut
    question: CommentOut


class AgentOut(BaseModel):
    name: str
    token_hint: str
    created_at: UTCDateTime
    last_seen_at: UTCDateTime | None
    revoked: bool


class NewAgentOut(AgentOut):
    token: str


def _project_out(project: Project, counts: dict[str, int]) -> ProjectOut:
    return ProjectOut(key=project.key, name=project.name, description=project.description, counts=counts)


def _comment_out(comment: Comment) -> CommentOut:
    return CommentOut.model_validate(comment, from_attributes=True)


def _issue_out(issue: Issue) -> IssueOut:
    return IssueOut(
        id=issue.ref,
        project=issue.project.key,
        title=issue.title,
        description=issue.description,
        status=issue.status,
        assignee=issue.assignee,
        position=issue.position,
        created_by=issue.created_by,
        created_at=issue.created_at,
        updated_at=issue.updated_at,
        waiting_on_human=svc.waiting_on_human(issue),
    )


def _issue_detail_out(issue: Issue) -> IssueDetailOut:
    return IssueDetailOut(**_issue_out(issue).model_dump(), comments=[_comment_out(c) for c in issue.comments])


def _agent_out(agent: Agent) -> AgentOut:
    return AgentOut(
        name=agent.name,
        token_hint=agent.token_hint,
        created_at=agent.created_at,
        last_seen_at=agent.last_seen_at,
        revoked=agent.revoked_at is not None,
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


class IssuePatch(BaseModel):
    title: str | None = None
    description: str | None = None
    status: str | None = None
    assignee: str | None = None
    position: float | None = None


class CommentIn(BaseModel):
    body: str


class AgentIn(BaseModel):
    name: str


# Routes


@router.get("/me")
def me(request: Request) -> dict:
    # The address this page was opened on also reaches /mcp, even when munin listens on 0.0.0.0.
    return {"name": request.app.state.settings.user, "mcp_url": f"{str(request.base_url).rstrip('/')}/mcp"}


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
) -> list[IssueOut]:
    return [_issue_out(issue) for issue in svc.list_issues(s, project, status, assignee)]


@router.post("/issues", status_code=201)
def create_issue(body: IssueIn, s: DB, actor: Human) -> IssueDetailOut:
    issue = svc.create_issue(s, actor, body.project, body.title, body.description, body.status, body.assignee)
    return _issue_detail_out(issue)


@router.get("/issues/{ref}")
def get_issue(ref: str, s: DB) -> IssueDetailOut:
    return _issue_detail_out(svc.get_issue(s, ref))


@router.patch("/issues/{ref}")
def update_issue(ref: str, body: IssuePatch, s: DB, actor: Human) -> IssueDetailOut:
    changes = body.model_dump(exclude_unset=True)
    return _issue_detail_out(svc.update_issue(s, actor, ref, **changes))


@router.post("/issues/{ref}/comments", status_code=201)
def add_comment(ref: str, body: CommentIn, s: DB, actor: Human) -> IssueDetailOut:
    comment = svc.add_comment(s, actor, ref, body.body)
    return _issue_detail_out(comment.issue)


@router.get("/inbox")
def inbox(s: DB) -> list[InboxItemOut]:
    return [InboxItemOut(issue=_issue_out(c.issue), question=_comment_out(c)) for c in svc.inbox(s)]


@router.get("/agents")
def list_agents(s: DB) -> list[AgentOut]:
    return [_agent_out(agent) for agent in agent_svc.list_agents(s)]


@router.post("/agents", status_code=201)
def add_agent(body: AgentIn, s: DB) -> NewAgentOut:
    agent, token = agent_svc.add_agent(s, body.name)
    return NewAgentOut(**_agent_out(agent).model_dump(), token=token)


@router.delete("/agents/{name}")
def revoke_agent(name: str, s: DB) -> AgentOut:
    return _agent_out(agent_svc.revoke_agent(s, name))
