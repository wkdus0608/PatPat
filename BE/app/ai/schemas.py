"""JSON schemas for structured output and the code-side validation of the results."""
from app.ai.types import AIBadOutput
from app.rules.loader import AREAS

FLAG_KINDS = ("incident", "conflict", "unresolved", "missing_fact", "ambiguous")
KIND_PRIORITY = {kind: index for index, kind in enumerate(FLAG_KINDS)}
MAX_FLAGS = 10

_STR = {"type": "string"}
_STR_LIST = {"type": "array", "items": _STR}

REVIEW_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["flags", "joint_events", "incident_child_ids"],
    "properties": {
        "flags": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["kind", "child_ids", "question", "options"],
                "properties": {
                    "kind": {"type": "string", "enum": list(FLAG_KINDS)},
                    "child_ids": _STR_LIST,
                    "question": _STR,
                    "options": _STR_LIST,
                },
            },
        },
        "joint_events": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["child_ids", "facts"],
                "properties": {
                    "child_ids": _STR_LIST,
                    "facts": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["child_id", "fact"],
                            "properties": {"child_id": _STR, "fact": _STR},
                        },
                    },
                },
            },
        },
        "incident_child_ids": _STR_LIST,
    },
}

TEXT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["text"],
    "properties": {"text": _STR},
}

REVIEW_WITH_METADATA_SCHEMA = {
    **REVIEW_SCHEMA,
    "required": [*REVIEW_SCHEMA["required"], "metadata"],
    "properties": {
        **REVIEW_SCHEMA["properties"],
        "metadata": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["block_id", "place", "time_text"],
                "properties": {"block_id": _STR, "place": _STR, "time_text": _STR},
            },
        },
    },
}

CONTENT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["content"],
    "properties": {"content": _STR},
}

AREAS_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["areas"],
    "properties": {"areas": {"type": "array", "items": {"type": "string", "enum": list(AREAS)}}},
}


def require_text(data: dict, key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise AIBadOutput(f"AI 응답에 '{key}'가 없거나 비어 있습니다.")
    return value.strip()


def parse_review(data: dict, valid_child_ids: set[str], *, allow_common: bool = False) -> dict:
    """Keep well-formed class or child questions, ordered by priority."""
    flags = []
    for raw in data.get("flags") or []:
        if not isinstance(raw, dict):
            continue
        kind = raw.get("kind")
        question = raw.get("question")
        options = [str(option).strip() for option in (raw.get("options") or []) if str(option).strip()]
        requested_ids = raw.get("child_ids")
        if not isinstance(requested_ids, list):
            continue
        child_ids = [child_id for child_id in requested_ids if isinstance(child_id, str) and child_id in valid_child_ids]
        is_common = allow_common and not requested_ids and kind != "incident"
        if kind not in KIND_PRIORITY or not isinstance(question, str) or not question.strip():
            continue
        if not 2 <= len(options) <= 4 or (not child_ids and not is_common):
            continue
        flags.append({"kind": kind, "child_ids": child_ids, "question": question.strip(), "options": options})
    flags.sort(key=lambda flag: KIND_PRIORITY[flag["kind"]])
    events = []
    for raw in data.get("joint_events") or []:
        if not isinstance(raw, dict):
            continue
        facts = {}
        for item in raw.get("facts") or []:
            if isinstance(item, dict) and item.get("child_id") in valid_child_ids and isinstance(item.get("fact"), str):
                facts[item["child_id"]] = item["fact"].strip()
        if len(facts) >= 2:
            events.append({"child_ids": list(facts), "facts": facts})
    incident_ids = [child_id for child_id in (data.get("incident_child_ids") or []) if child_id in valid_child_ids]
    return {"flags": flags[:MAX_FLAGS], "joint_events": events, "incident_child_ids": incident_ids}


def parse_areas(data: dict) -> list[str]:
    areas = [area for area in (data.get("areas") or []) if area in AREAS]
    return list(dict.fromkeys(areas))
