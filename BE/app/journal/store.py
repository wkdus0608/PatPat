"""Observation-journal rows, kept per child and per day.

A row is a copy of one paragraph's worth of the day: the shared (common) paragraph and the child's own
paragraph are separate rows, as in the 관찰일지 forms the teachers paste into. Rows the teacher edited are
never overwritten by a later re-confirm; they are only marked outdated.
"""
import json

from app.core.database import Database
from app.core.errors import ApiError
from app.core.timeutil import new_id, now_iso
from app.journal.days import day_text, editable_day, group_days
from app.journal.interpretation import split_interpretation

NO_INDIVIDUAL_NOTE = "개별 관찰 없음(반 공통 활동만 기록함)."
_DAY_ORDER = "(e.notice_id IS NULL), (e.block_kind='individual'), e.created_at, e.rowid"

EditVersions = tuple[int, tuple[tuple[str, int], ...]]

_SELECT = (
    "SELECT e.*, c.name AS child_name, COALESCE(n.version, 0) AS notice_version, "
    "COALESCE(n.status, '완료') AS notice_status, COALESCE(n.withdrawn, 0) AS notice_withdrawn, "
    "d.content AS day_content, d.version AS day_version, room.name AS classroom_name "
    "FROM journal_entries e JOIN children c ON c.child_id = e.child_id LEFT JOIN notices n ON n.notice_id = e.notice_id "
    "LEFT JOIN writing_sessions s ON s.session_id=n.session_id "
    "LEFT JOIN classrooms room ON room.classroom_id=COALESCE(e.classroom_id, s.classroom_id) "
    "LEFT JOIN journal_day_edits d ON d.teacher_id=e.teacher_id AND d.child_id=e.child_id AND d.observed_date=e.observed_date"
)


def entry_not_found() -> ApiError:
    return ApiError(status_code=404, code="NOT_FOUND", message="관찰일지 행을 찾을 수 없습니다.")


