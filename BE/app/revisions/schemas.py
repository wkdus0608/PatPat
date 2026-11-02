from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from app.core.jobs import JobStatus
from app.records.schemas import VersionRequest
from app.writing.models import ChildContent, NonBlank, WritingFailure


class RevisionRequest(VersionRequest):
    instruction: NonBlank = Field(repr=False)


class RevisionAccepted(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)
    revision_id: NonBlank
    job_id: NonBlank
    record_id: NonBlank
    status: Literal[JobStatus.QUEUED, JobStatus.RUNNING]


class RevisionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)
    revision_id: NonBlank
    job_id: NonBlank
    record_id: NonBlank
    child_id: NonBlank
    base_version: int
    status: JobStatus
    candidate_text: str | None = Field(repr=False)
    candidate: ChildContent | None
    failure: WritingFailure | None
