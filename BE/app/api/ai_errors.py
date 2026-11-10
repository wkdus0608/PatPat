from app.ai.types import AIError
from app.core.errors import ApiError

_STATUS = {
    "AI_NOT_CONFIGURED": 503,
    "AI_AUTH": 503,
    "AI_UNAVAILABLE": 503,
    "AI_RATE_LIMITED": 429,
    "AI_REFUSAL": 422,
}


def ai_error_to_api(error: AIError) -> ApiError:
    """Never copy provider error text; only our own safe message and code."""
    return ApiError(status_code=_STATUS.get(error.code, 502), code=error.code, message=error.message)
