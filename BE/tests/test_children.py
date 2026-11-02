"""Roster HTTP contracts with fake auth/storage; not database verification."""

from collections.abc import Iterator
from dataclasses import replace

import pytest
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient

from app.auth.dependencies import get_auth_service, require_teacher_ownership
from app.auth.models import TeacherContext
from app.auth.service import InvalidAccessToken
from app.children.dependencies import get_children_service
from app.children.models import Child
from app.children.router import children_router
from app.core.errors import ApiError
from app.core.exception_handlers import api_error_handler, validation_error_handler


TEACHER = TeacherContext("teacher-roster-01", "테스트 교사 1")
OTHER = TeacherContext("teacher-roster-02", "테스트 교사 2")
HEADERS = {"Authorization": "Bearer roster-token-01"}


class StubAuth:
    async def authenticate(self, access_token: str) -> TeacherContext:
        if access_token == "roster-token-01":
            return TEACHER
        if access_token == "roster-token-02":
            return OTHER
        raise InvalidAccessToken


class StubChildren:
    def __init__(self) -> None:
        self.children = {
            "C-DEMO-01": Child("C-DEMO-01", TEACHER.teacher_id, "가상 아동 A", True),
            "C-DEMO-02": Child("C-DEMO-02", TEACHER.teacher_id, "가상 아동 B", False),
            "C-OTHER-01": Child("C-OTHER-01", OTHER.teacher_id, "가상 아동 C", True),
        }
        self.calls: list[tuple] = []

    def _owned(self, teacher: TeacherContext, child_id: str) -> Child:
        child = self.children.get(child_id)
        if child is None:
            raise ApiError(status_code=404, code="NOT_FOUND", message="아동을 찾을 수 없습니다.")
        require_teacher_ownership(owner_teacher_id=child.teacher_id, teacher=teacher)
        return child

    async def list(self, *, teacher: TeacherContext, include_inactive: bool) -> list[Child]:
        self.calls.append(("list", teacher.teacher_id, include_inactive))
        return [
            child for child in self.children.values()
            if child.teacher_id == teacher.teacher_id and (include_inactive or child.is_active)
        ]

    async def create(self, *, teacher: TeacherContext, name: str) -> Child:
        self.calls.append(("create", teacher.teacher_id, name))
        child = Child("C-CREATED-DEMO", teacher.teacher_id, name, True)
        self.children[child.child_id] = child
        return child

    async def rename(self, *, teacher: TeacherContext, child_id: str, name: str) -> Child:
        self.calls.append(("rename", teacher.teacher_id, child_id, name))
        child = replace(self._owned(teacher, child_id), name=name)
        self.children[child_id] = child
        return child

    async def deactivate(self, *, teacher: TeacherContext, child_id: str) -> Child:
        self.calls.append(("deactivate", teacher.teacher_id, child_id))
        child = replace(self._owned(teacher, child_id), is_active=False)
        self.children[child_id] = child
        return child


@pytest.fixture
def application() -> FastAPI:
    # Mount only the feature under test; root-app integration is tested separately.
    app = FastAPI()
    app.add_exception_handler(ApiError, api_error_handler)
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    app.include_router(children_router, prefix="/api/v1")
    app.dependency_overrides[get_auth_service] = lambda: StubAuth()
    return app


@pytest.fixture
def stub() -> StubChildren:
    return StubChildren()


@pytest.fixture
def client(application: FastAPI, stub: StubChildren) -> Iterator[TestClient]:
    application.dependency_overrides[get_children_service] = lambda: stub
    with TestClient(application) as test_client:
        yield test_client


@pytest.mark.parametrize("method,path,body,operation", [
    ("GET", "/api/v1/children", None, "list"),
    ("POST", "/api/v1/children", {"name": "가상 아동"}, "create"),
    ("PATCH", "/api/v1/children/C-DEMO-01", {"name": "가상 새 이름"}, "rename"),
    ("POST", "/api/v1/children/C-DEMO-01/deactivate", None, "deactivate"),
])
def test_default_roster_service_is_explicitly_unimplemented(
    application: FastAPI, method: str, path: str, body: dict | None, operation: str
) -> None:
    with TestClient(application) as client:
        response = client.request(method, path, json=body, headers=HEADERS)
    assert response.status_code == 501
    assert response.json()["error"]["details"] == {"feature": "BE-02", "operation": operation}


@pytest.mark.parametrize("method,path,body", [
    ("GET", "/api/v1/children", None),
    ("POST", "/api/v1/children", {"name": "가상 아동"}),
    ("PATCH", "/api/v1/children/C-DEMO-01", {"name": "가상 새 이름"}),
    ("POST", "/api/v1/children/C-DEMO-01/deactivate", None),
])
def test_all_roster_operations_require_authentication(
    client: TestClient, stub: StubChildren, method: str, path: str, body: dict | None
) -> None:
    response = client.request(method, path, json=body)
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert stub.calls == []


