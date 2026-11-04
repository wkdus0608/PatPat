from typing import Annotated

from fastapi import Depends, Request

from app.recordings.service import RecordingService, UnimplementedRecordingService


def get_recording_service(request: Request) -> RecordingService:
    return getattr(request.app.state, "recording_service", UnimplementedRecordingService())


RecordingServiceDependency = Annotated[RecordingService, Depends(get_recording_service)]
