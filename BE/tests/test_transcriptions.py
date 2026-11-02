"""STT contracts only: injected in-memory doubles make no external calls."""
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.auth.dependencies import get_auth_service
from app.auth.models import TeacherContext
from app.auth.service import InvalidAccessToken
from app.core.errors import ApiError
from app.core.jobs import JobStatus
from app.main import create_app
from app.recordings.models import RecordingReference, RecordingStatus
from app.transcriptions.dependencies import get_transcription_service
from app.transcriptions.models import FailureStage, TranscriptionFailure, TranscriptionJob
from app.transcriptions.schemas import TranscriptionResponse
from app.transcriptions.service import ensure_transcription_allowed

TEACHER = TeacherContext("teacher-test-01", "테스트 교사")
HEADERS = {"Authorization": "Bearer contract-token"}


class StubAuth:
    async def authenticate(self, access_token):
        if access_token != "contract-token":
            raise InvalidAccessToken
        return TEACHER


class StubTranscriptions:
    def __init__(self):
        self.recordings = {
            "ready": RecordingReference("ready", TEACHER.teacher_id, RecordingStatus.QUEUED),
            "retry": RecordingReference("retry", TEACHER.teacher_id, RecordingStatus.FAILED),
            "busy": RecordingReference("busy", TEACHER.teacher_id, RecordingStatus.TRANSCRIBING),
            "done": RecordingReference("done", TEACHER.teacher_id, RecordingStatus.COMPLETED),
            "deleted": RecordingReference("deleted", TEACHER.teacher_id, RecordingStatus.QUEUED, True),
            "other": RecordingReference("other", "teacher-test-02", RecordingStatus.QUEUED),
        }
        self.jobs = {
            "old-failure": TranscriptionJob("old-failure", "retry", TEACHER.teacher_id,
                JobStatus.FAILED, failure=TranscriptionFailure(FailureStage.STT,"STT_UNAVAILABLE",True)),
            "complete": TranscriptionJob("complete", "done", TEACHER.teacher_id,
                JobStatus.COMPLETED, text="가상 전사문", observation_ids=("observation-test-01",)),
        }
        self.calls = []

    def recording(self, recording_id, teacher):
        recording = self.recordings.get(recording_id)
        if recording is None or recording.is_deleted or recording.teacher_id != teacher.teacher_id:
            raise ApiError(status_code=404, code="NOT_FOUND", message="녹음을 찾을 수 없습니다.")
        return recording

    async def request(self, *, teacher, recording_id):
        self.calls.append(teacher.teacher_id)
        recording = self.recording(recording_id, teacher)
        ensure_transcription_allowed(recording=recording, teacher=teacher)
        job = TranscriptionJob(f"new-job-{len(self.jobs)}",recording_id,teacher.teacher_id,JobStatus.QUEUED)
        self.jobs[job.job_id] = job
        self.recordings[recording_id] = replace(recording, status=RecordingStatus.TRANSCRIBING)
        return job

    async def get(self, *, teacher, job_id):
        job = self.jobs.get(job_id)
        if job is None:
            raise ApiError(status_code=404, code="NOT_FOUND", message="작업을 찾을 수 없습니다.")
        self.recording(job.recording_id, teacher)
        return job

    async def latest(self, *, teacher, recording_id):
        self.recording(recording_id, teacher)
        jobs = [job for job in self.jobs.values() if job.recording_id == recording_id]
        if not jobs:
            raise ApiError(status_code=404, code="NOT_FOUND", message="작업을 찾을 수 없습니다.")
        return jobs[-1]


@pytest.fixture
def setup_client():
    app = create_app()
    stub = StubTranscriptions()
    app.dependency_overrides[get_auth_service] = lambda: StubAuth()
    app.dependency_overrides[get_transcription_service] = lambda: stub
    with TestClient(app) as client:
        yield client, stub, app


@pytest.mark.parametrize("method,path",[
    ("post","/api/v1/recordings/ready/transcriptions"),
    ("get","/api/v1/transcription-jobs/complete"),
    ("get","/api/v1/recordings/done/transcriptions/latest"),
])
def test_all_stt_routes_require_auth_and_default_to_501(method,path):
    app=create_app()
    with TestClient(app) as client:
        assert getattr(client,method)(path).status_code == 401
        app.dependency_overrides[get_auth_service]=lambda: StubAuth()
        response=getattr(client,method)(path,headers=HEADERS)
        assert response.status_code == 501
        assert response.json()["error"]["details"]["feature"] == "BE-04"


