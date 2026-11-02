from app.records.schemas import RecordListQuery
from typing import NoReturn, Protocol
from app.auth.models import TeacherContext
from app.core.errors import ApiError
from app.writing.models import JournalRecord, RecordHistory, RecordPage


class RecordService(Protocol):
    async def list(self, *, teacher: TeacherContext, query: RecordListQuery) -> RecordPage: ...
    async def get(self, *, teacher: TeacherContext, record_id: str) -> JournalRecord: ...
    async def save(self, *, teacher: TeacherContext, record_id: str, edited_text: str, expected_version: int) -> JournalRecord:
        """Persist exact input + history atomically, enter review; no AI call."""
        ...
    async def confirm(self, *, teacher: TeacherContext, record_id: str, edited_text: str, expected_version: int) -> JournalRecord:
        """Persist exact input + history atomically, enter completed; no AI call."""
        ...
    async def history(self, *, teacher: TeacherContext, record_id: str) -> tuple[RecordHistory, ...]: ...


class UnimplementedRecordService:
    async def list(self, *, teacher: TeacherContext, query: RecordListQuery) -> RecordPage: self._missing()
    @staticmethod
    def _missing() -> NoReturn:
        raise ApiError(status_code=501, code="NOT_IMPLEMENTED", message="일지 저장 서비스가 아직 연결되지 않았습니다.", details={"feature":"BE-06"})
    async def get(self, *, teacher: TeacherContext, record_id: str) -> JournalRecord: self._missing()
    async def save(self, *, teacher: TeacherContext, record_id: str, edited_text: str, expected_version: int) -> JournalRecord: self._missing()
    async def confirm(self, *, teacher: TeacherContext, record_id: str, edited_text: str, expected_version: int) -> JournalRecord: self._missing()
    async def history(self, *, teacher: TeacherContext, record_id: str) -> tuple[RecordHistory, ...]: self._missing()
