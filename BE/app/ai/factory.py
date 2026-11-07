from app.ai.anthropic_client import AnthropicClient, NotConfiguredAIClient
from app.ai.fake import FakeAIClient
from app.core.config import Settings


def create_ai_client(settings: Settings):
    if settings.ai_provider == "fake":
        return FakeAIClient()
    if settings.ai_provider == "anthropic":
        if not settings.anthropic_api_key:
            return NotConfiguredAIClient(settings.ai_model)
        return AnthropicClient(
            api_key=settings.anthropic_api_key,
            model=settings.ai_model,
            effort=settings.ai_effort,
            max_tokens=settings.ai_max_tokens,
            timeout=settings.ai_timeout_seconds,
            fallbacks=settings.ai_fallbacks,
        )
    raise ValueError(f"알 수 없는 AI 공급자입니다: {settings.ai_provider!r} (anthropic 또는 fake)")
