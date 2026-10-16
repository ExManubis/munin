import os
from dataclasses import dataclass
from pathlib import Path

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

    @classmethod
    def from_env(cls) -> "Settings":
        web = os.environ.get("MUNIN_WEB")
        return cls(
            db_path=Path(os.environ.get("MUNIN_DB", Path.home() / ".munin" / "munin.db")),
            host=os.environ.get("MUNIN_HOST", "127.0.0.1"),
            port=int(os.environ.get("MUNIN_PORT", "7777")),
            user=os.environ.get("MUNIN_USER", "me"),
            web_dir=CHECKOUT_WEB if web is None else Path(web) if web else None,
        )

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}"
