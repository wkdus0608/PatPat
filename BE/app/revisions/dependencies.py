from typing import Annotated
from fastapi import Depends
from app.revisions.service import RevisionService, UnimplementedRevisionService


def get_revision_service() -> RevisionService:
    return UnimplementedRevisionService()


RevisionServiceDependency = Annotated[RevisionService, Depends(get_revision_service)]
