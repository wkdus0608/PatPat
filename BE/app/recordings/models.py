from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import BinaryIO


class RecordingStatus(StrEnum):
    QUEUED = "대기"
    TRANSCRIBING = "전사중"
    COMPLETED = "완료"
    FAILED = "실패"


@dataclass(frozen=True)
class RecordingReference:
    recording_id: str
    teacher_id: str
    status: RecordingStatus
    is_deleted: bool = False


@dataclass(frozen=True)
class Recording:
    recording_id: str
    teacher_id: str
    title: str
    recorded_at: datetime
    duration_seconds: float
    size_bytes: int
    content_type: str
    status: RecordingStatus
    created_at: datetime


@dataclass(frozen=True)
class RecordingUpload:
    title: str
    recorded_at: datetime
    duration_seconds: float
    content_type: str
    stream: BinaryIO = field(repr=False)


@dataclass(frozen=True)
class RecordingAudio:
    teacher_id: str
    content_type: str
    size_bytes: int
    chunks: AsyncIterator[bytes] = field(repr=False)
