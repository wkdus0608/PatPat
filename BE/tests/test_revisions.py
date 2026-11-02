import pytest
from app.core.jobs import JobStatus
from app.writing.models import RevisionJob, WritingFailure


def request(env):
    response=env.client.post("/api/v1/records/J1/revisions",json={"instruction":"짧게 수정","expected_version":1},headers=env.headers)
    assert response.status_code == 202
    return response.json()["revision_id"]


def ready(env,revision_id):
    original=env.state.revisions[revision_id]
    data=original.model_dump()
    data.update(status=JobStatus.COMPLETED,candidate_text="  새 후보\n그대로  ",candidate=env.state.record.generated)
    env.state.revisions[revision_id]=RevisionJob.model_validate(data)


def test_candidate_is_separate_until_adopt_and_then_needs_confirmation(writing_setup):
    env=writing_setup;original=env.state.record
    revision_id=request(env)
    assert env.state.record == original
    ready(env,revision_id)
    response=env.client.get(f"/api/v1/records/J1/revisions/{revision_id}",headers=env.headers)
    assert response.json()["candidate_text"] == "  새 후보\n그대로  "
    assert env.state.record == original
    adopted=env.client.post(f"/api/v1/records/J1/revisions/{revision_id}/adopt",json={"expected_version":1},headers=env.headers)
    assert adopted.status_code == 200
    assert adopted.json()["edited_text"] == "  새 후보\n그대로  "
    assert adopted.json()["status"] == "검토중" and adopted.json()["confirmed_at"] is None
    assert env.state.history[-1].revision_id == revision_id
    assert env.client.post(f"/api/v1/records/J1/revisions/{revision_id}/adopt",json={"expected_version":2},headers=env.headers).status_code == 409


def test_pending_failed_and_stale_candidates_keep_existing_text(writing_setup):
    env=writing_setup;original=env.state.record
    revision_id=request(env)
    path=f"/api/v1/records/J1/revisions/{revision_id}/adopt"
    assert env.client.post(path,json={"expected_version":1},headers=env.headers).status_code == 409
    job=env.state.revisions[revision_id]
    env.state.revisions[revision_id]=RevisionJob.model_validate({**job.model_dump(),"status":"failed",
        "failure":WritingFailure(stage="revision",code="AI_UNAVAILABLE",retryable=True)})
    assert env.client.post(path,json={"expected_version":1},headers=env.headers).status_code == 409
    assert env.state.record == original
    second=request(env);ready(env,second)
    env.client.patch("/api/v1/records/J1",json={"edited_text":"同時 수정","expected_version":1},headers=env.headers)
    assert env.client.post(f"/api/v1/records/J1/revisions/{second}/adopt",json={"expected_version":2},headers=env.headers).status_code == 409
    assert env.state.record.edited_text == "同時 수정"


def test_other_record_or_owner_candidate_hidden(writing_setup):
    env=writing_setup;revision_id=request(env);ready(env,revision_id)
    job=env.state.revisions[revision_id]
    env.state.revisions[revision_id]=job.model_copy(update={"teacher_id":"T2"})
    assert env.client.get(f"/api/v1/records/J1/revisions/{revision_id}",headers=env.headers).status_code == 404
    env.state.revisions[revision_id]=job.model_copy(update={"record_id":"J2"})
    assert env.client.post(f"/api/v1/records/J1/revisions/{revision_id}/adopt",json={"expected_version":1},headers=env.headers).status_code == 404


@pytest.mark.parametrize("body",[
    {"instruction":" ","expected_version":1},
    {"instruction":"수정","expected_version":1,"edited_text":"주입"},
    {"instruction":"수정","expected_version":1,"child_id":"C02"},
    {"instruction":"수정","expected_version":1,"observation_ids":["O2"]},
])
def test_revision_cannot_inject_body_or_child_or_evidence(writing_setup,body):
    env=writing_setup
    assert env.client.post("/api/v1/records/J1/revisions",json=body,headers=env.headers).status_code == 422
    assert env.state.revisions == {}
