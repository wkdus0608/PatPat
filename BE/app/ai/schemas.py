"""JSON schemas for structured output and the code-side validation of the results."""
import re

from app.ai.types import AIBadOutput
from app.rules.loader import AREAS

FLAG_KINDS = ("incident", "conflict", "unresolved", "missing_fact", "ambiguous")
KIND_PRIORITY = {kind: index for index, kind in enumerate(FLAG_KINDS)}
MAX_FLAGS = 10
MAX_DETAIL_QUESTIONS = 6  # 얇은 입력 보충 질문(missing_fact)은 학급 전체에서 6개까지다(규칙 '역질문 정책').
MAX_DETAIL_QUESTIONS_PER_CHILD = 2

_STR = {"type": "string"}
_STR_LIST = {"type": "array", "items": _STR}
JOURNAL_WORD_FIELDS = ("이름", "성별", "반", "생년월일", "관찰일", "관찰기간", "관찰장소", "관찰시간", "관찰영역", "관찰내용",
                       "해석및지원계획", "작성교사")
JOURNAL_WORD_LAYOUT_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["placements"],
    "properties": {"placements": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["slot", "fields"],
        "properties": {"slot": _STR,
                       "fields": {"type": "array", "items": {"type": "string", "enum": list(JOURNAL_WORD_FIELDS)}}},
    }}},
}

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

NOTICE_INCIDENT_HEADING = "특이사항"
INJURY_CONFIRMATION_LABELS = {"body_part": "부위 확인 필요", "laterality": "좌우 확인 필요", "care": "처치 확인 필요"}
INCIDENT_NOTICE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["text", "special_notes", "missing_injury_details"],
    "properties": {
        "text": _STR,
        "special_notes": _STR,
        "missing_injury_details": {"type": "array", "items": {"type": "string", "enum": list(INJURY_CONFIRMATION_LABELS)}},
    },
}

RECORDING_OBSERVATIONS_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["observations"],
    "properties": {"observations": {"type": "array", "items": {
        "type": "object",
        "additionalProperties": False,
        "required": ["recording_id", "quote", "scope", "child_id", "heard_name", "corrections"],
        "properties": {
            "recording_id": _STR, "quote": _STR, "child_id": _STR, "heard_name": _STR,
            "scope": {"type": "string", "enum": ["common", "individual", "unresolved"]},
            "corrections": {"type": "array", "items": {
                "type": "object", "additionalProperties": False,
                "required": ["original", "replacement", "occurrence"],
                "properties": {"original": _STR, "replacement": _STR, "occurrence": {"type": "integer"}},
            }},
        },
    }}},
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
    "required": ["content", "learning", "incident"],
    "properties": {
        "content": _STR,
        "learning": {"type": "array", "items": {
            "type": "object",
            "additionalProperties": False,
            "required": ["areas", "evidence", "text"],
            "properties": {
                "areas": {"type": "array", "items": {"type": "string", "enum": list(AREAS)}},
                "evidence": _STR,
                "text": _STR,
            },
        }},
        "incident": _STR,
    },
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


def render_notice(data: dict, *, incident: bool, unresolved_side: bool = False) -> str:
    if not incident:
        return require_text(data, "text")

    body = data.get("text")
    if not isinstance(body, str):
        raise AIBadOutput("AI 응답에 알림장 본문이 없습니다.")
    special_notes = require_text(data, "special_notes")
    missing = data.get("missing_injury_details")
    if not isinstance(missing, list) or any(
        not isinstance(key, str) or key not in INJURY_CONFIRMATION_LABELS for key in missing
    ):
        raise AIBadOutput("AI 응답의 부상 확인 항목을 읽을 수 없습니다.")
    missing_details = {*missing, "laterality"} if unresolved_side else set(missing)
    markers = [label for key, label in INJURY_CONFIRMATION_LABELS.items() if key in missing_details]
    section = "\n".join((NOTICE_INCIDENT_HEADING, special_notes, *markers))
    return "\n\n".join(part for part in (body.strip(), section) if part)


_SENTENCE_BREAK = re.compile(r"(?<=[.!?])\s+")


def _bigrams(sentence: str) -> set[str]:
    compact = re.sub(r"\s+", "", sentence)
    return {compact[index:index + 2] for index in range(len(compact) - 1)}


