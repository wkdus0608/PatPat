"""Public account registration, separate from the authenticated writing API."""
import sqlite3
from typing import Annotated

from fastapi import FastAPI, Response
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict, Field, SecretStr, StringConstraints

from app.auth.repository import create_teacher
from app.auth.schemas import TeacherResponse
from app.core.database import Database
from app.core.errors import ApiError
from app.core.exception_handlers import api_error_handler, unexpected_error_handler, validation_error_handler


class SignupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    login_id: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
    display_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]
    password: SecretStr = Field(min_length=1)


def build_signup_app(database: Database) -> FastAPI:
    application = FastAPI(title="PatPat 회원가입 API")
    application.add_exception_handler(ApiError, api_error_handler)
    application.add_exception_handler(RequestValidationError, validation_error_handler)
    application.add_exception_handler(Exception, unexpected_error_handler)

    @application.post("/signup", status_code=201, response_model=TeacherResponse, summary="교사 계정 만들기")
    def signup(body: SignupRequest, response: Response) -> TeacherResponse:
        try:
            teacher_id = create_teacher(database, body.login_id, body.display_name, body.password.get_secret_value())
        except sqlite3.IntegrityError:
            raise ApiError(
                status_code=409, code="LOGIN_ID_TAKEN", message="이미 사용 중인 계정 ID예요. 다른 ID를 입력해 주세요.",
                headers={"Cache-Control": "no-store"},
            ) from None
        response.headers["Cache-Control"] = "no-store"
        return TeacherResponse(teacher_id=teacher_id, display_name=body.display_name)

    return application
