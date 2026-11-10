"""Storage for a date's recording work and the sources of applied notice drafts."""
import json
from datetime import datetime
from zoneinfo import ZoneInfo

from app.core.database import Database
from app.core.errors import ApiError
from app.core.timeutil import new_id, now_iso
from app.notices.store import CONFIRMED, NoticeStore

WORKING = frozenset(("transcribing", "analyzing", "drafting"))
ACTIVE = WORKING | {"transcription_failed", "asking", "ready"}
SEOUL = ZoneInfo("Asia/Seoul")


def changed() -> ApiError:
    return ApiError(status_code=409, code="RECORDING_DRAFT_CHANGED", message="녹음 작성 상태가 바뀌었어요. 다시 불러와 주세요.")


class RecordingDraftStore:
    def __init__(self, database: Database, notices: NoticeStore):
        self.database = database
        self.notices = notices

    @staticmethod
    def _read(connection, session_id: str) -> dict | None:
        row = connection.execute("SELECT * FROM recording_drafts WHERE session_id=?", (session_id,)).fetchone()
        return {**dict(row), "payload": json.loads(row["payload"])} if row else None

    @staticmethod
    def _save(connection, draft: dict) -> None:
        connection.execute(
            "INSERT INTO recording_drafts(session_id, run_id, stage, payload) VALUES (?,?,?,?) "
            "ON CONFLICT(session_id) DO UPDATE SET run_id=excluded.run_id, stage=excluded.stage, payload=excluded.payload",
            (draft["session_id"], draft["run_id"], draft["stage"], json.dumps(draft["payload"], ensure_ascii=False)),
        )

    @staticmethod
    def _recordings(connection, teacher_id: str, date: str, recording_ids: list[str]) -> None:
        for recording_id in recording_ids:
            row = connection.execute(
                "SELECT recorded_at FROM recordings WHERE teacher_id=? AND recording_id=? AND deleted=0",
                (teacher_id, recording_id),
            ).fetchone()
            if row is None:
                raise ApiError(status_code=404, code="NOT_FOUND", message="선택한 녹음을 찾을 수 없어요.")
            started = datetime.fromisoformat(row["recorded_at"]).astimezone(SEOUL).date().isoformat()
            if started != date:
                raise ApiError(status_code=422, code="RECORDING_DATE_MISMATCH", message="알림장 날짜의 녹음만 선택해 주세요.")

    def get(self, session_id: str) -> dict | None:
        with self.database.connect() as connection:
            return self._read(connection, session_id)

    def recover(self) -> None:
        with self.database.connect() as connection:
            ids = [row["run_id"] for row in connection.execute(
                "SELECT run_id FROM recording_drafts WHERE stage IN ('transcribing','analyzing','drafting')",
            )]
        for run_id in ids:
            self.fail(run_id, "SERVER_RESTART")

    def sources(self, session_id: str) -> dict[str, dict]:
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT n.child_id, s.payload FROM notice_recording_sources s JOIN notices n USING(notice_id) "
                "WHERE n.session_id=?", (session_id,),
            )
            return {row["child_id"]: json.loads(row["payload"]) for row in rows}

    def begin(
        self, teacher_id: str, session_id: str, blocks: list[dict], recording_ids: list[str],
        targets: list[str] | None, previous_flags: list[dict], prior_facts: list[dict],
    ) -> dict:
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            session = connection.execute(
                "SELECT status, target_date FROM writing_sessions WHERE session_id=? AND teacher_id=?", (session_id, teacher_id),
            ).fetchone()
            current = self._read(connection, session_id)
            if current and current["stage"] in ACTIVE:
                raise changed()
            initial = targets is None
            expected = ("writing", "failed") if initial else ("reviewing",)
            if not session or session["status"] not in expected:
                raise changed()
            existing = {row["child_id"]: row for row in connection.execute(
                "SELECT child_id, status, version FROM notices WHERE session_id=?", (session_id,),
            )}
            present = [block["child_id"] for block in blocks if block["child_id"] and not block["absent"]]
            selected = present if initial else targets
            if not selected or not set(selected) <= set(present):
                raise ApiError(status_code=422, code="NO_CHILDREN", message="작성할 아이를 선택해 주세요.")
            if (initial and existing) or any(existing.get(child) and existing[child]["status"] == CONFIRMED for child in selected):
                raise ApiError(status_code=409, code="NOTICE_CONFIRMED", message="확정한 알림장은 확정 취소 후 다시 만들 수 있어요.")
            self._recordings(connection, teacher_id, session["target_date"], recording_ids)
            draft = {
                "session_id": session_id, "run_id": new_id(), "stage": "transcribing",
                "payload": {
                    "teacher_id": teacher_id, "target_date": session["target_date"], "initial": initial,
                    "recording_ids": recording_ids, "targets": selected, "blocks": blocks,
                    "versions": {child: existing[child]["version"] if child in existing else None for child in selected},
                    "previous_flags": previous_flags, "prior_facts": prior_facts,
                },
            }
            self._save(connection, draft)
            return draft

    def advance(self, draft: dict, stage: str, **changes) -> dict:
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            current = self._read(connection, draft["session_id"])
            if not current or current["run_id"] != draft["run_id"] or current["stage"] != draft["stage"]:
                raise changed()
            current["stage"] = stage
            current["payload"].update(changes)
            self._save(connection, current)
            return current

    def fail(self, run_id: str, code: str) -> None:
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT session_id FROM recording_drafts WHERE run_id=?", (run_id,)).fetchone()
            current = self._read(connection, row["session_id"]) if row else None
            if current and current["stage"] in WORKING:
                current["stage"] = "failed"
                current["payload"]["error_code"] = code
                self._save(connection, current)

    def publish(self, draft: dict, candidates: list[dict], *, child_id: str | None = None) -> list[str]:
        """Apply candidates and their sources together, guarded by the current notice versions."""
        session_id = draft["session_id"]
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            current = self._read(connection, session_id)
            if not current or current["run_id"] != draft["run_id"]:
                raise changed()
            payload = current["payload"]
            if child_id is None:
                if not payload["initial"] or current["stage"] != "drafting":
                    raise changed()
            else:
                if payload["initial"] or current["stage"] != "ready":
                    raise changed()
                candidates = [item for item in payload["candidates"] if item["child_id"] == child_id and not item["applied"]]
                if not candidates:
                    raise changed()
            teacher_id = payload["teacher_id"]
            self._recordings(connection, teacher_id, payload["target_date"], payload["recording_ids"])
            notice_ids = []
            for candidate in candidates:
                target = candidate["child_id"]
                if connection.execute(
                    "SELECT 1 FROM jobs WHERE ref_id=? AND status IN ('queued','running') LIMIT 1", (f"{session_id}:{target}",),
                ).fetchone():
                    raise changed()
                if not connection.execute(
                    "SELECT 1 FROM input_blocks b JOIN children c USING(child_id) "
                    "WHERE b.session_id=? AND b.child_id=? AND b.absent=0 AND c.is_active=1",
                    (session_id, target),
                ).fetchone():
                    raise changed()
                row = connection.execute(
                    "SELECT status, version FROM notices WHERE session_id=? AND child_id=?", (session_id, target),
                ).fetchone()
                version = row["version"] if row else None
                if version != payload["versions"][target] or (row and row["status"] == CONFIRMED):
                    raise ApiError(status_code=409, code="VERSION_CONFLICT", message="알림장이 먼저 수정됐어요. 새 초안을 다시 만들어 주세요.")
                notice_id = self.notices.write_generated(
                    connection, teacher_id=teacher_id, session_id=session_id, child_id=target, target_date=payload["target_date"],
                    **candidate["notice"],
                )
                connection.execute(
                    "INSERT INTO notice_recording_sources(notice_id, payload) VALUES (?,?) "
                    "ON CONFLICT(notice_id) DO UPDATE SET payload=excluded.payload",
                    (notice_id, json.dumps(candidate["source"], ensure_ascii=False)),
                )
                candidate["applied"] = True
                notice_ids.append(notice_id)
            if child_id is None or all(item["applied"] for item in payload["candidates"]):
                current["stage"] = "done"
                current["payload"] = {}
            connection.execute(
                "UPDATE writing_sessions SET status='reviewing', updated_at=?, error_code=NULL WHERE session_id=?",
                (now_iso(), session_id),
            )
            self._save(connection, current)
            return notice_ids
