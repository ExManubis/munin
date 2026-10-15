import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    db_path: Path
    host: str = "127.0.0.1"
    port: int = 7777
    # The name comments and issues get when you act through the web UI.
    user: str = "me"

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            db_path=Path(os.environ.get("MUNIN_DB", Path.home() / ".munin" / "munin.db")),
            host=os.environ.get("MUNIN_HOST", "127.0.0.1"),
            port=int(os.environ.get("MUNIN_PORT", "7777")),
            user=os.environ.get("MUNIN_USER", "me"),
        )

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}"
