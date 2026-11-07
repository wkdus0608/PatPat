from typing import Annotated

from fastapi import APIRouter, Depends, Response

from app.ai import prompts, schemas
from app.ai.privacy import mask_names
from app.ai.types import AIError
from app.api.ai_errors import ai_error_to_api
from app.api.common_responses import COMMON_ERROR_RESPONSES
from app.auth.dependencies import CurrentTeacher
from app.children.router import private_response
from app.core.errors import ApiError
from app.profile.schemas import ClassroomResponse
from app.rules.loader import age_band_from_label
from app.services import Services, get_services
from app.sessions.schemas import (
    AreaSuggestion,
    BlockPatch,
    BlockResponse,
    FlagResponse,
    JobSummary,
    NoticeSummary,
    SessionCreate,
    SessionResponse,
)

sessions_router = APIRouter(
    prefix="/sessions",
    tags=["sessions"],
    dependencies=[Depends(private_response)],
    responses={status: COMMON_ERROR_RESPONSES[status] for status in (401, 404, 409, 422, 500)},
)

ServicesDependency = Annotated[Services, Depends(get_services)]


def session_response(services: Services, session: dict) -> SessionResponse:
    classroom = services.profile.get_classroom(session["teacher_id"], session["classroom_id"])
    blocks = services.sessions.list_blocks(session["session_id"])
    job = services.sessions.latest_job(session["session_id"])
    return SessionResponse(
        session_id=session["session_id"],
        classroom=ClassroomResponse(
            classroom_id=classroom["classroom_id"], name=classroom["name"], age_label=classroom["age_label"],
            age_band=age_band_from_label(classroom["age_label"]),
        ),
        target_date=session["target_date"],
        status=session["status"],
        error_code=session["error_code"],
        common_outdated=services.sessions.common_outdated(session, blocks),
        blocks=[BlockResponse(**{key: value for key, value in block.items() if key != "child_active"}) for block in blocks],
        flags=[FlagResponse(**flag) for flag in services.sessions.list_flags(session["session_id"])],
        notices=[NoticeSummary(**row) for row in services.sessions.notice_summaries(session["session_id"])],
        job=JobSummary(**job) if job else None,
    )


@sessions_router.post(
    "",
    response_model=SessionResponse,
    summary="작성 세션 열기",
    description="같은 반·같은 날짜의 세션이 있으면 그대로 돌려주고(200), 없으면 만듭니다(201). "
    "등록된 아이마다 입력 블록이, 맨 위에 반 공통 블록이 자동으로 생깁니다.",
)
def open_session(body: SessionCreate, response: Response, teacher: CurrentTeacher, services: ServicesDependency) -> SessionResponse:
    session, created = services.sessions.get_or_create(teacher.teacher_id, body.classroom_id, body.target_date.isoformat())
    response.status_code = 201 if created else 200
    return session_response(services, session)


@sessions_router.get("/{session_id}", response_model=SessionResponse, summary="작성 세션 조회")
def get_session(session_id: str, teacher: CurrentTeacher, services: ServicesDependency) -> SessionResponse:
    session = services.sessions.require(teacher.teacher_id, session_id)
    services.sessions.ensure_blocks(teacher.teacher_id, session_id)  # children added after the session was opened
    return session_response(services, session)


@sessions_router.patch(
    "/{session_id}/blocks/{block_id}",
    response_model=BlockResponse,
    summary="입력 블록 수정",
    description="글, 영역(복수), 장소, 시간, 결석 여부 중 보낸 것만 바꿉니다. 생성 중에는 409입니다.",
)
def patch_block(
    session_id: str, block_id: str, body: BlockPatch, teacher: CurrentTeacher, services: ServicesDependency
) -> BlockResponse:
    changes = body.model_dump(include=body.model_fields_set)
    for key in ("text", "areas", "absent"):
        if key in changes and changes[key] is None:
            raise ApiError(status_code=422, code="VALIDATION_ERROR", message=f"{key}는 null일 수 없습니다.")
    block = services.sessions.update_block(teacher.teacher_id, session_id, block_id, changes)
    return BlockResponse(**{key: value for key, value in block.items() if key != "child_active"})


@sessions_router.post(
    "/{session_id}/blocks/{block_id}/suggest-areas",
    response_model=AreaSuggestion,
    summary="관찰영역 추천",
    description="글을 보고 영역을 미리 체크해 둘 후보를 돌려줍니다(저장하지 않음). 교사가 확인해 블록 수정으로 저장합니다.",
)
def suggest_areas(session_id: str, block_id: str, teacher: CurrentTeacher, services: ServicesDependency) -> AreaSuggestion:
    services.sessions.require(teacher.teacher_id, session_id)
    block = services.sessions.get_block(session_id, block_id)
    if block is None:
        raise ApiError(status_code=404, code="NOT_FOUND", message="입력 블록을 찾을 수 없습니다.")
    if not block["text"].strip():
        raise ApiError(status_code=422, code="EMPTY_BLOCK", message="글을 먼저 적어 주세요.")
    others = [
        item["child_name"] for item in services.sessions.list_blocks(session_id, only_active=False)
        if item["child_id"] not in (None, block["child_id"])
    ]
    request = prompts.build_areas(services.rules, text=mask_names(block["text"], others))  # no other child's name leaves
    try:
        result = services.ai.call(request, teacher_id=teacher.teacher_id, session_id=session_id)
    except AIError as error:
        raise ai_error_to_api(error) from error
    return AreaSuggestion(areas=schemas.parse_areas(result.data))


__all__ = ["sessions_router", "session_response"]