def test_request_accepts_job_and_scopes_owner(setup_client):
    client,stub,_=setup_client
    response=client.post("/api/v1/recordings/ready/transcriptions",headers=HEADERS)
    assert response.status_code == 202
    data=response.json()
    assert data["status"] == "queued"
    assert data["recording_id"] == "ready"
    assert stub.calls == [TEACHER.teacher_id]
    assert stub.recordings["ready"].status == RecordingStatus.TRANSCRIBING
    assert client.post("/api/v1/recordings/ready/transcriptions",headers=HEADERS).status_code == 409


@pytest.mark.parametrize("body",[{"teacher_id":"teacher-test-02"},{"text":"untrusted text"}])
def test_request_rejects_extra_inputs(setup_client,body):
    client,stub,_=setup_client
    response=client.post("/api/v1/recordings/ready/transcriptions",headers=HEADERS,json=body)
    assert response.status_code == 422
    assert stub.calls == []


@pytest.mark.parametrize("recording_id,status",[
    ("busy",409),("done",409),("deleted",404),("other",404),("missing",404)
])
def test_request_rejects_ineligible_recordings(setup_client,recording_id,status):
    client,_,_=setup_client
    assert client.post(f"/api/v1/recordings/{recording_id}/transcriptions",headers=HEADERS).status_code == status


def test_failed_retry_keeps_previous_attempt_and_exposes_latest(setup_client):
    client,stub,_=setup_client
    old=stub.jobs["old-failure"]
    response=client.post("/api/v1/recordings/retry/transcriptions",headers=HEADERS,json={})
    assert response.status_code == 202
    assert response.json()["job_id"] != old.job_id
    assert stub.jobs[old.job_id] == old
    latest=client.get("/api/v1/recordings/retry/transcriptions/latest",headers=HEADERS)
    assert latest.json()["job_id"] == response.json()["job_id"]
    assert latest.json()["text"] is None
    previous=client.get("/api/v1/transcription-jobs/old-failure",headers=HEADERS)
    assert previous.json()["failure"] == {"stage":"stt","code":"STT_UNAVAILABLE","retryable":True}


def test_completed_result_and_deleted_recording_access(setup_client):
    client,stub,_=setup_client
    response=client.get("/api/v1/transcription-jobs/complete",headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["text"] == "가상 전사문"
    assert response.json()["observation_ids"] == ["observation-test-01"]
    assert response.headers["cache-control"] == "no-store"
    stub.recordings["done"]=replace(stub.recordings["done"],is_deleted=True)
    assert client.get("/api/v1/transcription-jobs/complete",headers=HEADERS).status_code == 404
    assert client.get("/api/v1/recordings/done/transcriptions/latest",headers=HEADERS).status_code == 404


def test_router_defensively_rejects_other_owner_returned_by_service(setup_client):
    client,stub,_=setup_client
    stub.jobs["complete"]=replace(stub.jobs["complete"],teacher_id="teacher-test-02")
    response=client.get("/api/v1/transcription-jobs/complete",headers=HEADERS)
    assert response.status_code == 404
    assert "가상 전사문" not in response.text


@pytest.mark.parametrize("status,text,failure",[
    (JobStatus.COMPLETED,None,None),
    (JobStatus.QUEUED,"premature text",None),
    (JobStatus.FAILED,None,None),
    (JobStatus.RUNNING,None,{"stage":"stt","code":"ERROR","retryable":True}),
])
def test_result_schema_rejects_inconsistent_status(status,text,failure):
    with pytest.raises(ValidationError):
        TranscriptionResponse(job_id="job",recording_id="recording",status=status,text=text,failure=failure)


def test_openapi_integrates_all_features_and_bearer_security(setup_client):
    client,_,_=setup_client
    schema=client.get("/openapi.json").json()
    for path,method in [
        ("/api/v1/children","get"),
        ("/api/v1/recordings","post"),
        ("/api/v1/recordings/{recording_id}/transcriptions","post"),
        ("/api/v1/transcription-jobs/{job_id}","get"),
    ]:
        operation=schema["paths"][path][method]
        assert operation["security"] == [{"TeacherBearer":[]}]
        assert "501" in operation["responses"]
    assert "202" in schema["paths"]["/api/v1/recordings/{recording_id}/transcriptions"]["post"]["responses"]
