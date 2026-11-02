from pydantic import BaseModel, ConfigDict, Field, field_validator


class ChildNameRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: str = Field(min_length=1, description="설정에서 관리하는 아동 이름")

    @field_validator("name")
    @classmethod
    def require_nonblank_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("이름은 공백만으로 구성할 수 없습니다.")
        return value


class ChildCreateRequest(ChildNameRequest):
    pass


class ChildUpdateRequest(ChildNameRequest):
    pass


class ChildResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)

    child_id: str = Field(min_length=1, description="이름 변경·비활성화 뒤에도 유지되는 ID")
    name: str = Field(min_length=1)
    is_active: bool


class ChildListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[ChildResponse]
