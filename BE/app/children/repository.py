from typing import Protocol

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
