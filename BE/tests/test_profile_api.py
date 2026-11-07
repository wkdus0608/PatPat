"""B1: FE settings API (child characteristics, teacher documents, child delete) and classrooms."""
import pytest

import flow_helpers
from app.core.config import Settings
from app.main import create_app
from fastapi.testclient import TestClient


@pytest.fixture
def env(tmp_path):
    with flow_helpers.running_env(tmp_path) as environment:
        yield environment


def test_characteristics_roundtrip_preserves_whitespace_and_allows_clearing(env):
    (child_id,) = flow_helpers.add_children(env, ["가상 아동 A"])
    url = f"/api/v2/children/{child_id}/characteristics"
    first = env.client.get(url, headers=env.headers)
    assert first.status_code == 200
    assert first.headers["cache-control"] == "no-store"
    assert first.json() == {"child_id": child_id, "text": None, "updated_at": None}

    text = "  좋아하는 놀이: 낙엽\n\n  표현 방식: 짧은 말  \n"
    saved = env.client.put(url, headers=env.headers, json={"text": text})
    assert saved.status_code == 200 and saved.json()["text"] == text
    assert env.client.get(url, headers=env.headers).json()["text"] == text

    cleared = env.client.put(url, headers=env.headers, json={"text": ""})
    assert cleared.status_code == 200 and cleared.json()["text"] == ""
    assert env.client.get(url, headers=env.headers).json()["text"] == ""


def test_characteristics_validation_and_isolation(env):
    (child_id,) = flow_helpers.add_children(env, ["가상 아동 A"])
    url = f"/api/v2/children/{child_id}/characteristics"
    assert env.client.put(url, headers=env.headers, json={"text": "x", "extra": 1}).status_code == 422
    assert env.client.put(url, headers=env.headers, json={"text": 5}).status_code == 422
    assert env.client.put(url, headers=env.headers, json={"text": "가" * 20_001}).status_code == 422
    assert env.client.put(url, json={"text": "x"}).status_code == 401
    # Other teachers and unknown ids look the same: 404.
    assert env.client.get(url, headers=env.headers_b).status_code == 404
    assert env.client.put(url, headers=env.headers_b, json={"text": "침범"}).status_code == 404
    assert env.client.get("/api/v2/children/unknown/characteristics", headers=env.headers).status_code == 404
    assert env.client.get(url, headers=env.headers).json()["text"] is None


@pytest.mark.parametrize("kind", ["writing_examples", "record_format"])
def test_teacher_documents_roundtrip_and_per_teacher_isolation(env, kind):
    url = f"/api/v2/teacher/documents/{kind}"
    assert env.client.get(url, headers=env.headers).json() == {"kind": kind, "text": None, "updated_at": None}
    body = "예시 글\n\n둘째 단락  "
    assert env.client.put(url, headers=env.headers, json={"text": body}).json()["text"] == body
    assert env.client.get(url, headers=env.headers).json()["text"] == body
    assert env.client.get(url, headers=env.headers_b).json()["text"] is None
    env.client.put(url, headers=env.headers_b, json={"text": "B 교사 글"})
    assert env.client.get(url, headers=env.headers).json()["text"] == body


def test_unknown_document_kind_is_rejected(env):
    assert env.client.get("/api/v2/teacher/documents/other", headers=env.headers).status_code == 422
    assert env.client.put("/api/v2/teacher/documents/other", headers=env.headers, json={"text": "x"}).status_code == 422


def test_documents_and_characteristics_survive_restart(tmp_path):
    with flow_helpers.running_env(tmp_path) as env:
        (child_id,) = flow_helpers.add_children(env, ["가상 아동 A"])
        env.client.put(f"/api/v2/children/{child_id}/characteristics", headers=env.headers, json={"text": "저장 내용"})
        env.client.put("/api/v2/teacher/documents/writing_examples", headers=env.headers, json={"text": "내 글"})
        headers = env.headers
    restarted = create_app(Settings(database_path=str(tmp_path / "flow.sqlite3"), audio_path=str(tmp_path / "audio"), ai_provider="fake"))
    with TestClient(restarted) as client:
        assert client.get(f"/api/v2/children/{child_id}/characteristics", headers=headers).json()["text"] == "저장 내용"
        assert client.get("/api/v2/teacher/documents/writing_examples", headers=headers).json()["text"] == "내 글"


