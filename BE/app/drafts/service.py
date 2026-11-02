from typing import Protocol
from app.auth.models import TeacherContext
from app.core.errors import ApiError
from app.writing.models import DraftJob


class DraftService(Protocol):
    async def request(self, *, teacher: TeacherContext, recording_ids: tuple[str, ...]) -> DraftJob:
        """Read only owned, completed, undeleted recordings and full active roster.
        Freeze selected transcripts/roster, enqueue work; no caller-selected children.
        """
        ...
    async def get(self, *, teacher: TeacherContext, draft_id: str) -> DraftJob:
        ...


class UnimplementedDraftService:
    async def request(self, *, teacher: TeacherContext, recording_ids: tuple[str, ...]) -> DraftJob:
        raise ApiError(status_code=501, code="NOT_IMPLEMENTED", message="초안 생성 서비스가 아직 연결되지 않았습니다.", details={"feature":"BE-05","operation":"request"})
    async def get(self, *, teacher: TeacherContext, draft_id: str) -> DraftJob:
        raise ApiError(status_code=501, code="NOT_IMPLEMENTED", message="초안 생성 서비스가 아직 연결되지 않았습니다.", details={"feature":"BE-05","operation":"get"})
