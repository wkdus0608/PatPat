"""Background jobs: persisted state plus a small thread pool (run inline in tests).

A job's `work` callable does the domain updates itself. If it raises, the job is marked failed with a
code the client can show, and `on_error` lets the caller put its own record (session, revision, ...)
into a failed state too. Jobs that were queued or running when the server stopped are failed on
startup with SERVER_RESTART, and their owners are told through the recovery handlers.
"""
import json
import logging
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

from app.ai.types import AIError
from app.core.database import Database
from app.core.errors import ApiError
from app.core.timeutil import new_id, now_iso

logger = logging.getLogger(__name__)

SERVER_RESTART = "SERVER_RESTART"
ACTIVE = ("queued", "running")


class JobRunner:
    def __init__(self, database: Database, *, inline: bool = False, workers: int = 4):
        self.database = database
        self.inline = inline
        self._executor = None if inline else ThreadPoolExecutor(max_workers=max(1, workers), thread_name_prefix="patpat-job")
        self._recovery: dict[str, Callable[[dict], None]] = {}

    # --- lifecycle ---------------------------------------------------------------------------------------------
    def register_recovery(self, kind: str, handler: Callable[[dict], None]) -> None:
        self._recovery[kind] = handler

    def recover(self) -> int:
        """Fail every job that was interrupted by a restart and tell its owner."""
        with self.database.connect() as connection:
            rows = [dict(row) for row in connection.execute(
                "SELECT * FROM jobs WHERE status IN ('queued','running')").fetchall()]
            connection.execute(
                "UPDATE jobs SET status='failed', error_code=?, error_message=?, finished_at=? "
                "WHERE status IN ('queued','running')",
                (SERVER_RESTART, "서버가 다시 시작되어 작업이 끝나지 못했습니다.", now_iso()),
            )
        for row in rows:
            handler = self._recovery.get(row["kind"])
            if handler is None:
                continue
            try:
                handler(row)
            except Exception:
                logger.exception("중단된 작업을 정리하지 못했습니다: %s", row["job_id"])
        return len(rows)

    def shutdown(self) -> None:
        if self._executor is not None:
            self._executor.shutdown(wait=True, cancel_futures=False)

    # --- running jobs ----------------------------------------------------------------------------------------------
    def start(
        self,
        teacher_id: str,
        kind: str,
        ref_id: str,
        work: Callable[[], dict | None],
        *,
        on_error: Callable[[str], None] | None = None,
    ) -> dict:
        job_id = new_id()
        with self.database.connect() as connection:
            connection.execute(
                "INSERT INTO jobs(job_id, teacher_id, kind, ref_id, status, created_at) VALUES (?,?,?,?,'queued',?)",
                (job_id, teacher_id, kind, ref_id, now_iso()),
            )
        if self.inline:
            self._execute(job_id, work, on_error)
        else:
            self._executor.submit(self._execute, job_id, work, on_error)
        return self.get(teacher_id, job_id)

    def _execute(self, job_id: str, work: Callable[[], dict | None], on_error: Callable[[str], None] | None) -> None:
        self._update(job_id, status="running", started_at=now_iso())
        try:
            result = work()
        except AIError as error:
            self._fail(job_id, error.code, error.message, on_error)
        except ApiError as error:
            self._fail(job_id, error.code, error.message, on_error)
        except Exception:
            logger.exception("작업 처리 중 예상하지 못한 오류가 났습니다: %s", job_id)
            self._fail(job_id, "INTERNAL_ERROR", "서버 내부 오류가 발생했습니다.", on_error)
        else:
            self._update(job_id, status="completed", result=json.dumps(result or {}, ensure_ascii=False), finished_at=now_iso())

    def _fail(self, job_id: str, code: str, message: str, on_error: Callable[[str], None] | None) -> None:
        self._update(job_id, status="failed", error_code=code, error_message=message, finished_at=now_iso())
        if on_error is not None:
            try:
                on_error(code)
            except Exception:
                logger.exception("실패한 작업의 상태를 정리하지 못했습니다: %s", job_id)

    def _update(self, job_id: str, **fields) -> None:
        assignments = ", ".join(f"{key}=?" for key in fields)
        with self.database.connect() as connection:
            connection.execute(f"UPDATE jobs SET {assignments} WHERE job_id=?", (*fields.values(), job_id))

    # --- reading ---------------------------------------------------------------------------------------------------------
    @staticmethod
    def _row(row) -> dict:
        data = dict(row)
        data["result"] = json.loads(data["result"]) if data.get("result") else None
        return data

    def get(self, teacher_id: str, job_id: str) -> dict | None:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM jobs WHERE teacher_id=? AND job_id=?", (teacher_id, job_id)
            ).fetchone()
        return self._row(row) if row else None

    def is_active(self, ref_id: str) -> bool:
        with self.database.connect() as connection:
            return connection.execute(
                "SELECT 1 FROM jobs WHERE ref_id=? AND status IN ('queued','running') LIMIT 1", (ref_id,)
            ).fetchone() is not None
