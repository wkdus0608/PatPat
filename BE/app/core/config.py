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
    # Notice-first flow. The Anthropic key is intentionally empty until the team registers one.
    rules_path: str = str(Path(__file__).resolve().parents[2] / "rules")
    ai_provider: str = "anthropic"  # "anthropic" | "fake" (fake is for local demos and tests only)
    anthropic_api_key: str = ""
    ai_model: str = "claude-opus-5-5"
    ai_effort: str = "medium"
    ai_max_tokens: int = 16000
    ai_timeout_seconds: float = 120.0
    ai_fallbacks: bool | None = None  # None = on for models that support server-side fallbacks
    ai_parallelism: int = 4
    jobs_inline: bool = False  # run background jobs synchronously (tests)


def _optional_bool(name: str) -> bool | None:
    value = os.getenv(name)
    if value is None or not value.strip():
        return None
    return value.strip().lower() in {"1", "true", "yes", "on"}


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
        rules_path=os.getenv("PATPAT_RULES_PATH", Settings.rules_path),
        ai_provider=os.getenv("PATPAT_AI_PROVIDER", Settings.ai_provider).strip().lower(),
        anthropic_api_key=os.getenv("ANTHROPIC_API_KEY", "").strip(),
        ai_model=os.getenv("PATPAT_AI_MODEL", Settings.ai_model),
        ai_effort=os.getenv("PATPAT_AI_EFFORT", Settings.ai_effort),
        ai_max_tokens=int(os.getenv("PATPAT_AI_MAX_TOKENS", str(Settings.ai_max_tokens))),
        ai_timeout_seconds=float(os.getenv("PATPAT_AI_TIMEOUT_SECONDS", str(Settings.ai_timeout_seconds))),
        ai_fallbacks=_optional_bool("PATPAT_AI_FALLBACKS"),
        ai_parallelism=max(1, int(os.getenv("PATPAT_AI_PARALLELISM", str(Settings.ai_parallelism)))),
        jobs_inline=os.getenv("PATPAT_JOBS_INLINE", "false").lower() in {"1", "true", "yes"},
    )
