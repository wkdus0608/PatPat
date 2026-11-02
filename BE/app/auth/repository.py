from typing import Protocol

from app.auth.models import TeacherAccount


class AuthRepository(Protocol):
    """Read pre-provisioned accounts; BE-01 does not connect a database."""

    async def get_by_login_id(self, login_id: str) -> TeacherAccount | None:
        ...

    async def get_by_teacher_id(self, teacher_id: str) -> TeacherAccount | None:
        ...