def test_delete_child_hides_from_roster_but_keeps_the_record(env):
    first, second = flow_helpers.add_children(env, ["가상 아동 A", "가상 아동 B"])
    env.client.put(f"/api/v2/children/{first}/characteristics", headers=env.headers, json={"text": "기록 유지"})
    for _ in range(2):  # idempotent
        assert env.client.delete(f"/api/v2/children/{first}", headers=env.headers).status_code == 204
    roster = env.client.get("/api/v1/children", headers=env.headers).json()["items"]
    assert [row["child_id"] for row in roster] == [second]
    everyone = env.client.get("/api/v1/children?include_inactive=true", headers=env.headers).json()["items"]
    assert [row["child_id"] for row in everyone] == [first, second]
    assert env.client.get(f"/api/v2/children/{first}/characteristics", headers=env.headers).json()["text"] == "기록 유지"
    assert env.client.delete(f"/api/v2/children/{second}", headers=env.headers_b).status_code == 404
    assert env.client.delete("/api/v2/children/unknown", headers=env.headers).status_code == 404


def test_cors_allows_put_for_web_preview(env):
    response = env.client.options(
        "/api/v2/teacher/documents/writing_examples",
        headers={"Origin": "http://localhost:8081", "Access-Control-Request-Method": "PUT",
                 "Access-Control-Request-Headers": "authorization,content-type"},
    )
    assert response.status_code == 200
    assert "PUT" in response.headers["access-control-allow-methods"]


def test_classrooms_default_age_band_and_details(env):
    first = env.client.get("/api/v2/classrooms", headers=env.headers).json()["items"]
    assert len(first) == 1 and first[0]["name"] == "우리 반" and first[0]["age_band"] is None
    classroom_id = first[0]["classroom_id"]
    assert env.client.get("/api/v2/classrooms", headers=env.headers).json()["items"] == first  # not duplicated

    patched = env.client.patch(f"/api/v2/classrooms/{classroom_id}", headers=env.headers, json={"age_label": "만 2세"})
    assert patched.json()["age_band"] == "2세"
    assert env.client.patch(f"/api/v2/classrooms/{classroom_id}", headers=env.headers_b, json={"age_label": "만 3세"}).status_code == 404

    created = env.client.post("/api/v2/classrooms", headers=env.headers, json={"name": "별님반", "age_label": "5세"})
    assert created.status_code == 201 and created.json()["age_band"] == "3-5세"

    (child_id,) = flow_helpers.add_children(env, ["가상 아동 A"])
    url = f"/api/v2/children/{child_id}/details"
    assert env.client.get(url, headers=env.headers).json() == {
        "child_id": child_id, "gender": None, "birth_date": None, "classroom_id": None}
    patched = env.client.patch(url, headers=env.headers, json={"gender": "여", "birth_date": "2024-05-12", "classroom_id": classroom_id})
    assert patched.json() == {"child_id": child_id, "gender": "여", "birth_date": "2024-05-12", "classroom_id": classroom_id}
    only_gender = env.client.patch(url, headers=env.headers, json={"gender": None})
    assert only_gender.json()["gender"] is None and only_gender.json()["birth_date"] == "2024-05-12"
    assert env.client.patch(url, headers=env.headers, json={"classroom_id": "unknown"}).status_code == 404
    assert env.client.patch(url, headers=env.headers, json={"birth_date": "아님"}).status_code == 422
    assert env.client.get(url, headers=env.headers_b).status_code == 404
