from datetime import datetime, timezone
from uuid import uuid4


def now_iso() -> str:
    """UTC timestamp with an explicit offset, e.g. 2026-11-06T05:00:00+00:00."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id() -> str:
    return str(uuid4())
