from typing import Annotated

from fastapi import Depends

from app.recordings.service import RecordingService, UnimplementedRecordingService


def get_recording_service() -> RecordingService:
    return UnimplementedRecordingService()


RecordingServiceDependency = Annotated[RecordingService, Depends(get_recording_service)]
