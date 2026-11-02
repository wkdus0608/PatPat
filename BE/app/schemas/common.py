from datetime import date
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator


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


class ListQuery(BaseModel):
    """Calendar dates are inclusive in Asia/Seoul; ignore unknown query keys."""
    model_config = ConfigDict(extra="ignore", frozen=True)

    date_from: date | None = None
    date_to: date | None = None
    limit: int = Field(default=20, ge=1, le=100)
    offset: int = Field(default=0, ge=0)
    order: Literal["desc", "asc"] = "desc"

    @model_validator(mode="after")
    def ordered_dates(self) -> Self:
        if self.date_from and self.date_to and self.date_from > self.date_to:
            raise ValueError("시작일은 종료일 이후일 수 없습니다.")
        return self


class PageMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")

    total: int = Field(ge=0, description="필터 적용 후 페이지를 자르기 전 전체 수")
    limit: int = Field(ge=1, le=100)
    offset: int = Field(ge=0)
