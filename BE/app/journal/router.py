from datetime import date
from typing import Annotated, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Query, Request, UploadFile
from starlette.concurrency import run_in_threadpool
from fastapi.responses import PlainTextResponse, Response

from app.api.common_responses import COMMON_ERROR_RESPONSES
from app.auth.dependencies import CurrentTeacher
from app.children.router import private_response
from app.core.errors import ApiError
from app.jobs.router import JobResponse, job_response
from app.journal import export, output, word, word_import
from app.journal.days import editable_day, group_days
from app.journal.schemas import (
    DaysPatch, EntryPatch, JournalArchiveEntry, JournalChild, JournalDayResponse, JournalEntryResponse,
    JournalOutput, JournalResponse, JournalTemplate,
)
from app.rules.loader import AREAS
from app.schemas.common import ErrorResponse
from app.services import Services, get_services

journal_router = APIRouter(
    tags=["journal"],
    dependencies=[Depends(private_response)],
    responses={
        **{status: COMMON_ERROR_RESPONSES[status] for status in (401, 404, 409, 422, 500)},
        503: {"model": ErrorResponse, "description": "AI를 쓸 수 없음(키 미등록·점검·한도). code로 구분합니다."},
    },
)

ServicesDependency = Annotated[Services, Depends(get_services)]
EXPORT_RESPONSES = {200: {"content": {"text/plain": {}}, "description": "붙여 넣기용 글"}}


def entry_response(entry: dict) -> JournalEntryResponse:
    return JournalEntryResponse(**{key: entry[key] for key in JournalEntryResponse.model_fields})


def _child(services: Services, teacher_id: str, child_id: str) -> dict:
    child = services.profile.get_child(teacher_id, child_id)
    if child is None:
        raise ApiError(status_code=404, code="NOT_FOUND", message="아동을 찾을 수 없습니다.")
    return child


@journal_router.get(
    "/children/{child_id}/journal",
    response_model=JournalResponse,
    summary="아이의 관찰일지",
    description="아이 한 명의 관찰일지 행을 날짜순으로 돌려줍니다(공통 행이 그날의 개별 행보다 앞). 상반기·하반기 같은 기간은 from/to로 거릅니다. "
    "알림장을 확정하면 행이 쌓이고, 만드는 중이면 status가 pending입니다.",
)
def child_journal(
    child_id: str,
    teacher: CurrentTeacher,
    services: ServicesDependency,
    date_from: Annotated[date | None, Query(alias="from")] = None,
    date_to: Annotated[date | None, Query(alias="to")] = None,
) -> JournalResponse:
    child = _child(services, teacher.teacher_id, child_id)
    rows = services.journal_store.list_for_child(
        teacher.teacher_id, child_id,
        date_from=date_from.isoformat() if date_from else None, date_to=date_to.isoformat() if date_to else None,
    )
    return JournalResponse(
        child=JournalChild(child_id=child["child_id"], name=child["name"], gender=child["gender"], birth_date=child["birth_date"]),
        items=[entry_response(row) for row in rows],
        days=[JournalDayResponse(**editable_day(entries)) for entries in group_days(rows).values()],
        **output.status(services, teacher.teacher_id, child, rows, date_from, date_to),
    )


@journal_router.patch(
    "/children/{child_id}/journal",
    response_model=list[JournalDayResponse],
    summary="날짜별 관찰일지 본문 수정",
    description="확정된 관찰의 날짜별 본문을 한 번에 저장합니다. 원본 행과 관찰 영역·장소·시간은 보존합니다.",
)
def patch_days(
    child_id: str, body: DaysPatch, teacher: CurrentTeacher, services: ServicesDependency,
) -> list[JournalDayResponse]:
    _child(services, teacher.teacher_id, child_id)
    changes = {day.observed_date.isoformat(): (day.content, day.expected_revision) for day in body.days}
    if len(changes) != len(body.days):
        raise ApiError(status_code=422, code="VALIDATION_ERROR", message="같은 날짜를 한 번만 보내 주세요.")
    if any(not day.content.strip() for day in body.days):
        raise ApiError(status_code=422, code="EMPTY_TEXT", message="관찰내용을 입력해 주세요.")
    return [JournalDayResponse(**day) for day in services.journal_store.update_days(teacher.teacher_id, child_id, changes)]


