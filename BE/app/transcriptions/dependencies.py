from typing import Annotated

from fastapi import Depends

from app.transcriptions.service import TranscriptionService, UnimplementedTranscriptionService


def get_transcription_service() -> TranscriptionService:
    return UnimplementedTranscriptionService()


TranscriptionServiceDependency = Annotated[TranscriptionService, Depends(get_transcription_service)]
