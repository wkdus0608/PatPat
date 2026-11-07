from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from app.api.common_responses import COMMON_ERROR_RESPONSES
from app.auth.dependencies import CurrentTeacher
from app.children.router import private_response
from app.core.errors import ApiError
from app.services import Services, get_services

jobs_router = APIRouter(
    prefix="/jobs",
    tags=["jobs"],
    dependencies=[Depends(private_response)],
    responses={status: COMMON_ERROR_RESPONSES[status] for status in (401, 404, 500)},
)


class JobResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: str
    kind: str
    ref_id: str
    status: str
    error_code: str | None
    error_message: str | None
    result: dict[str, Any] | None
    created_at: str
    started_at: str | None
    finished_at: str | None


def job_response(job: dict) -> JobResponse:
    return JobResponse(**{key: job[key] for key in JobResponse.model_fields})


@jobs_router.get(
    "/{job_id}",
    response_model=JobResponse,
    summary="작업 상태 조회",
    description="생성·수정 요청·관찰일지 변환처럼 시간이 걸리는 일의 진행 상태입니다. 1~2초 간격으로 조회합니다.",
)
def get_job(job_id: str, teacher: CurrentTeacher, services: Annotated[Services, Depends(get_services)]) -> JobResponse:
    job = services.jobs.get(teacher.teacher_id, job_id)
    if job is None:
        raise ApiError(status_code=404, code="NOT_FOUND", message="작업을 찾을 수 없습니다.")
    return job_response(job)
