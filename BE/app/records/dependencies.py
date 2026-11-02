from typing import Annotated
from fastapi import Depends
from app.records.service import RecordService, UnimplementedRecordService


def get_record_service() -> RecordService:
    return UnimplementedRecordService()


RecordServiceDependency = Annotated[RecordService, Depends(get_record_service)]