def drop_repeated_sentences(parts: list[str], threshold: float = 0.6) -> list[str]:
    """앞에서 이미 쓴 한 문장의 글자 짝 중 60% 이상을 다시 쓴 문장은 같은 사실을 되풀이한 것이므로 뺀다.

    뒤 문장이 더 길어 새 사실이 있으면 겹치는 비율이 낮아 남는다. 글자 짝이 6개 미만인 짧은 문장은 건드리지 않는다.
    """
    kept: list[set[str]] = []
    result: list[str] = []
    for part in parts:
        sentences = []
        for sentence in _SENTENCE_BREAK.split(part.strip()):
            if not sentence:
                continue
            grams = _bigrams(sentence)
            if len(grams) >= 6 and any(len(grams & old) / len(grams) >= threshold for old in kept):
                continue
            kept.append(grams)
            sentences.append(sentence)
        if sentences:
            result.append(" ".join(sentences))
    return result


def render_journal(data: dict, source: str, areas: tuple[str, ...]) -> str:
    content = data.get("content")
    if not isinstance(content, str):
        raise AIBadOutput("AI 응답에 관찰내용이 없습니다.")
    parts = [content.strip()] if content.strip() else []
    selected = set(areas or AREAS)
    learning = data.get("learning")
    if isinstance(learning, list):
        for item in learning:
            if not isinstance(item, dict):
                continue
            labels, evidence, text = item.get("areas"), item.get("evidence"), item.get("text")
            if not isinstance(labels, list) or not labels or not all(
                isinstance(label, str) and label in selected for label in labels
            ):
                continue
            if not isinstance(evidence, str) or not evidence.strip() or evidence.strip() not in source:
                continue
            if isinstance(text, str) and text.strip() and not any(text.strip() in part for part in parts):
                sentence = text.strip()
                parts.append(sentence if sentence.endswith((".", "!", "?", "…")) else sentence + ".")
    incident = data.get("incident")
    if isinstance(incident, str) and incident.strip() and incident.strip() not in content:
        parts.append(incident.strip())
    parts = drop_repeated_sentences(parts)
    if not parts:
        raise AIBadOutput("AI 응답에 작성된 관찰내용이 없습니다.")
    return " ".join(parts)


def cap_detail_questions(flags: list[dict], rank: dict[str, int] | None = None) -> list[dict]:
    """직접 입력으로 사실을 묻는 질문(missing_fact)은 아이마다 2개, 학급 전체 6개까지만 남긴다.

    남길 질문은 rank(아이 → 순위, 작을수록 먼저)로 고른다. 규칙은 하지 않은 일을 먼저, 그다음 입력이 짧은 아이부터
    묻게 하므로 모델이 나열한 순서와 무관해야 한다. rank에 없는 아이는 맨 뒤이고 같은 순위는 먼저 온 순서다.
    남은 질문의 출력 순서는 원래 순서를 지킨다."""
    rank = rank or {}
    detail = [index for index, flag in enumerate(flags) if flag["kind"] == "missing_fact"]
    detail.sort(key=lambda index: (min((rank.get(child_id, len(rank)) for child_id in flags[index]["child_ids"]),
                                       default=len(rank)), index))
    keep, per_child = set(), {}
    for index in detail:
        child_ids = flags[index]["child_ids"]
        if len(keep) >= MAX_DETAIL_QUESTIONS or any(per_child.get(child_id, 0) >= MAX_DETAIL_QUESTIONS_PER_CHILD
                                                    for child_id in child_ids):
            continue
        keep.add(index)
        for child_id in child_ids:
            per_child[child_id] = per_child.get(child_id, 0) + 1
    return [flag for index, flag in enumerate(flags) if flag["kind"] != "missing_fact" or index in keep]


def parse_review(data: dict, valid_child_ids: set[str], *, allow_common: bool = False,
                 detail_rank: dict[str, int] | None = None) -> dict:
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
        direct_answer_only = kind == "missing_fact" and raw.get("options") == []
        if (not direct_answer_only and not 2 <= len(options) <= 4) or (not child_ids and not is_common):
            continue
        flags.append({"kind": kind, "child_ids": child_ids, "question": question.strip(), "options": options})
    # 사건사고로 보인다고 보호자 안내용으로 쓸지 묻지 않는다(부드러운 사건사고 알림장이 기본이다).
    # 모델이 그래도 질문을 만들면 질문은 버리고 그 아이들을 사건사고로만 옮긴다.
    asked_incident_ids = [child_id for flag in flags if flag["kind"] == "incident" for child_id in flag["child_ids"]]
    flags = [flag for flag in flags if flag["kind"] != "incident"]
    flags.sort(key=lambda flag: KIND_PRIORITY[flag["kind"]])
    flags = cap_detail_questions(flags, detail_rank)
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
    incident_ids = list(dict.fromkeys([*incident_ids, *asked_incident_ids]))
    return {"flags": flags[:MAX_FLAGS], "joint_events": events, "incident_child_ids": incident_ids}


def parse_areas(data: dict) -> list[str]:
    areas = [area for area in (data.get("areas") or []) if area in AREAS]
    return list(dict.fromkeys(areas))
