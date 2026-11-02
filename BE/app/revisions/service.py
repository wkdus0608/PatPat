from typing import NoReturn, Protocol
from app.auth.models import TeacherContext
from app.core.errors import ApiError
from app.writing.models import JournalRecord, RevisionJob


class RevisionService(Protocol):
    async def request(self, *, teacher: TeacherContext, record_id: str, instruction: str, expected_version: int) -> RevisionJob:
        """Snapshot server body/version/child/evidence; enqueue new candidate only."""
        ...
    async def get(self, *, teacher: TeacherContext, record_id: str, revision_id: str) -> RevisionJob: ...
    async def adopt(self, *, teacher: TeacherContext, record_id: str, revision_id: str, expected_version: int) -> JournalRecord:
        """CAS base/current version + apply ready candidate and history; no AI."""
        ...


class UnimplementedRevisionService:
    @staticmethod
    def _missing() -> NoReturn:
        raise ApiError(status_code=501, code="NOT_IMPLEMENTED", message="AI 수정 서비스가 아직 연결되지 않았습니다.", details={"feature":"BE-07"})
    async def request(self, *, teacher: TeacherContext, record_id: str, instruction: str, expected_version: int) -> RevisionJob: self._missing()
    async def get(self, *, teacher: TeacherContext, record_id: str, revision_id: str) -> RevisionJob: self._missing()
    async def adopt(self, *, teacher: TeacherContext, record_id: str, revision_id: str, expected_version: int) -> JournalRecord: self._missing()
