from typing import NoReturn, Protocol

from app.auth.models import TeacherContext
from app.children.models import Child
from app.core.errors import ApiError
from app.children.repository import ChildrenRepository


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


class SQLiteChildrenService:
    def __init__(self, repository: ChildrenRepository):
        self.repository = repository

    async def list(self, *, teacher: TeacherContext, include_inactive: bool) -> list[Child]:
        return await self.repository.list(teacher_id=teacher.teacher_id, include_inactive=include_inactive)

    async def create(self, *, teacher: TeacherContext, name: str) -> Child:
        return await self.repository.create(teacher_id=teacher.teacher_id, name=name)

    @staticmethod
    def _found(child: Child | None) -> Child:
        if child is None:
            raise ApiError(status_code=404, code="NOT_FOUND", message="아동을 찾을 수 없습니다.")
        return child

    async def rename(self, *, teacher: TeacherContext, child_id: str, name: str) -> Child:
        return self._found(await self.repository.rename(teacher_id=teacher.teacher_id, child_id=child_id, name=name))

    async def deactivate(self, *, teacher: TeacherContext, child_id: str) -> Child:
        return self._found(await self.repository.deactivate(teacher_id=teacher.teacher_id, child_id=child_id))


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
