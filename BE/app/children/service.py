from typing import NoReturn, Protocol

from app.auth.models import TeacherContext
from app.children.models import Child
from app.core.errors import ApiError


class ChildrenService(Protocol):
    """Future implementation must use teacher-scoped repository operations."""

    async def list(
        self, *, teacher: TeacherContext, include_inactive: bool
    ) -> list[Child]:
        ...

    async def create(self, *, teacher: TeacherContext, name: str) -> Child:
        ...

    async def rename(
        self, *, teacher: TeacherContext, child_id: str, name: str
    ) -> Child:
        """Preserve child_id; missing or other-owner children produce 404."""
        ...

    async def deactivate(self, *, teacher: TeacherContext, child_id: str) -> Child:
        """Preserve child/history; repeat requests stay inactive with the same ID."""
        ...


class UnimplementedChildrenService:
    async def list(
        self, *, teacher: TeacherContext, include_inactive: bool
    ) -> list[Child]:
        self._not_implemented("list")

    async def create(self, *, teacher: TeacherContext, name: str) -> Child:
        self._not_implemented("create")

    async def rename(
        self, *, teacher: TeacherContext, child_id: str, name: str
    ) -> Child:
        self._not_implemented("rename")

    async def deactivate(self, *, teacher: TeacherContext, child_id: str) -> Child:
        self._not_implemented("deactivate")

    @staticmethod
    def _not_implemented(operation: str) -> NoReturn:
        raise ApiError(
            status_code=501,
            code="NOT_IMPLEMENTED",
            message="아동 명단 서비스가 아직 연결되지 않았습니다.",
            details={"feature": "BE-02", "operation": operation},
        )
