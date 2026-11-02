from fastapi import APIRouter, Response
from app.api.common_responses import COMMON_ERROR_RESPONSES
from app.auth.dependencies import CurrentTeacher, require_teacher_ownership
from app.core.errors import ApiError
from app.auth.models import TeacherContext
from app.writing.models import RevisionJob
from app.records.router import record_response
from app.records.schemas import RecordResponse, VersionRequest
from app.revisions.dependencies import RevisionServiceDependency
from app.revisions.schemas import RevisionAccepted, RevisionRequest, RevisionResponse


revisions_router = APIRouter(prefix="/records/{record_id}/revisions",tags=["revisions"],responses={
    code: COMMON_ERROR_RESPONSES[code] for code in (401,404,409,422,500,501)
})


def check_revision(job: RevisionJob, teacher: TeacherContext, record_id: str, revision_id: str | None = None) -> None:
    require_teacher_ownership(owner_teacher_id=job.teacher_id,teacher=teacher)
    if job.record_id != record_id or revision_id is not None and job.revision_id != revision_id:
        raise ApiError(status_code=404,code="NOT_FOUND",message="수정 후보를 찾을 수 없습니다.")


@revisions_router.post("",status_code=202,response_model=RevisionAccepted,summary="AI 수정 후보 비동기 요청",
    description="기존 일지를 바꾸지 않고 새 후보를 만드는 계약입니다. 현재 기본 서비스는 501입니다.")
async def request_revision(record_id: str,body: RevisionRequest,teacher: CurrentTeacher,service: RevisionServiceDependency,response: Response) -> RevisionAccepted:
    job=await service.request(teacher=teacher,record_id=record_id,instruction=body.instruction,expected_version=body.expected_version)
    check_revision(job,teacher,record_id)
    response.headers["Cache-Control"]="no-store"
    return RevisionAccepted.model_validate(job)


@revisions_router.get("/{revision_id}",response_model=RevisionResponse,summary="수정 후보 상태·결과")
async def get_revision(record_id: str,revision_id: str,teacher: CurrentTeacher,service: RevisionServiceDependency,response: Response) -> RevisionResponse:
    job=await service.get(teacher=teacher,record_id=record_id,revision_id=revision_id)
    check_revision(job,teacher,record_id,revision_id)
    response.headers["Cache-Control"]="no-store"
    return RevisionResponse.model_validate(job)


@revisions_router.post("/{revision_id}/adopt",response_model=RecordResponse,summary="수정 후보 채택·재검토")
async def adopt_candidate(record_id: str,revision_id: str,body: VersionRequest,teacher: CurrentTeacher,service: RevisionServiceDependency,response: Response) -> RecordResponse:
    record=await service.adopt(teacher=teacher,record_id=record_id,revision_id=revision_id,expected_version=body.expected_version)
    response.headers["Cache-Control"]="no-store"
    return record_response(record,teacher,record_id)
