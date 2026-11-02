from typing import Annotated
from fastapi import APIRouter, Query, Response
from app.api.common_responses import COMMON_ERROR_RESPONSES
from app.auth.dependencies import CurrentTeacher, require_teacher_ownership
from app.auth.models import TeacherContext
from app.core.errors import ApiError
from app.records.dependencies import RecordServiceDependency
from app.records.schemas import HistoryEntry, HistoryResponse, RecordEditRequest, RecordResponse, RecordListQuery, RecordListResponse, RecordSummary
from app.writing.models import JournalRecord


records_router = APIRouter(prefix="/records",tags=["records"],responses={
    code: COMMON_ERROR_RESPONSES[code] for code in (401,404,409,422,500,501)
})


def record_response(record: JournalRecord, teacher: TeacherContext, record_id: str) -> RecordResponse:
    require_teacher_ownership(owner_teacher_id=record.teacher_id, teacher=teacher)
    if record.record_id != record_id:
        raise ApiError(status_code=404,code="NOT_FOUND",message="일지를 찾을 수 없습니다.")
    return RecordResponse.model_validate(record)


@records_router.get("", response_model=RecordListResponse, summary="이전 관찰일지 목록·필터")
async def list_records(teacher: CurrentTeacher, service: RecordServiceDependency,
                       query: Annotated[RecordListQuery, Query()], response: Response) -> RecordListResponse:
    page = await service.list(teacher=teacher, query=query)
    for record in page.items:
        require_teacher_ownership(owner_teacher_id=record.teacher_id, teacher=teacher)
    response.headers["Cache-Control"] = "no-store"
    return RecordListResponse(items=[RecordSummary.model_validate(item) for item in page.items],
                              total=page.total, limit=query.limit, offset=query.offset)


@records_router.get("/{record_id}",response_model=RecordResponse,summary="관찰일지 상세")
async def get_record(record_id: str,teacher: CurrentTeacher,service: RecordServiceDependency,response: Response) -> RecordResponse:
    record = await service.get(teacher=teacher,record_id=record_id)
    response.headers["Cache-Control"]="no-store"
    return record_response(record,teacher,record_id)


@records_router.patch("/{record_id}",response_model=RecordResponse,summary="직접 수정문 그대로 저장",
    description="AI를 호출하지 않는 계약입니다. 현재 기본 저장 서비스는 501입니다.")
async def save_record(record_id: str,body: RecordEditRequest,teacher: CurrentTeacher,service: RecordServiceDependency,response: Response) -> RecordResponse:
    record = await service.save(teacher=teacher,record_id=record_id,edited_text=body.edited_text,expected_version=body.expected_version)
    response.headers["Cache-Control"]="no-store"
    return record_response(record,teacher,record_id)


@records_router.post("/{record_id}/confirm",response_model=RecordResponse,summary="교사 문구 그대로 확정")
async def confirm_record(record_id: str,body: RecordEditRequest,teacher: CurrentTeacher,service: RecordServiceDependency,response: Response) -> RecordResponse:
    record = await service.confirm(teacher=teacher,record_id=record_id,edited_text=body.edited_text,expected_version=body.expected_version)
    response.headers["Cache-Control"]="no-store"
    return record_response(record,teacher,record_id)


@records_router.get("/{record_id}/history",response_model=HistoryResponse,summary="일지 버전·수정 이력")
async def get_history(record_id: str,teacher: CurrentTeacher,service: RecordServiceDependency,response: Response) -> HistoryResponse:
    history = await service.history(teacher=teacher,record_id=record_id)
    for item in history:
        require_teacher_ownership(owner_teacher_id=item.teacher_id,teacher=teacher)
        if item.record_id != record_id:
            raise ApiError(status_code=404,code="NOT_FOUND",message="이력을 찾을 수 없습니다.")
    response.headers["Cache-Control"]="no-store"
    return HistoryResponse(items=[HistoryEntry.model_validate(item) for item in history])
