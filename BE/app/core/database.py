from contextlib import contextmanager
from pathlib import Path
import sqlite3
from threading import Lock


class Database:
    """Connection-per-operation SQLite storage, shared by auth and roster."""

    def __init__(self, path: str):
        self.path = str(Path(path).expanduser().resolve())
        self._ready = False
        self._lock = Lock()

    def initialize(self) -> None:
        with self._lock:
            if self._ready:
                return
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
            connection = sqlite3.connect(self.path, timeout=5)
            try:
                connection.execute("PRAGMA journal_mode=WAL")
                connection.execute("BEGIN IMMEDIATE")
                version = connection.execute("PRAGMA user_version").fetchone()[0]
                if version not in (0, 1):
                    raise RuntimeError("지원하지 않는 DB 스키마 버전입니다.")
                if version == 0:
                    schema = """
                        CREATE TABLE teachers (
                            teacher_id TEXT PRIMARY KEY,
                            login_id TEXT NOT NULL UNIQUE,
                            display_name TEXT NOT NULL,
                            password_hash TEXT NOT NULL,
                            is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1))
                        );
                        CREATE TABLE sessions (
                            token_hash TEXT PRIMARY KEY,
                            teacher_id TEXT NOT NULL REFERENCES teachers(teacher_id),
                            expires_at INTEGER NOT NULL
                        );
                        CREATE INDEX sessions_teacher ON sessions(teacher_id);
                        CREATE TABLE children (
                            child_id TEXT PRIMARY KEY,
                            teacher_id TEXT NOT NULL REFERENCES teachers(teacher_id),
                            name TEXT NOT NULL,
                            is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1))
                        );
                        CREATE INDEX children_teacher ON children(teacher_id);
                        PRAGMA user_version=1;
                    """
                    for statement in schema.split(";"):
                        if statement.strip():
                            connection.execute(statement)
                connection.commit()
                self._ready = True
            finally:
                connection.close()

    @contextmanager
    def connect(self):
        self.initialize()
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            with connection:
                yield connection
        finally:
            connection.close()
