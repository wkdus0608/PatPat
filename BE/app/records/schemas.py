from datetime import datetime
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StrictInt, computed_field
from app.schemas.common import ListQuery, PageMetadata
from app.writing.models import ChildContent, NonBlank, RecordStatus


class VersionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: StrictInt = Field(ge=1)


class RecordEditRequest(VersionRequest):
    edited_text: NonBlank = Field(repr=False)


class RecordListQuery(ListQuery):
    child_id: NonBlank | None = None
    status: RecordStatus | None = None


class RecordSummary(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)

    record_id: NonBlank
    draft_id: NonBlank
    child_id: NonBlank
    version: int = Field(ge=1)
    status: RecordStatus
    created_at: AwareDatetime
    confirmed_at: AwareDatetime | None

    @computed_field
    @property
    def can_share(self) -> bool:
        return self.status == RecordStatus.COMPLETED


class RecordResponse(RecordSummary):
    edited_text: str = Field(repr=False)
    generated: ChildContent

    @computed_field
    @property
    def share_text(self) -> str | None:
        return self.edited_text if self.can_share else None


class RecordListResponse(PageMetadata):
    items: list[RecordSummary]


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
