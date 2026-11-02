"""History/share HTTP contracts with fictional data; no real DB or OS sharing."""
from dataclasses import replace
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from app.auth.models import TeacherContext
from app.core.errors import ApiError
from app.main import create_app
from app.recordings.dependencies import get_recording_service
from app.recordings.models import Recording, RecordingPage, RecordingStatus
from app.records.dependencies import get_record_service
from app.writing.models import ChildContent, RecordPage, RecordStatus

SEOUL=ZoneInfo("Asia/Seoul")


def utc(value):
    return datetime.fromisoformat(value).replace(tzinfo=timezone.utc)


def page_rows(rows,query,date_key,id_key):
    selected=[]
    for row in rows:
        day=getattr(row,date_key).astimezone(SEOUL).date()
        if query.date_from and day < query.date_from:continue
        if query.date_to and day > query.date_to:continue
        if getattr(query,"child_id",None) and row.child_id != query.child_id:continue
        if getattr(query,"status",None) and row.status != query.status:continue
        selected.append(row)
    selected.sort(key=lambda x:(getattr(x,date_key),getattr(x,id_key)),reverse=query.order=="desc")
    return tuple(selected[query.offset:query.offset+query.limit]),len(selected)


@pytest.fixture
def history_setup(writing_setup,writing_result):
    env=writing_setup
    dates=[utc("2026-11-01T15:00:00"),utc("2026-11-02T14:59:59"),utc("2026-11-02T15:00:00"),utc("2026-11-01T15:00:00")]
    source=env.state.record
    journals=[]
    for i,created in enumerate(dates):
        data=source.model_dump()
        child=writing_result.records[2] if i==2 else writing_result.records[0]
        data.update(record_id=f"J{i+1}",created_at=created,
            child_id=child.child_id,generated=ChildContent.model_validate(child.model_dump(exclude={"record_id"})))
        if i==1:data.update(status=RecordStatus.COMPLETED,confirmed_at=created)
        journals.append(type(source).model_validate(data))
    foreign=type(source).model_validate({**source.model_dump(),"record_id":"foreign","teacher_id":"T2"})
    journals.append(foreign)
    recordings=[Recording(f"R{i+1}","T1","가상 녹음",d,1.0,20,"audio/mp4",RecordingStatus.COMPLETED,d) for i,d in enumerate(dates)]
    recordings.append(replace(recordings[0],recording_id="foreign",teacher_id="T2"))
    recordings.append(replace(recordings[0],recording_id="deleted"))
    env.state.query_calls=[]
    env.state.leak_owner=False

    class Records:
        async def list(self,*,teacher,query):
            env.state.query_calls.append(("records",teacher.teacher_id,query))
            rows=[row for row in journals if row.teacher_id==teacher.teacher_id]
            if env.state.leak_owner:return RecordPage(items=(foreign,),total=1)
            items,total=page_rows(rows,query,"created_at","record_id")
            return RecordPage(items=items,total=total)
        async def get(self,*,teacher,record_id):
            matches=[row for row in journals if row.record_id==record_id and row.teacher_id==teacher.teacher_id]
            if not matches:raise ApiError(status_code=404,code="NOT_FOUND",message="일지를 찾을 수 없습니다.")
            return matches[0]

    class Recordings:
        async def list(self,*,teacher,query):
            env.state.query_calls.append(("recordings",teacher.teacher_id,query))
            if env.state.leak_owner:return RecordingPage((recordings[-2],),1)
            rows=[row for row in recordings if row.teacher_id==teacher.teacher_id and row.recording_id!="deleted"]
            items,total=page_rows(rows,query,"recorded_at","recording_id")
            return RecordingPage(items,total)

    env.app.dependency_overrides[get_record_service]=lambda:Records()
    env.app.dependency_overrides[get_recording_service]=lambda:Recordings()
    return env


@pytest.mark.parametrize("path,id_key",[("records","record_id"),("recordings","recording_id")])
def test_inclusive_seoul_dates_tie_order_and_filter_before_page(history_setup,path,id_key):
    env=history_setup
    query={"date_from":"2026-11-02","date_to":"2026-11-02","limit":1,"offset":1,"teacher_id":"T2"}
    response=env.client.get(f"/api/v1/{path}",params=query,headers=env.headers)
    assert response.status_code==200
    data=response.json()
    assert data["total"]==3 and data["limit"]==1 and data["offset"]==1
    assert data["items"][0][id_key]==("J4" if path=="records" else "R4")
    assert response.headers["cache-control"]=="no-store"
    _,owner,parsed=env.state.query_calls[-1]
    assert owner=="T1" and parsed.order=="desc"
    assert not hasattr(parsed,"teacher_id")
    asc=env.client.get(f"/api/v1/{path}",params={**query,"order":"asc","offset":0},headers=env.headers).json()
    assert asc["items"][0][id_key]==("J1" if path=="records" else "R1")


@pytest.mark.parametrize("path",["records","recordings"])
@pytest.mark.parametrize("params",[
    {"date_from":"2027-01-01"}, {"offset":1000},
])
def test_no_matches_or_outside_page_is_empty_200(history_setup,path,params):
    env=history_setup
    response=env.client.get(f"/api/v1/{path}",params=params,headers=env.headers)
    assert response.status_code==200 and response.json()["items"]==[]
    assert response.json()["total"]==(0 if "date_from" in params else 4)


