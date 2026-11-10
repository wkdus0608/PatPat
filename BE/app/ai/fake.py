"""Deterministic stand-in for the AI, for local demos and tests (no network, no key).

Its sentences are marked "[테스트 문장]" so they can never be mistaken for real output.
Tests replace handlers per task to script particular situations or failures.
"""
import json
import re
from collections.abc import Callable

from app.ai.privacy import mask_names
from app.ai.schemas import JOURNAL_WORD_FIELDS
from app.ai.types import AIRequest, AIResult, AITask, AIUnavailable, AIUsage
from app.rules.loader import AREAS

MARK = "[테스트 문장] "
INCIDENT_WORDS = ("밀침", "밀었", "넘어", "때림", "때렸", "깨묾", "깨물", "다침", "다쳤", "쓸림", "쓸려", "부딪", "할큄", "물림", "상처")
AREA_KEYWORDS = {
    "신체운동·건강": ("뛰", "걷", "달리", "던지", "미끄럼", "그네", "점프", "운동", "손 씻", "낮잠"),
    "의사소통": ("말", "이야기", "책", "대답", "물어", "큰거", "옹알"),
    "사회관계": ("친구", "사과", "같이", "함께", "양보", "미안", "밀"),
    "예술경험": ("그림", "클레이", "점토", "노래", "춤", "리듬", "만들", "그리"),
    "자연탐구": ("낙엽", "나무", "꽃", "곤충", "벌레", "날씨", "모래", "흙", "동물", "식물", "돌"),
}


def default_areas(text: str) -> list[str]:
    found = [area for area in AREAS if any(word in text for word in AREA_KEYWORDS.get(area, ()))]
    return found[:3]


def _review(request: AIRequest) -> dict:
    roster = {row["child_id"]: row["name"] for row in request.payload["roster"]}
    blocks = request.payload["blocks"]
    incident_ids = [row["child_id"] for row in blocks if any(word in row["text"] for word in INCIDENT_WORDS)]
    flags, events = [], []
    if incident_ids:
        names = "·".join(roster[child_id] for child_id in incident_ids)
        flags.append({
            "kind": "incident",
            "child_ids": incident_ids,
            "question": f"{names} 이야기는 사건사고로 보여요. 보호자 안내용으로 부드럽게 쓸까요?",
            "options": ["부드럽게", "그대로"],
        })
    if len(incident_ids) >= 2:
        facts = []
        for row in blocks:
            if row["child_id"] in incident_ids:
                others = [name for child_id, name in roster.items() if child_id != row["child_id"]]
                facts.append({"child_id": row["child_id"], "fact": mask_names(row["text"], others)})
        events.append({"child_ids": incident_ids, "facts": facts})
    result = {"flags": flags, "joint_events": events, "incident_child_ids": incident_ids}
    if "metadata_sources" in request.payload:
        metadata = []
        for source in request.payload["metadata_sources"]:
            text = source["text"]
            place = re.search(r"(바깥놀이터|놀이터|유희실|교실|운동장|공원)(?:에서|으로|에)", text)
            time = re.search(r"(?:오전 |오후 )?\d{1,2}(?::\d{2}|시(?:\s*\d{1,2}분)?)", text)
            metadata.append({
                "block_id": source["block_id"],
                "place": place[1] if place and "place" in source["fields"] else "",
                "time_text": time[0] if time and "time_text" in source["fields"] else "",
            })
        result["metadata"] = metadata
    return result


def _common(request: AIRequest) -> dict:
    return {"text": MARK + "오늘은 " + request.payload["text"].strip()}


def _individual(request: AIRequest) -> dict:
    payload = request.payload
    text = f"{MARK}{payload['name']}: {payload['text'].strip()}"
    if payload["mode"] == "incident_soft":
        text += " (사건사고 구성)"
    if payload["joint_facts"]:
        text += " / " + " / ".join(payload["joint_facts"])
    return {"text": text}


def _revise(request: AIRequest) -> dict:
    payload = request.payload
    return {"text": f"{payload['current_text']} (수정 요청 반영: {payload['instruction']})"}


