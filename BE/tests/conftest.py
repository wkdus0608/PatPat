from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.auth.dependencies import get_auth_service, require_teacher_ownership
from app.auth.models import TeacherContext
from app.auth.service import InvalidAccessToken
from app.core.errors import ApiError
from app.core.jobs import JobStatus
from app.drafts.dependencies import get_draft_service
from app.records.dependencies import get_record_service
from app.revisions.dependencies import get_revision_service
from app.main import create_app
from app.writing.models import (
    ChildContent, ChildSnapshot, DraftJob, DraftResult, EvidenceSentence,
    GeneratedChildRecord, GenerationSnapshot, JournalRecord, ObservationSnapshot,
    RecordHistory, RecordStatus, RevisionJob, TranscriptSnapshot,
)
from app.writing.validation import apply_manual_text, adopt_revision, build_revision_context, check_version


@pytest.fixture
def writing_snapshot():
    return GenerationSnapshot(
        children=tuple(ChildSnapshot(child_id=f"C0{i}",name=f"가상 아동 {i}") for i in (1,2,3)),
        transcripts=(TranscriptSnapshot(recording_id="R1",text="가상 전사문"),),
        observations=(
            ObservationSnapshot(observation_id="O0",recording_id="R1",child_ids=("C01","C02","C03"),scope="common",text="공통 활동"),
            ObservationSnapshot(observation_id="O1",recording_id="R1",child_ids=("C01",),scope="individual",text="가상 아동1 관찰"),
            ObservationSnapshot(observation_id="O2",recording_id="R1",child_ids=("C02",),scope="individual",text="가상 아동2 관찰"),
            ObservationSnapshot(observation_id="U1",recording_id="R1",child_ids=(),scope="unresolved",text="대상 불명확"),
        ))


@pytest.fixture
def writing_result():
    return DraftResult(common_text="공통 활동",common_observation_ids=("O0",),unresolved_observation_ids=("U1",),
        records=(
            GeneratedChildRecord(record_id="J1",child_id="C01",missing_evidence=False,individual_sentences=(EvidenceSentence(text="아동1 관찰",observation_ids=("O1",),content_kind="관찰"),)),
            GeneratedChildRecord(record_id="J2",child_id="C02",missing_evidence=False,individual_sentences=(EvidenceSentence(text="아동2 관찰",observation_ids=("O2",),content_kind="관찰"),)),
            GeneratedChildRecord(record_id="J3",child_id="C03",missing_evidence=True,individual_sentences=()),
        ))


@pytest.fixture
def writing_record(writing_snapshot, writing_result):
    content=ChildContent.model_validate(writing_result.records[0].model_dump(exclude={"record_id"}))
    return JournalRecord(record_id="J1",draft_id="D1",teacher_id="T1",child_id="C01",version=1,
        status=RecordStatus.REVIEW,edited_text="최초 가상 초안",generated=content,snapshot=writing_snapshot)


class StubAuth:
    async def authenticate(self,access_token):
        if access_token != "writing-token": raise InvalidAccessToken
        return TeacherContext("T1","가상 교사")


@pytest.fixture
def writing_setup(writing_record,writing_snapshot,writing_result):
    state=SimpleNamespace(record=writing_record,history=[],revisions={},calls=[],sequence=0)
    not_found=lambda: ApiError(status_code=404,code="NOT_FOUND",message="자료를 찾을 수 없습니다.")

    def own(teacher,record_id):
        if record_id != state.record.record_id: raise not_found()
        require_teacher_ownership(owner_teacher_id=state.record.teacher_id,teacher=teacher)
        return state.record

    def commit(record,action,revision_id=None):
        state.record=record
        state.history.append(RecordHistory(record_id=record.record_id,teacher_id=record.teacher_id,
            version=record.version,action=action,edited_text=record.edited_text,status=record.status,revision_id=revision_id))
        return record

    class DraftStub:
        async def request(self,*,teacher,recording_ids):
            state.calls.append(("draft",teacher.teacher_id,recording_ids))
            return DraftJob(draft_id="D1",job_id="DJ1",teacher_id=teacher.teacher_id,status=JobStatus.QUEUED,snapshot=writing_snapshot)
        async def get(self,*,teacher,draft_id):
            if draft_id != "D1": raise not_found()
            return DraftJob(draft_id="D1",job_id="DJ1",teacher_id="T1",status=JobStatus.COMPLETED,snapshot=writing_snapshot,result=writing_result)

    class RecordStub:
        async def get(self,*,teacher,record_id): return own(teacher,record_id)
        async def save(self,*,teacher,record_id,edited_text,expected_version):
            return commit(apply_manual_text(own(teacher,record_id),edited_text=edited_text,expected_version=expected_version),"manual_edit")
        async def confirm(self,*,teacher,record_id,edited_text,expected_version):
            return commit(apply_manual_text(own(teacher,record_id),edited_text=edited_text,expected_version=expected_version,confirm=True,now=datetime.now(timezone.utc)),"confirm")
        async def history(self,*,teacher,record_id):
            own(teacher,record_id)
            return tuple(state.history)

    class RevisionStub:
        async def request(self,*,teacher,record_id,instruction,expected_version):
            record=own(teacher,record_id);check_version(record,expected_version)
            state.sequence+=1
            job=RevisionJob(revision_id=f"V{state.sequence}",job_id=f"RJ{state.sequence}",record_id=record_id,
                teacher_id=teacher.teacher_id,child_id=record.child_id,base_version=record.version,
                status=JobStatus.QUEUED,instruction=instruction,context=build_revision_context(record))
            state.revisions[job.revision_id]=job
            return job
        async def get(self,*,teacher,record_id,revision_id):
            own(teacher,record_id)
            job=state.revisions.get(revision_id)
            if not job or job.record_id != record_id: raise not_found()
            require_teacher_ownership(owner_teacher_id=job.teacher_id,teacher=teacher)
            return job
        async def adopt(self,*,teacher,record_id,revision_id,expected_version):
            job=await self.get(teacher=teacher,record_id=record_id,revision_id=revision_id)
            return commit(adopt_revision(own(teacher,record_id),job,expected_version=expected_version),"adopt_revision",revision_id)

    app=create_app()
    app.dependency_overrides[get_auth_service]=lambda: StubAuth()
    app.dependency_overrides[get_draft_service]=lambda: DraftStub()
    app.dependency_overrides[get_record_service]=lambda: RecordStub()
    app.dependency_overrides[get_revision_service]=lambda: RevisionStub()
    with TestClient(app) as client:
        yield SimpleNamespace(client=client,state=state,app=app,headers={"Authorization":"Bearer writing-token"})
