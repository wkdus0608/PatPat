from typing import Annotated

from fastapi import Depends, Request

from app.children.service import ChildrenService, UnimplementedChildrenService


def get_children_service(request: Request) -> ChildrenService:
    return getattr(request.app.state, "children_service", UnimplementedChildrenService())


ChildrenServiceDependency = Annotated[ChildrenService, Depends(get_children_service)]
