from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.health import health_router
from app.api.v1.not_implemented import not_implemented_router
from app.api.v1.router import api_v1_router
from app.core.config import get_settings
from app.core.errors import ApiError
from app.core.exception_handlers import (
    api_error_handler,
    http_error_handler,
    unexpected_error_handler,
    validation_error_handler,
)


settings = get_settings()

app = FastAPI(
    title=settings.app_name,
    version=settings.api_version,
    description=(
        "쓰담쓰담 MVP 백엔드 API입니다. "
        "미구현 업무 API는 NOT_IMPLEMENTED 오류를 반환합니다."
    ),
    debug=settings.debug,
)

app.add_exception_handler(ApiError, api_error_handler)
app.add_exception_handler(StarletteHTTPException, http_error_handler)
app.add_exception_handler(RequestValidationError, validation_error_handler)
app.add_exception_handler(Exception, unexpected_error_handler)

app.include_router(health_router)
app.include_router(api_v1_router)
# Keep the fallback last so future feature routes take precedence.
app.include_router(not_implemented_router)
