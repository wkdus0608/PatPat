import pytest
from fastapi.testclient import TestClient
from app.auth.dependencies import get_auth_service
from app.auth.models import TeacherContext
from app.main import create_app


@pytest.mark.parametrize("method,path,body,feature",[
    ("post","/api/v1/drafts",{"recording_ids":["R1"]},"BE-05"),
    ("get","/api/v1/drafts/D1",None,"BE-05"),
    ("get","/api/v1/records/J1",None,"BE-06"),
    ("patch","/api/v1/records/J1",{"edited_text":"본문","expected_version":1},"BE-06"),
    ("post","/api/v1/records/J1/confirm",{"edited_text":"본문","expected_version":1},"BE-06"),
    ("get","/api/v1/records/J1/history",None,"BE-06"),
    ("post","/api/v1/records/J1/revisions",{"instruction":"문장 수정","expected_version":1},"BE-07"),
    ("get","/api/v1/records/J1/revisions/V1",None,"BE-07"),
    ("post","/api/v1/records/J1/revisions/V1/adopt",{"expected_version":1},"BE-07"),
])
def test_all_writing_routes_authenticate_and_default_to_501(method,path,body,feature):
    class Auth:
        async def authenticate(self,token):return TeacherContext("T1","가상 교사")
    app=create_app()
    kwargs={"json":body} if body is not None else {}
    with TestClient(app) as client:
        assert client.request(method,path,**kwargs).status_code == 401
        app.dependency_overrides[get_auth_service]=lambda: Auth()
        response=client.request(method,path,headers={"Authorization":"Bearer contract-token"},**kwargs)
        assert response.status_code == 501
        assert response.json()["error"]["details"]["feature"] == feature


@pytest.mark.parametrize("body",[
    {},{"recording_ids":[]},{"recording_ids":["R1","R1"]},
    {"recording_ids":[""]},{"recording_ids":[1]},
    {"recording_ids":["R1"],"child_ids":["C01"]},
    {"recording_ids":["R1"],"teacher_id":"T2"},
])
def test_invalid_selection_never_reaches_service(writing_setup,body):
    env=writing_setup
    response=env.client.post("/api/v1/drafts",json=body,headers=env.headers)
    assert response.status_code == 422
    assert env.state.calls == []


def test_draft_request_and_completed_result(writing_setup):
    env=writing_setup
    response=env.client.post("/api/v1/drafts",json={"recording_ids":["R1"]},headers=env.headers)
    assert response.status_code == 202
    assert response.json() == {"draft_id":"D1","job_id":"DJ1","status":"queued"}
    assert env.state.calls == [("draft","T1",("R1",))]
    result=env.client.get("/api/v1/drafts/D1",headers=env.headers)
    assert result.status_code == 200
    data=result.json()
    assert data["recording_ids"] == ["R1"]
    assert [r["child_id"] for r in data["result"]["records"]] == ["C01","C02","C03"]
    assert data["result"]["records"][2]["missing_evidence"] is True
    assert data["result"]["records"][2]["individual_sentences"] == []
    assert data["result"]["unresolved_observation_ids"] == ["U1"]
    assert "snapshot" not in data and "teacher_id" not in data
    assert result.headers["cache-control"] == "no-store"


def test_openapi_connects_writing_operations(writing_setup):
    schema=writing_setup.client.get("/openapi.json").json()
    for path,method in [("/api/v1/drafts","post"),("/api/v1/records/{record_id}","patch"),
        ("/api/v1/records/{record_id}/revisions","post")]:
        operation=schema["paths"][path][method]
        assert operation["security"] == [{"TeacherBearer":[]}]
        assert "501" in operation["responses"]
    assert "202" in schema["paths"]["/api/v1/drafts"]["post"]["responses"]
