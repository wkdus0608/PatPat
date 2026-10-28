import logging
from typing import Any

from fastapi import Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.errors import ApiError
from app.schemas.common import ErrorDetail, ErrorResponse


logger = logging.getLogger(__name__)


def _error_response(
    *,
    status_code: int,
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> JSONResponse:
    payload = ErrorResponse(
        error=ErrorDetail(code=code, message=message, details=details)
    )
    return JSONResponse(
        status_code=status_code,
        content=jsonable_encoder(payload),
    )


async def api_error_handler(_: Request, exc: ApiError) -> JSONResponse:
    return _error_response(
        status_code=exc.status_code,
        code=exc.code,
        message=exc.message,
        details=exc.details,
    )


async def http_error_handler(
    _: Request, exc: StarletteHTTPException
) -> JSONResponse:
    status_messages = {
        400: ("BAD_REQUEST", "요청을 처리할 수 없습니다."),
        401: ("UNAUTHENTICATED", "인증이 필요합니다."),
        403: ("FORBIDDEN", "요청한 작업을 수행할 수 없습니다."),
        404: ("NOT_FOUND", "요청한 리소스를 찾을 수 없습니다."),
        405: ("METHOD_NOT_ALLOWED", "지원하지 않는 요청 방식입니다."),
        409: ("CONFLICT", "현재 상태와 요청이 충돌합니다."),
        500: ("INTERNAL_ERROR", "서버 내부 오류가 발생했습니다."),
        501: ("NOT_IMPLEMENTED", "이 기능은 아직 구현되지 않았습니다."),
    }
    code, default_message = status_messages.get(
        exc.status_code, ("HTTP_ERROR", "요청을 처리할 수 없습니다.")
    )
    message = exc.detail if isinstance(exc.detail, str) else default_message
    return _error_response(
        status_code=exc.status_code,
        code=code,
        message=message,
    )


async def validation_error_handler(
    _: Request, exc: RequestValidationError
) -> JSONResponse:
    issues = [
        {
            "location": list(issue.get("loc", ())),
            "message": issue.get("msg", "Invalid value"),
            "type": issue.get("type", "value_error"),
        }
        for issue in exc.errors()
    ]
    return _error_response(
        status_code=422,
        code="VALIDATION_ERROR",
        message="요청 형식이 올바르지 않습니다.",
        details={"issues": issues},
    )


async def unexpected_error_handler(_: Request, exc: Exception) -> JSONResponse:
    logger.error(
        "Unhandled application error",
        exc_info=(type(exc), exc, exc.__traceback__),
    )
    return _error_response(
        status_code=500,
        code="INTERNAL_ERROR",
        message="서버 내부 오류가 발생했습니다.",
    )
