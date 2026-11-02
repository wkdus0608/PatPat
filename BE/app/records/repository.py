from typing import Protocol
from app.writing.models import JournalRecord, RecordHistory


class RecordRepository(Protocol):
    async def get(self, *, teacher_id: str, record_id: str) -> JournalRecord | None: ...
    async def commit(self, *, teacher_id: str, record_id: str, expected_version: int, record: JournalRecord, history: RecordHistory) -> None:
        """CAS current version and atomically write exact text/status/version +
        matching immutable history. Preserve generated content/evidence snapshots.
        Never invoke AI. Stale version ->409; other owner ->404.
        """
        ...
    async def history(self, *, teacher_id: str, record_id: str) -> tuple[RecordHistory, ...]:
        """Verify record ownership even for empty history; order by version."""
        ...
