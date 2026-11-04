from fastapi import APIRouter, Response, Depends
from typing import Annotated
from fastapi.security import HTTPAuthorizationCredentials

from app.api.common_responses import COMMON_ERROR_RESPONSES
from app.auth.dependencies import (
    AuthServiceDependency,
    CurrentTeacher,
    authentication_error,
    teacher_bearer,
)
from app.auth.models import LoginCredentials
from app.auth.schemas import LoginRequest, LoginResponse, TeacherResponse
from app.auth.service import InvalidCredentials


auth_router = APIRouter(prefix="/auth", tags=["auth"])


@auth_router.post(
    "/login",
    response_model=LoginResponse,
    summary="테스트 계정 로그인",
    description=(
        "사전 준비된 테스트 계정의 로그인 계약입니다. "
        "등록된 계정의 비밀번호를 검증하고 접근 토큰을 발급합니다."
    ),
    responses={
        status: COMMON_ERROR_RESPONSES[status] for status in (401, 422, 500, 501)
    },
)
async def login(
    body: LoginRequest, response: Response, service: AuthServiceDependency
) -> LoginResponse:
    try:
        result = await service.login(
            LoginCredentials(
                login_id=body.login_id, password=body.password.get_secret_value()
            )
        )
    except InvalidCredentials:
        raise authentication_error(
            code="INVALID_CREDENTIALS",
            message="계정 ID 또는 비밀번호를 확인해 주세요.",
        ) from None

    response.headers["Cache-Control"] = "no-store"
    return LoginResponse(
        access_token=result.access_token,
        expires_in=result.expires_in,
        teacher=TeacherResponse.model_validate(result.teacher),
    )


@auth_router.get(
    "/me",
    response_model=TeacherResponse,
    summary="내 교사 계정 조회",
    description=(
        "검증된 Bearer 토큰의 교사 정보를 반환합니다. "
        "만료·폐기·비활성 계정의 토큰은 거부합니다."
    ),
    responses={status: COMMON_ERROR_RESPONSES[status] for status in (401, 500, 501)},
)
async def get_me(teacher: CurrentTeacher, response: Response) -> TeacherResponse:
    response.headers["Cache-Control"] = "no-store"
    return TeacherResponse.model_validate(teacher)


@auth_router.post("/logout", status_code=204, response_class=Response,
                  summary="현재 기기 로그아웃", responses={status: COMMON_ERROR_RESPONSES[status] for status in (401, 500, 501)})
async def logout(
    teacher: CurrentTeacher,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(teacher_bearer)],
    service: AuthServiceDependency,
) -> Response:
    assert credentials is not None  # CurrentTeacher validated the same Bearer token.
    await service.logout(credentials.credentials)
    return Response(status_code=204, headers={"Cache-Control": "no-store"})
