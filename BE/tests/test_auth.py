"""Auth HTTP contracts using a stub; no real account/token verification."""

from collections.abc import Iterator

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.auth.dependencies import (
    CurrentTeacher,
    get_auth_service,
    require_teacher_ownership,
)
from app.auth.models import LoginCredentials, LoginResult, TeacherContext
from app.auth.service import InvalidAccessToken, InvalidCredentials
from app.main import create_app


TEACHER_1 = TeacherContext(teacher_id="teacher-test-01", display_name="테스트 교사 1")
TEACHER_2 = TeacherContext(teacher_id="teacher-test-02", display_name="테스트 교사 2")
LOGIN_DATA = {"login_id": "teacher_test_01", "password": "contract-only-password"}


class StubAuthService:
    def __init__(self) -> None:
        self.login_calls: list[LoginCredentials] = []
        self.authenticate_calls: list[str] = []

    async def login(self, credentials: LoginCredentials) -> LoginResult:
        self.login_calls.append(credentials)
        if (
            credentials.login_id != LOGIN_DATA["login_id"]
            or credentials.password != LOGIN_DATA["password"]
        ):
            raise InvalidCredentials
        return LoginResult(
            access_token="contract-token-01", expires_in=3600, teacher=TEACHER_1
        )

    async def authenticate(self, access_token: str) -> TeacherContext:
        self.authenticate_calls.append(access_token)
        teachers = {"contract-token-01": TEACHER_1, "contract-token-02": TEACHER_2}
        if access_token not in teachers:
            raise InvalidAccessToken
        return teachers[access_token]


@pytest.fixture
def application() -> FastAPI:
    return create_app()


@pytest.fixture
def stub() -> StubAuthService:
    return StubAuthService()


@pytest.fixture
def client(application: FastAPI, stub: StubAuthService) -> Iterator[TestClient]:
    application.dependency_overrides[get_auth_service] = lambda: stub
    with TestClient(application) as test_client:
        yield test_client


def test_default_service_keeps_login_and_token_verification_unimplemented() -> None:
    with TestClient(create_app()) as client:
        login = client.post("/api/v1/auth/login", json=LOGIN_DATA)
        me = client.get(
            "/api/v1/auth/me", headers={"Authorization": "Bearer arbitrary-token"}
        )

    for response, operation in [(login, "login"), (me, "authenticate")]:
        assert response.status_code == 501
        assert response.json()["error"] == {
            "code": "NOT_IMPLEMENTED",
            "message": "테스트 계정 인증 서비스가 아직 연결되지 않았습니다.",
            "details": {"feature": "BE-01", "operation": operation},
        }
        assert response.headers["cache-control"] == "no-store"
        assert LOGIN_DATA["password"] not in response.text
        assert "arbitrary-token" not in response.text


def test_login_passes_credentials_to_service_and_returns_token_contract(
    client: TestClient, stub: StubAuthService
) -> None:
    response = client.post("/api/v1/auth/login", json=LOGIN_DATA)

    assert response.status_code == 200
    assert response.json() == {
        "access_token": "contract-token-01",
        "token_type": "bearer",
        "expires_in": 3600,
        "teacher": {
            "teacher_id": TEACHER_1.teacher_id,
            "display_name": TEACHER_1.display_name,
        },
    }
    assert response.headers["cache-control"] == "no-store"
    assert len(stub.login_calls) == 1
    assert stub.login_calls[0].login_id == LOGIN_DATA["login_id"]
    assert stub.login_calls[0].password == LOGIN_DATA["password"]
    assert LOGIN_DATA["password"] not in repr(stub.login_calls[0])


