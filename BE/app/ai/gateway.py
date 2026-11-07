"""Every AI call goes through here so token usage, latency, and failures are recorded."""
import logging
import time

from app.ai.types import AIClient, AIError, AIRequest, AIResult, AIUsage
from app.core.database import Database
from app.core.timeutil import new_id, now_iso

logger = logging.getLogger(__name__)


class AIGateway:
    def __init__(self, client: AIClient, database: Database, rules_hash: str):
        self.client = client
        self.database = database
        self.rules_hash = rules_hash

    @property
    def model(self) -> str:
        return getattr(self.client, "model", "")

    def call(self, request: AIRequest, *, teacher_id: str, session_id: str | None = None) -> AIResult:
        started = time.monotonic()
        try:
            result = self.client.complete(request)
        except AIError as error:
            self._log(request, teacher_id, session_id, started, AIUsage(), "error", error.code)
            raise
        self._log(request, teacher_id, session_id, started, result.usage, "ok", None)
        return result

    def _log(self, request, teacher_id, session_id, started, usage: AIUsage, status: str, error_code: str | None) -> None:
        try:
            with self.database.connect() as connection:
                connection.execute(
                    "INSERT INTO ai_calls(call_id, teacher_id, session_id, task, model, rules_hash, status, error_code, "
                    "input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, latency_ms, created_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (new_id(), teacher_id, session_id, request.task.value, self.model, self.rules_hash, status, error_code,
                     usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens,
                     usage.output_tokens, int((time.monotonic() - started) * 1000), now_iso()),
                )
        except Exception:  # logging must never hide the real result or error
            logger.exception("AI 호출 기록에 실패했습니다.")
