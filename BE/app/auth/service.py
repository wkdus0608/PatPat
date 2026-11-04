from typing import NoReturn, Protocol
from asyncio import to_thread
import secrets
import time

from app.auth.models import LoginCredentials, LoginResult, TeacherContext
from app.core.errors import ApiError
from app.auth.repository import AuthRepository
from app.auth.security import dummy_hash, token_digest, verify_password


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

    async def logout(self, access_token: str) -> None: ...


class SQLiteAuthService:
    def __init__(self, repository: AuthRepository, ttl_seconds: int):
        if ttl_seconds <= 0:
            raise ValueError("세션 유효기간은 양수여야 합니다.")
        self.repository = repository
        self.ttl_seconds = ttl_seconds

    async def login(self, credentials: LoginCredentials) -> LoginResult:
        account = await self.repository.get_by_login_id(credentials.login_id)
        valid = await to_thread(verify_password, account.password_hash if account else dummy_hash, credentials.password)
        if not valid or account is None or not account.is_active:
            raise InvalidCredentials
        token = secrets.token_urlsafe(32)
        await self.repository.save_session(token_digest(token), account.teacher.teacher_id,
                                           int(time.time()) + self.ttl_seconds)
        return LoginResult(token, self.ttl_seconds, account.teacher)

    async def authenticate(self, access_token: str) -> TeacherContext:
        teacher = await self.repository.session_teacher(token_digest(access_token), int(time.time()))
        if teacher is None:
            raise InvalidAccessToken
        return teacher

    async def logout(self, access_token: str) -> None:
        await self.repository.revoke_session(token_digest(access_token))


class UnimplementedAuthService:
    """Fallback for isolated routers without application services."""

    async def login(self, credentials: LoginCredentials) -> LoginResult:
        self._not_implemented("login")

    async def authenticate(self, access_token: str) -> TeacherContext:
        self._not_implemented("authenticate")

    async def logout(self, access_token: str) -> None:
        self._not_implemented("logout")

    @staticmethod
    def _not_implemented(operation: str) -> NoReturn:
        raise ApiError(
            status_code=501,
            code="NOT_IMPLEMENTED",
            message="테스트 계정 인증 서비스가 아직 연결되지 않았습니다.",
            details={"feature": "BE-01", "operation": operation},
            headers={"Cache-Control": "no-store"},
        )
