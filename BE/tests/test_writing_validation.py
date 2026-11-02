"""Structural provenance/state checks, not semantic AI/golden-case judgments."""
from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from app.auth.models import TeacherContext
from app.core.errors import ApiError
from app.core.jobs import JobStatus
from app.recordings.models import RecordingReference, RecordingStatus
from app.writing.client import RevisionContext
from app.writing.models import (
    ChildContent, DraftContent, DraftJob, EvidenceSentence, GenerationSnapshot,
    ObservationSnapshot, RevisionJob,
)
from app.writing.validation import (
    apply_manual_text, build_revision_context, validate_child_content,
    validate_draft_content, validate_recording_selection,
)


def test_valid_full_roster_and_selected_evidence(writing_snapshot,writing_result):
    validate_draft_content(writing_snapshot,writing_result)
    assert writing_result.records[2].missing_evidence
    assert not writing_result.records[2].individual_sentences


@pytest.mark.parametrize("observation_id",["O2","O0","U1","not-selected"])
def test_individual_sentence_cannot_use_other_child_common_unresolved_or_unknown(writing_snapshot,observation_id):
    content=ChildContent(child_id="C01",missing_evidence=False,individual_sentences=(
        EvidenceSentence(text="가상 문장",observation_ids=(observation_id,),content_kind="관찰"),))
    with pytest.raises(ApiError) as error:validate_child_content(writing_snapshot,content)
    assert error.value.code == "INVALID_GENERATION_RESULT"


@pytest.mark.parametrize("mutation",["order","missing_child","unsupported_kind","omit_evidence","invent_for_missing","missing_common","missing_unresolved"])
def test_invalid_generation_structure_rejected(writing_snapshot,writing_result,mutation):
    data=writing_result.model_dump()
    # DraftContent deliberately excludes server-assigned record IDs.
    for child in data["records"]:child.pop("record_id")
    data["records"]=list(data["records"])
    if mutation=="order":data["records"].reverse()
    if mutation=="missing_child":data["records"].pop()
    if mutation=="unsupported_kind":data["records"][0]["individual_sentences"][0]["content_kind"]="지원 계획"
    if mutation=="omit_evidence":data["records"][0]["individual_sentences"]=[]
    if mutation=="invent_for_missing":
        data["records"][2]["missing_evidence"]=False
        data["records"][2]["individual_sentences"]=data["records"][0]["individual_sentences"]
    if mutation=="missing_common":data["common_observation_ids"]=[]
    if mutation=="missing_unresolved":data["unresolved_observation_ids"]=[]
    content=DraftContent.model_validate(data)
    with pytest.raises(ApiError):validate_draft_content(writing_snapshot,content)


def test_joint_fact_allowed_only_for_participating_children(writing_snapshot):
    joint=ObservationSnapshot(observation_id="joint",recording_id="R1",child_ids=("C01","C02"),scope="joint",text="가상 공동 관찰")
    snapshot=GenerationSnapshot(children=writing_snapshot.children,transcripts=writing_snapshot.transcripts,observations=(joint,))
    sentence=EvidenceSentence(text="가상 공동 문장",observation_ids=("joint",),content_kind="관찰")
    for child_id in ("C01","C02"):
        validate_child_content(snapshot,ChildContent(child_id=child_id,missing_evidence=False,individual_sentences=(sentence,)))
    with pytest.raises(ApiError):validate_child_content(snapshot,ChildContent(child_id="C03",missing_evidence=False,individual_sentences=(sentence,)))


@pytest.mark.parametrize("status",[RecordingStatus.QUEUED,RecordingStatus.TRANSCRIBING,RecordingStatus.FAILED])
def test_only_completed_recordings_can_generate(status):
    with pytest.raises(ApiError) as error:
        validate_recording_selection(recording_ids=("R1",),sources=(RecordingReference("R1","T1",status),),teacher=TeacherContext("T1","가상 교사"))
    assert error.value.status_code == 409


