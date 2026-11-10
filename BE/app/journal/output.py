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


def _current_source(services, key, *, include_document=False):
    teacher_id, child_id, date_from, date_to = key
    child = services.profile.get_child(teacher_id, child_id)
    rows = services.journal_store.list_for_child(teacher_id, child_id, date_from=date_from or None, date_to=date_to or None)
    form = template(services.database, teacher_id, include_document=include_document)
    return _source(services, teacher_id, child, rows, form), form


def preview(services, teacher_id: str, child: dict, date_from, date_to) -> dict:
    key = _key(teacher_id, child["child_id"], date_from, date_to)
    with services.database.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        (revision, text, days, _), form = _current_source(services, key)
        if not days:
            raise ApiError(status_code=422, code="EMPTY_JOURNAL_OUTPUT", message="이 기간에 출력할 관찰일지가 없어요.")
        saved = connection.execute(
            "INSERT INTO journal_outputs (teacher_id, child_id, range_from, range_to, revision, text) VALUES (?,?,?,?,?,?) "
            "ON CONFLICT(teacher_id, child_id, range_from, range_to) DO UPDATE "
            "SET revision=excluded.revision, text=excluded.text RETURNING word_revision",
            (*key, revision, text),
        ).fetchone()
    return {"text": text, "revision": revision, "has_word": saved["word_revision"] == revision, "can_export_word": form is not None}


def _changed() -> ApiError:
    return ApiError(status_code=409, code="JOURNAL_OUTPUT_CHANGED", message="일지나 양식이 바뀌었어요. 출력 화면을 다시 열어 주세요.")


def _saved_output(connection, key, revision: str):
    return connection.execute(
        "SELECT revision, CASE WHEN word_revision=? THEN word END AS word FROM journal_outputs " + _OUTPUT_WHERE,
        (revision, *key),
    ).fetchone()


def generate_word(services, teacher_id: str, child_id: str, date_from, date_to, revision: str) -> bytes:
    key = _key(teacher_id, child_id, date_from, date_to)
    with services.database.connect() as connection:
        saved = _saved_output(connection, key, revision)
    if saved is not None and saved["word"] is not None:
        return saved["word"]
    if saved is None or saved["revision"] != revision:
        raise _changed()

    (current_revision, _, days, rules), form = _current_source(services, key, include_document=True)
    if current_revision != revision:
        raise _changed()
    if form is None:
        raise ApiError(status_code=404, code="NO_WORD_TEMPLATE", message="설정에서 Word 양식을 올려 주세요.")

    document = word.fill_form(form["document"], days, rules, services, teacher_id)
    with services.database.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        saved = _saved_output(connection, key, revision)
        if saved is not None and saved["word"] is not None:
            return saved["word"]
        (latest_revision, *_), _ = _current_source(services, key)
        if saved is None or saved["revision"] != revision or latest_revision != revision:
            raise _changed()
        connection.execute(
            "UPDATE journal_outputs SET word=?, word_revision=? " + _OUTPUT_WHERE,
            (document, revision, *key),
        )
    return document


def download(database, teacher_id: str, child_id: str, date_from, date_to, revision: str) -> bytes:
    with database.connect() as connection:
        saved = _saved_output(connection, _key(teacher_id, child_id, date_from, date_to), revision)
    if saved is not None and saved["word"] is None and saved["revision"] != revision:
        raise _changed()
    if saved is None or saved["word"] is None:
        raise ApiError(status_code=404, code="NO_WORD_OUTPUT", message="Word 양식을 올린 뒤 출력해 주세요.")
    return saved["word"]
