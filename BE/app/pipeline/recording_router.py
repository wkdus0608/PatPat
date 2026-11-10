from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from app.api.common_responses import COMMON_ERROR_RESPONSES
from app.auth.dependencies import CurrentTeacher
from app.children.router import private_response
from app.core.errors import ApiError
from app.services import Services, get_services
from app.sessions.schemas import FlagResponse

router = APIRouter(prefix="/sessions/{session_id}/recording-drafts", tags=["recording-drafts"],
                   dependencies=[Depends(private_response)],
                   responses={status: COMMON_ERROR_RESPONSES[status] for status in (401, 404, 409, 422, 500)})
ServicesDependency = Annotated[Services, Depends(get_services)]


class StartRecordingDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    recording_ids: list[str]
    child_ids: list[str] | None = None


class DraftAnswers(BaseModel):
    model_config = ConfigDict(extra="forbid")
    answers: dict[str, Annotated[str, Field(max_length=500)] | None]


class FailedRecording(BaseModel):
    recording_id: str
    code: str


class RecordingCandidate(BaseModel):
    child_id: str
    child_name: str
    text: str
    replaces_notice: bool


class RecordingRun(BaseModel):
    run_id: str
    stage: Literal["transcribing", "transcription_failed", "analyzing", "asking", "drafting", "ready", "failed"]
    initial: bool
    recording_ids: list[str]
    child_ids: list[str]
    flags: list[FlagResponse]
    failed_recordings: list[FailedRecording]
    candidates: list[RecordingCandidate]
    missing_children: list[str]
    error_code: str | None


class RecordingDraftState(BaseModel):
    used_recordings: dict[str, list[str]]
    run: RecordingRun | None


def _response(services: Services, teacher: CurrentTeacher, session_id: str) -> RecordingDraftState:
    draft, sources = services.recording_drafts.state(teacher, session_id)
    used = {child: source["recording_ids"] for child, source in sources.items()}
    if draft is None or draft["stage"] in ("done", "dismissed"):
        return RecordingDraftState(used_recordings=used, run=None)
    payload = draft["payload"]
    return RecordingDraftState(used_recordings=used, run=RecordingRun(
        run_id=draft["run_id"], stage=draft["stage"], initial=payload["initial"], recording_ids=payload["recording_ids"],
        child_ids=payload["targets"], flags=[FlagResponse(**flag) for flag in payload.get("flags", []) if flag["status"] == "open"],
        failed_recordings=[FailedRecording(**failure) for failure in payload.get("failed_recordings", [])],
        candidates=[RecordingCandidate(
            child_id=item["child_id"], child_name=item["child_name"], text=item["notice"]["text"],
            replaces_notice=payload["versions"][item["child_id"]] is not None,
        ) for item in payload.get("candidates", []) if not item["applied"]],
        missing_children=payload.get("missing_children", []), error_code=payload.get("error_code"),
    ))


@router.get("", response_model=RecordingDraftState)
def get_recording_draft(session_id: str, teacher: CurrentTeacher, services: ServicesDependency) -> RecordingDraftState:
    return _response(services, teacher, session_id)


@router.post("", response_model=RecordingDraftState, status_code=202)
def start_recording_draft(
    session_id: str, body: StartRecordingDraft, teacher: CurrentTeacher, services: ServicesDependency,
) -> RecordingDraftState:
    if (len(set(body.recording_ids)) != len(body.recording_ids)
            or (body.child_ids is not None and len(set(body.child_ids)) != len(body.child_ids))):
        raise ApiError(status_code=422, code="DUPLICATE_SELECTION", message="같은 녹음이나 아이를 한 번만 선택해 주세요.")
    if body.child_ids is None and not body.recording_ids:
        raise ApiError(status_code=422, code="NO_RECORDINGS", message="사용할 녹음을 선택해 주세요.")
    services.recording_drafts.start(teacher, session_id, body.recording_ids, body.child_ids)
    return _response(services, teacher, session_id)


@router.post("/{run_id}/transcriptions/{action}", response_model=RecordingDraftState, status_code=202)
def resolve_transcription(
    session_id: str, run_id: str, action: Literal["retry", "exclude"],
    teacher: CurrentTeacher, services: ServicesDependency,
) -> RecordingDraftState:
    services.recording_drafts.retry(teacher, session_id, run_id, exclude_failed=action == "exclude")
    return _response(services, teacher, session_id)


@router.post("/{run_id}/answers", response_model=RecordingDraftState, status_code=202)
def answer_recording_draft(
    session_id: str, run_id: str, body: DraftAnswers, teacher: CurrentTeacher, services: ServicesDependency,
) -> RecordingDraftState:
    answers = {key: (value or "").strip() or None for key, value in body.answers.items()}
    services.recording_drafts.answer(teacher, session_id, run_id, answers)
    return _response(services, teacher, session_id)


@router.post("/{run_id}/children/{child_id}/apply", response_model=RecordingDraftState)
def apply_recording_draft(
    session_id: str, run_id: str, child_id: str, teacher: CurrentTeacher, services: ServicesDependency,
) -> RecordingDraftState:
    services.recording_drafts.apply(teacher, session_id, run_id, child_id)
    return _response(services, teacher, session_id)


@router.delete("/{run_id}", response_model=RecordingDraftState)
def dismiss_recording_draft(
    session_id: str, run_id: str, teacher: CurrentTeacher, services: ServicesDependency,
) -> RecordingDraftState:
    services.recording_drafts.dismiss(teacher, session_id, run_id)
    return _response(services, teacher, session_id)
