"""Recording HTTP contracts; stub audio is not actual recorded speech."""
from collections.abc import Iterator
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient

from app.auth.dependencies import get_current_teacher
from app.auth.models import TeacherContext
from app.core.errors import ApiError
from app.core.exception_handlers import api_error_handler, validation_error_handler
from app.recordings.dependencies import get_recording_service
from app.recordings.models import Recording, RecordingAudio, RecordingPage, RecordingStatus, RecordingUpload
from app.recordings.router import recordings_router


TEACHER = TeacherContext("teacher-test-01", "테스트 교사")
NOW = datetime(2026, 11, 2, tzinfo=timezone.utc)
FORM = {"title": "가상 녹음", "recorded_at": NOW.isoformat(), "duration_seconds": "5.5"}
AUDIO = b"fictional-audio-contract-bytes"


def record(owner: str = TEACHER.teacher_id) -> Recording:
    return Recording(
        recording_id="recording-test-01", teacher_id=owner, title="가상 녹음",
        recorded_at=NOW, duration_seconds=5.5, size_bytes=len(AUDIO),
        content_type="audio/mp4", status=RecordingStatus.QUEUED, created_at=NOW,
    )


class StubRecordingService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []
        self.uploaded_bytes: bytes | None = None
        self.other_owner = False

    async def upload(self, *, teacher: TeacherContext, upload: RecordingUpload) -> Recording:
        self.calls.append(("upload", teacher.teacher_id))
        self.uploaded_bytes = upload.stream.read()
        return record()

    async def list(self, *, teacher: TeacherContext, query) -> RecordingPage:
        self.calls.append(("list", teacher.teacher_id))
        return RecordingPage((record("other-teacher" if self.other_owner else teacher.teacher_id),), 1)

    async def get(self, *, teacher: TeacherContext, recording_id: str) -> Recording:
        self.calls.append(("get", teacher.teacher_id))
        return record("other-teacher" if self.other_owner else teacher.teacher_id)

    async def open_audio(self, *, teacher: TeacherContext, recording_id: str) -> RecordingAudio:
        self.calls.append(("open_audio", teacher.teacher_id))
        async def chunks():
            yield AUDIO
        return RecordingAudio(
            teacher_id="other-teacher" if self.other_owner else teacher.teacher_id,
            content_type="audio/mp4", size_bytes=len(AUDIO), chunks=chunks(),
        )

    async def delete(self, *, teacher: TeacherContext, recording_id: str) -> None:
        self.calls.append(("delete", teacher.teacher_id))
        if self.other_owner:
            raise ApiError(status_code=404, code="NOT_FOUND", message="자료를 찾을 수 없습니다.")


@pytest.fixture
def application() -> FastAPI:
    app = FastAPI()
    app.add_exception_handler(ApiError, api_error_handler)
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    app.include_router(recordings_router, prefix="/api/v1")
    return app


@pytest.fixture
def stub() -> StubRecordingService:
    return StubRecordingService()


@pytest.fixture
def client(application: FastAPI, stub: StubRecordingService) -> Iterator[TestClient]:
    application.dependency_overrides[get_current_teacher] = lambda: TEACHER
    application.dependency_overrides[get_recording_service] = lambda: stub
    with TestClient(application) as client:
        yield client


def upload(client: TestClient, data: dict | None = None, mime: str = "audio/mp4"):
    return client.post(
        "/api/v1/recordings", data=FORM if data is None else data,
        files={"file": ("virtual.m4a", AUDIO, mime)},
    )


def test_upload_passes_stream_and_authenticated_owner(client: TestClient, stub: StubRecordingService) -> None:
    response = upload(client)
    assert response.status_code == 201
    assert response.json()["recording_id"] == "recording-test-01"
    assert response.json()["status"] == "대기"
    assert "teacher_id" not in response.json()
    assert "storage_key" not in response.json()
    assert stub.uploaded_bytes == AUDIO
    assert stub.calls == [("upload", TEACHER.teacher_id)]


@pytest.mark.parametrize("data", [
    {**FORM, "title": "   "}, {**FORM, "duration_seconds": "0"},
    {**FORM, "duration_seconds": "nan"}, {**FORM, "duration_seconds": "inf"},
    {**FORM, "recorded_at": "2026-11-02T09:00:00"},
    {**FORM, "teacher_id": "another-teacher"},
    {**FORM, "path": "/private/arbitrary"},
])
def test_invalid_upload_metadata_does_not_reach_service(client: TestClient, stub: StubRecordingService, data: dict) -> None:
    response = upload(client, data)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert stub.calls == []


