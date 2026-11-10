from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Protocol


class AITask(StrEnum):
    RECORDING_OBSERVATIONS = "recording_observations"
    REVIEW = "review"
    COMMON = "common"
    INDIVIDUAL = "individual"
    REVISE = "revise"
    JOURNAL_COMMON = "journal_common"
    JOURNAL_INDIVIDUAL = "journal_individual"
    JOURNAL_WORD_LAYOUT = "journal_word_layout"
    AREAS = "areas"


@dataclass(frozen=True)
class AIRequest:
    task: AITask
    system_text: str  # fixed rules block; identical for every call so it can be cached
    user_text: str  # task instruction + this call's data
    schema: dict | None  # JSON schema of the expected output
    payload: dict = field(default_factory=dict)  # structured copy of the input; used by the fake, never sent
    max_tokens: int | None = None


@dataclass(frozen=True)
class AIUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0


@dataclass(frozen=True)
class AIResult:
    data: dict[str, Any]
    usage: AIUsage = field(default_factory=AIUsage)
    model: str = ""


class AIError(Exception):
    code = "AI_ERROR"

    def __init__(self, message: str = "", *, code: str | None = None):
        super().__init__(message or self.code)
        self.message = message or self.code
        if code:
            self.code = code


class AINotConfigured(AIError):
    code = "AI_NOT_CONFIGURED"


class AIUnavailable(AIError):
    code = "AI_UNAVAILABLE"


class AIRateLimited(AIError):
    code = "AI_RATE_LIMITED"


class AIRefusal(AIError):
    code = "AI_REFUSAL"


class AITruncated(AIError):
    code = "AI_TRUNCATED"


class AIBadOutput(AIError):
    code = "AI_BAD_OUTPUT"


class AIClient(Protocol):
    model: str

    def complete(self, request: AIRequest) -> AIResult:
        """Blocking call. Raise an AIError subclass on any failure."""
        ...
