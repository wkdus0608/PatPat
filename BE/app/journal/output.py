"""Persist the last explicitly generated output for each child and date range."""
from hashlib import sha256
import json

from app.core.errors import ApiError
from app.journal import export, word, word_import
from app.journal.days import day_text, group_days

_OUTPUT_WHERE = "WHERE teacher_id=? AND child_id=? AND range_from=? AND range_to=?"


def template(database, teacher_id: str, *, include_document: bool = False):
    columns = "filename, revision, document" if include_document else "filename, revision"
    with database.connect() as connection:
        return connection.execute(
            "SELECT " + columns + " FROM teacher_journal_templates WHERE teacher_id=?", (teacher_id,),
        ).fetchone()


def save_template(database, teacher_id: str, filename: str, data: bytes, converter: str) -> None:
    revision = sha256(filename.encode() + b"\0" + data).hexdigest()
    document = word_import.normalize(data, filename, converter)
    with database.connect() as connection:
        connection.execute(
            "INSERT INTO teacher_journal_templates VALUES (?,?,?,?) "
            "ON CONFLICT(teacher_id) DO UPDATE SET filename=excluded.filename, revision=excluded.revision, document=excluded.document",
            (teacher_id, filename, revision, document),
        )


def delete_template(database, teacher_id: str) -> None:
    with database.connect() as connection:
        connection.execute("DELETE FROM teacher_journal_templates WHERE teacher_id=?", (teacher_id,))


def _source(services, teacher_id: str, child: dict, rows: list[dict], form) -> tuple[str, str, list[dict], str]:
    ready, _ = export.exportable(rows)
    text = export.as_text(child, ready)
    days = []
    rules = (services.profile.get_document(teacher_id, "record_format")[0] or "") if form else ""
    for entries in group_days(rows).values():
        day = day_text(entries)
        if not day["content"].strip():
            continue
        days.append({
            "이름": child["name"], "성별": child["gender"] or "", "생년월일": child["birth_date"] or "",
            "반": ", ".join(dict.fromkeys(entry["classroom_name"] for entry in entries if entry["classroom_name"])),
            "관찰일": day["observed_date"], "관찰장소": ", ".join(day["places"]),
            "관찰시간": ", ".join(day["times"]), "관찰영역": ", ".join(day["areas"]), "관찰내용": day["content"],
        })
    fingerprint = sha256(json.dumps([text, days, form["revision"] if form else None, rules], ensure_ascii=False).encode()).hexdigest()
    return fingerprint, text, days, rules


def _key(teacher_id: str, child_id: str, date_from, date_to) -> tuple[str, str, str, str]:
    return teacher_id, child_id, date_from.isoformat() if date_from else "", date_to.isoformat() if date_to else ""


def status(services, teacher_id: str, child: dict, rows: list[dict], date_from, date_to) -> dict:
    key = _key(teacher_id, child["child_id"], date_from, date_to)
    with services.database.connect() as connection:
        saved = connection.execute("SELECT revision FROM journal_outputs " + _OUTPUT_WHERE, key).fetchone()
    if saved is None:
        return {"output_revision": None, "output_stale": False}
    revision, *_ = _source(services, teacher_id, child, rows, template(services.database, teacher_id))
    return {"output_revision": saved["revision"], "output_stale": saved["revision"] != revision}


def _metadata(saved) -> dict:
    return {"text": saved["text"], "revision": saved["revision"], "has_word": bool(saved["has_word"])}


def generate(services, teacher_id: str, child: dict, date_from, date_to) -> dict:
    key = _key(teacher_id, child["child_id"], date_from, date_to)

    def current_source(*, include_document=False):
        current_child = services.profile.get_child(teacher_id, child["child_id"])
        rows = services.journal_store.list_for_child(teacher_id, child["child_id"], date_from=key[2] or None, date_to=key[3] or None)
        form = template(services.database, teacher_id, include_document=include_document)
        return _source(services, teacher_id, current_child, rows, form), form

    (revision, text, days, rules), form = current_source(include_document=True)
    if not days:
        raise ApiError(status_code=422, code="EMPTY_JOURNAL_OUTPUT", message="이 기간에 출력할 관찰일지가 없어요.")
    with services.database.connect() as connection:
        saved = connection.execute(
            "SELECT revision, text, word IS NOT NULL AS has_word FROM journal_outputs " + _OUTPUT_WHERE, key,
        ).fetchone()
        if saved is not None and saved["revision"] == revision:
            return _metadata(saved)

    document = word.fill_form(form["document"], days, rules, services, teacher_id) if form else None
    with services.database.connect() as connection:
        # A template or a journal edit may have been saved while the AI was working.
        connection.execute("BEGIN IMMEDIATE")
        (latest_revision, *_), _ = current_source()
        if latest_revision != revision:
            raise ApiError(status_code=409, code="JOURNAL_OUTPUT_CHANGED", message="출력하는 동안 일지나 양식이 바뀌었어요. 다시 출력해 주세요.")
        connection.execute(
            "INSERT INTO journal_outputs VALUES (?,?,?,?,?,?,?) "
            "ON CONFLICT(teacher_id, child_id, range_from, range_to) DO UPDATE "
            "SET revision=excluded.revision, text=excluded.text, word=excluded.word",
            (*key, revision, text, document),
        )
    return {"text": text, "revision": revision, "has_word": document is not None}


def download(database, teacher_id: str, child_id: str, date_from, date_to, revision: str) -> bytes:
    with database.connect() as connection:
        saved = connection.execute(
            "SELECT revision, word FROM journal_outputs " + _OUTPUT_WHERE, _key(teacher_id, child_id, date_from, date_to),
        ).fetchone()
    if saved is not None and saved["revision"] != revision:
        raise ApiError(status_code=409, code="JOURNAL_OUTPUT_CHANGED", message="출력본이 갱신됐어요. 출력 화면을 다시 열어 주세요.")
    if saved is None or saved["word"] is None:
        raise ApiError(status_code=404, code="NO_WORD_OUTPUT", message="Word 양식을 올린 뒤 출력해 주세요.")
    return saved["word"]
