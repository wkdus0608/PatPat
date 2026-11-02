from typing import Annotated
from fastapi import Depends
from app.drafts.service import DraftService, UnimplementedDraftService


def get_draft_service() -> DraftService:
    return UnimplementedDraftService()


DraftServiceDependency = Annotated[DraftService, Depends(get_draft_service)]
