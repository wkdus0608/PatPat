from typing import Protocol
from asyncio import to_thread

from app.auth.models import TeacherAccount, TeacherContext
from app.core.database import Database


class AuthRepository(Protocol):
    """Pre-provisioned accounts and hashed access-token sessions."""

    async def get_by_login_id(self, login_id: str) -> TeacherAccount | None:
        ...

    async def get_by_teacher_id(self, teacher_id: str) -> TeacherAccount | None:
        ...

    async def save_session(self, token_hash: str, teacher_id: str, expires_at: int) -> None: ...
    async def session_teacher(self, token_hash: str, now: int) -> TeacherContext | None: ...
    async def revoke_session(self, token_hash: str) -> None: ...


class SQLiteAuthRepository:
    def __init__(self, database: Database):
        self.database = database

    def _account(self, column: str, value: str) -> TeacherAccount | None:
        # column is selected only by the two methods below, never by callers.
        with self.database.connect() as connection:
            row = connection.execute(f"SELECT * FROM teachers WHERE {column}=?", (value,)).fetchone()
        if row is None:
            return None
        return TeacherAccount(TeacherContext(row["teacher_id"], row["display_name"]),
                              row["login_id"], row["password_hash"], bool(row["is_active"]))

    async def get_by_login_id(self, login_id: str) -> TeacherAccount | None:
        return await to_thread(self._account, "login_id", login_id)

    async def get_by_teacher_id(self, teacher_id: str) -> TeacherAccount | None:
        return await to_thread(self._account, "teacher_id", teacher_id)

    async def save_session(self, token_hash: str, teacher_id: str, expires_at: int) -> None:
        def write():
            with self.database.connect() as connection:
                connection.execute("INSERT INTO sessions VALUES (?,?,?)", (token_hash, teacher_id, expires_at))
        await to_thread(write)

    async def session_teacher(self, token_hash: str, now: int) -> TeacherContext | None:
        def read():
            with self.database.connect() as connection:
                row = connection.execute("""SELECT t.teacher_id,t.display_name FROM sessions s
                    JOIN teachers t ON t.teacher_id=s.teacher_id
                    WHERE s.token_hash=? AND s.expires_at>? AND t.is_active=1""", (token_hash, now)).fetchone()
            return TeacherContext(row[0], row[1]) if row else None
        return await to_thread(read)

    async def revoke_session(self, token_hash: str) -> None:
        def write():
            with self.database.connect() as connection:
                connection.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash,))
        await to_thread(write)
