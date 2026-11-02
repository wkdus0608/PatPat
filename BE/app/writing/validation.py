from collections.abc import Sequence
from datetime import datetime

from app.auth.dependencies import require_teacher_ownership
from app.auth.models import TeacherContext
from app.core.errors import ApiError
from app.core.jobs import JobStatus
from app.recordings.models import RecordingReference, RecordingStatus
from app.writing.models import (
    ChildContent, DraftContent, GenerationSnapshot, JournalRecord,
    RecordStatus, RevisionContext, RevisionJob,
)


def conflict(message: str) -> ApiError:
    return ApiError(status_code=409, code="WRITING_CONFLICT", message=message)


def invalid_result() -> ApiError:
    return ApiError(status_code=422, code="INVALID_GENERATION_RESULT", message="생성 결과의 근거 연결을 확인할 수 없습니다.")


def validate_recording_selection(
    *, recording_ids: Sequence[str], sources: Sequence[RecordingReference], teacher: TeacherContext
) -> None:
    by_id = {s.recording_id: s for s in sources}
    if not recording_ids or len(set(recording_ids)) != len(recording_ids):
        raise ApiError(status_code=422, code="VALIDATION_ERROR", message="녹음을 중복 없이 선택해 주세요.")
    if set(by_id) != set(recording_ids) or len(sources) != len(recording_ids):
        raise ApiError(status_code=404, code="NOT_FOUND", message="선택한 녹음을 찾을 수 없습니다.")
    for recording_id in recording_ids:
        source = by_id[recording_id]
        require_teacher_ownership(owner_teacher_id=source.teacher_id, teacher=teacher)
        if source.is_deleted:
            raise ApiError(status_code=404, code="NOT_FOUND", message="선택한 녹음을 찾을 수 없습니다.")
        if source.status != RecordingStatus.COMPLETED:
            raise conflict("전사가 완료된 녹음만 사용할 수 있습니다.")


def validate_child_content(snapshot: GenerationSnapshot, content: ChildContent) -> None:
    if content.child_id not in {c.child_id for c in snapshot.children}:
        raise invalid_result()
    eligible = {o.observation_id: o for o in snapshot.observations
                if o.scope in ("individual", "joint") and content.child_id in o.child_ids}
    if content.missing_evidence != (not eligible):
        raise invalid_result()
    if (not eligible and content.individual_sentences) or (eligible and not content.individual_sentences):
        raise invalid_result()
    used = set()
    for sentence in content.individual_sentences:
        for observation_id in sentence.observation_ids:
            observation = eligible.get(observation_id)
            if observation is None or sentence.content_kind not in observation.content_kinds:
                raise invalid_result()
            used.add(observation_id)
    if used != set(eligible):
        raise invalid_result()


def validate_draft_content(snapshot: GenerationSnapshot, content: DraftContent) -> None:
    if tuple(r.child_id for r in content.records) != tuple(c.child_id for c in snapshot.children):
        raise invalid_result()
    common = tuple(o.observation_id for o in snapshot.observations if o.scope == "common")
    unresolved = tuple(o.observation_id for o in snapshot.observations if o.scope == "unresolved")
    if content.common_observation_ids != common or content.unresolved_observation_ids != unresolved:
        raise invalid_result()
    if bool(content.common_text.strip()) != bool(common):
        raise invalid_result()
    for record in content.records:
        validate_child_content(snapshot, record)


def check_version(record: JournalRecord, expected_version: int) -> None:
    if record.version != expected_version:
        raise conflict("일지가 변경되었습니다. 최신 버전을 확인해 주세요.")


def apply_manual_text(
    record: JournalRecord, *, edited_text: str, expected_version: int,
    confirm: bool = False, now: datetime | None = None,
) -> JournalRecord:
    """Pure state transition. Persistence/history must be atomic in repository."""
    check_version(record, expected_version)
    if not isinstance(edited_text, str) or not edited_text.strip():
        raise ApiError(status_code=422, code="VALIDATION_ERROR", message="일지 내용을 입력해 주세요.")
    if confirm and (now is None or now.utcoffset() is None):
        raise ValueError("확정 시 시간대가 있는 서버 시각이 필요합니다.")
    data = record.model_dump()
    data.update(edited_text=edited_text, version=record.version + 1,
                status=RecordStatus.COMPLETED if confirm else RecordStatus.REVIEW,
                confirmed_at=now if confirm else None)
    return JournalRecord.model_validate(data)


def adopt_revision(
    record: JournalRecord, revision: RevisionJob, *, expected_version: int
) -> JournalRecord:
    if (revision.teacher_id != record.teacher_id or revision.record_id != record.record_id
        or revision.child_id != record.child_id):
        raise ApiError(status_code=404, code="NOT_FOUND", message="수정 후보를 찾을 수 없습니다.")
    check_version(record, expected_version)
    if revision.base_version != record.version or revision.status != JobStatus.COMPLETED:
        raise conflict("현재 버전에 채택할 수 있는 완료 후보가 아닙니다.")
    assert revision.candidate is not None and revision.candidate_text is not None
    validate_child_content(record.snapshot, revision.candidate)
    return apply_manual_text(record, edited_text=revision.candidate_text, expected_version=expected_version)


def build_revision_context(record: JournalRecord) -> RevisionContext:
    child = next(c for c in record.snapshot.children if c.child_id == record.child_id)
    evidence = tuple(o for o in record.snapshot.observations
                     if o.scope == "common" or o.scope in ("individual", "joint") and record.child_id in o.child_ids)
    return RevisionContext(record_id=record.record_id, child=child,
        base_version=record.version, current_text=record.edited_text, observations=evidence)
