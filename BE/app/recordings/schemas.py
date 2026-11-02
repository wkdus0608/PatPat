from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from app.recordings.models import RecordingStatus


class RecordingResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)

    recording_id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    recorded_at: AwareDatetime
    duration_seconds: float = Field(gt=0, allow_inf_nan=False)
    size_bytes: int = Field(gt=0)
    content_type: str
    status: RecordingStatus
    created_at: AwareDatetime


class RecordingListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[RecordingResponse]
