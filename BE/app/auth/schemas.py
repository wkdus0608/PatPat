from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr


class LoginRequest(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        strict=True,
        json_schema_extra={
            "examples": [{"login_id": "teacher-demo", "password": "demo-password-only"}]
        },
    )

    login_id: str = Field(min_length=1, description="미리 준비한 테스트 계정 ID")
    password: SecretStr = Field(min_length=1, description="테스트 계정 비밀번호")


class TeacherResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)

    teacher_id: str = Field(min_length=1, description="서버가 확인한 교사 ID")
    display_name: str = Field(min_length=1, description="앱에 표시할 교사 이름")


class LoginResponse(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "examples": [
                {
                    "access_token": "example-access-token",
                    "token_type": "bearer",
                    "expires_in": 3600,
                    "teacher": {
                        "teacher_id": "T_DEMO_01",
                        "display_name": "테스트 교사 1",
                    },
                }
            ]
        },
    )

    access_token: str = Field(min_length=1, repr=False, description="Bearer 접근 토큰")
    token_type: Literal["bearer"] = "bearer"
    expires_in: int = Field(gt=0, description="토큰 만료까지 남은 초")
    teacher: TeacherResponse
