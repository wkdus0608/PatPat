from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response

from app.api.common_responses import COMMON_ERROR_RESPONSES
from app.auth.dependencies import CurrentTeacher
from app.children.router import private_response
from app.core.errors import ApiError
from app.profile.schemas import (
    CharacteristicsResponse,
    ChildDetailsPatch,
    ChildDetailsResponse,
    ClassroomBody,
    ClassroomListResponse,
    ClassroomPatch,
    ClassroomResponse,
    DocumentKind,
    DocumentResponse,
    OnboardingProgress,
    TextBody,
    WritingPreferences,
)
from app.profile.store import ProfileStore
from app.rules.loader import age_band_from_label

profile_router = APIRouter(
    tags=["profile"],
    dependencies=[Depends(private_response)],
    responses={status: COMMON_ERROR_RESPONSES[status] for status in (401, 404, 422, 500)},
)


def get_profile_store(request: Request) -> ProfileStore:
    return request.app.state.profile_store


StoreDependency = Annotated[ProfileStore, Depends(get_profile_store)]


@profile_router.get("/onboarding", response_model=OnboardingProgress, summary="첫 설정 진행 단계 조회")
def get_onboarding(teacher: CurrentTeacher, store: StoreDependency) -> OnboardingProgress:
    return OnboardingProgress(step=store.onboarding_step(teacher.teacher_id))


@profile_router.put("/onboarding", response_model=OnboardingProgress, summary="첫 설정 진행 단계 저장")
def update_onboarding(
    body: OnboardingProgress, teacher: CurrentTeacher, store: StoreDependency
) -> OnboardingProgress:
    return OnboardingProgress(step=store.advance_onboarding(teacher.teacher_id, body.step))


@profile_router.get("/teacher/writing-preferences", response_model=WritingPreferences, summary="자주 쓰는 장소·시간 조회")
def writing_preferences(teacher: CurrentTeacher, store: StoreDependency) -> WritingPreferences:
    return WritingPreferences(**store.writing_preferences(teacher.teacher_id))


@profile_router.put("/teacher/writing-preferences", response_model=WritingPreferences, summary="자주 쓰는 장소·시간 저장")
def save_writing_preferences(body: WritingPreferences, teacher: CurrentTeacher, store: StoreDependency) -> WritingPreferences:
    store.save_writing_preferences(teacher.teacher_id, body.places, body.times)
    return body

def _own_child(store: ProfileStore, teacher_id: str, child_id: str) -> None:
    if not store.owns_child(teacher_id, child_id):
        raise ApiError(status_code=404, code="NOT_FOUND", message="아동을 찾을 수 없습니다.")


def _classroom_response(row: dict) -> ClassroomResponse:
    return ClassroomResponse(
        classroom_id=row["classroom_id"],
        name=row["name"],
        age_label=row["age_label"],
        age_band=age_band_from_label(row["age_label"]),
    )


# --- child characteristics ---------------------------------------------------------------------
@profile_router.get(
    "/children/{child_id}/characteristics",
    response_model=CharacteristicsResponse,
    summary="아동 특성 조회",
    description="저장한 적이 없으면 text가 null입니다.",
)
def get_characteristics(child_id: str, teacher: CurrentTeacher, store: StoreDependency) -> CharacteristicsResponse:
    _own_child(store, teacher.teacher_id, child_id)
    text, updated_at = store.get_characteristics(child_id)
    return CharacteristicsResponse(child_id=child_id, text=text, updated_at=updated_at)


@profile_router.put(
    "/children/{child_id}/characteristics",
    response_model=CharacteristicsResponse,
    summary="아동 특성 저장",
    description="자유 서술 한 칸을 그대로 저장합니다. 빈 문자열은 내용을 지웁니다.",
)
def put_characteristics(
    child_id: str, body: TextBody, teacher: CurrentTeacher, store: StoreDependency
) -> CharacteristicsResponse:
    _own_child(store, teacher.teacher_id, child_id)
    updated_at = store.set_characteristics(child_id, body.text)
    return CharacteristicsResponse(child_id=child_id, text=body.text, updated_at=updated_at)


