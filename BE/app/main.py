from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.health import health_router
from app.api.v1.not_implemented import not_implemented_router
from app.api.v1.router import api_v1_router
from app.core.config import Settings, get_settings
from app.core.errors import ApiError
from app.core.exception_handlers import (
    api_error_handler,
    http_error_handler,
    unexpected_error_handler,
    validation_error_handler,
)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    application = FastAPI(
        title=settings.app_name,
        version=settings.api_version,
        description=(
            "쓰담쓰담 MVP 백엔드 API입니다. "
            "계정·토큰 서비스와 미구현 업무 API는 NOT_IMPLEMENTED 오류를 반환합니다."
        ),
        debug=settings.debug,
    )

    application.add_exception_handler(ApiError, api_error_handler)
    application.add_exception_handler(StarletteHTTPException, http_error_handler)
    application.add_exception_handler(RequestValidationError, validation_error_handler)
    application.add_exception_handler(Exception, unexpected_error_handler)

    application.include_router(health_router)
    application.include_router(api_v1_router)
    # Keep the fallback last so feature routes take precedence.
    application.include_router(not_implemented_router)
    return application


app = create_app()
