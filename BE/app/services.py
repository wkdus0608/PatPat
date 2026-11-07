"""The service container shared by the /api/v2 routers (kept free of router imports)."""
from dataclasses import dataclass
from typing import Any

from fastapi import Request


@dataclass
class Services:
    settings: Any
    database: Any
    rules: Any
    profile: Any
    sessions: Any
    ai: Any
    jobs: Any
    pipeline: Any = None
    notices: Any = None  # NoticeStore
    notice_service: Any = None
    journal: Any = None  # JournalService
    journal_store: Any = None
    quicknote_store: Any = None


def get_services(request: Request) -> Services:
    return request.app.state.services
