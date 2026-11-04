from typing import Protocol
from asyncio import to_thread
from uuid import uuid4
from app.core.database import Database

from app.children.models import Child


class ChildrenRepository(Protocol):
    """All reads and writes are scoped by the authenticated teacher ID."""

    async def list(
        self, *, teacher_id: str, include_inactive: bool
    ) -> list[Child]:
        ...

    async def create(self, *, teacher_id: str, name: str) -> Child:
        """Allocate a new stable ID; identical names need not identify one child."""
        ...

    async def get(self, *, teacher_id: str, child_id: str) -> Child | None:
        ...

    async def rename(
        self, *, teacher_id: str, child_id: str, name: str
    ) -> Child | None:
        ...

    async def deactivate(self, *, teacher_id: str, child_id: str) -> Child | None:
        """Idempotently mark inactive without deleting child/history references."""
        ...


class SQLiteChildrenRepository:
    def __init__(self, database: Database):
        self.database = database

    @staticmethod
    def _child(row) -> Child | None:
        return Child(row["child_id"], row["teacher_id"], row["name"], bool(row["is_active"])) if row else None

    async def list(self, *, teacher_id: str, include_inactive: bool) -> list[Child]:
        def read():
            with self.database.connect() as connection:
                rows = connection.execute("SELECT * FROM children WHERE teacher_id=? AND (? OR is_active=1) ORDER BY rowid",
                                          (teacher_id, include_inactive)).fetchall()
            return [self._child(row) for row in rows]
        return await to_thread(read)

    async def create(self, *, teacher_id: str, name: str) -> Child:
        child = Child(str(uuid4()), teacher_id, name, True)
        def write():
            with self.database.connect() as connection:
                connection.execute("INSERT INTO children VALUES (?,?,?,1)", (child.child_id, teacher_id, name))
            return child
        return await to_thread(write)

    async def get(self, *, teacher_id: str, child_id: str) -> Child | None:
        def read():
            with self.database.connect() as connection:
                return self._child(connection.execute("SELECT * FROM children WHERE teacher_id=? AND child_id=?",
                                                       (teacher_id, child_id)).fetchone())
        return await to_thread(read)

    async def _update(self, teacher_id: str, child_id: str, name: str | None) -> Child | None:
        def write():
            with self.database.connect() as connection:
                if name is None:
                    connection.execute("UPDATE children SET is_active=0 WHERE teacher_id=? AND child_id=?", (teacher_id, child_id))
                else:
                    connection.execute("UPDATE children SET name=? WHERE teacher_id=? AND child_id=?", (name, teacher_id, child_id))
                return self._child(connection.execute("SELECT * FROM children WHERE teacher_id=? AND child_id=?",
                                                       (teacher_id, child_id)).fetchone())
        return await to_thread(write)

    async def rename(self, *, teacher_id: str, child_id: str, name: str) -> Child | None:
        return await self._update(teacher_id, child_id, name)

    async def deactivate(self, *, teacher_id: str, child_id: str) -> Child | None:
        return await self._update(teacher_id, child_id, None)
