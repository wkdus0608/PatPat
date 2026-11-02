from fastapi import APIRouter, Response
from app.api.common_responses import COMMON_ERROR_RESPONSES
from app.auth.dependencies import CurrentTeacher, require_teacher_ownership
from app.core.errors import ApiError
from app.drafts.dependencies import DraftServiceDependency
from app.drafts.schemas import DraftAccepted, DraftRequest, DraftResponse
from app.writing.validation import validate_draft_content


drafts_router = APIRouter(prefix="/drafts", tags=["drafts"], responses={
    code: COMMON_ERROR_RESPONSES[code] for code in (401,404,409,422,500,501)
})


@drafts_router.post("", status_code=202, response_model=DraftAccepted,
    summary="선택 녹음과 전체 명단으로 관찰일지 초안 생성",
    description="비동기 계약입니다. 현재 기본 서비스는 501이며 DB/외부 AI는 연결되지 않았습니다.")
async def request_draft(body: DraftRequest, teacher: CurrentTeacher,
                        service: DraftServiceDependency, response: Response) -> DraftAccepted:
    job = await service.request(teacher=teacher, recording_ids=tuple(body.recording_ids))
    require_teacher_ownership(owner_teacher_id=job.teacher_id, teacher=teacher)
    response.headers["Cache-Control"] = "no-store"
    return DraftAccepted.model_validate(job)


@drafts_router.get("/{draft_id}", response_model=DraftResponse, summary="초안 작업 상태·아동별 결과 조회")
async def get_draft(draft_id: str, teacher: CurrentTeacher,
                    service: DraftServiceDependency, response: Response) -> DraftResponse:
    job = await service.get(teacher=teacher, draft_id=draft_id)
    require_teacher_ownership(owner_teacher_id=job.teacher_id, teacher=teacher)
    if job.draft_id != draft_id:
        raise ApiError(status_code=404, code="NOT_FOUND", message="초안을 찾을 수 없습니다.")
    if job.result:
        validate_draft_content(job.snapshot, job.result)
    response.headers["Cache-Control"] = "no-store"
    return DraftResponse(draft_id=job.draft_id,job_id=job.job_id,status=job.status,
        recording_ids=tuple(t.recording_id for t in job.snapshot.transcripts),
        roster=job.snapshot.children,result=job.result,failure=job.failure)
