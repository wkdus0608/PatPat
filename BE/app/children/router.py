from fastapi import APIRouter, Query
from typing import Annotated

from app.api.common_responses import COMMON_ERROR_RESPONSES
from app.auth.dependencies import CurrentTeacher, require_teacher_ownership
from app.auth.models import TeacherContext
from app.children.dependencies import ChildrenServiceDependency
from app.children.models import Child
from app.children.schemas import (
    ChildCreateRequest,
    ChildListResponse,
    ChildResponse,
    ChildUpdateRequest,
)


children_router = APIRouter(
    prefix="/children",
    tags=["children"],
    responses={status: COMMON_ERROR_RESPONSES[status] for status in (401, 404, 422, 500, 501)},
)


def _response(child: Child, teacher: TeacherContext) -> ChildResponse:
    require_teacher_ownership(owner_teacher_id=child.teacher_id, teacher=teacher)
    return ChildResponse.model_validate(child)


@children_router.get(
    "",
    response_model=ChildListResponse,
    summary="내 아동 명단 조회",
    description="기본값은 활성 아동만 조회합니다. 현재 명단 저장소는 연결되지 않아 501을 반환합니다.",
)
async def list_children(
    teacher: CurrentTeacher,
    service: ChildrenServiceDependency,
    include_inactive: Annotated[bool, Query(description="비활성 아동도 포함")] = False,
) -> ChildListResponse:
    children = await service.list(teacher=teacher, include_inactive=include_inactive)
    return ChildListResponse(items=[_response(child, teacher) for child in children])


@children_router.post(
    "",
    status_code=201,
    response_model=ChildResponse,
    summary="아동 등록",
    description="소유자는 인증된 교사로 결정합니다. 현재 저장 서비스는 연결되지 않아 501을 반환합니다.",
)
async def create_child(
    body: ChildCreateRequest,
    teacher: CurrentTeacher,
    service: ChildrenServiceDependency,
) -> ChildResponse:
    return _response(await service.create(teacher=teacher, name=body.name), teacher)


@children_router.patch(
    "/{child_id}",
    response_model=ChildResponse,
    summary="아동 이름 수정",
    description="고정 아동 ID와 과거 기록을 유지합니다. 현재 저장 서비스는 연결되지 않아 501을 반환합니다.",
)
async def rename_child(
    child_id: str,
    body: ChildUpdateRequest,
    teacher: CurrentTeacher,
    service: ChildrenServiceDependency,
) -> ChildResponse:
    child = await service.rename(teacher=teacher, child_id=child_id, name=body.name)
    return _response(child, teacher)


@children_router.post(
    "/{child_id}/deactivate",
    response_model=ChildResponse,
    summary="아동 비활성화",
    description="아동을 삭제하지 않고 비활성화합니다. 현재 저장 서비스는 연결되지 않아 501을 반환합니다.",
)
async def deactivate_child(
    child_id: str, teacher: CurrentTeacher, service: ChildrenServiceDependency
) -> ChildResponse:
    child = await service.deactivate(teacher=teacher, child_id=child_id)
    return _response(child, teacher)
