from typing import Annotated

from fastapi import Depends

from app.children.service import ChildrenService, UnimplementedChildrenService


def get_children_service() -> ChildrenService:
    return UnimplementedChildrenService()


ChildrenServiceDependency = Annotated[ChildrenService, Depends(get_children_service)]
