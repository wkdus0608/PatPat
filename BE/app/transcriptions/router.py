from fastapi import APIRouter, Response

from app.api.common_responses import COMMON_ERROR_RESPONSES
from app.auth.dependencies import CurrentTeacher, require_teacher_ownership
from app.transcriptions.dependencies import TranscriptionServiceDependency
from app.transcriptions.schemas import TranscriptionAccepted, TranscriptionRequest, TranscriptionResponse


transcriptions_router = APIRouter(tags=["transcriptions"], responses={
    status: COMMON_ERROR_RESPONSES[status] for status in (401, 404, 409, 422, 500, 501)
})


@transcriptions_router.post(
    "/recordings/{recording_id}/transcriptions", status_code=202,
    response_model=TranscriptionAccepted, summary="외부 전사 요청·실패 재시도",
    description="비동기 작업 계약입니다. 현재 기본 서비스는 501이며 외부 호출은 하지 않습니다.",
)
async def request_transcription(
    recording_id: str, teacher: CurrentTeacher, service: TranscriptionServiceDependency,
    response: Response, body: TranscriptionRequest | None = None,
) -> TranscriptionAccepted:
    job = await service.request(teacher=teacher, recording_id=recording_id)
    require_teacher_ownership(owner_teacher_id=job.teacher_id, teacher=teacher)
    response.headers["Cache-Control"] = "no-store"
    return TranscriptionAccepted.model_validate(job)


@transcriptions_router.get(
    "/transcription-jobs/{job_id}", response_model=TranscriptionResponse,
    summary="전사 작업 상태·결과 조회",
)
async def get_transcription_job(
    job_id: str, teacher: CurrentTeacher, service: TranscriptionServiceDependency,
    response: Response,
) -> TranscriptionResponse:
    job = await service.get(teacher=teacher, job_id=job_id)
    require_teacher_ownership(owner_teacher_id=job.teacher_id, teacher=teacher)
    response.headers["Cache-Control"] = "no-store"
    return TranscriptionResponse.model_validate(job)


@transcriptions_router.get(
    "/recordings/{recording_id}/transcriptions/latest", response_model=TranscriptionResponse,
    summary="녹음의 최신 전사 작업·결과 조회",
)
async def get_latest_transcription(
    recording_id: str, teacher: CurrentTeacher, service: TranscriptionServiceDependency,
    response: Response,
) -> TranscriptionResponse:
    job = await service.latest(teacher=teacher, recording_id=recording_id)
    require_teacher_ownership(owner_teacher_id=job.teacher_id, teacher=teacher)
    response.headers["Cache-Control"] = "no-store"
    return TranscriptionResponse.model_validate(job)
