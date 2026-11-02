from typing import Protocol
from app.writing.models import DraftJob, DraftResult, GenerationSnapshot, JournalRecord, WritingFailure


class DraftRepository(Protocol):
    async def reserve(self, *, teacher_id: str, snapshot: GenerationSnapshot) -> DraftJob:
        """Recheck owned completed/nondeleted sources; freeze roster/transcripts atomically."""
        ...
    async def get(self, *, teacher_id: str, draft_id: str) -> DraftJob | None: ...
    async def claim(self, *, teacher_id: str, job_id: str) -> DraftJob:
        """One worker atomically claims queued -> running."""
        ...
    async def complete(self, *, teacher_id: str, job_id: str, snapshot: GenerationSnapshot, result: DraftResult, records: tuple[JournalRecord, ...]) -> None:
        """Require same frozen roster/transcripts as reservation; add validated extracted
        observations. Validate selected evidence and roster order; publish all records + initial
        history + completed job atomically. Server assigns unique record IDs.
        No partial results on validation/persistence failure. Preserve snapshots.
        """
        ...
    async def fail(self, *, teacher_id: str, job_id: str, failure: WritingFailure) -> None: ...
