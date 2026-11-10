"""Notices: one per child per writing session, with a version counter, a history, and AI revision candidates.

Every change to a notice (generation, manual edit, confirm, adopting a revision) writes a new version and a
history row, and every write checks the version the client saw, so two screens can never overwrite each other.
"""
import json
from difflib import SequenceMatcher
from typing import Literal

from app.core.database import Database
from app.core.errors import ApiError
from app.core.timeutil import new_id, now_iso

CONFIRMED = "완료"
REVIEWING = "검토중"

_SELECT = (
    "SELECT n.*, c.name AS child_name, CASE WHEN n.withdrawn=1 THEN n.edited_text <> COALESCE("
    "(SELECT h.text FROM notice_history h WHERE h.notice_id=n.notice_id AND h.kind='confirm' "
    "ORDER BY h.version DESC LIMIT 1), n.edited_text) ELSE 0 END AS needs_journal_update_choice "
    "FROM notices n JOIN children c ON c.child_id = n.child_id"
)


def not_found(message: str = "알림장을 찾을 수 없습니다.") -> ApiError:
    return ApiError(status_code=404, code="NOT_FOUND", message=message)


def version_conflict(current_version: int, **extra) -> ApiError:
    return ApiError(
        status_code=409,
        code="VERSION_CONFLICT",
        message="다른 화면에서 먼저 바뀌었습니다. 새로 불러온 뒤 다시 시도해 주세요.",
        details={"current_version": current_version, **extra},
    )


def edit_ratio(generated: str, current: str) -> float:
    """0.0 when the teacher kept the draft as written, 1.0 when nothing of it remains."""
    if generated == current:
        return 0.0
    return round(1 - SequenceMatcher(None, generated, current, autojunk=False).ratio(), 3)


