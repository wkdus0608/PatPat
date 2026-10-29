from typing import Annotated

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.auth.models import TeacherContext
from app.auth.service import (
    AuthService,
    InvalidAccessToken,
    UnimplementedAuthService,
)
from app.core.errors import ApiError


teacher_bearer = HTTPBearer(
    scheme_name="TeacherBearer",
    description="테스트 계정 로그인에서 발급받은 접근 토큰",
    auto_error=False,
)


def get_auth_service() -> AuthService:
    return UnimplementedAuthService()


AuthServiceDependency = Annotated[AuthService, Depends(get_auth_service)]


def authentication_error(*, code: str, message: str) -> ApiError:
    return ApiError(
        status_code=401,
        code=code,
        message=message,
        headers={"WWW-Authenticate": "Bearer", "Cache-Control": "no-store"},
    )


async def get_current_teacher(
    credentials: Annotated[
        HTTPAuthorizationCredentials | None, Depends(teacher_bearer)
    ],
    service: AuthServiceDependency,
) -> TeacherContext:
    if credentials is None or any(
        character.isspace() for character in credentials.credentials
    ):
        raise authentication_error(
            code="UNAUTHENTICATED", message="Bearer 토큰 인증이 필요합니다."
        )

    try:
        return await service.authenticate(credentials.credentials)
    except InvalidAccessToken:
        raise authentication_error(
            code="INVALID_TOKEN", message="접근 토큰을 확인할 수 없습니다."
        ) from None


CurrentTeacher = Annotated[TeacherContext, Depends(get_current_teacher)]


def require_teacher_ownership(
    *, owner_teacher_id: str, teacher: TeacherContext
) -> None:
    """Hide other teachers' resources; queries must also use teacher.teacher_id."""
    if owner_teacher_id != teacher.teacher_id:
        raise ApiError(
            status_code=404,
            code="NOT_FOUND",
            message="요청한 리소스를 찾을 수 없습니다.",
        )
