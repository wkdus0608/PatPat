from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.api.common_responses import COMMON_ERROR_RESPONSES
from app.auth.dependencies import CurrentTeacher
from app.children.router import private_response
from app.core.errors import ApiError
from app.notices.schemas import (
    ConfirmBody,
    ConfirmResponse,
    HistoryItem,
    HistoryResponse,
    NoticeListResponse,
    NoticePatch,
    NoticeResponse,
    NoticeStatus,
    RevisionBody,
    RevisionResponse,
    VersionBody,
    WarningItem,
)
from app.notices.store import CONFIRMED, edit_ratio
from app.schemas.common import ErrorResponse
from app.services import Services, get_services
from app.sessions.schemas import JobSummary

notices_router = APIRouter(
    prefix="/notices",
    tags=["notices"],
    dependencies=[Depends(private_response)],
    responses={
        **{status: COMMON_ERROR_RESPONSES[status] for status in (401, 404, 409, 422, 500)},
        503: {"model": ErrorResponse, "description": "AI를 쓸 수 없음(키 미등록·점검·한도). code로 구분합니다."},
    },
)

ServicesDependency = Annotated[Services, Depends(get_services)]


def notice_response(services: Services, notice: dict) -> NoticeResponse:
    confirmed = notice["status"] == CONFIRMED
    return NoticeResponse(
        notice_id=notice["notice_id"], session_id=notice["session_id"], child_id=notice["child_id"],
        child_name=notice["child_name"], target_date=notice["target_date"], version=notice["version"],
        status=notice["status"], text=notice["edited_text"], generated_text=notice["generated_text"],
        needs_check=notice["needs_check"], incident=notice["incident"],
        warnings=[WarningItem(**item) for item in notice["warnings"]],
        edit_ratio=edit_ratio(notice["generated_text"], notice["edited_text"]),
        can_share=confirmed, share_text=notice["edited_text"] if confirmed else None,
        busy=services.notice_service.is_busy(notice), rules_hash=notice["rules_hash"], model=notice["model"],
        created_at=notice["created_at"], updated_at=notice["updated_at"], confirmed_at=notice["confirmed_at"],
        needs_journal_update_choice=notice["needs_journal_update_choice"],
    )


def revision_response(services: Services, notice: dict, revision: dict) -> RevisionResponse:
    return RevisionResponse(
        revision_id=revision["revision_id"], notice_id=revision["notice_id"], base_version=revision["base_version"],
        instruction=revision["instruction"], status=revision["status"], candidate_text=revision["candidate_text"],
        error_code=revision["error_code"],
        warnings=[WarningItem(**item) for item in services.notice_service.revision_warnings(notice, revision)],
        job_id=revision["job_id"], created_at=revision["created_at"], adopted_at=revision["adopted_at"],
    )


