from typing import Literal, Protocol

from app.core.jobs import JobStatus
from app.transcriptions.models import TranscriptionFailure, TranscriptionJob


class TranscriptionRepository(Protocol):
    async def reserve(
        self, *, teacher_id: str, recording_id: str
    ) -> TranscriptionJob:
        """Atomically check ownership/deletion/retry eligibility, reserve a NEW
        queued job and transition recording to 전사중. Reject duplicate work with
        409; preserve previous attempts. Failed nonretryable work is rejected.
        """
        ...

    async def claim(self, *, teacher_id: str, job_id: str) -> TranscriptionJob:
        """Atomically transition only the current queued attempt to running.
        Recheck recording owner/deletion; exactly one worker may claim a job.
        """
        ...

    async def get(self, *, teacher_id: str, job_id: str) -> TranscriptionJob | None:
        """Hide jobs whose recording is deleted or owned by another teacher."""
        ...

    async def latest(
        self, *, teacher_id: str, recording_id: str
    ) -> TranscriptionJob | None:
        ...

    async def finish(
        self, *, teacher_id: str, job_id: str, status: Literal[JobStatus.COMPLETED, JobStatus.FAILED],
        text: str | None, failure: TranscriptionFailure | None
    ) -> None:
        """Finish only a running, current attempt; recheck deletion and update
        job + recording atomically. Never revive deleted audio or old attempts.
        """
        ...
