from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.sessions.schemas import AreaName


class JournalEntryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entry_id: str
    child_id: str
    session_id: str
    notice_id: str
    block_kind: Literal["common", "individual"] = Field(description="common은 반 전체에 같은 행, individual은 그 아이만의 행")
    observed_date: str = Field(description="관찰일")
    place: str | None = Field(description="관찰장소")
    time_text: str | None = Field(description="관찰시간(교사가 적은 그대로)")
    areas: list[str] = Field(description="관찰영역")
    content: str = Field(description="관찰내용")
    status: Literal["pending", "ready", "edited", "failed"]
    error_code: str | None
    included: bool = Field(description="false이면 내보내기에서 뺍니다.")
    version: int = Field(description="수정 요청에 expected_version으로 그대로 보냅니다.")
    source_notice_version: int
    outdated: bool = Field(description="알림장이 이 행을 만든 뒤에 바뀌었으면 true. 다시 확정하거나 행을 다시 만들면 풀립니다.")
    updated_at: str


class JournalChild(BaseModel):
    model_config = ConfigDict(extra="forbid")

    child_id: str
    name: str
    gender: str | None
    birth_date: str | None


class JournalResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    child: JournalChild = Field(description="관찰일지 문서 머리(이름, 성별, 생년월일)")
    items: list[JournalEntryResponse]


class EntryPatch(BaseModel):
    """Only the fields that are sent change. Editing content, place, time or areas keeps the row from being overwritten later."""

    model_config = ConfigDict(extra="forbid")

    expected_version: int = Field(ge=1)
    content: str | None = Field(default=None, max_length=3000)
    place: str | None = Field(default=None, max_length=100)
    time_text: str | None = Field(default=None, max_length=100)
    areas: list[AreaName] | None = None
    included: bool | None = None
