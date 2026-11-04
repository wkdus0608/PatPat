from typing import Annotated

from fastapi import APIRouter, File, Form, Query, Request, Response, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import AwareDatetime

from app.api.common_responses import COMMON_ERROR_RESPONSES
from app.auth.dependencies import CurrentTeacher, require_teacher_ownership
from app.core.errors import ApiError
from app.recordings.dependencies import RecordingServiceDependency
from app.recordings.models import RecordingUpload
from app.schemas.common import ListQuery
from app.recordings.schemas import RecordingListResponse, RecordingResponse


AUDIO_CONTENT_TYPES = frozenset({
    "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/mpeg", "audio/wav",
    "audio/x-wav", "audio/webm", "audio/aac",
})
recordings_router = APIRouter(
    prefix="/recordings", tags=["recordings"],
    responses={code: COMMON_ERROR_RESPONSES[code] for code in (401, 404, 422, 500, 501)},
)


@recordings_router.post(
    "", status_code=201, response_model=RecordingResponse,
    summary="녹음 파일 업로드",
    description="원음을 검증해 비공개 저장소와 SQLite에 저장합니다. Idempotency-Key로 재전송 중복을 방지합니다.",
    responses={code: {"model": COMMON_ERROR_RESPONSES[422]["model"], "description": description} for code, description in ((409, "업로드 키 충돌"), (413, "파일 크기 초과"), (415, "지원하지 않거나 손상된 오디오"), (503, "오디오 검증 도구 미준비"))},
)
async def upload_recording(
    request: Request,
    teacher: CurrentTeacher,
    service: RecordingServiceDependency,
    file: Annotated[UploadFile, File()],
    title: Annotated[str, Form(min_length=1)],
    recorded_at: Annotated[AwareDatetime, Form()],
    duration_seconds: Annotated[float, Form(gt=0, allow_inf_nan=False)],
) -> RecordingResponse:
    form = await request.form()
    allowed = {"file", "title", "recorded_at", "duration_seconds"}
    if set(form) - allowed or any(len(form.getlist(key)) != 1 for key in allowed):
        raise ApiError(status_code=422, code="VALIDATION_ERROR", message="정의된 업로드 필드를 한 번씩 제출해 주세요.")
    if not title.strip():
        raise ApiError(status_code=422, code="VALIDATION_ERROR", message="녹음 제목을 입력해 주세요.")
    if file.content_type not in AUDIO_CONTENT_TYPES:
        raise ApiError(status_code=415, code="UNSUPPORTED_AUDIO_TYPE", message="지원하지 않는 오디오 형식입니다.")
    upload_key = request.headers.get("Idempotency-Key")
    if upload_key is not None and (not upload_key.strip() or len(upload_key) > 128):
        raise ApiError(status_code=422, code="VALIDATION_ERROR", message="업로드 키를 확인해 주세요.")
    recording = await service.upload(
        teacher=teacher,
        upload=RecordingUpload(
            title=title, recorded_at=recorded_at, duration_seconds=duration_seconds,
            content_type=file.content_type, stream=file.file,
            upload_key=upload_key,
        ),
    )
    require_teacher_ownership(owner_teacher_id=recording.teacher_id, teacher=teacher)
    return RecordingResponse.model_validate(recording)


@recordings_router.get("", response_model=RecordingListResponse, summary="내 녹음 목록 계약")
async def list_recordings(
    teacher: CurrentTeacher, service: RecordingServiceDependency,
    query: Annotated[ListQuery, Query()], response: Response,
) -> RecordingListResponse:
    page = await service.list(teacher=teacher, query=query)
    for recording in page.items:
        require_teacher_ownership(owner_teacher_id=recording.teacher_id, teacher=teacher)
    response.headers["Cache-Control"] = "no-store"
    return RecordingListResponse(items=[RecordingResponse.model_validate(item) for item in page.items],
                                 total=page.total, limit=query.limit, offset=query.offset)


@recordings_router.get("/{recording_id}", response_model=RecordingResponse, summary="내 녹음 상세 계약")
async def get_recording(
    recording_id: str, teacher: CurrentTeacher, service: RecordingServiceDependency
) -> RecordingResponse:
    recording = await service.get(teacher=teacher, recording_id=recording_id)
    require_teacher_ownership(owner_teacher_id=recording.teacher_id, teacher=teacher)
    return RecordingResponse.model_validate(recording)


@recordings_router.get(
    "/{recording_id}/audio", response_class=StreamingResponse,
    summary="인증된 비공개 녹음 재생 계약",
    responses={200: {"content": {mime: {"schema": {"type": "string", "format": "binary"}} for mime in AUDIO_CONTENT_TYPES}}},
)
async def play_recording(
    recording_id: str, teacher: CurrentTeacher, service: RecordingServiceDependency
) -> StreamingResponse:
    audio = await service.open_audio(teacher=teacher, recording_id=recording_id)
    require_teacher_ownership(owner_teacher_id=audio.teacher_id, teacher=teacher)
    return StreamingResponse(
        audio.chunks, media_type=audio.content_type,
        headers={"Cache-Control": "private, no-store", "Content-Length": str(audio.size_bytes)},
    )


@recordings_router.delete("/{recording_id}", status_code=204, response_class=Response, summary="녹음 삭제 계약")
async def delete_recording(
    recording_id: str, teacher: CurrentTeacher, service: RecordingServiceDependency
) -> Response:
    await service.delete(teacher=teacher, recording_id=recording_id)
    return Response(status_code=204)
