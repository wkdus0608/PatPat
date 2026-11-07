from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from app.api.common_responses import COMMON_ERROR_RESPONSES
from app.auth.dependencies import CurrentTeacher
from app.children.router import private_response
from app.jobs.router import JobResponse, job_response
from app.schemas.common import ErrorResponse
from app.services import Services, get_services
from app.sessions.router import session_response
from app.sessions.schemas import AreaName, SessionResponse

pipeline_router = APIRouter(
    prefix="/sessions",
    tags=["pipeline"],
    dependencies=[Depends(private_response)],
    responses={
        **{status: COMMON_ERROR_RESPONSES[status] for status in (401, 404, 409, 422, 500)},
        503: {"model": ErrorResponse, "description": "AI를 쓸 수 없음(키 미등록·점검·한도). code로 구분합니다."},
    },
)

ServicesDependency = Annotated[Services, Depends(get_services)]


class AnswerItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    flag_id: str
    answer: str | None = Field(default=None, max_length=500, description="질문의 선택지 중 하나이거나 직접 쓴 답. null 또는 빈 글이면 건너뛰기")
    areas: list[AreaName] | None = Field(default=None, max_length=5, description="영역 확인 질문에서 교사가 선택한 영역")


class AnswersBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    answers: list[AnswerItem] = Field(default_factory=list)
    skip_remaining: bool = Field(default=False, description="보내지 않은 나머지 질문을 모두 건너뜁니다.")


@pipeline_router.post(
    "/{session_id}/generate",
    status_code=202,
    response_model=JobResponse,
    summary="알림장 만들기 시작",
    description="모든 아이의 입력을 한 번에 검토해 꼭 필요한 질문만 뽑고, 질문이 없으면 곧바로 아이별 초안을 씁니다. "
    "session.status가 asking이면 질문에 답하고(answers), reviewing이면 초안이 나온 것입니다. "
    "작성 중(writing)이거나 실패(failed)한 세션에서만 시작할 수 있습니다.",
)
def generate(
    session_id: str, teacher: CurrentTeacher, services: ServicesDependency, ask_missing_areas: bool = False,
) -> JobResponse:
    return job_response(services.pipeline.start_generate(
        teacher.teacher_id, session_id, ask_missing_areas=ask_missing_areas,
    ))


@pipeline_router.post(
    "/{session_id}/answers",
    status_code=202,
    response_model=JobResponse,
    summary="질문에 답하고 초안 쓰기",
    description="모든 질문에 답하거나 건너뛰어야 합니다(남은 질문을 한꺼번에 건너뛰려면 skip_remaining). "
    "사건사고 질문에 '부드럽게'를 고르면 그 아이는 부드러운 사건사고 알림장으로 씁니다.",
)
def answers(session_id: str, body: AnswersBody, teacher: CurrentTeacher, services: ServicesDependency) -> JobResponse:
    items = [item.model_dump() for item in body.answers]
    return job_response(services.pipeline.submit_answers(teacher.teacher_id, session_id, items, body.skip_remaining))


@pipeline_router.post(
    "/{session_id}/reopen",
    response_model=SessionResponse,
    summary="질문 단계에서 입력으로 돌아가기",
    description="질문이 떠 있을 때 입력을 고치고 싶으면 호출합니다. 질문은 사라지고 다시 만들 때 새로 물어봅니다.",
)
def reopen(session_id: str, teacher: CurrentTeacher, services: ServicesDependency) -> SessionResponse:
    services.pipeline.reopen(teacher.teacher_id, session_id)
    return session_response(services, services.sessions.require(teacher.teacher_id, session_id))


@pipeline_router.post(
    "/{session_id}/children/{child_id}/regenerate",
    status_code=202,
    response_model=JobResponse,
    summary="한 아이의 알림장만 다시 쓰기",
    description="그 아이의 지금 입력으로 새 버전을 씁니다(이전 버전은 이력에 남습니다). 초안이 없던 아이의 알림장을 처음 쓸 때도 씁니다. "
    "공통 블록을 고쳤다면 공통 단락도 다시 씁니다.",
)
def regenerate_child(session_id: str, child_id: str, teacher: CurrentTeacher, services: ServicesDependency) -> JobResponse:
    return job_response(services.pipeline.start_regenerate_child(teacher.teacher_id, session_id, child_id))
