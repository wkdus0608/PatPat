from fastapi import APIRouter

from app.auth.router import auth_router
from app.children.router import children_router
from app.recordings.router import recordings_router
from app.transcriptions.router import transcriptions_router


api_v1_router = APIRouter(prefix="/api/v1")
api_v1_router.include_router(auth_router)
api_v1_router.include_router(children_router)
api_v1_router.include_router(recordings_router)
api_v1_router.include_router(transcriptions_router)
