from fastapi import APIRouter


api_v1_router = APIRouter(prefix="/api/v1")

# Register feature routers here as their BE tasks are implemented.
# Document shared failures with `responses=COMMON_ERROR_RESPONSES`.