def _journal(request: AIRequest) -> dict:
    return {"content": f"{MARK}{request.payload['text'].strip()} 관찰함."}


def _journal_word_layout(request: AIRequest) -> dict:
    """Match labeled fields to inline slots or immediately adjacent blanks."""
    fields_by_label = {field: (field,) for field in JOURNAL_WORD_FIELDS}
    fields_by_label.update({
        "아동명": ("이름",), "유아명": ("이름",), "영아명": ("이름",), "성명": ("이름",),
        "이름/성별": ("이름", "성별"), "이름(성별)": ("이름", "성별"),
        "반명": ("반",), "관찰일자": ("관찰일",), "관찰날짜": ("관찰일",),
    })
    layout = request.payload["layout"]
    paragraph_groups = [layout]
    for block in layout:
        for row in block.get("table", []):
            paragraph_groups.append([paragraph for cell in row for paragraph in cell["paragraphs"]])

    placements = []
    used_fields = set()
    for paragraphs in paragraph_groups:
        for index, paragraph in enumerate(paragraphs):
            label = re.sub(r"\s+", "", paragraph.get("text", "")).rstrip(":：")
            fields = fields_by_label.get(label, ())
            if not fields or used_fields.intersection(fields):
                continue
            slot = paragraph.get("slot")
            if not slot and index + 1 < len(paragraphs):
                next_paragraph = paragraphs[index + 1]
                if not next_paragraph.get("text"):
                    slot = next_paragraph.get("slot")
            if slot:
                placements.append({"slot": slot, "fields": list(fields)})
                used_fields.update(fields)
    return {"placements": placements if "관찰내용" in used_fields else []}


def _areas(request: AIRequest) -> dict:
    return {"areas": default_areas(request.payload["text"])}


def _recording_observations(request: AIRequest) -> dict:
    observations = []
    roster = request.payload["roster"]
    for recording_id, transcript in request.payload["transcripts"].items():
        for quote in transcript.splitlines():
            if not quote.strip():
                continue
            matches = [child for child in roster if child["name"] in quote]
            if len(matches) == 1:
                scope, child_id = "individual", matches[0]["child_id"]
            else:
                scope = "common" if not matches and quote.startswith(("반 공통", "우리 반")) else "unresolved"
                child_id = ""
            observations.append({"recording_id": recording_id, "quote": quote, "scope": scope, "child_id": child_id,
                                 "heard_name": matches[0]["name"] if len(matches) == 1 else "", "corrections": []})
    return {"observations": observations}


DEFAULT_HANDLERS: dict[AITask, Callable[[AIRequest], dict]] = {
    AITask.RECORDING_OBSERVATIONS: _recording_observations,
    AITask.REVIEW: _review,
    AITask.COMMON: _common,
    AITask.INDIVIDUAL: _individual,
    AITask.REVISE: _revise,
    AITask.JOURNAL_COMMON: _journal,
    AITask.JOURNAL_INDIVIDUAL: _journal,
    AITask.JOURNAL_WORD_LAYOUT: _journal_word_layout,
    AITask.AREAS: _areas,
}


class FakeAIClient:
    model = "fake"

    def __init__(self, handlers: dict[AITask, Callable[[AIRequest], dict]] | None = None):
        self.handlers = dict(DEFAULT_HANDLERS)
        if handlers:
            self.handlers.update(handlers)
        self.calls: list[AIRequest] = []

    def complete(self, request: AIRequest) -> AIResult:
        self.calls.append(request)
        handler = self.handlers.get(request.task)
        if handler is None:
            raise AIUnavailable("가짜 AI에 이 작업의 처리기가 없습니다.")
        data = handler(request)
        usage = AIUsage(input_tokens=len(request.user_text) // 2, output_tokens=len(json.dumps(data, ensure_ascii=False)) // 2)
        return AIResult(data=data, usage=usage, model=self.model)

    def calls_for(self, task: AITask) -> list[AIRequest]:
        return [call for call in self.calls if call.task == task]