def test_list_scopes_teacher_and_supports_inactive_filter(client: TestClient, stub: StubChildren) -> None:
    active = client.get("/api/v1/children", headers=HEADERS, params={"teacher_id": OTHER.teacher_id})
    all_children = client.get("/api/v1/children?include_inactive=true", headers=HEADERS)
    assert active.status_code == 200
    assert active.json() == {"items": [{"child_id": "C-DEMO-01", "name": "가상 아동 A", "is_active": True}]}
    assert {child["child_id"] for child in all_children.json()["items"]} == {"C-DEMO-01", "C-DEMO-02"}
    assert stub.calls == [("list", TEACHER.teacher_id, False), ("list", TEACHER.teacher_id, True)]


def test_empty_roster_returns_empty_items(client: TestClient, stub: StubChildren) -> None:
    stub.children.clear()
    response = client.get("/api/v1/children", headers=HEADERS)
    assert response.status_code == 200
    assert response.json() == {"items": []}


def test_invalid_filter_never_reaches_service(client: TestClient, stub: StubChildren) -> None:
    response = client.get("/api/v1/children?include_inactive=maybe", headers=HEADERS)
    assert response.status_code == 422
    assert stub.calls == []


@pytest.mark.parametrize("method,path", [
    ("POST", "/api/v1/children"),
    ("PATCH", "/api/v1/children/C-DEMO-01"),
])
@pytest.mark.parametrize("body", [
    {}, {"name": ""}, {"name": "   "}, {"name": 7},
    {"name": "가상 아동", "teacher_id": OTHER.teacher_id},
    {"name": "가상 아동", "child_id": "FORGED"},
])
def test_invalid_or_owner_injecting_body_is_rejected(
    client: TestClient, stub: StubChildren, method: str, path: str, body: dict
) -> None:
    response = client.request(method, path, json=body, headers=HEADERS)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert stub.calls == []


def test_create_uses_authenticated_owner(client: TestClient, stub: StubChildren) -> None:
    response = client.post("/api/v1/children", json={"name": "가상 새 아동"}, headers=HEADERS)
    assert response.status_code == 201
    assert response.json() == {"child_id": "C-CREATED-DEMO", "name": "가상 새 아동", "is_active": True}
    assert stub.calls == [("create", TEACHER.teacher_id, "가상 새 아동")]


def test_rename_and_repeated_deactivation_preserve_stable_id(client: TestClient) -> None:
    renamed = client.patch("/api/v1/children/C-DEMO-01", json={"name": "가상 변경 이름"}, headers=HEADERS)
    first = client.post("/api/v1/children/C-DEMO-01/deactivate", headers=HEADERS)
    repeated = client.post("/api/v1/children/C-DEMO-01/deactivate", headers=HEADERS)
    assert renamed.status_code == first.status_code == repeated.status_code == 200
    assert renamed.json() == {"child_id": "C-DEMO-01", "name": "가상 변경 이름", "is_active": True}
    assert first.json() == repeated.json() == {"child_id": "C-DEMO-01", "name": "가상 변경 이름", "is_active": False}


@pytest.mark.parametrize("method,path,body", [
    ("PATCH", "/api/v1/children/C-OTHER-01", {"name": "가상 이름"}),
    ("POST", "/api/v1/children/C-OTHER-01/deactivate", None),
    ("PATCH", "/api/v1/children/UNKNOWN", {"name": "가상 이름"}),
])
def test_other_owner_or_missing_children_return_404(
    client: TestClient, stub: StubChildren, method: str, path: str, body: dict | None
) -> None:
    before = stub.children["C-OTHER-01"]
    response = client.request(method, path, json=body, headers=HEADERS)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"
    assert "가상 아동 C" not in response.text
    assert stub.children["C-OTHER-01"] == before


def test_response_boundary_rejects_foreign_rows_from_misconfigured_service(
    client: TestClient, stub: StubChildren
) -> None:
    async def foreign_list(**kwargs) -> list[Child]:
        return [stub.children["C-OTHER-01"]]
    stub.list = foreign_list
    response = client.get("/api/v1/children", headers=HEADERS)
    assert response.status_code == 404
    assert "가상 아동 C" not in response.text


def test_openapi_defines_authenticated_roster_contract(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()
    create = schema["paths"]["/api/v1/children"]["post"]
    assert "201" in create["responses"]
    for path, methods in schema["paths"].items():
        for operation in methods.values():
            assert operation["security"] == [{"TeacherBearer": []}]
            for status in ("401", "404", "422", "501"):
                assert operation["responses"][status]["content"]["application/json"]["schema"] == {"$ref": "#/components/schemas/ErrorResponse"}
