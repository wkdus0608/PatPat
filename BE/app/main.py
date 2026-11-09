from fastapi import FastAPI
from asyncio import to_thread
from contextlib import asynccontextmanager
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.health import health_router
from app.api.v1.not_implemented import not_implemented_router
from app.api.v1.router import api_v1_router
from app.container import install_services
from app.core.config import Settings, get_settings
from app.core.errors import ApiError
from app.core.database import Database
from app.auth.repository import SQLiteAuthRepository
from app.auth.service import SQLiteAuthService
from app.children.repository import SQLiteChildrenRepository
from app.children.service import SQLiteChildrenService
from app.recordings.storage import SQLiteRecordingService
from app.transcriptions.client import SpeechToTextClient
from app.core.exception_handlers import (
    api_error_handler,
    http_error_handler,
    unexpected_error_handler,
    validation_error_handler,
)


def create_app(settings: Settings | None = None, *, speech_to_text: SpeechToTextClient | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        await to_thread(application.state.database.initialize)
        for hook in application.state.startup_hooks:
            await to_thread(hook)
        yield
        for hook in application.state.shutdown_hooks:
            await to_thread(hook)

    application = FastAPI(
        title=settings.app_name,
        version=settings.api_version,
        description=(
            "쓰담쓰담 MVP 백엔드 API입니다. "
            "인증·아동 명단은 SQLite에 저장하며 후속 업무 API는 아직 미연결입니다."
        ),
        debug=settings.debug,
        lifespan=lifespan,
    )
    database = Database(settings.database_path)
    application.state.database = database
    application.state.auth_service = SQLiteAuthService(SQLiteAuthRepository(database), settings.session_ttl_seconds)
    application.state.children_service = SQLiteChildrenService(SQLiteChildrenRepository(database))
    application.state.recording_service = SQLiteRecordingService(database, settings)
    install_services(application, settings, database, speech_to_text=speech_to_text)
    application.add_middleware(CORSMiddleware, allow_origins=list(settings.cors_origins),
                               allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
                               allow_headers=["Authorization", "Content-Type", "Idempotency-Key"])

    application.add_exception_handler(ApiError, api_error_handler)
    application.add_exception_handler(StarletteHTTPException, http_error_handler)
    application.add_exception_handler(RequestValidationError, validation_error_handler)
    application.add_exception_handler(Exception, unexpected_error_handler)

    application.include_router(health_router)
    application.include_router(api_v1_router)
    # Keep the fallback last so feature routes take precedence.
    application.include_router(not_implemented_router)
    return application


app = create_app()
