"""Writing sessions: one per teacher, classroom, and day, with one input block per child plus a common block."""
import json

from app.core.database import Database
from app.core.errors import ApiError
from app.core.timeutil import new_id, now_iso
from app.profile.store import ProfileStore
from app.rules.loader import AREAS

EDITABLE_STATUSES = ("writing", "failed", "reviewing")


def _not_found(message: str = "작성 세션을 찾을 수 없습니다.") -> ApiError:
    return ApiError(status_code=404, code="NOT_FOUND", message=message)


class SessionStore:
    def __init__(self, database: Database, profile: ProfileStore):
        self.database = database
        self.profile = profile

    # --- sessions -----------------------------------------------------------------------------------------
    def get_or_create(self, teacher_id: str, classroom_id: str | None, target_date: str) -> tuple[dict, bool]:
        if classroom_id is None:
            classroom_id = self.profile.default_classroom(teacher_id)["classroom_id"]
        elif self.profile.get_classroom(teacher_id, classroom_id) is None:
            raise _not_found("반을 찾을 수 없습니다.")
        created = False
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM writing_sessions WHERE teacher_id=? AND classroom_id=? AND target_date=?",
                (teacher_id, classroom_id, target_date),
            ).fetchone()
            if row is None:
                session_id, stamp = new_id(), now_iso()
                connection.execute(
                    "INSERT INTO writing_sessions(session_id, teacher_id, classroom_id, target_date, status, created_at, updated_at) "
                    "VALUES (?,?,?,?,'writing',?,?)",
                    (session_id, teacher_id, classroom_id, target_date, stamp, stamp),
                )
                created = True
            else:
                session_id = row["session_id"]
        self.ensure_blocks(teacher_id, session_id)
        return self.get(teacher_id, session_id), created

    def get(self, teacher_id: str, session_id: str) -> dict | None:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM writing_sessions WHERE teacher_id=? AND session_id=?", (teacher_id, session_id)
            ).fetchone()
        return dict(row) if row else None

    def require(self, teacher_id: str, session_id: str) -> dict:
        session = self.get(teacher_id, session_id)
        if session is None:
            raise _not_found()
        return session

    def set_status(self, session_id: str, status: str, **fields) -> None:
        allowed = {"snapshot", "common_paragraph", "review_json", "rules_hash", "model", "error_code"}
        assignments = ["status=?", "updated_at=?"]
        values: list = [status, now_iso()]
        for key, value in fields.items():
            if key not in allowed:
                raise ValueError(key)
            assignments.append(f"{key}=?")
            values.append(value)
        with self.database.connect() as connection:
            connection.execute(f"UPDATE writing_sessions SET {', '.join(assignments)} WHERE session_id=?", (*values, session_id))

    # --- blocks ---------------------------------------------------------------------------------------------------
    def _classroom_children(self, connection, teacher_id: str, classroom_id: str) -> list:
        default_id = connection.execute(
            "SELECT classroom_id FROM classrooms WHERE teacher_id=? ORDER BY created_at, rowid LIMIT 1", (teacher_id,)
        ).fetchone()
        is_default = bool(default_id and default_id["classroom_id"] == classroom_id)
        return connection.execute(
            "SELECT c.child_id, c.name FROM children c LEFT JOIN child_profiles p ON p.child_id=c.child_id "
            "WHERE c.teacher_id=? AND c.is_active=1 AND (p.classroom_id=? OR (p.classroom_id IS NULL AND ?)) ORDER BY c.rowid",
            (teacher_id, classroom_id, 1 if is_default else 0),
        ).fetchall()

    def ensure_blocks(self, teacher_id: str, session_id: str) -> None:
        """Create the common block and a block for every active child that has none yet."""
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            session = connection.execute(
                "SELECT classroom_id FROM writing_sessions WHERE teacher_id=? AND session_id=?", (teacher_id, session_id)
            ).fetchone()
            if session is None:
                return
            have = {row["child_id"] for row in connection.execute(
                "SELECT child_id FROM input_blocks WHERE session_id=?", (session_id,))}
            stamp = now_iso()
            if None not in have:
                connection.execute(
                    "INSERT INTO input_blocks(block_id, session_id, child_id, updated_at) VALUES (?,?,NULL,?)",
                    (new_id(), session_id, stamp),
                )
            for child in self._classroom_children(connection, teacher_id, session["classroom_id"]):
                if child["child_id"] not in have:
                    connection.execute(
                        "INSERT INTO input_blocks(block_id, session_id, child_id, updated_at) VALUES (?,?,?,?)",
                        (new_id(), session_id, child["child_id"], stamp),
                    )

    @staticmethod
    def _block(row) -> dict:
        return {
            "block_id": row["block_id"],
            "child_id": row["child_id"],
            "child_name": row["child_name"],
            "is_common": row["child_id"] is None,
            "text": row["text"],
            "areas": json.loads(row["areas"]),
            "place": row["place"],
            "time_text": row["time_text"],
            "absent": bool(row["absent"]),
            "filled": bool(row["text"].strip()),
            "child_active": True if row["child_id"] is None else bool(row["child_active"]),
        }

    def list_blocks(self, session_id: str, *, only_active: bool = True) -> list[dict]:
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT b.*, c.name AS child_name, c.is_active AS child_active FROM input_blocks b "
                "LEFT JOIN children c ON c.child_id=b.child_id WHERE b.session_id=? "
                "ORDER BY (b.child_id IS NOT NULL), c.rowid",
                (session_id,),
            ).fetchall()
        blocks = [self._block(row) for row in rows]
        return [block for block in blocks if block["child_active"]] if only_active else blocks

    def get_block(self, session_id: str, block_id: str) -> dict | None:
        return next((block for block in self.list_blocks(session_id, only_active=False) if block["block_id"] == block_id), None)

    def other_child_names(self, session_id: str, child_id: str) -> list[str]:
        """Names of the other children of this session's class (also removed ones), to keep them out of a child's text."""
        return [
            block["child_name"] for block in self.list_blocks(session_id, only_active=False)
            if block["child_id"] not in (None, child_id)
        ]

    def child_source_text(self, session_id: str, child_id: str) -> str:
        """What the teacher wrote about this child that day, plus the class-wide note."""
        blocks = self.list_blocks(session_id, only_active=False)
        parts = [block["text"].strip() for block in blocks if block["child_id"] in (child_id, None) and block["text"].strip()]
        return "\n".join(parts)

    def update_block(self, teacher_id: str, session_id: str, block_id: str, changes: dict) -> dict:
        session = self.require(teacher_id, session_id)
        block = self.get_block(session_id, block_id)
        if block is None:
            raise _not_found("입력 블록을 찾을 수 없습니다.")
        if session["status"] not in EDITABLE_STATUSES:
            raise ApiError(status_code=409, code="SESSION_BUSY", message="생성 중에는 입력을 고칠 수 없습니다.",
                           details={"status": session["status"]})
        if block["is_common"] and changes.get("absent"):
            raise ApiError(status_code=422, code="VALIDATION_ERROR", message="반 공통 블록은 결석 처리할 수 없습니다.")
        assignments, values = [], []
        for key in ("text", "place", "time_text"):
            if key in changes:
                assignments.append(f"{key}=?")
                values.append(changes[key])
        if "areas" in changes:
            ordered = [area for area in AREAS if area in set(changes["areas"])]
            assignments.append("areas=?")
            values.append(json.dumps(ordered, ensure_ascii=False))
        if "absent" in changes:
            assignments.append("absent=?")
            values.append(1 if changes["absent"] else 0)
        if assignments:
            with self.database.connect() as connection:
                connection.execute(
                    f"UPDATE input_blocks SET {', '.join(assignments)}, updated_at=? WHERE block_id=?",
                    (*values, now_iso(), block_id),
                )
        return self.get_block(session_id, block_id)

    @staticmethod
    def append_text(connection, block_id: str, text: str) -> None:
        """Add a line to a block inside the caller's transaction."""
        row = connection.execute("SELECT text FROM input_blocks WHERE block_id=?", (block_id,)).fetchone()
        joined = (row["text"].rstrip() + "\n" + text) if row and row["text"].strip() else text
        connection.execute("UPDATE input_blocks SET text=?, updated_at=? WHERE block_id=?", (joined, now_iso(), block_id))

    # --- flags -------------------------------------------------------------------------------------------------------
    def list_flags(self, session_id: str) -> list[dict]:
        with self.database.connect() as connection:
            rows = connection.execute("SELECT * FROM review_flags WHERE session_id=? ORDER BY seq", (session_id,)).fetchall()
        return [
            {"flag_id": row["flag_id"], "kind": row["kind"], "child_ids": json.loads(row["child_ids"]),
             "question": row["question"], "options": json.loads(row["options"]), "answer": row["answer"], "status": row["status"]}
            for row in rows
        ]

    def replace_flags(self, session_id: str, flags: list[dict]) -> None:
        with self.database.connect() as connection:
            connection.execute("DELETE FROM review_flags WHERE session_id=?", (session_id,))
            for seq, flag in enumerate(flags):
                connection.execute(
                    "INSERT INTO review_flags(flag_id, session_id, seq, kind, child_ids, question, options, status, created_at) "
                    "VALUES (?,?,?,?,?,?,?,'open',?)",
                    (new_id(), session_id, seq, flag["kind"], json.dumps(flag["child_ids"]), flag["question"],
                     json.dumps(flag["options"], ensure_ascii=False), now_iso()),
                )

    def finish_review(
        self, teacher_id: str, session_id: str, answers: dict[str, str | None], areas_by_child: dict[str, list[str]],
        metadata_by_child: dict[str | None, dict[str, str]],
    ) -> None:
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            session = connection.execute(
                "SELECT status FROM writing_sessions WHERE teacher_id=? AND session_id=?", (teacher_id, session_id),
            ).fetchone()
            if session is None or session["status"] != "asking":
                raise ApiError(status_code=409, code="NOT_ASKING", message="지금은 질문에 답하는 단계가 아니에요.")
            flags = dict(connection.execute("SELECT flag_id, status FROM review_flags WHERE session_id=?", (session_id,)))
            if not answers.keys() <= flags.keys() or any(
                status == "open" and flag_id not in answers for flag_id, status in flags.items()
            ):
                raise ApiError(status_code=409, code="QUESTIONS_CHANGED", message="질문이 바뀌었어요. 다시 불러와 주세요.")
            connection.executemany(
                "UPDATE review_flags SET answer=?, status=? WHERE session_id=? AND flag_id=?",
                [(answer, "skipped" if answer is None else "answered", session_id, flag_id)
                 for flag_id, answer in answers.items()],
            )
            stamp = now_iso()
            for child_id, areas in areas_by_child.items():
                ordered = [area for area in AREAS if area in areas]
                connection.execute(
                    "UPDATE input_blocks SET areas=?, updated_at=? WHERE session_id=? AND child_id=? AND areas='[]'",
                    (json.dumps(ordered, ensure_ascii=False), stamp, session_id, child_id),
                )
            for child_id, metadata in metadata_by_child.items():
                for key in ("place", "time_text"):
                    if key in metadata:
                        connection.execute(
                            f"UPDATE input_blocks SET {key}=?, updated_at=? "
                            f"WHERE session_id=? AND child_id IS ? AND trim(coalesce({key}, ''))=''",
                            (metadata[key], stamp, session_id, child_id),
                        )
            connection.execute(
                "UPDATE writing_sessions SET status='drafting', updated_at=?, error_code=NULL WHERE session_id=?",
                (stamp, session_id),
            )

    def reopen_review(self, teacher_id: str, session_id: str) -> None:
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            session = connection.execute(
                "SELECT status FROM writing_sessions WHERE teacher_id=? AND session_id=?", (teacher_id, session_id),
            ).fetchone()
            if session is None:
                raise _not_found()
            if session["status"] != "asking":
                raise ApiError(status_code=409, code="NOT_ASKING", message="질문 단계에서만 입력으로 돌아갈 수 있어요.",
                               details={"status": session["status"]})
            connection.execute("DELETE FROM review_flags WHERE session_id=?", (session_id,))
            connection.execute(
                "UPDATE writing_sessions SET status='writing', error_code=NULL, updated_at=? WHERE session_id=?",
                (now_iso(), session_id),
            )

    # --- read model for GET /sessions/{id} ---------------------------------------------------------------------------------
    def latest_job(self, session_id: str) -> dict | None:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT job_id, kind, status, error_code, result FROM jobs WHERE ref_id=? "
                "ORDER BY created_at DESC, rowid DESC LIMIT 1",
                (session_id,),
            ).fetchone()
        if row is None:
            return None
        data = dict(row)
        data["result"] = json.loads(data["result"]) if data["result"] else None
        return data

    def notice_summaries(self, session_id: str) -> list[dict]:
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT n.notice_id, n.child_id, c.name AS child_name, n.status, n.version, n.needs_check, n.incident, "
                "EXISTS (SELECT 1 FROM jobs j WHERE j.ref_id = n.session_id || ':' || n.child_id "
                "AND j.status IN ('queued','running')) AS busy "
                "FROM notices n JOIN children c ON c.child_id=n.child_id WHERE n.session_id=? ORDER BY c.rowid",
                (session_id,),
            ).fetchall()
        return [
            {**dict(row), "needs_check": bool(row["needs_check"]), "incident": bool(row["incident"]), "busy": bool(row["busy"])}
            for row in rows
        ]

    @staticmethod
    def common_outdated(session: dict, blocks: list[dict]) -> bool:
        """True when the common block was edited after its paragraph was written (only meaningful while reviewing)."""
        if session["status"] != "reviewing" or not session["snapshot"]:
            return False
        written = json.loads(session["snapshot"]).get("common")
        common = next((block for block in blocks if block["is_common"]), None)
        current = None
        if common is not None and common["filled"]:
            current = {"text": common["text"], "areas": common["areas"], "place": common["place"], "time_text": common["time_text"]}
        return written != current