def test_declared_non_audio_type_is_rejected(client: TestClient, stub: StubRecordingService) -> None:
    response = upload(client, mime="image/jpeg")
    assert response.status_code == 415
    assert response.json()["error"]["code"] == "UNSUPPORTED_AUDIO_TYPE"
    assert stub.calls == []


@pytest.mark.parametrize("path", ["", "/recording-test-01", "/recording-test-01/audio"])
def test_recording_routes_require_authentication(application: FastAPI, path: str) -> None:
    with TestClient(application) as client:
        response = client.get("/api/v1/recordings" + path)
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


@pytest.mark.parametrize("method,path", [
    ("GET", ""), ("GET", "/recording-test-01"),
    ("GET", "/recording-test-01/audio"), ("DELETE", "/recording-test-01"),
])
def test_unconnected_service_returns_501(application: FastAPI, method: str, path: str) -> None:
    application.dependency_overrides[get_current_teacher] = lambda: TEACHER
    with TestClient(application) as client:
        response = client.request(method, "/api/v1/recordings" + path)
    assert response.status_code == 501
    assert response.json()["error"]["details"]["feature"] == "BE-03"


def test_default_upload_does_not_claim_storage_success(application: FastAPI) -> None:
    application.dependency_overrides[get_current_teacher] = lambda: TEACHER
    with TestClient(application) as client:
        response = upload(client)
    assert response.status_code == 501


def test_list_detail_playback_and_delete_contract(client: TestClient, stub: StubRecordingService) -> None:
    listed = client.get("/api/v1/recordings", params={"teacher_id": "other"})
    detail = client.get("/api/v1/recordings/recording-test-01")
    audio = client.get("/api/v1/recordings/recording-test-01/audio")
    deleted = client.delete("/api/v1/recordings/recording-test-01")
    assert listed.status_code == detail.status_code == audio.status_code == 200
    assert listed.json()["items"][0] == detail.json()
    assert audio.content == AUDIO
    assert audio.headers["content-type"] == "audio/mp4"
    assert audio.headers["cache-control"] == "private, no-store"
    assert deleted.status_code == 204
    assert deleted.content == b""
    assert stub.calls == [(op, TEACHER.teacher_id) for op in ["list", "get", "open_audio", "delete"]]


@pytest.mark.parametrize("method,path", [
    ("GET", ""), ("GET", "/recording-test-01"),
    ("GET", "/recording-test-01/audio"), ("DELETE", "/recording-test-01"),
])
def test_other_owner_resources_are_hidden(client: TestClient, stub: StubRecordingService, method: str, path: str) -> None:
    stub.other_owner = True
    response = client.request(method, "/api/v1/recordings" + path)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"
    assert "other-teacher" not in response.text


def test_openapi_documents_protected_upload_and_binary_playback(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()
    for path in ["/api/v1/recordings", "/api/v1/recordings/{recording_id}", "/api/v1/recordings/{recording_id}/audio"]:
        for method, operation in schema["paths"][path].items():
            assert operation["security"] == [{"TeacherBearer": []}]
            assert "501" in operation["responses"]
    operation = schema["paths"]["/api/v1/recordings"]["post"]
    assert "multipart/form-data" in operation["requestBody"]["content"]
    operation = schema["paths"]["/api/v1/recordings/{recording_id}/audio"]["get"]
    assert "audio/mp4" in operation["responses"]["200"]["content"]


def test_upload_requires_authentication(application: FastAPI) -> None:
    with TestClient(application) as client:
        response = upload(client)
    assert response.status_code == 401


def test_duplicate_form_values_are_rejected(client: TestClient, stub: StubRecordingService) -> None:
    response = upload(client, {**FORM, "title": ["first", "second"]})
    assert response.status_code == 422
    assert stub.calls == []


def test_empty_recording_list_is_valid(client: TestClient, stub: StubRecordingService) -> None:
    async def empty_list(*, teacher: TeacherContext, query):
        return RecordingPage((), 0)
    stub.list = empty_list
    response = client.get("/api/v1/recordings")
    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 0, "limit": 20, "offset": 0}
