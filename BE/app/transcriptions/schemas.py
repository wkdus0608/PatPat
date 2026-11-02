from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.core.jobs import JobStatus
from app.transcriptions.models import FailureStage


class TranscriptionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TranscriptionAccepted(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)

    job_id: str = Field(min_length=1)
    recording_id: str = Field(min_length=1)
    status: Literal[JobStatus.QUEUED, JobStatus.RUNNING]


class FailureResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)

    stage: FailureStage
    code: str = Field(min_length=1, description="서버의 안전한 실패 코드; 외부 오류 원문 제외")
    retryable: bool


class TranscriptionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)

    job_id: str = Field(min_length=1)
    recording_id: str = Field(min_length=1)
    status: JobStatus
    text: str | None = Field(default=None, repr=False)
    observation_ids: list[str] = Field(default_factory=list)
    failure: FailureResponse | None = None

    @model_validator(mode="after")
    def consistent_result(self) -> Self:
        if self.status == JobStatus.COMPLETED:
            if self.text is None or self.failure is not None:
                raise ValueError("완료 작업은 전사문을 가지며 실패 정보를 갖지 않습니다.")
        elif self.text is not None or self.observation_ids:
            raise ValueError("완료 전에는 전사문과 관찰 ID를 공개하지 않습니다.")
        if (self.status == JobStatus.FAILED) != (self.failure is not None):
            raise ValueError("실패 상태에만 실패 정보가 필요합니다.")
        return self
