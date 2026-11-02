from typing import Protocol
from pydantic import Field
from app.writing.models import (
    ChildContent, ChildSnapshot, DraftContent, FrozenModel, GenerationSnapshot,
    NonBlank, ObservationSnapshot, RevisionContext, TranscriptSnapshot,
)


class RevisionProposal(FrozenModel):
    edited_text: NonBlank = Field(repr=False)
    content: ChildContent


class DiaryAIClient(Protocol):
    async def extract(self, *, transcripts: tuple[TranscriptSnapshot, ...], children: tuple[ChildSnapshot, ...]) -> tuple[ObservationSnapshot, ...]:
        """Preserve appearance order; common/individual/joint/unresolved.
        Ambiguous names stay unresolved. Service assigns/checks observation IDs.
        """
        ...
    async def generate(self, *, snapshot: GenerationSnapshot) -> DraftContent:
        """Validated selected evidence/full frozen roster only. No server record IDs.
        Preserve facts; omit unsupported content kinds and individual inventions.
        """
        ...
    async def revise(self, *, context: RevisionContext, instruction: str) -> RevisionProposal:
        """Only target child + original common/individual/joint evidence.
        Current teacher text/instruction cannot add facts to the evidence snapshot.
        Output is a candidate, never a write to the teacher's current record.
        """
        ...