@journal_router.get(
    "/journal/archive",
    response_model=list[JournalArchiveEntry],
    summary="보관함의 날짜별 관찰일지",
    description="확정된 관찰일지를 날짜·아동순으로 반환합니다. 비활성 아동의 기록도 포함합니다.",
)
def journal_archive(teacher: CurrentTeacher, services: ServicesDependency) -> list[JournalArchiveEntry]:
    return [JournalArchiveEntry(**day) for day in services.journal_store.archive(teacher.teacher_id)]


@journal_router.get(
    "/children/{child_id}/journal/export",
    response_class=PlainTextResponse,
    responses=EXPORT_RESPONSES,
    summary="관찰일지 붙여 넣기용 글",
    description="관찰일지를 항목별 글 또는 탭 구분 표로 돌려줍니다. "
    "format=text는 날짜마다 한 묶음의 글, tsv는 표(탭 구분)입니다. 포함으로 표시한 행 중 만들어진 것만 담고, "
    "아직 만드는 중이거나 실패한 행의 수는 X-Skipped-Count 헤더로 알립니다.",
)
def export_journal(
    child_id: str,
    teacher: CurrentTeacher,
    services: ServicesDependency,
    format: Literal["text", "tsv"] = "text",
    date_from: Annotated[date | None, Query(alias="from")] = None,
    date_to: Annotated[date | None, Query(alias="to")] = None,
) -> PlainTextResponse:
    child = _child(services, teacher.teacher_id, child_id)
    rows = services.journal_store.list_for_child(
        teacher.teacher_id, child_id,
        date_from=date_from.isoformat() if date_from else None, date_to=date_to.isoformat() if date_to else None,
    )
    ready, skipped = export.exportable(rows)
    body = export.as_text(child, ready) if format == "text" else export.as_tsv(ready)
    return PlainTextResponse(body, headers={"X-Skipped-Count": str(skipped), "X-Exported-Count": str(len(ready))})


@journal_router.get("/teacher/journal-template", response_model=JournalTemplate, summary="관찰일지 Word 양식 조회")
def get_template(teacher: CurrentTeacher, services: ServicesDependency) -> JournalTemplate:
    form = output.template(services.database, teacher.teacher_id)
    return JournalTemplate(filename=form["filename"] if form else None)


@journal_router.put("/teacher/journal-template", response_model=JournalTemplate, summary="관찰일지 Word 양식 업로드")
def put_template(teacher: CurrentTeacher, services: ServicesDependency, file: Annotated[UploadFile | str | None, File()] = None) -> JournalTemplate:
    if file is None or isinstance(file, str):
        raise ApiError(status_code=422, code="WORD_FILE_MISSING", message="양식 파일을 받지 못했어요. 화면을 새로고침한 뒤 파일을 다시 선택해 주세요.")
    filename = word_import.clean_filename(file.filename or "")
    output.save_template(services.database, teacher.teacher_id, filename, file.file.read(word.MAX_TEMPLATE_BYTES + 1),
                         services.settings.word_converter)
    return JournalTemplate(filename=filename)


@journal_router.post("/teacher/journal-template", response_model=JournalTemplate, summary="관찰일지 Word 호환 양식 업로드")
async def upload_template(request: Request, filename: str, teacher: CurrentTeacher, services: ServicesDependency) -> JournalTemplate:
    filename = word_import.clean_filename(filename)
    data = bytearray()
    async for chunk in request.stream():
        word.check_template_size(len(data) + len(chunk))
        data.extend(chunk)
    await run_in_threadpool(output.save_template, services.database, teacher.teacher_id, filename, bytes(data),
                            services.settings.word_converter)
    return JournalTemplate(filename=filename)


@journal_router.delete("/teacher/journal-template", status_code=204, summary="관찰일지 Word 양식 제거")
def remove_template(teacher: CurrentTeacher, services: ServicesDependency) -> Response:
    output.delete_template(services.database, teacher.teacher_id)
    return Response(status_code=204)


