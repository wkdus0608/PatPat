from fastapi import APIRouter

from app.core.errors import ApiError


not_implemented_router = APIRouter(prefix="/api/v1")

_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]


@not_implemented_router.api_route(
    "/{path:path}", methods=_METHODS, include_in_schema=False
)
async def feature_not_implemented(path: str) -> None:
    raise ApiError(
        status_code=501,
        code="NOT_IMPLEMENTED",
        message="이 기능은 아직 구현되지 않았습니다.",
        details={"path": f"/api/v1/{path}"},
    )
