from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from app.core.jobs import JobStatus

NonBlank = Annotated[str, StringConstraints(strict=True, min_length=1, pattern=r"\S")]
ContentKind = Literal["관찰", "배움 읽기", "놀이 지원", "지원 계획"]


class FrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class RecordStatus(StrEnum):
    WRITING = "작성중"
    REVIEW = "검토중"
    COMPLETED = "완료"


class ChildSnapshot(FrozenModel):
    child_id: NonBlank
    name: NonBlank


class TranscriptSnapshot(FrozenModel):
    recording_id: NonBlank
    text: str = Field(repr=False)


class ObservationSnapshot(FrozenModel):
    observation_id: NonBlank
    recording_id: NonBlank
    child_ids: tuple[NonBlank, ...]
    scope: Literal["common", "individual", "joint", "unresolved"]
    text: NonBlank = Field(repr=False)
    content_kinds: tuple[ContentKind, ...] = ("관찰",)

    @model_validator(mode="after")
    def coherent_scope(self) -> Self:
        if len(set(self.child_ids)) != len(self.child_ids):
            raise ValueError("아동 ID는 중복할 수 없습니다.")
        if (self.scope == "unresolved" and self.child_ids
            or self.scope == "individual" and len(self.child_ids) != 1
            or self.scope == "joint" and len(self.child_ids) < 2):
            raise ValueError("관찰 범위와 아동 연결이 일치하지 않습니다.")
        if not self.content_kinds or len(set(self.content_kinds)) != len(self.content_kinds):
            raise ValueError("근거 항목은 비어 있거나 중복할 수 없습니다.")
        return self


class GenerationSnapshot(FrozenModel):
    children: tuple[ChildSnapshot, ...] = Field(min_length=1)
    transcripts: tuple[TranscriptSnapshot, ...] = Field(min_length=1)
    observations: tuple[ObservationSnapshot, ...]

    @model_validator(mode="after")
    def validate_references(self) -> Self:
        children = {c.child_id for c in self.children}
        recordings = {t.recording_id for t in self.transcripts}
        if len(children) != len(self.children) or len(recordings) != len(self.transcripts):
            raise ValueError("명단/녹음 ID가 중복되었습니다.")
        if len({o.observation_id for o in self.observations}) != len(self.observations):
            raise ValueError("관찰 ID가 중복되었습니다.")
        for observation in self.observations:
            if observation.recording_id not in recordings or not set(observation.child_ids) <= children:
                raise ValueError("선택 범위 밖의 관찰입니다.")
        return self


class EvidenceSentence(FrozenModel):
    text: NonBlank = Field(repr=False)
    observation_ids: tuple[NonBlank, ...] = Field(min_length=1)
    content_kind: ContentKind

    @model_validator(mode="after")
    def unique_evidence(self) -> Self:
        if len(set(self.observation_ids)) != len(self.observation_ids):
            raise ValueError("문장 근거가 중복되었습니다.")
        return self


class ChildContent(FrozenModel):
    child_id: NonBlank
    individual_sentences: tuple[EvidenceSentence, ...]
    missing_evidence: bool


class GeneratedChildRecord(ChildContent):
    record_id: NonBlank


class DraftContent(FrozenModel):
    common_text: str = Field(repr=False)
    common_observation_ids: tuple[NonBlank, ...] = ()
    records: tuple[ChildContent, ...]
    unresolved_observation_ids: tuple[NonBlank, ...] = ()


class DraftResult(DraftContent):
    records: tuple[GeneratedChildRecord, ...]


class WritingFailure(FrozenModel):
    stage: Literal["extraction", "generation", "revision", "validation", "persist"]
    code: NonBlank
    retryable: bool


