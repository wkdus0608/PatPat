from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client


def test_health_returns_ok(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_unimplemented_get_returns_common_501_error(client: TestClient) -> None:
    response = client.get("/api/v1/children")

    assert response.status_code == 501
    assert response.json() == {
        "error": {
            "code": "NOT_IMPLEMENTED",
            "message": "이 기능은 아직 구현되지 않았습니다.",
            "details": {"path": "/api/v1/children"},
        }
    }


def test_unimplemented_post_returns_common_501_error(client: TestClient) -> None:
    response = client.post("/api/v1/recordings", json={"example": "request"})

    assert response.status_code == 501
    assert response.json()["error"]["code"] == "NOT_IMPLEMENTED"


def test_unknown_non_api_path_returns_common_404_error(client: TestClient) -> None:
    response = client.get("/missing")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


def test_openapi_documents_health_and_shared_error_schema(
    client: TestClient,
) -> None:
    response = client.get("/openapi.json")
    schema = response.json()

    assert response.status_code == 200
    health = schema["paths"]["/health"]["get"]
    assert health["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/HealthResponse"
    }
    assert health["responses"]["500"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/ErrorResponse"
    }
    assert "/api/v1/{path}" not in schema["paths"]