class JournalStore:
    def __init__(self, database: Database):
        self.database = database

    # --- reading ----------------------------------------------------------------------------------------------------
    @staticmethod
    def _entry(row) -> dict:
        data = dict(row)
        data["areas"] = json.loads(data["areas"])
        data["included"] = bool(data["included"])
        data["is_draft"] = bool(data["from_inputs"] and data["notice_status"] != "완료")
        data["outdated"] = not data["from_inputs"] and data["source_notice_version"] < data["notice_version"]
        if data["notice_id"] is None:
            # A day edit that includes linked observations applies only while linked rows are visible.
            data.update(day_content=None, day_version=None)
        return data

    @staticmethod
    def _present(entries: list[dict]) -> list[dict]:
        """개별 관찰이 없는 아이(알림장에 반 공통 행만 있음)의 일지에는 아이 개인의 경험처럼 읽히는 해석 문장을 빼고
        개별 관찰이 없다고 적는다. 저장된 글은 그대로 두고 보여 줄 때만 바꾸며, 교사가 고친 글은 건드리지 않는다."""
        kinds: dict[str, set[str]] = {}
        for entry in entries:
            kinds.setdefault(entry["notice_id"], set()).add(entry["block_kind"])
        shown = []
        for entry in entries:
            if entry["block_kind"] == "common" and kinds[entry["notice_id"]] == {"common"} and entry["status"] == "ready" and entry["content"]:
                observed, _ = split_interpretation(entry["content"])
                entry = {**entry, "content": f"{observed.rstrip()}\n{NO_INDIVIDUAL_NOTE}"}
            shown.append(entry)
        return shown

    def get(self, teacher_id: str, entry_id: str) -> dict | None:
        with self.database.connect() as connection:
            row = connection.execute(_SELECT + " WHERE e.teacher_id=? AND e.entry_id=?", (teacher_id, entry_id)).fetchone()
        return self._entry(row) if row else None

    def require(self, teacher_id: str, entry_id: str) -> dict:
        entry = self.get(teacher_id, entry_id)
        if entry is None:
            raise entry_not_found()
        return entry

    def list_for_child(
        self, teacher_id: str, child_id: str, *, date_from: str | None = None, date_to: str | None = None
    ) -> list[dict]:
        clauses, values = ["e.teacher_id=?", "e.child_id=?", "COALESCE(n.withdrawn, 0)=0"], [teacher_id, child_id]
        if date_from:
            clauses.append("e.observed_date>=?")
            values.append(date_from)
        if date_to:
            clauses.append("e.observed_date<=?")
            values.append(date_to)
        with self.database.connect() as connection:
            rows = connection.execute(
                _SELECT + " WHERE " + " AND ".join(clauses)
                + " ORDER BY e.observed_date, " + _DAY_ORDER,
                values,
            ).fetchall()
        return self._present([self._entry(row) for row in rows])

    def archive(self, teacher_id: str) -> list[dict]:
        with self.database.connect() as connection:
            rows = connection.execute(
                _SELECT + " WHERE e.teacher_id=? AND COALESCE(n.withdrawn, 0)=0 "
                "AND COALESCE(n.status, '완료')='완료' AND e.included=1 "
                "ORDER BY e.observed_date, c.rowid, " + _DAY_ORDER,
                (teacher_id,),
            ).fetchall()
        days = [day_text(entries) for entries in group_days(self._present([self._entry(row) for row in rows])).values()]
        return [day for day in days if day["content"].strip()]

    def update_days(self, teacher_id: str, child_id: str, changes: dict[str, tuple[str, str]]) -> list[dict]:
        saved = []
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute(
                _SELECT + " WHERE e.teacher_id=? AND e.child_id=? AND COALESCE(n.withdrawn, 0)=0 "
                "AND e.observed_date BETWEEN ? AND ? "
                "ORDER BY e.observed_date, " + _DAY_ORDER,
                (teacher_id, child_id, min(changes), max(changes)),
            ).fetchall()
            groups = group_days([self._entry(row) for row in rows])
            for observed_date, (content, expected_revision) in changes.items():
                entries = groups.get((child_id, observed_date))
                if not entries:
                    raise ApiError(status_code=409, code="VERSION_CONFLICT",
                                   message=f"{observed_date}의 확정된 관찰이 바뀌었어요. 수정 화면을 다시 열어 주세요.")
                day = editable_day(entries)
                if content != day["content"]:
                    if not day["editable"] or expected_revision != day["revision"]:
                        raise ApiError(status_code=409, code="VERSION_CONFLICT",
                                       message=f"{observed_date}의 내용이 바뀌었어요. 수정 화면을 다시 열어 주세요.")
                    first = entries[0]
                    if first["notice_id"] is None:
                        connection.execute(
                            "UPDATE journal_entries SET content=?, status='edited', version=version+1, updated_at=? "
                            "WHERE entry_id=?", (content, now_iso(), first["entry_id"]),
                        )
                        connection.execute(
                            "DELETE FROM journal_day_edits WHERE teacher_id=? AND child_id=? AND observed_date=?",
                            (teacher_id, child_id, observed_date),
                        )
                        first.update(content=content, version=first["version"] + 1)
                    else:
                        version = day["edit_version"] + 1
                        connection.execute(
                            "INSERT INTO journal_day_edits (teacher_id, child_id, observed_date, content, version) VALUES (?,?,?,?,?) "
                            "ON CONFLICT (teacher_id, child_id, observed_date) DO UPDATE "
                            "SET content=excluded.content, version=excluded.version",
                            (teacher_id, child_id, observed_date, content, version),
                        )
                        first.update(day_content=content, day_version=version)
                    day = editable_day(entries)
                saved.append(day)
        return saved

    def find_shared_content(self, session_id: str, block_id: str, source_hash: str, areas: list[str],
                            place: str | None, time_text: str | None) -> str | None:
        """A finished common row of another child with exactly the same source, so the class text is written once."""
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT content FROM journal_entries WHERE session_id=? AND block_id=? AND block_kind='common' "
                "AND source_hash=? AND areas=? AND place IS ? AND time_text IS ? AND status='ready' AND content<>'' LIMIT 1",
                (session_id, block_id, source_hash, json.dumps(areas, ensure_ascii=False), place, time_text),
            ).fetchone()
        return row["content"] if row else None

    # --- writing -------------------------------------------------------------------------------------------------------
    def save_standalone(
        self, teacher_id: str, child_id: str, observed_date: str, *,
        content: str, areas: list[str], place: str | None, time_text: str | None,
    ) -> dict:
        key = (teacher_id, child_id, observed_date)
        stamp, entry_id = now_iso(), new_id()
        encoded_areas = json.dumps(areas, ensure_ascii=False)
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            child = connection.execute(
                "SELECT p.classroom_id FROM children c LEFT JOIN child_profiles p ON p.child_id=c.child_id "
                "WHERE c.teacher_id=? AND c.child_id=? AND c.is_active=1", (teacher_id, child_id),
            ).fetchone()
            if child is None:
                raise ApiError(status_code=404, code="NOT_FOUND", message="명단에서 아동을 찾을 수 없어요.")
            existing = connection.execute(
                _SELECT + " WHERE e.teacher_id=? AND e.child_id=? AND e.observed_date=? AND e.notice_id IS NULL", key,
            ).fetchone()
            if existing:
                if (existing["content"], existing["areas"], existing["place"], existing["time_text"]) == (
                    content, encoded_areas, place, time_text,
                ):
                    return self._entry(existing)
                raise ApiError(status_code=409, code="JOURNAL_ALREADY_EXISTS",
                               message="이 아동의 독립 관찰일지가 이미 있어요. 목록의 수정하기를 이용해 주세요.")
            connection.execute(
                "INSERT INTO journal_entries(entry_id, teacher_id, child_id, observed_date, classroom_id, block_kind, "
                "place, time_text, areas, content, status, source_notice_version, created_at, updated_at) "
                "VALUES (?,?,?,?,?,'individual',?,?,?,?,'ready',0,?,?)",
                (entry_id, *key, child["classroom_id"], place, time_text, encoded_areas, content, stamp, stamp),
            )
            # An existing day edit replaces its source rows when rendered. Keep the new observation visible there too.
            connection.execute(
                "UPDATE journal_day_edits SET content=content || char(10) || char(10) || ?, version=version+1 "
                "WHERE teacher_id=? AND child_id=? AND observed_date=?", (content, *key),
            )
            return self._entry(connection.execute(_SELECT + " WHERE e.entry_id=?", (entry_id,)).fetchone())

    def has_input_rows(self, notice_id: str) -> bool:
        with self.database.connect() as connection:
            return connection.execute(
                "SELECT 1 FROM journal_entries WHERE notice_id=? AND from_inputs=1 LIMIT 1", (notice_id,),
            ).fetchone() is not None

    @staticmethod
    def _edit_versions(connection, notice: dict) -> EditVersions:
        day = connection.execute(
            "SELECT version FROM journal_day_edits WHERE teacher_id=? AND child_id=? AND observed_date=?",
            (notice["teacher_id"], notice["child_id"], notice["target_date"]),
        ).fetchone()
        rows = connection.execute(
            "SELECT entry_id, version FROM journal_entries WHERE notice_id=? AND status='edited' ORDER BY entry_id",
            (notice["notice_id"],),
        )
        return (day["version"] if day else 0, tuple((row["entry_id"], row["version"]) for row in rows))

    def edit_versions(self, notice: dict) -> EditVersions:
        with self.database.connect() as connection:
            return self._edit_versions(connection, notice)

    def apply_notice_refresh(self, notice: dict, rows: list[dict], expected_edits: EditVersions) -> None:
        """Publish a complete rewrite only if its confirmed notice and the teacher's edits are still current."""
        stamp = now_iso()
        teacher_id, notice_id = notice["teacher_id"], notice["notice_id"]
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            active = connection.execute(
                "SELECT 1 FROM notices WHERE teacher_id=? AND notice_id=? AND version=? AND status='완료' AND withdrawn=0",
                (teacher_id, notice_id, notice["version"]),
            ).fetchone()
            if active is None or self._edit_versions(connection, notice) != expected_edits:
                raise ApiError(status_code=409, code="VERSION_CONFLICT", message="알림장이나 관찰일지가 먼저 바뀌었어요.")
            for row in rows:
                connection.execute(
                    "INSERT INTO journal_entries(entry_id, teacher_id, child_id, session_id, block_id, notice_id, "
                    "block_kind, observed_date, place, time_text, areas, content, status, included, version, "
                    "source_notice_version, source_hash, created_at, updated_at, from_inputs) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'ready',1,1,?,?,?,?,0) "
                    "ON CONFLICT(child_id, block_id) DO UPDATE SET notice_id=excluded.notice_id, "
                    "block_kind=excluded.block_kind, place=excluded.place, time_text=excluded.time_text, areas=excluded.areas, "
                    "content=excluded.content, status='ready', error_code=NULL, version=journal_entries.version+1, "
                    "source_notice_version=excluded.source_notice_version, source_hash=excluded.source_hash, "
                    "updated_at=excluded.updated_at, from_inputs=0",
                    (new_id(), teacher_id, notice["child_id"], notice["session_id"], row["block_id"], notice_id,
                     row["block_kind"], notice["target_date"], row["place"], row["time_text"],
                     json.dumps(row["areas"], ensure_ascii=False), row["content"],
                     notice["version"], row["source_hash"], stamp, stamp),
                )
            block_ids = [row["block_id"] for row in rows]
            placeholders = ",".join("?" for _ in block_ids)
            connection.execute(
                f"DELETE FROM journal_entries WHERE teacher_id=? AND notice_id=? AND block_id NOT IN ({placeholders})",
                (teacher_id, notice_id, *block_ids),
            )
            day = (teacher_id, notice["child_id"], notice["target_date"])
            connection.execute(
                "DELETE FROM journal_day_edits WHERE teacher_id=? AND child_id=? AND observed_date=? "
                "AND NOT EXISTS (SELECT 1 FROM journal_entries "
                "WHERE teacher_id=? AND child_id=? AND observed_date=? AND notice_id IS NULL)", (*day, *day),
            )

    def sync_rows(self, *, teacher_id: str, notice: dict, specs: list[dict], from_inputs: bool = False) -> list[str]:
        """Bring this child's rows of the session in line with a confirmed notice; return the rows to (re)generate."""
        to_generate: list[str] = []
        stamp = now_iso()
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            active = connection.execute(
                "SELECT 1 FROM notices WHERE notice_id=? AND teacher_id=? AND version=? AND status=? AND withdrawn=0",
                (notice["notice_id"], teacher_id, notice["version"], "검토중" if from_inputs else "완료"),
            ).fetchone()
            if active is None:
                return []
            existing = {
                row["block_id"]: row for row in connection.execute(
                    "SELECT * FROM journal_entries WHERE child_id=? AND session_id=?", (notice["child_id"], notice["session_id"])
                )
            }
            wanted = set()
            for spec in specs:
                wanted.add(spec["block_id"])
                areas = json.dumps(spec["areas"], ensure_ascii=False)
                row = existing.get(spec["block_id"])
                if row is None:
                    entry_id = new_id()
                    connection.execute(
                        "INSERT INTO journal_entries(entry_id, teacher_id, child_id, session_id, block_id, notice_id, block_kind, "
                        "observed_date, place, time_text, areas, content, status, included, version, source_notice_version, "
                        "source_hash, created_at, updated_at, from_inputs) VALUES (?,?,?,?,?,?,?,?,?,?,?,'','pending',1,1,?,?,?,?,?)",
                        (entry_id, teacher_id, notice["child_id"], notice["session_id"], spec["block_id"], notice["notice_id"],
                         spec["block_kind"], notice["target_date"], spec["place"], spec["time_text"], areas,
                         notice["version"], spec["source_hash"], stamp, stamp, int(from_inputs)),
                    )
                    to_generate.append(entry_id)
                    continue
                same_source = row["source_hash"] == spec["source_hash"]
                if row["status"] == "edited":
                    if same_source:  # the paragraph is the same, so the teacher's version is still the right one
                        connection.execute(
                            "UPDATE journal_entries SET source_notice_version=?, notice_id=?, updated_at=? WHERE entry_id=?",
                            (notice["version"], notice["notice_id"], stamp, row["entry_id"]),
                        )
                    continue  # otherwise it stays outdated until the teacher regenerates it
                unchanged = (
                    same_source and row["from_inputs"] == int(from_inputs) and row["status"] == "ready" and row["areas"] == areas
                    and row["place"] == spec["place"] and row["time_text"] == spec["time_text"]
                )
                if unchanged:
                    connection.execute(
                        "UPDATE journal_entries SET source_notice_version=?, notice_id=?, updated_at=? WHERE entry_id=?",
                        (notice["version"], notice["notice_id"], stamp, row["entry_id"]),
                    )
                    continue
                connection.execute(
                    "UPDATE journal_entries SET notice_id=?, place=?, time_text=?, areas=?, status='pending', error_code=NULL, "
                    "version=version+1, source_notice_version=?, source_hash=?, updated_at=?, from_inputs=? WHERE entry_id=?",
                    (notice["notice_id"], spec["place"], spec["time_text"], areas, notice["version"], spec["source_hash"], stamp,
                     int(from_inputs), row["entry_id"]),
                )
                to_generate.append(row["entry_id"])
            for block_id, row in existing.items():
                if block_id not in wanted and row["status"] != "edited":
                    connection.execute("DELETE FROM journal_entries WHERE entry_id=?", (row["entry_id"],))
        return to_generate

    def mark_pending(self, entry_id: str, *, notice_version: int, source_hash: str, areas: list[str],
                     place: str | None, time_text: str | None) -> None:
        with self.database.connect() as connection:
            connection.execute(
                "UPDATE journal_entries SET place=?, time_text=?, areas=?, status='pending', error_code=NULL, "
                "version=version+1, source_notice_version=?, source_hash=?, updated_at=? WHERE entry_id=?",
                (place, time_text, json.dumps(areas, ensure_ascii=False), notice_version, source_hash, now_iso(), entry_id),
            )

    def mark_ready(self, entry_id: str, content: str, expected_version: int) -> None:
        with self.database.connect() as connection:
            connection.execute(
                "UPDATE journal_entries SET content=?, status='ready', error_code=NULL, version=version+1, updated_at=? "
                "WHERE entry_id=? AND status='pending' AND version=?",
                (content, now_iso(), entry_id, expected_version),
            )

    def mark_failed(self, entry_id: str, error_code: str, expected_version: int) -> None:
        with self.database.connect() as connection:
            connection.execute(
                "UPDATE journal_entries SET status='failed', error_code=?, version=version+1, updated_at=? "
                "WHERE entry_id=? AND status='pending' AND version=?",
                (error_code, now_iso(), entry_id, expected_version),
            )

    def fail_all_pending_for_notice(self, notice_id: str, error_code: str, source_version: int | None = None) -> None:
        with self.database.connect() as connection:
            connection.execute(
                "UPDATE journal_entries SET status='failed', error_code=?, version=version+1, updated_at=? "
                "WHERE notice_id=? AND status='pending' AND (? IS NULL OR source_notice_version=?)",
                (error_code, now_iso(), notice_id, source_version, source_version),
            )

    def update(self, teacher_id: str, entry_id: str, expected_version: int, changes: dict) -> dict:
        """Teacher edit. Content, place, time or areas make the row 'edited'; `included` alone does not."""
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT e.* FROM journal_entries e LEFT JOIN notices n ON n.notice_id=e.notice_id "
                "WHERE e.teacher_id=? AND e.entry_id=? AND COALESCE(n.withdrawn, 0)=0", (teacher_id, entry_id)
            ).fetchone()
            if row is None:
                raise entry_not_found()
            if row["status"] == "pending":
                raise ApiError(status_code=409, code="ENTRY_BUSY", message="이 행을 만드는 중이에요. 끝난 뒤에 고쳐 주세요.")
            if row["version"] != expected_version:
                raise ApiError(status_code=409, code="VERSION_CONFLICT",
                               message="다른 화면에서 먼저 바뀌었습니다. 새로 불러온 뒤 다시 시도해 주세요.",
                               details={"current_version": row["version"]})
            assignments, values = [], []
            if "included" in changes:
                assignments.append("included=?")
                values.append(1 if changes["included"] else 0)
            content_fields = {key: changes[key] for key in ("content", "place", "time_text") if key in changes}
            if "areas" in changes:
                content_fields["areas"] = json.dumps(changes["areas"], ensure_ascii=False)
            for key, value in content_fields.items():
                assignments.append(f"{key}=?")
                values.append(value)
            if content_fields:
                assignments.append("status='edited'")
                assignments.append("error_code=NULL")
            if assignments:
                connection.execute(
                    f"UPDATE journal_entries SET {', '.join(assignments)}, version=version+1, updated_at=? WHERE entry_id=?",
                    (*values, now_iso(), entry_id),
                )
        return self.require(teacher_id, entry_id)
