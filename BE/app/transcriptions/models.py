from dataclasses import dataclass, field
from enum import StrEnum

from app.core.jobs import JobStatus


class FailureStage(StrEnum):
    STT = "stt"
    PERSIST = "persist"


@dataclass(frozen=True)
class TranscriptionFailure:
    stage: FailureStage
    code: str
    retryable: bool


@dataclass(frozen=True)
class TranscriptionJob:
    job_id: str
    recording_id: str
    teacher_id: str
    status: JobStatus
    text: str | None = field(default=None, repr=False)
    observation_ids: tuple[str, ...] = ()
    failure: TranscriptionFailure | None = None


@dataclass(frozen=True)
class SpeechToTextResult:
    text: str = field(repr=False)
