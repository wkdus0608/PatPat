from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

DocumentKind = Literal["writing_examples", "record_format"]
MAX_TEXT = 20_000


class OnboardingProgress(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    step: int = Field(ge=1, le=5, description="1 반 정보, 2 아동 명단, 3 아동 특성, 4 글 예시, 5 완료")


class TextBody(BaseModel):
    """Whitespace and newlines are stored exactly as sent; an empty string clears the text."""

    model_config = ConfigDict(extra="forbid", strict=True)

    text: str = Field(max_length=MAX_TEXT)


class CharacteristicsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    child_id: str
    text: str | None
    updated_at: str | None


class DocumentResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: DocumentKind
    text: str | None
    updated_at: str | None


class ClassroomBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=100)
    age_label: str = Field(default="", max_length=30, description="교사가 입력한 반 연령. 예: 만 2세")


class ClassroomPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=100)
    age_label: str | None = Field(default=None, max_length=30)


class ClassroomResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    classroom_id: str
    name: str
    age_label: str
    age_band: str | None = Field(description="표준보육과정 구간(0-1세/2세/3-5세). 연령이 비었거나 범위 밖이면 null")


class ClassroomListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[ClassroomResponse]


class ChildDetailsPatch(BaseModel):
    """Only the fields that are sent change; null clears a field."""

    model_config = ConfigDict(extra="forbid")

    gender: str | None = Field(default=None, max_length=10)
    birth_date: date | None = None
    classroom_id: str | None = None


class ChildDetailsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    child_id: str
    gender: str | None
    birth_date: str | None
    classroom_id: str | None
