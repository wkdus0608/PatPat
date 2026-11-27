"""Select curriculum-aligned observations from one child's saved week."""
import re
from datetime import date, timedelta

from app.ai import observations, prompts
from app.ai.anthropic_client import NotConfiguredAIClient
from app.ai.gateway import AIGateway
from app.ai.privacy import mask_names
from app.ai.text_privacy import mask_transport_peers
from app.ai.types import AIBadOutput
from app.core.errors import ApiError
from app.journal.store import JournalStore, weekly_evidence_hash
from app.jobs.runner import JobRunner
from app.profile.store import ProfileStore
from app.rules.loader import AREAS, RulesBundle

KIND = "weekly_journal"
MAX_ENTRIES = 20
MAX_QUESTIONS = 3


def _normalized(text: str) -> str:
    return " ".join(text.split())


class WeeklyJournal:
    def __init__(self, rules: RulesBundle, store: JournalStore, profile: ProfileStore, jobs: JobRunner, ai: AIGateway):
        self.rules = rules
        self.store = store
        self.profile = profile
        self.jobs = jobs
        self.ai = ai

    def draft(self, teacher_id: str, child_id: str, week_of: date) -> dict:
        self._active_child(teacher_id, child_id)
        start = week_of - timedelta(days=week_of.weekday())
        end = start + timedelta(days=min(6, (date.max - start).days))
        sources = self.store.weekly_sources(teacher_id, child_id, start.isoformat(), end.isoformat())
        week = {"week_start": start.isoformat(), "week_end": end.isoformat(), "source_dates": len({source["date"] for source in sources})}
        if sources:
            self._ensure_ai()

        def select() -> dict:
            entries, questions = self._select(teacher_id, child_id, sources, follow_up=False) if sources else ([], [])
            return self._mark_saved(teacher_id, child_id, {**week, "entries": entries, "questions": questions})

        return self.jobs.start(teacher_id, KIND, child_id, select)

    def answer(self, teacher_id: str, child_id: str, job_id: str, answers: dict[int, str]) -> dict:
        self._active_child(teacher_id, child_id)
        prior = self._result(teacher_id, child_id, job_id)
        questions = prior["questions"]
        if not answers or any(not 0 <= index < len(questions) for index in answers):
            raise ApiError(status_code=422, code="INVALID_JOURNAL_ANSWER", message="초안에 표시된 질문에 답해 주세요.")
        sources = []
        for index, answer in answers.items():
            answer, _ = observations.strip_writing_requests(answer)
            if answer:
                question = questions[index]
                sources.append({
                    **question, "text": question["evidence"],
                    "teacher_answer": answer,
                })
        if sources:
            self._ensure_ai()

        def select() -> dict:
            entries, _ = self._select(teacher_id, child_id, sources, follow_up=True) if sources else ([], [])
            unique = {(item["date"], item["evidence"]): item for item in prior["entries"]}
            for entry in entries:
                unique.setdefault((entry["date"], entry["evidence"]), entry)
            updated = {**prior, "entries": sorted(unique.values(), key=lambda item: item["date"]), "questions": []}
            return self._mark_saved(teacher_id, child_id, updated)

        return self.jobs.start(teacher_id, KIND, child_id, select)

    def confirm(self, teacher_id: str, child_id: str, job_id: str, edits: dict[int, str]) -> list[str]:
        result = self._result(teacher_id, child_id, job_id)
        entries = result["entries"]
        if not edits or any(not 0 <= index < len(entries) or not text.strip() for index, text in edits.items()):
            raise ApiError(status_code=422, code="INVALID_JOURNAL_SELECTION", message="저장할 관찰과 본문을 확인해 주세요.")
        by_date: dict[str, list[dict]] = {}
        for index in sorted(edits):
            entry = entries[index]
            by_date.setdefault(entry["date"], []).append({**entry, "content": edits[index], "index": index})
        return self.store.save_weekly(teacher_id, child_id, job_id, dict(sorted(by_date.items())))

    def _mark_saved(self, teacher_id: str, child_id: str, result: dict) -> dict:
        saved = self.store.weekly_saved_evidence(teacher_id, child_id, result["week_start"], result["week_end"])

        def is_saved(item: dict) -> bool:
            return (item["date"], weekly_evidence_hash(item["evidence"])) in saved

        return {
            **result,
            "entries": [{**entry, "saved": is_saved(entry)} for entry in result["entries"]],
            "questions": [question for question in result["questions"] if not is_saved(question)],
        }

    def _active_child(self, teacher_id: str, child_id: str) -> None:
        child = self.profile.get_child(teacher_id, child_id)
        if child is None or not child["is_active"]:
            raise ApiError(status_code=404, code="NOT_FOUND", message="명단에서 아동을 찾을 수 없어요.")

    def _ensure_ai(self) -> None:
        if isinstance(self.ai.client, NotConfiguredAIClient):
            raise ApiError(status_code=503, code="AI_NOT_CONFIGURED", message="AI 연결을 확인해 주세요.")

    def _result(self, teacher_id: str, child_id: str, job_id: str) -> dict:
        job = self.jobs.get(teacher_id, job_id)
        if job is None or job["kind"] != KIND or job["ref_id"] != child_id:
            raise ApiError(status_code=404, code="NOT_FOUND", message="주간 관찰일지 초안을 찾을 수 없어요.")
        if job["status"] != "completed":
            raise ApiError(status_code=409, code="DRAFT_NOT_READY", message="완료된 초안을 다시 열어 주세요.")
        return job["result"]

    def _select(self, teacher_id: str, child_id: str, sources: list[dict], *, follow_up: bool) -> tuple[list[dict], list[dict]]:
        request = prompts.build_weekly_journal(self.rules, child_id=child_id, sources=sources, follow_up=follow_up)
        result = self.ai.call(request, teacher_id=teacher_id, protect_text=True).data
        privacy = self.ai.text_privacy(teacher_id, None)
        source_text = [privacy.encode(_normalized(source["text"])) for source in sources]
        peer_names = self.profile.other_child_names(teacher_id, child_id)
        subject = f"⟦C:{child_id}⟧"
        subject_alias = re.compile(r"(?<![A-Za-z0-9])" + re.escape(privacy.encode(subject)) + r"(?![A-Za-z0-9])")
        seen = set()

        def display(text: str) -> str:
            return mask_names(mask_transport_peers(text, subject, "또래"), peer_names, replacement="또래")

        def parse(key: str, text_key: str, limit: int) -> list[dict]:
            items = result.get(key)
            if not isinstance(items, list):
                raise AIBadOutput("주간 관찰 응답을 읽을 수 없어요.")
            accepted = []
            for row in items:
                if not isinstance(row, dict):
                    continue
                index, quote, text = row.get("source_id"), row.get("quote"), row.get(text_key)
                if type(index) is not int or not 0 <= index < len(sources):
                    continue
                if not isinstance(quote, str) or not isinstance(text, str) or not text.strip():
                    continue
                quote = privacy.encode(_normalized(quote))
                if not quote or quote not in source_text[index] or (follow_up and quote != source_text[index]):
                    continue
                area = row.get("area")
                if key == "entries" and area not in AREAS:
                    continue
                source = sources[index]
                if source["scope"] == "common" and not follow_up and not subject_alias.search(quote):
                    continue
                evidence = display(privacy.decode(quote))
                identity = (source["date"], evidence)
                if identity in seen:
                    continue
                seen.add(identity)
                item = {field: source[field] for field in ("date", "scope", "age_band", "place", "time_text")}
                if key == "entries":
                    item["area"] = area
                    if follow_up:
                        item["teacher_answer"] = display(source["teacher_answer"])
                accepted.append({**item, "evidence": evidence, text_key: display(text.strip())})
                if len(accepted) == limit:
                    break
            return sorted(accepted, key=lambda item: item["date"])

        questions = [] if follow_up else parse("questions", "question", MAX_QUESTIONS)
        entries = parse("entries", "content", MAX_ENTRIES)
        return entries, questions