class NoticeStore:
    def __init__(self, database: Database):
        self.database = database

    # --- reading -------------------------------------------------------------------------------------------------
    @staticmethod
    def _notice(row) -> dict:
        data = dict(row)
        data["needs_check"] = bool(data["needs_check"])
        data["incident"] = bool(data["incident"])
        data["needs_journal_update_choice"] = bool(data["needs_journal_update_choice"])
        data["warnings"] = json.loads(data["warnings"])
        return data

    def get(self, teacher_id: str, notice_id: str) -> dict | None:
        with self.database.connect() as connection:
            row = connection.execute(
                _SELECT + " WHERE n.teacher_id=? AND n.notice_id=?", (teacher_id, notice_id)
            ).fetchone()
        return self._notice(row) if row else None

    def require(self, teacher_id: str, notice_id: str) -> dict:
        notice = self.get(teacher_id, notice_id)
        if notice is None:
            raise not_found()
        return notice

    def get_by_session_child(self, session_id: str, child_id: str) -> dict | None:
        with self.database.connect() as connection:
            row = connection.execute(
                _SELECT + " WHERE n.session_id=? AND n.child_id=?", (session_id, child_id)
            ).fetchone()
        return self._notice(row) if row else None

    def list(
        self,
        teacher_id: str,
        *,
        child_id: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        status: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict]:
        clauses, values = ["n.teacher_id=?"], [teacher_id]
        for clause, value in (
            ("n.child_id=?", child_id),
            ("n.target_date>=?", date_from),
            ("n.target_date<=?", date_to),
            ("n.status=?", status),
        ):
            if value is not None:
                clauses.append(clause)
                values.append(value)
        with self.database.connect() as connection:
            rows = connection.execute(
                _SELECT + " WHERE " + " AND ".join(clauses)
                + " ORDER BY n.target_date DESC, c.rowid, n.rowid LIMIT ? OFFSET ?",
                (*values, limit, offset),
            ).fetchall()
        return [self._notice(row) for row in rows]

    def recent_texts(self, teacher_id: str, child_id: str, before_date: str, limit: int = 3) -> list[str]:
        """The child's latest earlier notices (newest first), to keep a new draft from repeating them."""
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT edited_text FROM notices WHERE teacher_id=? AND child_id=? AND target_date<? "
                "ORDER BY target_date DESC, rowid DESC LIMIT ?",
                (teacher_id, child_id, before_date, limit),
            ).fetchall()
        return [row["edited_text"] for row in rows]

    def history(self, teacher_id: str, notice_id: str) -> list[dict]:
        self.require(teacher_id, notice_id)
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT version, kind, text, status, revision_id, created_at FROM notice_history "
                "WHERE notice_id=? ORDER BY version",
                (notice_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def last_confirmed(self, notice_id: str) -> dict | None:
        """The newest confirmed text (and its version), even if the notice was edited again after it."""
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT version, text FROM notice_history WHERE notice_id=? AND kind='confirm' ORDER BY version DESC LIMIT 1",
                (notice_id,),
            ).fetchone()
        return dict(row) if row else None

    # --- writing -----------------------------------------------------------------------------------------------------
    @staticmethod
    def _add_history(connection, notice_id: str, version: int, kind: str, text: str, status: str, revision_id=None) -> None:
        connection.execute(
            "INSERT INTO notice_history(notice_id, version, kind, text, status, revision_id, created_at) VALUES (?,?,?,?,?,?,?)",
            (notice_id, version, kind, text, status, revision_id, now_iso()),
        )

    def save_generated(
        self,
        *,
        teacher_id: str,
        session_id: str,
        child_id: str,
        target_date: str,
        text: str,
        needs_check: bool,
        incident: bool,
        warnings: list[dict],
        rules_hash: str | None,
        model: str | None,
    ) -> dict:
        """Create the child's notice, or replace the draft (as a new version; older versions stay in the history)."""
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            notice_id = self.write_generated(
                connection, teacher_id=teacher_id, session_id=session_id, child_id=child_id, target_date=target_date,
                text=text, needs_check=needs_check, incident=incident, warnings=warnings, rules_hash=rules_hash, model=model,
            )
            connection.execute("DELETE FROM notice_recording_sources WHERE notice_id=?", (notice_id,))
        return self.require(teacher_id, notice_id)

    def write_generated(
        self, connection, *, teacher_id: str, session_id: str, child_id: str, target_date: str, text: str,
        needs_check: bool, incident: bool, warnings: list[dict], rules_hash: str | None, model: str | None,
    ) -> str:
        stamp = now_iso()
        row = connection.execute(
            "SELECT notice_id, version FROM notices WHERE session_id=? AND child_id=?", (session_id, child_id),
        ).fetchone()
        warning_json = json.dumps(warnings, ensure_ascii=False)
        if row is None:
            notice_id, version, kind = new_id(), 1, "generated"
            connection.execute(
                "INSERT INTO notices(notice_id, teacher_id, session_id, child_id, target_date, version, status, "
                "generated_text, edited_text, needs_check, incident, warnings, rules_hash, model, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (notice_id, teacher_id, session_id, child_id, target_date, version, REVIEWING, text, text,
                 int(needs_check), int(incident), warning_json, rules_hash, model, stamp, stamp),
            )
        else:
            notice_id, version, kind = row["notice_id"], row["version"] + 1, "regenerated"
            connection.execute(
                "UPDATE notices SET version=?, status=?, generated_text=?, edited_text=?, needs_check=?, incident=?, "
                "warnings=?, rules_hash=?, model=?, updated_at=?, confirmed_at=NULL WHERE notice_id=?",
                (version, REVIEWING, text, text, int(needs_check), int(incident), warning_json, rules_hash, model, stamp, notice_id),
            )
        self._add_history(connection, notice_id, version, kind, text, REVIEWING)
        return notice_id

    def recording_source(self, notice_id: str) -> dict | None:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT payload FROM notice_recording_sources WHERE notice_id=?", (notice_id,),
            ).fetchone()
        return json.loads(row["payload"]) if row else None

    def _locked(self, connection, teacher_id: str, notice_id: str):
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            _SELECT + " WHERE n.teacher_id=? AND n.notice_id=?", (teacher_id, notice_id)
        ).fetchone()
        if row is None:
            raise not_found()
        return row

    def update_text(self, teacher_id: str, notice_id: str, expected_version: int, text: str) -> dict:
        with self.database.connect() as connection:
            row = self._locked(connection, teacher_id, notice_id)
            if row["version"] != expected_version:
                raise version_conflict(row["version"])
            if text != row["edited_text"]:
                version = row["version"] + 1
                connection.execute(
                    "UPDATE notices SET edited_text=?, status=?, version=?, needs_check=0, updated_at=?, confirmed_at=NULL "
                    "WHERE notice_id=?",
                    (text, REVIEWING, version, now_iso(), notice_id),
                )
                self._add_history(connection, notice_id, version, "manual_edit", text, REVIEWING)
        return self.require(teacher_id, notice_id)

    def confirm(
        self, teacher_id: str, notice_id: str, expected_version: int, *, update_journal: bool | None = None,
    ) -> tuple[dict, Literal["keep", "sync", "refresh"]]:
        """Confirm the saved text and decide the journal action in the same transaction."""
        journal_action: Literal["keep", "sync", "refresh"] = "keep"
        with self.database.connect() as connection:
            row = self._locked(connection, teacher_id, notice_id)
            if row["status"] == CONFIRMED:
                last = connection.execute(
                    "SELECT kind FROM notice_history WHERE notice_id=? ORDER BY version DESC LIMIT 1", (notice_id,)
                ).fetchone()
                if expected_version != row["version"] and not (
                    expected_version == row["version"] - 1 and last and last["kind"] == "confirm"
                ):
                    raise version_conflict(row["version"])
            elif row["version"] != expected_version:
                raise version_conflict(row["version"])
            else:
                if row["needs_journal_update_choice"]:
                    if update_journal is None:
                        raise ApiError(status_code=409, code="JOURNAL_UPDATE_CHOICE_REQUIRED",
                                       message="관찰일지를 업데이트할지 선택해 주세요.")
                    if update_journal:
                        journal_action = "refresh"
                elif not row["withdrawn"]:
                    journal_action = "sync"
                version, stamp = row["version"] + 1, now_iso()
                connection.execute(
                    "UPDATE notices SET status=?, version=?, needs_check=0, updated_at=?, confirmed_at=?, withdrawn=0 WHERE notice_id=?",
                    (CONFIRMED, version, stamp, stamp, notice_id),
                )
                self._add_history(connection, notice_id, version, "confirm", row["edited_text"], CONFIRMED)
            confirmed = connection.execute(_SELECT + " WHERE n.notice_id=?", (notice_id,)).fetchone()
            return self._notice(confirmed), journal_action

    def unconfirm(self, teacher_id: str, notice_id: str, expected_version: int) -> dict:
        with self.database.connect() as connection:
            row = self._locked(connection, teacher_id, notice_id)
            if row["status"] != CONFIRMED and row["withdrawn"]:
                last = connection.execute(
                    "SELECT kind FROM notice_history WHERE notice_id=? AND version=?", (notice_id, row["version"]),
                ).fetchone()
                if expected_version == row["version"] or (
                    expected_version == row["version"] - 1 and last and last["kind"] == "unconfirm"
                ):
                    return self._notice(connection.execute(_SELECT + " WHERE n.notice_id=?", (notice_id,)).fetchone())
            if row["version"] != expected_version:
                raise version_conflict(row["version"])
            if row["status"] != CONFIRMED:
                raise ApiError(status_code=409, code="NOT_CONFIRMED", message="확정된 알림장만 확정을 취소할 수 있어요.")
            version = row["version"] + 1
            connection.execute(
                "UPDATE notices SET status=?, version=?, updated_at=?, confirmed_at=NULL, withdrawn=1 WHERE notice_id=?",
                (REVIEWING, version, now_iso(), notice_id),
            )
            self._add_history(connection, notice_id, version, "unconfirm", row["edited_text"], REVIEWING)
            return self._notice(connection.execute(_SELECT + " WHERE n.notice_id=?", (notice_id,)).fetchone())

    # --- AI revision candidates ----------------------------------------------------------------------------------------
    def create_revision(self, teacher_id: str, notice_id: str, base_version: int, instruction: str) -> dict:
        revision_id = new_id()
        with self.database.connect() as connection:
            row = self._locked(connection, teacher_id, notice_id)
            if row["version"] != base_version:
                raise version_conflict(row["version"])
            connection.execute(
                "INSERT INTO notice_revisions(revision_id, notice_id, teacher_id, base_version, instruction, status, created_at) "
                "VALUES (?,?,?,?,?,'queued',?)",
                (revision_id, notice_id, teacher_id, base_version, instruction, now_iso()),
            )
        return self.get_revision(teacher_id, notice_id, revision_id)

    def get_revision(self, teacher_id: str, notice_id: str, revision_id: str) -> dict | None:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM notice_revisions WHERE teacher_id=? AND notice_id=? AND revision_id=?",
                (teacher_id, notice_id, revision_id),
            ).fetchone()
        return dict(row) if row else None

    def set_revision_job(self, revision_id: str, job_id: str) -> None:
        with self.database.connect() as connection:
            connection.execute("UPDATE notice_revisions SET job_id=? WHERE revision_id=?", (job_id, revision_id))

    def mark_revision_running(self, revision_id: str) -> None:
        with self.database.connect() as connection:
            connection.execute("UPDATE notice_revisions SET status='running' WHERE revision_id=?", (revision_id,))

    def finish_revision(self, revision_id: str, candidate_text: str) -> None:
        with self.database.connect() as connection:
            connection.execute(
                "UPDATE notice_revisions SET status='completed', candidate_text=?, error_code=NULL WHERE revision_id=?",
                (candidate_text, revision_id),
            )

    def fail_revision(self, revision_id: str, error_code: str) -> None:
        with self.database.connect() as connection:
            connection.execute(
                "UPDATE notice_revisions SET status='failed', error_code=? WHERE revision_id=?", (error_code, revision_id)
            )

    def adopt_revision(self, teacher_id: str, notice_id: str, revision_id: str, expected_version: int) -> dict:
        with self.database.connect() as connection:
            row = self._locked(connection, teacher_id, notice_id)
            revision = connection.execute(
                "SELECT * FROM notice_revisions WHERE revision_id=? AND notice_id=?", (revision_id, notice_id)
            ).fetchone()
            if revision is None:
                raise not_found("수정 요청을 찾을 수 없습니다.")
            if revision["status"] != "completed" or not revision["candidate_text"]:
                raise ApiError(status_code=409, code="REVISION_NOT_READY", message="아직 수정안이 만들어지지 않았습니다.",
                               details={"status": revision["status"]})
            if revision["adopted_at"]:
                raise ApiError(status_code=409, code="ALREADY_ADOPTED", message="이미 반영한 수정안입니다.")
            if row["version"] != expected_version or row["version"] != revision["base_version"]:
                raise version_conflict(row["version"], base_version=revision["base_version"])
            version, stamp = row["version"] + 1, now_iso()
            connection.execute(
                "UPDATE notices SET edited_text=?, status=?, version=?, needs_check=0, updated_at=?, confirmed_at=NULL "
                "WHERE notice_id=?",
                (revision["candidate_text"], REVIEWING, version, stamp, notice_id),
            )
            connection.execute("UPDATE notice_revisions SET adopted_at=? WHERE revision_id=?", (stamp, revision_id))
            self._add_history(connection, notice_id, version, "adopt_revision", revision["candidate_text"], REVIEWING, revision_id)
        return self.require(teacher_id, notice_id)

    def fail_open_revisions(self, notice_id: str | None = None) -> None:
        """Used after a restart: revisions that never finished cannot finish any more."""
        with self.database.connect() as connection:
            connection.execute(
                "UPDATE notice_revisions SET status='failed', error_code='SERVER_RESTART' "
                "WHERE status IN ('queued','running')" + (" AND notice_id=?" if notice_id else ""),
                (notice_id,) if notice_id else (),
            )
