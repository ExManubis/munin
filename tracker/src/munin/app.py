import contextlib
import json

import anyio.to_thread
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from mcp.server.transport_security import TransportSecuritySettings
from sqlalchemy.orm import Session, sessionmaker
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.routing import Route
from starlette.types import ASGIApp, Receive, Scope, Send

from munin import agents
from munin.github import GitHub
from munin.github import watching as github_watching
from munin.push import Push
from munin.push import watching as push_watching
from munin.api import router
from munin.config import Settings
from munin.db import Changes, connect
from munin.issues import Conflict, Invalid, MuninError, NotFound
from munin.mcp_server import build_mcp

LOOPBACK = ("127.0.0.1", "localhost")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    settings.check()
    sessions = connect(settings.db_path)
    # GitHub (github.py): what linked pull requests are called and whether they've merged.
    github = GitHub(settings.db_path.parent / "github.json")
    mcp = build_mcp(sessions, github)
    mcp_app = mcp.streamable_http_app(
        stateless_http=True, json_response=True, host=settings.host, transport_security=_mcp_security(settings)
    )
    mcp_endpoint = next(route.endpoint for route in mcp_app.routes if getattr(route, "path", None) == "/mcp")

    changes = Changes(sessions)
    # Push notifications (push.py), with keys of the tracker's own next to its database.
    pusher = Push(settings.db_path.parent / "push.json", subject=f"{settings.public_url or 'mailto:munin@localhost'}")

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI):
        async with mcp.session_manager.run(), push_watching(pusher, sessions, changes), github_watching(github, sessions):
            yield

    app = FastAPI(title="munin", lifespan=lifespan)
    app.state.settings = settings
    app.state.sessions = sessions
    app.state.changes = changes
    app.state.push = pusher
    app.state.github = github
    if settings.host in LOOPBACK:
        # The API has no login, so refuse other Host names: that stops web pages using DNS rebinding to reach it.
        # Behind the edge, its name is the one other name that reaches munin.
        public = [settings.public_host] if settings.public_host else []
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=[*LOOPBACK, *public])
    if settings.public_host:
        app.add_middleware(OnlyListedPeople, public_host=settings.public_host, users=settings.users)

    @app.exception_handler(MuninError)
    async def munin_error(_request: Request, error: MuninError) -> JSONResponse:
        code = {NotFound: 404, Conflict: 409, Invalid: 422}.get(type(error), 400)
        return JSONResponse({"detail": str(error)}, status_code=code)

    app.include_router(router)
    app.router.routes.append(Route("/mcp", endpoint=AgentAuth(mcp_endpoint, sessions)))
    if settings.web_dir and (settings.web_dir / "index.html").is_file():
        app.mount("/", Revalidated(directory=settings.web_dir, html=True), name="web")
    return app


class Revalidated(StaticFiles):
    """The frontend, which browsers check with the server each time they load it (a 304 when it
    hasn't changed), so a page never keeps running an old module after munin is updated."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


def _mcp_security(settings: Settings) -> TransportSecuritySettings | None:
    """MCP's own Host check, with munin's public name added; None keeps the SDK's default for loopback."""
    if not settings.public_url:
        return None
    public = settings.public_host
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=["127.0.0.1:*", "localhost:*", "[::1]:*", "127.0.0.1", "localhost", public, f"{public}:*"],
        allowed_origins=["http://127.0.0.1:*", "http://localhost:*", "http://[::1]:*", settings.public_url],
    )


class OnlyListedPeople:
    """Behind the edge, lets in only the people in MUNIN_USERS. tailscale serve says who's calling in
    Tailscale-User-Login, after removing any the caller sent, so the header can be trusted on requests that
    came through it, which are the ones addressed to munin's public name. /mcp is for agents, who have
    tokens of their own wherever they run; requests from this machine itself are let through as before."""

    def __init__(self, app: ASGIApp, public_host: str, users: tuple[str, ...]):
        self.app = app
        self.public_host = public_host
        self.users = {user.lower() for user in users}

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and not (scope["path"] == "/mcp" or scope["path"].startswith("/mcp/")):
            headers = dict(scope.get("headers", []))
            host = headers.get(b"host", b"").decode().rsplit(":", 1)[0].strip("[]").lower()
            login = headers.get(b"tailscale-user-login", b"").decode().strip().lower()
            if host == self.public_host and login not in self.users:
                who = f"{login} isn't" if login else "Tailscale didn't say who you are, so you aren't"
                detail = f"{who} one of munin's people. Its owner adds people to MUNIN_USERS."
                await _send_json(send, 403, {"detail": detail})
                return
        await self.app(scope, receive, send)


class AgentAuth:
    """Lets a request through to MCP only with a valid agent token, and records which agent it is."""

    def __init__(self, app: ASGIApp, sessions: sessionmaker[Session]):
        self.app = app
        self.sessions = sessions

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        header = dict(scope.get("headers", [])).get(b"authorization", b"").decode()
        scheme, _, token = header.partition(" ")
        agent = None
        if scheme.lower() == "bearer" and token.strip():
            agent = await anyio.to_thread.run_sync(self._authenticate, token.strip())
        if agent is None:
            message = "Missing or unknown agent token. Create one with: munin agent add NAME"
            await _send_json(send, 401, {"error": message})
            return
        scope.setdefault("state", {})["agent"] = agent
        await self.app(scope, receive, send)

    def _authenticate(self, token: str) -> str | None:
        with self.sessions() as s:
            agent = agents.authenticate(s, token)
            return agent.name if agent else None


async def _send_json(send: Send, status: int, body: dict) -> None:
    payload = json.dumps(body).encode()
    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(payload)).encode())]
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": payload})
