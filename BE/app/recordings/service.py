from typing import NoReturn, Protocol
from app.schemas.common import ListQuery

from app.auth.models import TeacherContext
from app.core.errors import ApiError
from app.recordings.models import Recording, RecordingAudio, RecordingPage, RecordingUpload


class RecordingService(Protocol):
    async def upload(self, *, teacher: TeacherContext, upload: RecordingUpload) -> Recording:
        ...

    async def list(self, *, teacher: TeacherContext, query: ListQuery) -> RecordingPage:
        ...

    async def get(self, *, teacher: TeacherContext, recording_id: str) -> Recording:
        ...

    async def open_audio(
        self, *, teacher: TeacherContext, recording_id: str
    ) -> RecordingAudio:
        ...

    async def delete(self, *, teacher: TeacherContext, recording_id: str) -> None:
        """Remove original/playback access; preserve prior diary evidence."""
        ...


class UnimplementedRecordingService:
    async def upload(self, *, teacher: TeacherContext, upload: RecordingUpload) -> Recording:
        self._unimplemented("upload")

    async def list(self, *, teacher: TeacherContext, query: ListQuery) -> RecordingPage:
        self._unimplemented("list")

    async def get(self, *, teacher: TeacherContext, recording_id: str) -> Recording:
        self._unimplemented("get")

    async def open_audio(
        self, *, teacher: TeacherContext, recording_id: str
    ) -> RecordingAudio:
        self._unimplemented("open_audio")

    async def delete(self, *, teacher: TeacherContext, recording_id: str) -> None:
        self._unimplemented("delete")

    @staticmethod
    def _unimplemented(operation: str) -> NoReturn:
        raise ApiError(
            status_code=501, code="NOT_IMPLEMENTED",
            message="녹음 저장 서비스가 아직 연결되지 않았습니다.",
            details={"feature": "BE-03", "operation": operation},
        )