@pytest.mark.parametrize("path",["records","recordings"])
@pytest.mark.parametrize("params",[
    {"date_from":"bad"},{"date_from":"2026-11-03","date_to":"2026-11-02"},
    {"limit":0},{"limit":101},{"offset":-1},{"order":"random"},
])
def test_invalid_history_query_never_reaches_service(history_setup,path,params):
    env=history_setup
    response=env.client.get(f"/api/v1/{path}",params=params,headers=env.headers)
    assert response.status_code==422 and response.json()["error"]["code"]=="VALIDATION_ERROR"
    assert env.state.query_calls==[]


def test_child_status_filters_and_inactive_child_history(history_setup):
    env=history_setup
    response=env.client.get("/api/v1/records",params={"child_id":"C01","status":"완료"},headers=env.headers)
    assert response.json()["total"]==1
    assert response.json()["items"][0]["record_id"]=="J2"
    assert response.json()["items"][0]["can_share"] is True
    assert "edited_text" not in response.json()["items"][0]
    inactive=env.client.get("/api/v1/records",params={"child_id":"C03"},headers=env.headers)
    assert inactive.json()["total"]==1  # no active-roster requirement for historical IDs
    unknown=env.client.get("/api/v1/records",params={"child_id":"other-child"},headers=env.headers)
    assert unknown.json()["total"]==0
    for query in [{"status":"unknown"},{"child_id":"   "}]:
        assert env.client.get("/api/v1/records",params=query,headers=env.headers).status_code==422


@pytest.mark.parametrize("path",["records","recordings"])
def test_history_pages_reject_accidentally_returned_foreign_rows(history_setup,path):
    env=history_setup;env.state.leak_owner=True
    response=env.client.get(f"/api/v1/{path}",headers=env.headers)
    assert response.status_code==404 and "foreign" not in response.text


def test_confirmed_text_shares_exactly_then_edit_revokes_it(writing_setup):
    env=writing_setup
    before=env.client.get("/api/v1/records/J1",headers=env.headers).json()
    assert before["can_share"] is False and before["share_text"] is None
    text="  최종 확정문\n줄바꿈 그대로  "
    confirmed=env.client.post("/api/v1/records/J1/confirm",json={"edited_text":text,"expected_version":1},headers=env.headers).json()
    assert confirmed["can_share"] is True and confirmed["share_text"]==text
    assert confirmed["created_at"]==before["created_at"]
    detail=env.client.get("/api/v1/records/J1",headers=env.headers).json()
    assert detail["share_text"]==text and detail["version"]==2
    edited=env.client.patch("/api/v1/records/J1",json={"edited_text":"다시 검토","expected_version":2},headers=env.headers).json()
    assert edited["can_share"] is False and edited["share_text"] is None
    assert edited["created_at"]==before["created_at"]
    assert env.state.revisions=={}


def test_no_public_share_endpoint_and_complete_openapi(writing_setup):
    env=writing_setup;schema=env.client.get("/openapi.json").json()
    assert "/health" in schema["paths"]
    assert {"/api/v1/records", "/api/v1/recordings", "/api/v1/drafts"} <= set(schema["paths"])
    for path,operations in schema["paths"].items():
        for method,operation in operations.items():
            if path in ("/health","/api/v1/auth/login"):
                assert not operation.get("security")
            else:
                assert operation["security"]==[{"TeacherBearer":[]}]
                assert "501" in operation["responses"]
                assert operation["responses"]["401"]["content"]["application/json"]["schema"]["$ref"].endswith("/ErrorResponse")
    for path in ("/api/v1/records","/api/v1/recordings"):
        query={p["name"] for p in schema["paths"][path]["get"]["parameters"]}
        assert {"date_from","date_to","limit","offset","order"}<=query
    detail=schema["components"]["schemas"]["RecordResponse"]["properties"]
    assert detail["can_share"]["readOnly"] and detail["share_text"]["readOnly"]
    assert not any("share" in path for path in schema["paths"])
    response=env.client.get("/api/v1/records/J1/share",headers=env.headers)
    assert response.status_code==501


@pytest.mark.parametrize("path",["records","recordings"])
def test_history_default_auth_and_service_are_not_fake_success(path):
    from fastapi.testclient import TestClient
    from app.auth.dependencies import get_current_teacher
    app=create_app()
    with TestClient(app) as client:
        assert client.get(f"/api/v1/{path}").status_code==401
        app.dependency_overrides[get_current_teacher]=lambda:TeacherContext("T1","가상 교사")
        response=client.get(f"/api/v1/{path}")
        assert response.status_code==501
        assert response.json()["error"]["code"]=="NOT_IMPLEMENTED"


def test_integrated_index_matches_live_operations_and_feature_links(writing_setup):
    from pathlib import Path
    import re
    be=Path(__file__).resolve().parents[1]
    document=be/"docs/API_CONTRACT.md"
    text=document.read_text()
    documented=set(re.findall(r"\| `([A-Z]+)` \| `([^`]+)` \|",text))
    schema=writing_setup.client.get("/openapi.json").json()
    live={(method.upper(),path) for path,operations in schema["paths"].items() for method in operations}
    assert documented==live
    for target in re.findall(r"\]\(([^)]+)\)",text):
        if "://" not in target:
            assert (document.parent/target.split("#")[0]).exists(),target
