from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, ConfigDict, Field

from app.api.common_responses import COMMON_ERROR_RESPONSES
from app.auth.dependencies import CurrentTeacher
from app.children.router import private_response
from app.core.errors import ApiError
from app.services import Services, get_services
from app.sessions.store import EDITABLE_STATUSES

quicknotes_router = APIRouter(
    tags=["quick-notes"],
    dependencies=[Depends(private_response)],
    responses={status: COMMON_ERROR_RESPONSES[status] for status in (401, 404, 409, 422, 500)},
)

ServicesDependency = Annotated[Services, Depends(get_services)]


class QuickNoteCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    note_date: date = Field(description="메모가 속한 날짜(그날 알림장을 쓸 때 가져옵니다)")
    text: str = Field(min_length=1, max_length=2000)
    child_id: str | None = Field(default=None, description="비우면 반 전체에 대한 메모")
    recording_id: str | None = Field(default=None, description="측면 버튼 녹음과 이어 두고 싶을 때. 글로 옮기는 기능은 아직 없습니다.")


class QuickNotePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str | None = Field(default=None, min_length=1, max_length=2000)
    child_id: str | None = Field(default=None, description="null을 보내면 반 전체 메모로 바꿉니다.")


class QuickNoteResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    note_id: str
    note_date: str
    text: str
    child_id: str | None
    child_name: str | None
    recording_id: str | None
    imported_session_id: str | None = Field(description="입력 블록으로 가져왔으면 그 세션 id")
    created_at: str


class QuickNoteListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[QuickNoteResponse]


class SkippedNote(BaseModel):
    model_config = ConfigDict(extra="forbid")

    note_id: str
    reason: str


class ImportResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    imported: list[QuickNoteResponse]
    skipped: list[SkippedNote] = Field(description="가져오지 못한 메모(예: 이 반에 없는 아이의 메모)")


def note_response(note: dict) -> QuickNoteResponse:
    return QuickNoteResponse(**{key: note[key] for key in QuickNoteResponse.model_fields})


def _check_links(services: Services, teacher_id: str, child_id: str | None, recording_id: str | None = None) -> None:
    if child_id is not None and not services.profile.owns_child(teacher_id, child_id):
        raise ApiError(status_code=404, code="NOT_FOUND", message="아동을 찾을 수 없습니다.")
    if recording_id is not None and not services.quicknote_store.owns_recording(teacher_id, recording_id):
        raise ApiError(status_code=404, code="NOT_FOUND", message="녹음을 찾을 수 없습니다.")


@quicknotes_router.post(
    "/quick-notes",
    status_code=201,
    response_model=QuickNoteResponse,
    summary="메모 남기기",
    description="하루 동안 짧게 남기는 메모입니다. 저녁에 알림장을 쓸 때 입력 블록으로 가져올 수 있습니다.",
)
def create_note(body: QuickNoteCreate, teacher: CurrentTeacher, services: ServicesDependency) -> QuickNoteResponse:
    text = body.text.strip()
    if not text:
        raise ApiError(status_code=422, code="EMPTY_TEXT", message="메모가 비어 있습니다.")
    _check_links(services, teacher.teacher_id, body.child_id, body.recording_id)
    note = services.quicknote_store.create(teacher.teacher_id, body.note_date.isoformat(), text, body.child_id, body.recording_id)
    return note_response(note)


@quicknotes_router.get("/quick-notes", response_model=QuickNoteListResponse, summary="메모 목록")
def list_notes(
    teacher: CurrentTeacher,
    services: ServicesDependency,
    note_date: date | None = None,
    imported: bool | None = None,
    child_id: str | None = None,
) -> QuickNoteListResponse:
    rows = services.quicknote_store.list(
        teacher.teacher_id, note_date=note_date.isoformat() if note_date else None, imported=imported, child_id=child_id
    )
    return QuickNoteListResponse(items=[note_response(row) for row in rows])


@quicknotes_router.patch(
    "/quick-notes/{note_id}",
    response_model=QuickNoteResponse,
    summary="메모 고치기",
    description="이미 입력 블록으로 가져온 메모는 고칠 수 없습니다(409).",
)
def patch_note(note_id: str, body: QuickNotePatch, teacher: CurrentTeacher, services: ServicesDependency) -> QuickNoteResponse:
    changes = body.model_dump(include=body.model_fields_set)
    if not changes:
        raise ApiError(status_code=422, code="VALIDATION_ERROR", message="바꿀 항목을 하나 이상 보내 주세요.")
    if "text" in changes:
        if changes["text"] is None:
            raise ApiError(status_code=422, code="VALIDATION_ERROR", message="text는 null일 수 없습니다.")
        changes["text"] = changes["text"].strip()
        if not changes["text"]:
            raise ApiError(status_code=422, code="EMPTY_TEXT", message="메모가 비어 있습니다.")
    _check_links(services, teacher.teacher_id, changes.get("child_id"))
    return note_response(services.quicknote_store.update(teacher.teacher_id, note_id, changes))


@quicknotes_router.delete("/quick-notes/{note_id}", status_code=204, summary="메모 지우기", description="이미 지운 메모를 다시 지워도 204입니다.")
def delete_note(note_id: str, teacher: CurrentTeacher, services: ServicesDependency) -> Response:
    services.quicknote_store.delete(teacher.teacher_id, note_id)
    return Response(status_code=204)


@quicknotes_router.post(
    "/sessions/{session_id}/quick-notes/import",
    response_model=ImportResponse,
    summary="그날 메모를 입력 블록으로 가져오기",
    description="세션 날짜의 아직 가져오지 않은 메모를 아이별 블록(아이를 정하지 않은 메모는 반 공통 블록) 끝에 줄을 바꿔 붙입니다. "
    "한 번 가져온 메모는 다시 가져오지 않습니다. 관찰영역은 교사가 따로 고릅니다.",
)
def import_notes(session_id: str, teacher: CurrentTeacher, services: ServicesDependency) -> ImportResponse:
    session = services.sessions.require(teacher.teacher_id, session_id)
    if session["status"] not in EDITABLE_STATUSES:
        raise ApiError(status_code=409, code="SESSION_BUSY", message="생성 중에는 입력을 바꿀 수 없습니다.",
                       details={"status": session["status"]})
    services.sessions.ensure_blocks(teacher.teacher_id, session_id)
    blocks = services.sessions.list_blocks(session_id)
    targets = {block["child_id"]: block["block_id"] for block in blocks}
    imported, skipped = services.quicknote_store.import_into_session(teacher.teacher_id, session, targets)
    return ImportResponse(imported=[note_response(note) for note in imported], skipped=[SkippedNote(**item) for item in skipped])