@pytest.mark.parametrize("source",[
    RecordingReference("R1","T2",RecordingStatus.COMPLETED),
    RecordingReference("R1","T1",RecordingStatus.COMPLETED,True),
    RecordingReference("R2","T1",RecordingStatus.COMPLETED),
])
def test_other_deleted_or_unselected_source_hidden(source):
    with pytest.raises(ApiError) as error:
        validate_recording_selection(recording_ids=("R1",),sources=(source,),teacher=TeacherContext("T1","가상 교사"))
    assert error.value.status_code == 404


def test_valid_source_and_no_extra_source(writing_snapshot):
    source=RecordingReference("R1","T1",RecordingStatus.COMPLETED)
    validate_recording_selection(recording_ids=("R1",),sources=(source,),teacher=TeacherContext("T1","가상 교사"))
    with pytest.raises(ApiError):
        validate_recording_selection(recording_ids=("R1",),sources=(source,source),teacher=TeacherContext("T1","가상 교사"))


def test_snapshot_rejects_outside_recording_or_roster(writing_snapshot):
    for field,value in [("recording_id","outside"),("child_ids",("outside",))]:
        observation=writing_snapshot.observations[1].model_copy(update={field:value})
        with pytest.raises(ValidationError):GenerationSnapshot(children=writing_snapshot.children,transcripts=writing_snapshot.transcripts,observations=(observation,))


def test_ambiguous_target_cannot_have_child_assignment():
    with pytest.raises(ValidationError):
        ObservationSnapshot(observation_id="O",recording_id="R1",child_ids=("C01",),scope="unresolved",text="불명확")


def test_revision_context_filters_other_child_and_unresolved(writing_record):
    context=build_revision_context(writing_record)
    assert context.child.child_id == "C01"
    assert tuple(o.observation_id for o in context.observations) == ("O0","O1")
    assert context.current_text == writing_record.edited_text
    assert context.base_version == 1


def test_direct_confirmation_keeps_generated_evidence_and_snapshot(writing_record):
    confirmed=apply_manual_text(writing_record,edited_text="  교사 확정문\n",expected_version=1,confirm=True,now=datetime.now(timezone.utc))
    assert confirmed.edited_text == "  교사 확정문\n"
    assert confirmed.snapshot == writing_record.snapshot
    assert confirmed.generated == writing_record.generated
    assert writing_record.version == 1 and confirmed.version == 2
    with pytest.raises(ValueError):
        apply_manual_text(writing_record,edited_text="본문",expected_version=1,confirm=True,now=datetime.now())


def test_job_states_do_not_publish_partial_result(writing_snapshot,writing_result,writing_record):
    with pytest.raises(ValidationError):DraftJob(draft_id="D",job_id="J",teacher_id="T1",status=JobStatus.RUNNING,snapshot=writing_snapshot,result=writing_result)
    with pytest.raises(ValidationError):RevisionJob(revision_id="V",job_id="J",record_id="J1",teacher_id="T1",child_id="C01",base_version=1,status=JobStatus.RUNNING,instruction="수정",context=build_revision_context(writing_record),candidate_text="부분 결과")


def test_revision_context_itself_rejects_unfiltered_other_child(writing_record):
    context=build_revision_context(writing_record)
    with pytest.raises(ValidationError):
        RevisionContext.model_validate({**context.model_dump(),"observations":writing_record.snapshot.observations})


def test_reserved_revision_keeps_old_body_after_record_changes(writing_setup):
    env=writing_setup
    response=env.client.post("/api/v1/records/J1/revisions",json={"instruction":"수정","expected_version":1},headers=env.headers)
    revision=env.state.revisions[response.json()["revision_id"]]
    before=revision.context.current_text
    env.client.patch("/api/v1/records/J1",json={"edited_text":"새 본문","expected_version":1},headers=env.headers)
    assert revision.context.current_text == before
    assert revision.context.base_version == 1
    assert env.state.record.version == 2
