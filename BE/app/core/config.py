from dataclasses import dataclass
import os
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    app_name: str = "PatPat Backend"
    api_version: str = "0.1.0"
    debug: bool = False
    audio_path: str = ""
    audio_max_bytes: int = 100 * 1024 * 1024
    audio_validation_seconds: int = 30
    database_path: str = str(Path(__file__).resolve().parents[2] / "data/patpat.sqlite3")
    session_ttl_seconds: int = 7 * 24 * 60 * 60
    cors_origins: tuple[str, ...] = ("http://localhost:8081", "http://127.0.0.1:8081")


def get_settings() -> Settings:
    return Settings(
        app_name=os.getenv("APP_NAME", "PatPat Backend"),
        api_version=os.getenv("APP_VERSION", "0.1.0"),
        debug=os.getenv("DEBUG", "false").lower() in {"1", "true", "yes"},
        audio_path=os.getenv("PATPAT_AUDIO_PATH", ""),
        audio_max_bytes=int(os.getenv("PATPAT_AUDIO_MAX_BYTES", str(Settings.audio_max_bytes))),
        audio_validation_seconds=int(os.getenv("PATPAT_AUDIO_VALIDATION_SECONDS", "30")),
        database_path=os.getenv("PATPAT_DATABASE_PATH", Settings.database_path),
        session_ttl_seconds=int(os.getenv("PATPAT_SESSION_TTL_SECONDS", str(Settings.session_ttl_seconds))),
        cors_origins=tuple(x.strip() for x in os.getenv("PATPAT_CORS_ORIGINS", ",".join(Settings.cors_origins)).split(",") if x.strip()),
    )
