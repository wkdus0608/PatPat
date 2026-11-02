from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field, StrictInt
from app.writing.models import ChildContent, NonBlank, RecordStatus


class VersionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: StrictInt = Field(ge=1)


class RecordEditRequest(VersionRequest):
    edited_text: NonBlank = Field(repr=False)


class RecordResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)
    record_id: NonBlank
    draft_id: NonBlank
    child_id: NonBlank
    version: int
    status: RecordStatus
    edited_text: str = Field(repr=False)
    generated: ChildContent
    confirmed_at: datetime | None


class HistoryEntry(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)
    record_id: NonBlank
    version: int
    action: str
    edited_text: str = Field(repr=False)
    status: RecordStatus
    revision_id: str | None


class HistoryResponse(BaseModel):
    items: list[HistoryEntry]
