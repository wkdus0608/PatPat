"""The notice-first API, served as a mounted sub-application under /api/v2.

It has its own OpenAPI (/api/v2/openapi.json) so the legacy /api/v1 contract, which
existing tests compare against BE/docs/API_CONTRACT.md, stays untouched. Both apps
share the same bearer tokens and database.
"""
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.config import Settings
from app.core.errors import ApiError
from app.core.exception_handlers import (
    api_error_handler,
    http_error_handler,
    unexpected_error_handler,
    validation_error_handler,
)


def build_v2_app(settings: Settings, routers: list) -> FastAPI:
    application = FastAPI(
        title=f"{settings.app_name} - 알림장 API (v2)",
        version=settings.api_version,
        description=(
            "알림장 중심 흐름: 반·아이별 입력 블록 → 교차 검토(역질문) → 아이별 초안 → "
            "수정·AI 재요청·확정 → 관찰일지 행. 인증은 /api/v1/auth/login의 Bearer 토큰을 그대로 씁니다."
        ),
        debug=settings.debug,
    )
    application.add_exception_handler(ApiError, api_error_handler)
    application.add_exception_handler(StarletteHTTPException, http_error_handler)
    application.add_exception_handler(RequestValidationError, validation_error_handler)
    application.add_exception_handler(Exception, unexpected_error_handler)
    for router in routers:
        application.include_router(router)
    return application
