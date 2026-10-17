import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

# The frontend lives at the top of the repository, next to the tracker. The tracker serves it, so
# one command runs munin locally; a deployment can serve it from elsewhere instead.
CHECKOUT_WEB = Path(__file__).resolve().parents[3] / "web"


@dataclass(frozen=True)
class Settings:
    db_path: Path
    host: str = "127.0.0.1"
    port: int = 7777
    # The name comments and issues get when you act through the web UI.
    user: str = "me"
    # The frontend to serve at /, or None for the API and MCP only.
    web_dir: Path | None = CHECKOUT_WEB
    # Behind the edge (tailscale serve): the address people use, like https://munin.tail1234.ts.net,
    # and the Tailscale logins allowed in through it. Agents' MCP calls need a token instead.
    public_url: str | None = None
    users: tuple[str, ...] = ()
    # munin demo: the frontend shows the Agents part with the runtime's stand-in.
    demo: bool = False

    @classmethod
    def from_env(cls) -> "Settings":
        web = os.environ.get("MUNIN_WEB")
        return cls(
            db_path=Path(os.environ.get("MUNIN_DB", Path.home() / ".munin" / "munin.db")),
            host=os.environ.get("MUNIN_HOST", "127.0.0.1"),
            port=int(os.environ.get("MUNIN_PORT", "7777")),
            user=os.environ.get("MUNIN_USER", "me"),
            web_dir=CHECKOUT_WEB if web is None else Path(web) if web else None,
            public_url=os.environ.get("MUNIN_PUBLIC_URL", "").strip().rstrip("/") or None,
            users=tuple(u.strip().lower() for u in os.environ.get("MUNIN_USERS", "").split(",") if u.strip()),
        )

    @property
    def public_host(self) -> str | None:
        return urlsplit(self.public_url).hostname if self.public_url else None

    def check(self) -> None:
        """Refuse settings that would let in more than they should."""
        if self.public_url and not urlsplit(self.public_url).hostname:
            raise ValueError(f"MUNIN_PUBLIC_URL isn't a URL: {self.public_url}")
        if self.public_url and not self.users:
            raise ValueError(
                "MUNIN_PUBLIC_URL is set, so say who may use munin through it: "
                "MUNIN_USERS=you@example.com, the Tailscale logins, comma-separated."
            )

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}"
