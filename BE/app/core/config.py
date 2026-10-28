from dataclasses import dataclass
import os


@dataclass(frozen=True)
class Settings:
    app_name: str = "PatPat Backend"
    api_version: str = "0.1.0"
    debug: bool = False


def get_settings() -> Settings:
    return Settings(
        app_name=os.getenv("APP_NAME", "PatPat Backend"),
        api_version=os.getenv("APP_VERSION", "0.1.0"),
        debug=os.getenv("DEBUG", "false").lower() in {"1", "true", "yes"},
    )
