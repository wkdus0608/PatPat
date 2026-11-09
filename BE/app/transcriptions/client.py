from collections.abc import AsyncIterator
from typing import Protocol

from app.transcriptions.models import SpeechToTextResult


class SpeechToTextClient(Protocol):
    async def transcribe(
        self, *, audio: AsyncIterator[bytes], content_type: str
    ) -> SpeechToTextResult:
        """Send private server audio to external STT, return transcript only.
        Credentials remain server-side. No child assignment or diary generation.
        """
        ...


class DemoSpeechToTextClient:
    """Explicit fixture for local demos. Never use it to infer what the audio says."""

    def __init__(self, text: str):
        self.text = text

    async def transcribe(self, *, audio: AsyncIterator[bytes], content_type: str) -> SpeechToTextResult:
        return SpeechToTextResult(text=self.text)