class DraftJob(FrozenModel):
    draft_id: NonBlank
    job_id: NonBlank
    teacher_id: NonBlank
    status: JobStatus
    snapshot: GenerationSnapshot
    result: DraftResult | None = None
    failure: WritingFailure | None = None

    @model_validator(mode="after")
    def coherent_job(self) -> Self:
        if (self.status == JobStatus.COMPLETED) != (self.result is not None):
            raise ValueError("완료 상태에만 초안 결과가 필요합니다.")
        if (self.status == JobStatus.FAILED) != (self.failure is not None):
            raise ValueError("실패 상태에만 실패 정보가 필요합니다.")
        if self.result and len({r.record_id for r in self.result.records}) != len(self.result.records):
            raise ValueError("일지 ID가 중복되었습니다.")
        return self


class JournalRecord(FrozenModel):
    record_id: NonBlank
    draft_id: NonBlank
    teacher_id: NonBlank
    child_id: NonBlank
    version: int = Field(ge=1)
    status: RecordStatus
    edited_text: str = Field(repr=False)
    generated: ChildContent
    snapshot: GenerationSnapshot
    confirmed_at: datetime | None = None

    @model_validator(mode="after")
    def coherent_record(self) -> Self:
        if self.child_id != self.generated.child_id:
            raise ValueError("일지와 생성 내용의 아동이 다릅니다.")
        if self.child_id not in {c.child_id for c in self.snapshot.children}:
            raise ValueError("명단에 없는 아동입니다.")
        if (self.status == RecordStatus.COMPLETED) != (self.confirmed_at is not None):
            raise ValueError("완료 상태와 확정 시각이 일치하지 않습니다.")
        if self.confirmed_at and self.confirmed_at.utcoffset() is None:
            raise ValueError("확정 시각에는 시간대가 필요합니다.")
        if self.status == RecordStatus.COMPLETED and not self.edited_text.strip():
            raise ValueError("빈 일지를 확정할 수 없습니다.")
        return self


class RecordHistory(FrozenModel):
    record_id: NonBlank
    teacher_id: NonBlank
    version: int = Field(ge=1)
    action: Literal["generated", "manual_edit", "confirm", "adopt_revision"]
    edited_text: str = Field(repr=False)
    status: RecordStatus
    revision_id: NonBlank | None = None


class RevisionContext(FrozenModel):
    record_id: NonBlank
    child: ChildSnapshot
    base_version: int = Field(ge=1)
    current_text: str = Field(repr=False)
    observations: tuple[ObservationSnapshot, ...]

    @model_validator(mode="after")
    def only_target_evidence(self) -> Self:
        for observation in self.observations:
            if not (observation.scope == "common" or observation.scope in ("individual", "joint")
                    and self.child.child_id in observation.child_ids):
                raise ValueError("대상 아동 범위 밖의 재요청 근거입니다.")
        return self


class RevisionJob(FrozenModel):
    revision_id: NonBlank
    job_id: NonBlank
    record_id: NonBlank
    teacher_id: NonBlank
    child_id: NonBlank
    base_version: int = Field(ge=1)
    status: JobStatus
    instruction: NonBlank = Field(repr=False)
    context: RevisionContext
    candidate_text: NonBlank | None = Field(default=None, repr=False)
    candidate: ChildContent | None = None
    failure: WritingFailure | None = None

    @model_validator(mode="after")
    def coherent_job(self) -> Self:
        if (self.context.record_id != self.record_id
            or self.context.child.child_id != self.child_id
            or self.context.base_version != self.base_version):
            raise ValueError("수정 요청과 고정 컨텍스트가 다릅니다.")
        completed = self.status == JobStatus.COMPLETED
        if completed != (self.candidate_text is not None and self.candidate is not None):
            raise ValueError("완료 상태에만 후보가 필요합니다.")
        if not completed and (self.candidate_text is not None or self.candidate is not None):
            raise ValueError("완료 전 후보를 공개할 수 없습니다.")
        if self.candidate and self.candidate.child_id != self.child_id:
            raise ValueError("다른 아동의 후보입니다.")
        if (self.status == JobStatus.FAILED) != (self.failure is not None):
            raise ValueError("실패 상태에만 실패 정보가 필요합니다.")
        return self
