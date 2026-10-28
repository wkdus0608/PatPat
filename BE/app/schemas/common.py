from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ErrorDetail(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(description="기계가 처리할 수 있는 오류 코드")
    message: str = Field(description="사용자에게 표시할 오류 설명")
    details: dict[str, Any] | None = Field(
        default=None,
        description="오류에 관한 구조화된 부가 정보",
    )


class ErrorResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    error: ErrorDetail
