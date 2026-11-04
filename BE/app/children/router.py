from fastapi import APIRouter, Query, Depends, Response
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


def private_response(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


children_router = APIRouter(
    prefix="/children",
    tags=["children"],
    dependencies=[Depends(private_response)],
    responses={status: COMMON_ERROR_RESPONSES[status] for status in (401, 404, 422, 500, 501)},
)


def _response(child: Child, teacher: TeacherContext) -> ChildResponse:
    require_teacher_ownership(owner_teacher_id=child.teacher_id, teacher=teacher)
    return ChildResponse.model_validate(child)


@children_router.get(
    "",
    response_model=ChildListResponse,
    summary="내 아동 명단 조회",
    description="인증 교사의 명단을 등록 순서로 조회합니다. 기본값은 활성 아동만 포함합니다.",
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
    description="소유자는 인증된 교사로 결정합니다. 동명이인도 별도의 고정 ID로 등록합니다.",
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
    description="고정 아동 ID를 유지하고 소유 교사의 아동 이름만 수정합니다.",
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
    description="아동을 삭제하지 않고 비활성화합니다. 반복 요청에도 같은 ID를 유지합니다.",
)
async def deactivate_child(
    child_id: str, teacher: CurrentTeacher, service: ChildrenServiceDependency
) -> ChildResponse:
    child = await service.deactivate(teacher=teacher, child_id=child_id)
    return _response(child, teacher)
