from collections.abc import AsyncIterator
from tempfile import SpooledTemporaryFile
from typing import Protocol

import httpx

from app.transcriptions.models import SpeechToTextResult


AUDIO_EXTENSIONS = {
    "audio/mp4": "m4a",
    "audio/m4a": "m4a",
    "audio/x-m4a": "m4a",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/webm": "webm",
    "audio/aac": "aac",
}


class SpeechToTextClient(Protocol):
    async def transcribe(
        self, *, audio: AsyncIterator[bytes], content_type: str
    ) -> SpeechToTextResult:
        """Send private server audio to external STT, return transcript only.
        Credentials remain server-side. No child assignment or diary generation.
        """
        ...


class MultipartSpeechToTextClient:
    def __init__(self, url: str, api_key: str, model: str):
        self.url = url
        self.api_key = api_key
        self.model = model

    async def transcribe(self, *, audio: AsyncIterator[bytes], content_type: str) -> SpeechToTextResult:
        filename = "recording." + AUDIO_EXTENSIONS[content_type]
        fields = {"response_format": "json"}
        if self.model:
            fields["model"] = self.model
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        with SpooledTemporaryFile(max_size=2 * 1024 * 1024) as upload:
            async for chunk in audio:
                upload.write(chunk)
            upload.seek(0)
            async with httpx.AsyncClient(timeout=httpx.Timeout(180, connect=10)) as client:
                response = await client.post(
                    self.url, headers=headers, data=fields, files={"file": (filename, upload, content_type)},
                )
                response.raise_for_status()
                result = response.json()
        if not isinstance(result, dict) or not isinstance(result.get("text"), str):
            raise ValueError("The transcription response must contain text.")
        return SpeechToTextResult(text=result["text"])


class DemoSpeechToTextClient:
    """Explicit fixture for local demos. Never use it to infer what the audio says."""

    def __init__(self, text: str):
        self.text = text

    async def transcribe(self, *, audio: AsyncIterator[bytes], content_type: str) -> SpeechToTextResult:
        return SpeechToTextResult(text=self.text)
