"""Claude (Anthropic Messages API) client.

The rule block is sent as the first system block with `cache_control`, so every call that shares
it reads the prompt cache. Output is constrained with `output_config.format` (JSON schema).
Server-side refusal fallbacks are on by default for the models that support them.
Nothing here has been exercised against the live API yet (no key is registered).
"""
import json

from app.ai.types import (
    AIBadOutput,
    AIError,
    AINotConfigured,
    AIRateLimited,
    AIRefusal,
    AIRequest,
    AIResult,
    AITruncated,
    AIUnavailable,
    AIUsage,
)

FALLBACK_BETA = "server-side-fallback-2026-07-01"
AUTO_FALLBACK_PREFIXES = ("claude-opus-5", "claude-fable", "claude-sonnet-5-5")


class NotConfiguredAIClient:
    """Used while no API key is registered: the server starts, AI features answer 503."""

    def __init__(self, model: str = ""):
        self.model = model

    def complete(self, request: AIRequest) -> AIResult:
        raise AINotConfigured("AI API 키가 등록되지 않았습니다. ANTHROPIC_API_KEY를 설정해 주세요.")


class AnthropicClient:
    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        effort: str = "",
        max_tokens: int = 16000,
        timeout: float = 120.0,
        fallbacks: bool | None = None,
        sdk=None,
    ):
        self.api_key = api_key
        self.model = model
        self.effort = effort
        self.max_tokens = max_tokens
        self.timeout = timeout
        self.fallbacks = fallbacks
        self._sdk = sdk

    @property
    def use_fallbacks(self) -> bool:
        if self.fallbacks is not None:
            return self.fallbacks
        return self.model.startswith(AUTO_FALLBACK_PREFIXES)

    def _client(self):
        if self._sdk is None:
            try:
                import anthropic
            except ImportError as error:
                raise AINotConfigured("anthropic 패키지가 없습니다. pip install -e '.[ai]' 로 설치해 주세요.") from error
            self._sdk = anthropic.Anthropic(api_key=self.api_key, timeout=self.timeout, max_retries=2)
        return self._sdk

    def build_kwargs(self, request: AIRequest) -> dict:
        kwargs: dict = {
            "model": self.model,
            "max_tokens": request.max_tokens or self.max_tokens,
            "system": [{"type": "text", "text": request.system_text, "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "user", "content": request.user_text}],
        }
        output_config: dict = {}
        if self.effort:
            output_config["effort"] = self.effort
        if request.schema:
            output_config["format"] = {"type": "json_schema", "schema": request.schema}
        if output_config:
            kwargs["output_config"] = output_config
        if self.use_fallbacks:
            kwargs["betas"] = [FALLBACK_BETA]
            kwargs["fallbacks"] = "default"
        return kwargs

    def complete(self, request: AIRequest) -> AIResult:
        sdk = self._client()
        kwargs = self.build_kwargs(request)
        try:
            endpoint = sdk.beta.messages if "betas" in kwargs else sdk.messages
            response = endpoint.create(**kwargs)
        except AIError:
            raise
        except Exception as error:  # the SDK's typed errors are mapped by status code
            raise _map_error(error) from error
        return self._result(response)

    def _result(self, response) -> AIResult:
        stop_reason = getattr(response, "stop_reason", None)
        if stop_reason == "refusal":
            raise AIRefusal("AI가 이 요청을 처리하지 않았습니다.")
        if stop_reason == "max_tokens":
            raise AITruncated("AI 응답이 길이 제한에서 잘렸습니다.")
        text = "".join(block.text for block in getattr(response, "content", []) if getattr(block, "type", "") == "text")
        try:
            data = json.loads(text)
        except json.JSONDecodeError as error:
            raise AIBadOutput("AI 응답이 JSON이 아닙니다.") from error
        if not isinstance(data, dict):
            raise AIBadOutput("AI 응답이 JSON 객체가 아닙니다.")
        usage = getattr(response, "usage", None)
        return AIResult(
            data=data,
            usage=AIUsage(
                input_tokens=getattr(usage, "input_tokens", 0) or 0,
                output_tokens=getattr(usage, "output_tokens", 0) or 0,
                cache_creation_input_tokens=getattr(usage, "cache_creation_input_tokens", 0) or 0,
                cache_read_input_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
            ),
            model=getattr(response, "model", "") or self.model,
        )


def _map_error(error: Exception) -> AIError:
    status = getattr(error, "status_code", None)
    if status == 429:
        return AIRateLimited("AI 요청이 한도에 걸렸습니다. 잠시 뒤 다시 시도해 주세요.")
    if status in (401, 403):
        return AINotConfigured("AI API 키가 올바르지 않거나 권한이 없습니다.", code="AI_AUTH")
    if status == 400:
        return AIError("AI가 요청을 받아들이지 않았습니다.", code="AI_BAD_REQUEST")
    return AIUnavailable("AI에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