def test_invalid_credentials_return_generic_error_without_echoing_password(
    client: TestClient,
) -> None:
    response = client.post(
        "/api/v1/auth/login",
        json={"login_id": "unknown_test_account", "password": "wrong-test-password"},
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "INVALID_CREDENTIALS"
    assert response.headers["www-authenticate"] == "Bearer"
    assert response.headers["cache-control"] == "no-store"
    assert "wrong-test-password" not in response.text
    assert "unknown_test_account" not in response.text


@pytest.mark.parametrize(
    "body",
    [
        {},
        {**LOGIN_DATA, "login_id": ""},
        {**LOGIN_DATA, "password": ""},
        {**LOGIN_DATA, "login_id": 123},
        {**LOGIN_DATA, "password": 123},
        {**LOGIN_DATA, "teacher_id": TEACHER_2.teacher_id},
    ],
)
def test_invalid_login_input_never_reaches_auth_service(
    client: TestClient, stub: StubAuthService, body: dict
) -> None:
    response = client.post("/api/v1/auth/login", json=body)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert LOGIN_DATA["password"] not in response.text
    assert stub.login_calls == []


@pytest.mark.parametrize(
    "authorization",
    [None, "", "Basic dGVzdDp0ZXN0", "Bearer", "Bearer    ", "Bearer two tokens"],
)
def test_missing_or_malformed_bearer_header_returns_401(
    client: TestClient, stub: StubAuthService, authorization: str | None
) -> None:
    headers = {} if authorization is None else {"Authorization": authorization}
    response = client.get("/api/v1/auth/me", headers=headers)

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "UNAUTHENTICATED"
    assert response.headers["www-authenticate"] == "Bearer"
    assert response.headers["cache-control"] == "no-store"
    assert stub.authenticate_calls == []


def test_service_token_rejection_returns_401(client: TestClient) -> None:
    response = client.get(
        "/api/v1/auth/me", headers={"Authorization": "Bearer rejected-test-token"}
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "INVALID_TOKEN"
    assert response.headers["www-authenticate"] == "Bearer"
    assert response.headers["cache-control"] == "no-store"
    assert "rejected-test-token" not in response.text


def test_me_uses_authenticated_teacher_despite_spoofed_query(
    client: TestClient, stub: StubAuthService
) -> None:
    response = client.get(
        "/api/v1/auth/me",
        params={"teacher_id": TEACHER_2.teacher_id},
        headers={"Authorization": "Bearer contract-token-01"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "teacher_id": TEACHER_1.teacher_id,
        "display_name": TEACHER_1.display_name,
    }
    assert response.headers["cache-control"] == "no-store"
    assert stub.authenticate_calls == ["contract-token-01"]


def test_resource_boundary_allows_owner_and_hides_other_teacher_resource(
    application: FastAPI, client: TestClient
) -> None:
    # This route exists only in this isolated test application.
    @application.get("/__tests__/resources/{resource_id}")
    async def get_resource(resource_id: str, teacher: CurrentTeacher) -> dict:
        owners = {"resource-01": TEACHER_1.teacher_id, "resource-02": TEACHER_2.teacher_id}
        require_teacher_ownership(owner_teacher_id=owners[resource_id], teacher=teacher)
        return {"resource_id": resource_id, "teacher_id": teacher.teacher_id}

    own = client.get(
        "/__tests__/resources/resource-01",
        headers={"Authorization": "Bearer contract-token-01"},
    )
    other = client.get(
        "/__tests__/resources/resource-01",
        params={"teacher_id": TEACHER_1.teacher_id},
        headers={"Authorization": "Bearer contract-token-02"},
    )
    second_owner = client.get(
        "/__tests__/resources/resource-02",
        headers={"Authorization": "Bearer contract-token-02"},
    )

    assert own.status_code == 200
    assert own.json()["teacher_id"] == TEACHER_1.teacher_id
    assert other.status_code == 404
    assert other.json()["error"]["code"] == "NOT_FOUND"
    assert TEACHER_1.teacher_id not in other.text
    assert second_owner.status_code == 200
    assert second_owner.json()["teacher_id"] == TEACHER_2.teacher_id


def test_http_exception_handler_preserves_authentication_header(
    application: FastAPI, client: TestClient
) -> None:
    @application.get("/__tests__/http-auth-error")
    async def http_auth_error() -> None:
        raise HTTPException(status_code=401, headers={"WWW-Authenticate": "Bearer"})

    response = client.get("/__tests__/http-auth-error")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "UNAUTHENTICATED"
    assert response.headers["www-authenticate"] == "Bearer"


def test_openapi_auth_contract_distinguishes_public_and_protected_routes(
    client: TestClient,
) -> None:
    schema = client.get("/openapi.json").json()
    login = schema["paths"]["/api/v1/auth/login"]["post"]
    me = schema["paths"]["/api/v1/auth/me"]["get"]

    assert not login.get("security")
    assert me["security"] == [{"TeacherBearer": []}]
    assert schema["components"]["securitySchemes"]["TeacherBearer"] == {
        "type": "http",
        "description": "테스트 계정 로그인에서 발급받은 접근 토큰",
        "scheme": "bearer",
    }
    request = schema["components"]["schemas"]["LoginRequest"]
    assert request["additionalProperties"] is False
    assert request["properties"]["password"]["writeOnly"] is True
    for operation in [login, me]:
        for code in ["401", "501"]:
            assert operation["responses"][code]["content"]["application/json"]["schema"] == {
                "$ref": "#/components/schemas/ErrorResponse"
            }
