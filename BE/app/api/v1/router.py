from fastapi import APIRouter

from app.auth.router import auth_router


api_v1_router = APIRouter(prefix="/api/v1")

api_v1_router.include_router(auth_router)
