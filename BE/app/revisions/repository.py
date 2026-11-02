from typing import Protocol
from app.writing.models import JournalRecord, RecordHistory, RevisionJob, WritingFailure


class RevisionRepository(Protocol):
    async def reserve(self, *, teacher_id: str, record_id: str, expected_version: int, instruction: str) -> RevisionJob:
        """Atomically verify record/version, freeze current body + child + original
        evidence and assign new job/revision IDs. Do not change current record.
        """
        ...
    async def get(self, *, teacher_id: str, record_id: str, revision_id: str) -> RevisionJob | None: ...
    async def claim(self, *, teacher_id: str, revision_id: str) -> RevisionJob:
        """Atomically queued -> running, one worker."""
        ...
    async def complete(self, *, teacher_id: str, revision: RevisionJob) -> None:
        """Only current running attempt. Validate candidate provenance against
        reserved child's evidence; store ready candidate, never overwrite record.
        """
        ...
    async def fail(self, *, teacher_id: str, revision_id: str, failure: WritingFailure) -> None:
        """Persist safe failure only; preserve current record/body/version."""
        ...
    async def adopt(self, *, teacher_id: str, revision_id: str, expected_version: int, record: JournalRecord, history: RecordHistory) -> None:
        """CAS record current/base versions and ownership, require ready candidate;
        apply exact candidate + review state + history atomically; no AI invocation.
        """
        ...