@journal_router.post("/children/{child_id}/journal/output", response_model=JournalOutput, summary="관찰일지 텍스트 출력 또는 재출력")
def preview_output(
    child_id: str, teacher: CurrentTeacher, services: ServicesDependency,
    date_from: Annotated[date | None, Query(alias="from")] = None,
    date_to: Annotated[date | None, Query(alias="to")] = None,
) -> JournalOutput:
    child = _child(services, teacher.teacher_id, child_id)
    return JournalOutput(**output.preview(services, teacher.teacher_id, child, date_from, date_to))


def _word_response(name: str, data: bytes) -> Response:
    filename = quote(name + " 관찰일지.docx", safe="")
    return Response(data, media_type=word.WORD_MIME, headers={"Content-Disposition": "attachment; filename*=UTF-8''" + filename})


@journal_router.post("/children/{child_id}/journal/output/word", summary="관찰일지 Word 출력본 생성 또는 다운로드")
def generate_word_output(
    child_id: str, revision: str, teacher: CurrentTeacher, services: ServicesDependency,
    date_from: Annotated[date | None, Query(alias="from")] = None,
    date_to: Annotated[date | None, Query(alias="to")] = None,
) -> Response:
    child = _child(services, teacher.teacher_id, child_id)
    return _word_response(child["name"], output.generate_word(services, teacher.teacher_id, child_id, date_from, date_to, revision))


@journal_router.get("/children/{child_id}/journal/output/word", summary="저장된 관찰일지 Word 출력본 다운로드")
def download_output(
    child_id: str, revision: str, teacher: CurrentTeacher, services: ServicesDependency,
    date_from: Annotated[date | None, Query(alias="from")] = None,
    date_to: Annotated[date | None, Query(alias="to")] = None,
) -> Response:
    child = _child(services, teacher.teacher_id, child_id)
    data = output.download(services.database, teacher.teacher_id, child_id, date_from, date_to, revision)
    return _word_response(child["name"], data)


@journal_router.patch(
    "/journal-entries/{entry_id}",
    response_model=JournalEntryResponse,
    summary="관찰일지 행 수정",
    description="보낸 필드만 바꿉니다. 내용·장소·시간·영역을 고친 행(edited)은 알림장을 다시 확정해도 덮어쓰지 않습니다. "
    "included만 바꾸면 edited가 되지 않습니다. 만드는 중(pending)에는 409입니다.",
)
def patch_entry(entry_id: str, body: EntryPatch, teacher: CurrentTeacher, services: ServicesDependency) -> JournalEntryResponse:
    changes = body.model_dump(include=body.model_fields_set - {"expected_version"})
    if not changes:
        raise ApiError(status_code=422, code="VALIDATION_ERROR", message="바꿀 항목을 하나 이상 보내 주세요.")
    for key in ("content", "areas", "included"):
        if key in changes and changes[key] is None:
            raise ApiError(status_code=422, code="VALIDATION_ERROR", message=f"{key}는 null일 수 없습니다.")
    if "content" in changes:
        changes["content"] = changes["content"].replace("\r\n", "\n").strip()
        if not changes["content"]:
            raise ApiError(status_code=422, code="EMPTY_TEXT", message="관찰내용이 비어 있습니다.")
    if "areas" in changes:
        changes["areas"] = [area for area in AREAS if area in set(changes["areas"])]
    return entry_response(services.journal_store.update(teacher.teacher_id, entry_id, body.expected_version, changes))


@journal_router.post(
    "/journal-entries/{entry_id}/regenerate",
    status_code=202,
    response_model=JobResponse,
    summary="관찰일지 행 다시 만들기",
    description="가장 최근에 확정한 알림장 글로 이 행을 다시 씁니다. 직접 고친 내용은 사라집니다.",
)
def regenerate_entry(entry_id: str, teacher: CurrentTeacher, services: ServicesDependency) -> JobResponse:
    return job_response(services.journal.regenerate_entry(teacher.teacher_id, entry_id))
