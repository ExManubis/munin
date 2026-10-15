import contextlib
import json
from pathlib import Path

import anyio.to_thread
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session, sessionmaker
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.routing import Route
from starlette.types import ASGIApp, Receive, Scope, Send

from munin import agents
from munin.api import router
from munin.config import Settings
from munin.db import connect
from munin.issues import Conflict, Invalid, MuninError, NotFound
from munin.mcp_server import build_mcp

WEB_DIR = Path(__file__).parent / "web"
LOOPBACK = ("127.0.0.1", "localhost")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    sessions = connect(settings.db_path)
    mcp = build_mcp(sessions)
    mcp_app = mcp.streamable_http_app(stateless_http=True, json_response=True, host=settings.host)
    mcp_endpoint = next(route.endpoint for route in mcp_app.routes if getattr(route, "path", None) == "/mcp")

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI):
        async with mcp.session_manager.run():
            yield

    app = FastAPI(title="munin", lifespan=lifespan)
    app.state.settings = settings
    app.state.sessions = sessions
    if settings.host in LOOPBACK:
        # The API has no login, so refuse other Host names: that stops web pages using DNS rebinding to reach it.
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(LOOPBACK))

    @app.exception_handler(MuninError)
    async def munin_error(_request: Request, error: MuninError) -> JSONResponse:
        code = {NotFound: 404, Conflict: 409, Invalid: 422}.get(type(error), 400)
        return JSONResponse({"detail": str(error)}, status_code=code)

    app.include_router(router)
    app.router.routes.append(Route("/mcp", endpoint=AgentAuth(mcp_endpoint, sessions)))
    if WEB_DIR.is_dir():
        app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
    return app


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
