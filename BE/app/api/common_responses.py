from app.schemas.common import ErrorResponse


COMMON_ERROR_RESPONSES = {
    400: {"model": ErrorResponse, "description": "잘못된 요청"},
    401: {"model": ErrorResponse, "description": "인증 필요"},
    403: {"model": ErrorResponse, "description": "접근 거부"},
    404: {"model": ErrorResponse, "description": "리소스를 찾을 수 없음"},
    409: {"model": ErrorResponse, "description": "상태 충돌"},
    422: {"model": ErrorResponse, "description": "요청 검증 실패"},
    500: {"model": ErrorResponse, "description": "서버 내부 오류"},
    501: {"model": ErrorResponse, "description": "기능 미구현"},
}
