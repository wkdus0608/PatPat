from typing import Literal, Self
from pydantic import BaseModel, ConfigDict, Field, model_validator
from app.core.jobs import JobStatus
from app.writing.models import ChildSnapshot, DraftResult, NonBlank, WritingFailure


class DraftRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    recording_ids: list[NonBlank] = Field(min_length=1)

    @model_validator(mode="after")
    def unique_selection(self) -> Self:
        if len(set(self.recording_ids)) != len(self.recording_ids):
            raise ValueError("녹음 선택이 중복되었습니다.")
        return self


class DraftAccepted(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)
    draft_id: NonBlank
    job_id: NonBlank
    status: Literal[JobStatus.QUEUED, JobStatus.RUNNING]


class DraftResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    draft_id: NonBlank
    job_id: NonBlank
    status: JobStatus
    recording_ids: tuple[NonBlank, ...]
    roster: tuple[ChildSnapshot, ...]
    result: DraftResult | None
    failure: WritingFailure | None
