from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.profile.schemas import ClassroomResponse

AreaName = Literal["신체운동·건강", "의사소통", "사회관계", "예술경험", "자연탐구"]
SessionStatus = Literal["writing", "analyzing", "asking", "drafting", "reviewing", "failed"]


class SessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    target_date: date = Field(description="알림장을 쓰는 날짜")
    classroom_id: str | None = Field(default=None, description="비우면 첫 번째(기본) 반")


class BlockPatch(BaseModel):
    """Only the fields that are sent change. place/time_text accept null to clear."""

    model_config = ConfigDict(extra="forbid")

    text: str | None = Field(default=None, max_length=5000)
    areas: list[AreaName] | None = None
    place: str | None = Field(default=None, max_length=100)
    time_text: str | None = Field(default=None, max_length=100)
    absent: bool | None = None


class BlockResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    block_id: str
    child_id: str | None = Field(description="null이면 반 공통 블록")
    child_name: str | None
    is_common: bool
    text: str
    areas: list[str]
    place: str | None
    time_text: str | None
    absent: bool
    filled: bool


class FlagResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    flag_id: str
    kind: str
    child_ids: list[str]
    question: str
    options: list[str]
    answer: str | None
    status: Literal["open", "answered", "skipped"]


class NoticeSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    notice_id: str
    child_id: str
    child_name: str
    status: str
    version: int
    needs_check: bool
    incident: bool
    busy: bool = Field(description="이 아이의 알림장을 다시 쓰는 중이면 true(그동안 수정·확정할 수 없음)")


class JobSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: str
    kind: str
    status: str
    error_code: str | None
    result: dict[str, Any] | None = Field(description="끝난 작업의 요약(예: 초안을 쓴 수, 실패한 아이)")


class SessionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    classroom: ClassroomResponse
    target_date: str
    status: SessionStatus
    error_code: str | None
    common_outdated: bool = Field(description="공통 블록을 고친 뒤 공통 단락을 다시 쓰지 않았으면 true")
    blocks: list[BlockResponse]
    flags: list[FlagResponse]
    notices: list[NoticeSummary]
    job: JobSummary | None


class AreaSuggestion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    areas: list[AreaName]