@notices_router.get(
    "",
    response_model=NoticeListResponse,
    summary="알림장 목록",
    description="최근 날짜순입니다. 아이·기간·상태로 거릅니다.",
)
def list_notices(
    teacher: CurrentTeacher,
    services: ServicesDependency,
    child_id: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    status: NoticeStatus | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> NoticeListResponse:
    rows = services.notices.list(
        teacher.teacher_id, child_id=child_id,
        date_from=date_from.isoformat() if date_from else None, date_to=date_to.isoformat() if date_to else None,
        status=status, limit=limit, offset=offset,
    )
    return NoticeListResponse(items=[notice_response(services, row) for row in rows])


@notices_router.get("/{notice_id}", response_model=NoticeResponse, summary="알림장 조회")
def get_notice(notice_id: str, teacher: CurrentTeacher, services: ServicesDependency) -> NoticeResponse:
    return notice_response(services, services.notices.require(teacher.teacher_id, notice_id))


@notices_router.patch(
    "/{notice_id}",
    response_model=NoticeResponse,
    summary="알림장 직접 수정",
    description="글을 통째로 바꿉니다. 완료된 알림장을 고치면 다시 검토중이 됩니다. "
    "expected_version이 지금 version과 다르면 409(VERSION_CONFLICT)이고 details.current_version을 돌려줍니다.",
)
def edit_notice(notice_id: str, body: NoticePatch, teacher: CurrentTeacher, services: ServicesDependency) -> NoticeResponse:
    notice = services.notice_service.edit(teacher.teacher_id, notice_id, body.expected_version, body.edited_text)
    return notice_response(services, notice)


@notices_router.post(
    "/{notice_id}/confirm",
    response_model=ConfirmResponse,
    summary="알림장 확정",
    description="지금 글을 그대로 완료로 저장합니다(AI를 다시 부르지 않습니다). "
    "확정 취소 후 본문을 수정했으면 update_journal로 기존 관찰일지를 유지하거나 업데이트할지 선택합니다. "
    "같은 요청을 다시 보내도 알림장이나 일지를 중복 저장하지 않습니다.",
)
def confirm_notice(notice_id: str, body: ConfirmBody, teacher: CurrentTeacher, services: ServicesDependency) -> ConfirmResponse:
    notice, job = services.notice_service.confirm(
        teacher.teacher_id, notice_id, body.expected_version, update_journal=body.update_journal,
    )
    return ConfirmResponse(
        notice=notice_response(services, notice),
        journal_job=JobSummary(**{key: job[key] for key in ("job_id", "kind", "status", "error_code", "result")}) if job else None,
    )


@notices_router.post("/{notice_id}/unconfirm", response_model=NoticeResponse, summary="알림장 확정 취소")
def unconfirm_notice(notice_id: str, body: VersionBody, teacher: CurrentTeacher, services: ServicesDependency) -> NoticeResponse:
    notice = services.notice_service.unconfirm(teacher.teacher_id, notice_id, body.expected_version)
    return notice_response(services, notice)


@notices_router.get("/{notice_id}/history", response_model=HistoryResponse, summary="알림장 변경 이력")
def notice_history(notice_id: str, teacher: CurrentTeacher, services: ServicesDependency) -> HistoryResponse:
    return HistoryResponse(items=[HistoryItem(**row) for row in services.notices.history(teacher.teacher_id, notice_id)])


@notices_router.post(
    "/{notice_id}/revisions",
    status_code=202,
    response_model=RevisionResponse,
    summary="AI에게 고쳐 달라고 요청",
    description="수정안을 만들어 두기만 합니다. 마음에 들면 adopt로 반영하고, 아니면 버립니다. "
    "요청한 뒤 글이 바뀌면(base_version이 달라지면) 반영할 수 없습니다.",
)
def request_revision(notice_id: str, body: RevisionBody, teacher: CurrentTeacher, services: ServicesDependency) -> RevisionResponse:
    revision, _job = services.notice_service.start_revision(teacher.teacher_id, notice_id, body.base_version, body.instruction)
    return revision_response(services, services.notices.require(teacher.teacher_id, notice_id), revision)


@notices_router.get("/{notice_id}/revisions/{revision_id}", response_model=RevisionResponse, summary="AI 수정안 조회")
def get_revision(notice_id: str, revision_id: str, teacher: CurrentTeacher, services: ServicesDependency) -> RevisionResponse:
    notice = services.notices.require(teacher.teacher_id, notice_id)
    revision = services.notices.get_revision(teacher.teacher_id, notice_id, revision_id)
    if revision is None:
        raise ApiError(status_code=404, code="NOT_FOUND", message="수정 요청을 찾을 수 없습니다.")
    return revision_response(services, notice, revision)


@notices_router.post(
    "/{notice_id}/revisions/{revision_id}/adopt",
    response_model=NoticeResponse,
    summary="AI 수정안 반영",
    description="수정안으로 글을 바꿉니다(새 version). 그 사이 글이 바뀌었거나 이미 반영한 수정안이면 409입니다.",
)
def adopt_revision(
    notice_id: str, revision_id: str, body: VersionBody, teacher: CurrentTeacher, services: ServicesDependency
) -> NoticeResponse:
    notice = services.notice_service.adopt(teacher.teacher_id, notice_id, revision_id, body.expected_version)
    return notice_response(services, notice)