# --- child details / delete -----------------------------------------------------------------------
@profile_router.get(
    "/children/{child_id}/details",
    response_model=ChildDetailsResponse,
    summary="아동 성별·생년월일·반 조회",
)
def get_child_details(child_id: str, teacher: CurrentTeacher, store: StoreDependency) -> ChildDetailsResponse:
    _own_child(store, teacher.teacher_id, child_id)
    return ChildDetailsResponse(child_id=child_id, **store.get_details(child_id))


@profile_router.patch(
    "/children/{child_id}/details",
    response_model=ChildDetailsResponse,
    summary="아동 성별·생년월일·반 수정",
    description="보낸 필드만 바꿉니다. null을 보내면 해당 값을 지웁니다.",
)
def patch_child_details(
    child_id: str, body: ChildDetailsPatch, teacher: CurrentTeacher, store: StoreDependency
) -> ChildDetailsResponse:
    _own_child(store, teacher.teacher_id, child_id)
    changes = body.model_dump(include=body.model_fields_set)
    if "birth_date" in changes and changes["birth_date"] is not None:
        changes["birth_date"] = changes["birth_date"].isoformat()
    classroom_id = changes.get("classroom_id")
    if classroom_id is not None and store.get_classroom(teacher.teacher_id, classroom_id) is None:
        raise ApiError(status_code=404, code="NOT_FOUND", message="반을 찾을 수 없습니다.")
    return ChildDetailsResponse(child_id=child_id, **store.update_details(child_id, changes))


@profile_router.delete(
    "/children/{child_id}",
    status_code=204,
    summary="아동 삭제(명단에서 제외)",
    description="명단에서 숨기고 기존 알림장·관찰일지는 그대로 유지합니다. 반복 요청도 204입니다.",
)
async def delete_child(child_id: str, teacher: CurrentTeacher, request: Request) -> Response:
    await request.app.state.children_service.deactivate(teacher=teacher, child_id=child_id)
    return Response(status_code=204)


# --- teacher documents ----------------------------------------------------------------------------------
@profile_router.get(
    "/teacher/documents/{kind}",
    response_model=DocumentResponse,
    summary="교사 문서 조회",
    description="writing_examples는 글쓰기 예시이며, record_format은 관찰일지 Word 양식의 칸을 채울 때 참고하는 규칙입니다.",
)
def get_document(kind: DocumentKind, teacher: CurrentTeacher, store: StoreDependency) -> DocumentResponse:
    text, updated_at = store.get_document(teacher.teacher_id, kind)
    return DocumentResponse(kind=kind, text=text, updated_at=updated_at)


@profile_router.put(
    "/teacher/documents/{kind}",
    response_model=DocumentResponse,
    summary="교사 문서 저장",
)
def put_document(kind: DocumentKind, body: TextBody, teacher: CurrentTeacher, store: StoreDependency) -> DocumentResponse:
    updated_at = store.set_document(teacher.teacher_id, kind, body.text)
    return DocumentResponse(kind=kind, text=body.text, updated_at=updated_at)


# --- classrooms --------------------------------------------------------------------------------------------
@profile_router.get(
    "/classrooms",
    response_model=ClassroomListResponse,
    summary="내 반 목록",
    description="반이 하나도 없으면 '우리 반'을 만들어 돌려줍니다. 연령(age_label)은 교사가 입력합니다.",
)
def list_classrooms(teacher: CurrentTeacher, store: StoreDependency) -> ClassroomListResponse:
    store.default_classroom(teacher.teacher_id)
    return ClassroomListResponse(items=[_classroom_response(row) for row in store.list_classrooms(teacher.teacher_id)])


@profile_router.post("/classrooms", status_code=201, response_model=ClassroomResponse, summary="반 추가")
def create_classroom(body: ClassroomBody, teacher: CurrentTeacher, store: StoreDependency) -> ClassroomResponse:
    return _classroom_response(store.create_classroom(teacher.teacher_id, body.name, body.age_label))


@profile_router.patch("/classrooms/{classroom_id}", response_model=ClassroomResponse, summary="반 이름·연령 수정")
def patch_classroom(
    classroom_id: str, body: ClassroomPatch, teacher: CurrentTeacher, store: StoreDependency
) -> ClassroomResponse:
    row = store.update_classroom(teacher.teacher_id, classroom_id, body.model_dump(exclude_unset=True))
    if row is None:
        raise ApiError(status_code=404, code="NOT_FOUND", message="반을 찾을 수 없습니다.")
    return _classroom_response(row)
