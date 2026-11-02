from typing import NoReturn, Protocol

from app.auth.dependencies import require_teacher_ownership
from app.auth.models import TeacherContext
from app.core.errors import ApiError
from app.recordings.models import RecordingReference, RecordingStatus
from app.transcriptions.models import TranscriptionJob


def ensure_transcription_allowed(
    *, recording: RecordingReference, teacher: TeacherContext
) -> None:
    require_teacher_ownership(owner_teacher_id=recording.teacher_id, teacher=teacher)
    if recording.is_deleted:
        raise ApiError(status_code=404, code="NOT_FOUND", message="녹음을 찾을 수 없습니다.")
    if recording.status not in (RecordingStatus.QUEUED, RecordingStatus.FAILED):
        raise ApiError(
            status_code=409, code="TRANSCRIPTION_CONFLICT",
            message="현재 녹음 상태에서는 전사를 요청할 수 없습니다.",
        )


class TranscriptionService(Protocol):
    async def request(
        self, *, teacher: TeacherContext, recording_id: str
    ) -> TranscriptionJob:
        """Use atomic repository reservation before any STT side effects.
        Retry failed retryable work with a new job ID, preserving earlier jobs.
        """
        ...

    async def get(self, *, teacher: TeacherContext, job_id: str) -> TranscriptionJob:
        ...

    async def latest(
        self, *, teacher: TeacherContext, recording_id: str
    ) -> TranscriptionJob:
        ...


class UnimplementedTranscriptionService:
    async def request(self, *, teacher: TeacherContext, recording_id: str) -> TranscriptionJob:
        self._unimplemented("request")

    async def get(self, *, teacher: TeacherContext, job_id: str) -> TranscriptionJob:
        self._unimplemented("get")

    async def latest(self, *, teacher: TeacherContext, recording_id: str) -> TranscriptionJob:
        self._unimplemented("latest")

    @staticmethod
    def _unimplemented(operation: str) -> NoReturn:
        raise ApiError(
            status_code=501, code="NOT_IMPLEMENTED",
            message="외부 전사 서비스가 아직 연결되지 않았습니다.",
            details={"feature": "BE-04", "operation": operation},
        )
