from typing import NoReturn, Protocol

from app.auth.models import LoginCredentials, LoginResult, TeacherContext
from app.core.errors import ApiError


class InvalidCredentials(Exception):
    """Unknown account, wrong password, or inactive account at login."""


class InvalidAccessToken(Exception):
    """Unknown, expired, tampered token, or an unavailable teacher account."""


class AuthService(Protocol):
    async def login(self, credentials: LoginCredentials) -> LoginResult:
        """Verify a test account or raise InvalidCredentials."""
        ...

    async def authenticate(self, access_token: str) -> TeacherContext:
        """Verify token validity and account state or raise InvalidAccessToken."""
        ...


class UnimplementedAuthService:
    """Explicit placeholder until account storage and token handling are built."""

    async def login(self, credentials: LoginCredentials) -> LoginResult:
        self._not_implemented("login")

    async def authenticate(self, access_token: str) -> TeacherContext:
        self._not_implemented("authenticate")

    @staticmethod
    def _not_implemented(operation: str) -> NoReturn:
        raise ApiError(
            status_code=501,
            code="NOT_IMPLEMENTED",
            message="테스트 계정 인증 서비스가 아직 연결되지 않았습니다.",
            details={"feature": "BE-01", "operation": operation},
            headers={"Cache-Control": "no-store"},
        )
