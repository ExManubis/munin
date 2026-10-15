import threading
from pathlib import Path

from sqlalchemy import Engine, create_engine, event, inspect, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.schema import CreateColumn

from munin.models import Base


def connect(db_path: Path) -> sessionmaker[Session]:
    """Open (and create or upgrade if needed) the SQLite database and return a session factory."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    event.listen(engine, "connect", _sqlite_pragmas)
    Base.metadata.create_all(engine)
    _add_missing_columns(engine)
    return sessionmaker(engine, expire_on_commit=False)


def _sqlite_pragmas(dbapi_connection, _record) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()


def _add_missing_columns(engine: Engine) -> None:
    """Bring a database from an older munin up to date.

    create_all adds new tables but not new columns, so add those here. New columns are
    always nullable or have a server default, which is what makes this safe.
    """
    inspector = inspect(engine)
    with engine.begin() as connection:
        for table in Base.metadata.sorted_tables:
            existing = {column["name"] for column in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name not in existing:
                    ddl = CreateColumn(column).compile(dialect=engine.dialect)
                    try:
                        connection.execute(text(f"ALTER TABLE {table.name} ADD COLUMN {ddl}"))
                    except OperationalError as error:
                        if "duplicate column" not in str(error):  # another munin got there first
                            raise


class Changes:
    """Counts commits, so the web UI can hear about changes as they happen instead of polling."""

    def __init__(self, sessions: sessionmaker[Session]):
        self._revision = 0
        self._lock = threading.Lock()
        event.listen(sessions, "after_commit", lambda _session: self._bump())

    def _bump(self) -> None:
        with self._lock:
            self._revision += 1

    @property
    def revision(self) -> int:
        return self._revision
