"""Quick notes: short texts jotted during the day (typed, or the typed-in text of a side-button recording).

They are the raw material for the evening's input blocks. Importing copies them into a writing session; a
note is imported once.
"""
from app.core.database import Database
from app.core.errors import ApiError
from app.core.timeutil import new_id, now_iso
from app.sessions.store import SessionStore

_SELECT = "SELECT q.*, c.name AS child_name FROM quick_notes q LEFT JOIN children c ON c.child_id = q.child_id"


def note_not_found() -> ApiError:
    return ApiError(status_code=404, code="NOT_FOUND", message="메모를 찾을 수 없습니다.")


class QuickNoteStore:
    def __init__(self, database: Database):
        self.database = database

    def owns_recording(self, teacher_id: str, recording_id: str) -> bool:
        with self.database.connect() as connection:
            return connection.execute(
                "SELECT 1 FROM recordings WHERE teacher_id=? AND recording_id=? AND deleted=0", (teacher_id, recording_id)
            ).fetchone() is not None

    def create(self, teacher_id: str, note_date: str, text: str, child_id: str | None, recording_id: str | None) -> dict:
        note_id = new_id()
        with self.database.connect() as connection:
            connection.execute(
                "INSERT INTO quick_notes(note_id, teacher_id, note_date, child_id, text, recording_id, created_at) VALUES (?,?,?,?,?,?,?)",
                (note_id, teacher_id, note_date, child_id, text, recording_id, now_iso()),
            )
        return self.require(teacher_id, note_id)

    def get(self, teacher_id: str, note_id: str) -> dict | None:
        with self.database.connect() as connection:
            row = connection.execute(_SELECT + " WHERE q.teacher_id=? AND q.note_id=?", (teacher_id, note_id)).fetchone()
        return dict(row) if row else None

    def require(self, teacher_id: str, note_id: str) -> dict:
        note = self.get(teacher_id, note_id)
        if note is None:
            raise note_not_found()
        return note

    def list(
        self, teacher_id: str, *, note_date: str | None = None, imported: bool | None = None, child_id: str | None = None
    ) -> list[dict]:
        clauses, values = ["q.teacher_id=?"], [teacher_id]
        if note_date:
            clauses.append("q.note_date=?")
            values.append(note_date)
        if child_id:
            clauses.append("q.child_id=?")
            values.append(child_id)
        if imported is True:
            clauses.append("q.imported_session_id IS NOT NULL")
        elif imported is False:
            clauses.append("q.imported_session_id IS NULL")
        with self.database.connect() as connection:
            rows = connection.execute(
                _SELECT + " WHERE " + " AND ".join(clauses) + " ORDER BY q.note_date DESC, q.created_at, q.rowid", values
            ).fetchall()
        return [dict(row) for row in rows]

    def update(self, teacher_id: str, note_id: str, changes: dict) -> dict:
        note = self.require(teacher_id, note_id)
        if note["imported_session_id"]:
            raise ApiError(status_code=409, code="ALREADY_IMPORTED", message="이미 입력 블록으로 가져온 메모는 고칠 수 없어요.")
        assignments = [f"{key}=?" for key in changes]
        if assignments:
            with self.database.connect() as connection:
                connection.execute(
                    f"UPDATE quick_notes SET {', '.join(assignments)} WHERE teacher_id=? AND note_id=?",
                    (*changes.values(), teacher_id, note_id),
                )
        return self.require(teacher_id, note_id)

    def delete(self, teacher_id: str, note_id: str) -> bool:
        """Idempotent: deleting a note that is already gone is not an error."""
        with self.database.connect() as connection:
            return connection.execute(
                "DELETE FROM quick_notes WHERE teacher_id=? AND note_id=?", (teacher_id, note_id)
            ).rowcount > 0

    def import_into_session(self, teacher_id: str, session: dict, targets: dict[str | None, str]) -> tuple[list[dict], list[dict]]:
        """Append each not-yet-imported note of the session's date to its block, all or nothing.

        `targets` maps child_id (None = shared block) to block_id. Notes of children without a block are skipped.
        """
        imported_ids, skipped = [], []
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute(
                "SELECT note_id, child_id, text FROM quick_notes WHERE teacher_id=? AND note_date=? "
                "AND imported_session_id IS NULL ORDER BY created_at, rowid",
                (teacher_id, session["target_date"]),
            ).fetchall()
            for row in rows:
                block_id = targets.get(row["child_id"])
                if block_id is None:
                    skipped.append({"note_id": row["note_id"], "reason": "CHILD_NOT_IN_CLASS"})
                    continue
                SessionStore.append_text(connection, block_id, row["text"])
                connection.execute(
                    "UPDATE quick_notes SET imported_session_id=? WHERE note_id=?", (session["session_id"], row["note_id"])
                )
                imported_ids.append(row["note_id"])
        imported = [self.require(teacher_id, note_id) for note_id in imported_ids]
        return imported, skipped
