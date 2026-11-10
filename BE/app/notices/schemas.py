from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.sessions.schemas import JobSummary

NoticeStatus = Literal["작성중", "검토중", "완료"]


class WarningItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: Literal["TEACHER_LED", "UNSUPPORTED_FEELING"]
    word: str


class NoticeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    notice_id: str
    session_id: str
    child_id: str
    child_name: str
    target_date: str
    version: int = Field(description="바뀔 때마다 1씩 늘어납니다. 수정·확정 요청에 expected_version으로 그대로 보냅니다.")
    status: NoticeStatus
    text: str = Field(description="지금 글(교사가 고친 것까지 반영)")
    generated_text: str = Field(description="AI가 처음 쓴 글")
    needs_check: bool = Field(description="아이 입력이 없어 공통 단락만 들어간 초안이면 true")
    incident: bool
    warnings: list[WarningItem] = Field(description="교사 주도 표현·입력에 없는 감정 같은 점검 결과(막지 않고 알립니다)")
    edit_ratio: float = Field(description="AI 초안에서 교사가 고친 정도. 0이면 그대로, 1에 가까울수록 많이 고침")
    can_share: bool = Field(description="완료된 알림장만 공유할 수 있습니다.")
    share_text: str | None = Field(description="공유할 때 복사할 글. 완료 전에는 null")
    busy: bool = Field(description="다시 쓰는 중이면 true(수정·확정 불가)")
    rules_hash: str | None
    model: str | None
    created_at: str
    updated_at: str
    confirmed_at: str | None
    needs_journal_update_choice: bool = Field(description="확정을 취소한 뒤 본문을 바꿔 다시 확정하는 경우")


class NoticeListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[NoticeResponse]


class NoticePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    edited_text: str = Field(min_length=1, max_length=6000)
    expected_version: int = Field(ge=1)


class VersionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_version: int = Field(ge=1)


class ConfirmBody(VersionBody):
    update_journal: bool | None = Field(default=None, description="수정한 알림장을 다시 확정할 때 관찰일지도 업데이트할지 선택")


class ConfirmResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    notice: NoticeResponse
    journal_job: JobSummary | None = Field(description="관찰일지 행을 만드는 작업. 이미 확정된 글을 다시 확정하면 null")


class HistoryItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int
    kind: Literal["generated", "regenerated", "manual_edit", "confirm", "unconfirm", "adopt_revision"]
    text: str
    status: str
    revision_id: str | None
    created_at: str


class HistoryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[HistoryItem]


class RevisionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    instruction: str = Field(min_length=1, max_length=500, description="예: 조금 더 부드럽게, 한 문장으로 줄여줘")
    base_version: int = Field(ge=1, description="수정을 요청한 시점에 본 알림장 version")


class RevisionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision_id: str
    notice_id: str
    base_version: int
    instruction: str
    status: Literal["queued", "running", "completed", "failed"]
    candidate_text: str | None
    error_code: str | None
    warnings: list[WarningItem]
    job_id: str | None
    created_at: str
    adopted_at: str | None
