import pytest


def test_exact_text_confirm_edit_and_version_history(writing_setup):
    env=writing_setup
    text="  선생님이 직접 쓴 글\n줄바꿈도 그대로  "
    saved=env.client.patch("/api/v1/records/J1",json={"edited_text":text,"expected_version":1},headers=env.headers)
    assert saved.status_code == 200
    assert saved.json()["edited_text"] == text
    assert saved.json()["version"] == 2 and saved.json()["status"] == "검토중"
    confirmed=env.client.post("/api/v1/records/J1/confirm",json={"edited_text":text,"expected_version":2},headers=env.headers)
    assert confirmed.status_code == 200
    assert confirmed.json()["status"] == "완료"
    assert confirmed.json()["edited_text"] == text
    assert confirmed.json()["confirmed_at"] is not None
    edited=env.client.patch("/api/v1/records/J1",json={"edited_text":"다시 수정","expected_version":3},headers=env.headers)
    assert edited.json()["status"] == "검토중"
    assert edited.json()["confirmed_at"] is None
    history=env.client.get("/api/v1/records/J1/history",headers=env.headers).json()["items"]
    assert [h["version"] for h in history] == [2,3,4]
    assert [h["action"] for h in history] == ["manual_edit","confirm","manual_edit"]
    assert history[0]["edited_text"] == text
    assert env.state.revisions == {}  # no revision/AI request in this flow


def test_stale_save_and_confirm_do_not_overwrite(writing_setup):
    env=writing_setup
    for path,method in [("/api/v1/records/J1","patch"),("/api/v1/records/J1/confirm","post")]:
        response=env.client.request(method,path,json={"edited_text":"덮어쓰기","expected_version":2},headers=env.headers)
        assert response.status_code == 409
    assert env.state.record.version == 1
    assert env.state.history == []


@pytest.mark.parametrize("body",[
    {"edited_text":"   ","expected_version":1}, {"edited_text":123,"expected_version":1},
    {"edited_text":"본문","expected_version":True}, {"edited_text":"본문","expected_version":0},
    {"edited_text":"본문","expected_version":"1"},
    {"edited_text":"본문","expected_version":1,"teacher_id":"T2"},
])
def test_invalid_writes_are_rejected(writing_setup,body):
    env=writing_setup
    assert env.client.patch("/api/v1/records/J1",json=body,headers=env.headers).status_code == 422
    assert env.state.record.version == 1


def test_other_teacher_record_and_history_are_hidden(writing_setup):
    env=writing_setup
    env.state.record=env.state.record.model_copy(update={"teacher_id":"T2"})
    assert env.client.get("/api/v1/records/J1",headers=env.headers).status_code == 404
    assert env.client.get("/api/v1/records/J1/history",headers=env.headers).status_code == 404
    response=env.client.patch("/api/v1/records/J1",json={"edited_text":"본문","expected_version":1},headers=env.headers)
    assert response.status_code == 404
