from fastapi import APIRouter

from app.api.common_responses import COMMON_ERROR_RESPONSES
from app.schemas.health import HealthResponse


health_router = APIRouter(tags=["health"])


@health_router.get(
    "/health",
    response_model=HealthResponse,
    summary="서버 상태 확인",
    responses={500: COMMON_ERROR_RESPONSES[500]},
)
async def get_health() -> HealthResponse:
    return HealthResponse(status="ok")
