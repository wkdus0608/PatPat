"""Writes journal drafts from reviewed inputs, or legacy journal rows from confirmed notices."""
import hashlib
import json
import re

from app.ai import prompts, schemas
from app.ai.anthropic_client import NotConfiguredAIClient
from app.ai.gateway import AIGateway
from app.ai.privacy import mask_names
from app.ai.prompts import BlockCtx, ChildCtx, ClassCtx
from app.ai.types import AIError
from app.core.errors import ApiError
from app.journal.store import JournalStore
from app.jobs.runner import JobRunner
from app.notices.store import NoticeStore
from app.profile.store import ProfileStore
from app.rules.loader import AREAS, RulesBundle, age_band_from_label
from app.sessions.store import SessionStore


def paragraph_hash(text: str) -> str:
    return hashlib.sha256(" ".join(text.split()).encode("utf-8")).hexdigest()[:16]


def _union_areas(*groups: list[str]) -> list[str]:
    wanted = {area for group in groups for area in group}
    return [area for area in AREAS if area in wanted]


def plan_rows(notice_text: str, child_block: dict | None, common_block: dict | None) -> list[dict]:
    """Which journal rows a notice text makes, as {block_id, block_kind, text, areas, place, time_text, source_hash}."""
    common_filled = bool(common_block and common_block["filled"])
    child_filled = bool(child_block and child_block["filled"])
    paragraphs = [part.strip() for part in re.split(r"\n\s*\n", notice_text) if part.strip()]
    text = "\n\n".join(paragraphs)

    def spec(block: dict, kind: str, body: str, areas: list[str], place, time_text) -> dict:
        return {"block_id": block["block_id"], "block_kind": kind, "text": body, "areas": areas, "place": place,
                "time_text": time_text, "source_hash": paragraph_hash(body)}

    def own_place_time():
        return ((child_block["place"] or (common_block or {}).get("place")),
                (child_block["time_text"] or (common_block or {}).get("time_text")))

    if common_filled and child_filled:
        place, time_text = own_place_time()
        if len(paragraphs) >= 2:
            return [
                spec(common_block, "common", paragraphs[0], common_block["areas"], common_block["place"], common_block["time_text"]),
                spec(child_block, "individual", "\n\n".join(paragraphs[1:]), child_block["areas"], place, time_text),
            ]
        # the teacher merged the shared paragraph into the child's text: one row, with both blocks' areas
        return [spec(child_block, "individual", text, _union_areas(common_block["areas"], child_block["areas"]), place, time_text)]
    if common_filled:
        return [spec(common_block, "common", text, common_block["areas"], common_block["place"], common_block["time_text"])]
    if child_filled:
        place, time_text = own_place_time()
        return [spec(child_block, "individual", text, child_block["areas"], place, time_text)]
    return []


class JournalService:
    def __init__(
        self,
        *,
        rules: RulesBundle,
        store: JournalStore,
        notices: NoticeStore,
        sessions: SessionStore,
        profile: ProfileStore,
        jobs: JobRunner,
        ai: AIGateway,
    ):
        self.rules = rules
        self.store = store
        self.notices = notices
        self.sessions = sessions
        self.profile = profile
        self.jobs = jobs
        self.ai = ai
        jobs.register_recovery("journal", lambda job: self.store.fail_all_pending_for_notice(job["ref_id"], "SERVER_RESTART"))

    # --- planning ------------------------------------------------------------------------------------------------------
    def _specs(self, session_id: str, child_id: str, notice_text: str) -> list[dict]:
        blocks = self.sessions.list_blocks(session_id, only_active=False)
        child_block = next((block for block in blocks if block["child_id"] == child_id), None)
        common_block = next((block for block in blocks if block["is_common"]), None)
        return plan_rows(notice_text, child_block, common_block)

    def _input_specs(self, notice: dict, flags: list[dict], review: dict) -> list[dict]:
        blocks = self.sessions.list_blocks(notice["session_id"], only_active=False)
        child_id = notice["child_id"]
        common = next((block for block in blocks if block["is_common"]), None)
        child = next((block for block in blocks if block["child_id"] == child_id), None)
        all_names = [block["child_name"] for block in blocks if block["child_id"] is not None]
        other_names = [block["child_name"] for block in blocks if block["child_id"] not in (None, child_id)]

        def source(block: dict | None, scoped_id: str | None, names: list[str]) -> str:
            if not block or not block["filled"]:
                return ""
            parts = [block["text"]]
            for flag in flags:
                applies = scoped_id in flag["child_ids"] if scoped_id is not None else not flag["child_ids"]
                if not applies or flag["status"] != "answered" or flag["kind"] in ("area", "place", "time_text"):
                    continue
                answer = flag["answer"]
                if answer and (flag["kind"] != "incident" or answer not in ("부드럽게", "그대로")):
                    parts.append(f'교사 확인 ({flag["question"]}): {answer}')
            if scoped_id is not None:
                for event in review.get("joint_events", []):
                    facts = event["facts"]
                    if scoped_id in facts:
                        parts.extend(fact for other, fact in facts.items() if other != scoped_id and fact)
            return mask_names(re.sub(r"\n\s*\n", "\n", "\n".join(parts).strip()), names)

        text = "\n\n".join(part for part in (source(common, None, all_names), source(child, child_id, other_names)) if part)
        return plan_rows(text, child, common)

    def prepare(self, *, teacher_id: str, notice: dict, flags: list[dict], review: dict) -> dict | None:
        specs = self._input_specs(notice, flags, review)
        entry_ids = self.store.sync_rows(teacher_id=teacher_id, notice=notice, specs=specs, from_inputs=True)
        if not entry_ids:
            return None
        return self._start(teacher_id, notice, entry_ids, {spec["block_id"]: spec["text"] for spec in specs}, notice["version"])

    # --- on confirm ----------------------------------------------------------------------------------------------------------
    def on_confirm(self, teacher_id: str, notice: dict) -> dict | None:
        if self.store.has_input_rows(notice["notice_id"]):
            return None
        specs = self._specs(notice["session_id"], notice["child_id"], notice["edited_text"])
        entry_ids = self.store.sync_rows(teacher_id=teacher_id, notice=notice, specs=specs)
        if not entry_ids:
            return None
        return self._start(teacher_id, notice, entry_ids, {spec["block_id"]: spec["text"] for spec in specs}, notice["version"])

    def _start(self, teacher_id: str, notice: dict, entry_ids: list[str], texts: dict[str, str], source_version: int) -> dict:
        return self.jobs.start(
            teacher_id, "journal", notice["notice_id"],
            lambda: self._generate(teacher_id, notice, entry_ids, texts, source_version),
            on_error=lambda code: self.store.fail_all_pending_for_notice(notice["notice_id"], code, source_version),
        )

    # --- regenerate one row --------------------------------------------------------------------------------------------------------
    def regenerate_entry(self, teacher_id: str, entry_id: str) -> dict:
        entry = self.store.require(teacher_id, entry_id)
        if entry["notice_withdrawn"]:
            raise ApiError(status_code=409, code="NOT_CONFIRMED", message="알림장을 다시 확정한 뒤 관찰일지를 만들 수 있어요.")
        if entry["status"] == "pending":
            raise ApiError(status_code=409, code="ENTRY_BUSY", message="이 행을 이미 만드는 중이에요.")
        if isinstance(self.ai.client, NotConfiguredAIClient):
            raise ApiError(status_code=503, code="AI_NOT_CONFIGURED",
                           message="AI 연결 키가 아직 등록되지 않았습니다. 직접 고치거나 키가 등록된 뒤에 요청해 주세요.")
        notice = self.notices.require(teacher_id, entry["notice_id"])
        if entry["from_inputs"]:
            session = self.sessions.require(teacher_id, notice["session_id"])
            review = json.loads(session["review_json"] or "{}")
            specs = self._input_specs(notice, self.sessions.list_flags(notice["session_id"]), review)
            source_version = notice["version"]
        else:
            confirmed = self.notices.last_confirmed(notice["notice_id"])
            if confirmed is None:
                raise ApiError(status_code=409, code="NOT_CONFIRMED", message="확정한 알림장이 있어야 관찰일지 행을 만들 수 있어요.")
            specs = self._specs(notice["session_id"], notice["child_id"], confirmed["text"])
            source_version = confirmed["version"]
        spec = next((item for item in specs if item["block_id"] == entry["block_id"]), None)
        if spec is None:
            raise ApiError(status_code=409, code="SOURCE_GONE", message="이 행의 바탕이 된 문단이 알림장에서 사라졌어요.")
        self.store.mark_pending(
            entry_id, notice_version=source_version, source_hash=spec["source_hash"], areas=spec["areas"],
            place=spec["place"], time_text=spec["time_text"],
        )
        return self._start(teacher_id, notice, [entry_id], {spec["block_id"]: spec["text"]}, source_version)

    # --- the job ---------------------------------------------------------------------------------------------------------------------------
    def _generate(self, teacher_id: str, notice: dict, entry_ids: list[str], texts: dict[str, str], source_version: int) -> dict:
        session = self.sessions.require(teacher_id, notice["session_id"])
        classroom = self.profile.get_classroom(teacher_id, session["classroom_id"])
        cls = ClassCtx(age_label=classroom["age_label"], band=age_band_from_label(classroom["age_label"]))
        traits, _ = self.profile.get_characteristics(notice["child_id"])
        child = ChildCtx(child_id=notice["child_id"], name=notice["child_name"], characteristics=traits)
        other_names = self.sessions.other_child_names(notice["session_id"], notice["child_id"])
        generated, reused, failed, first_error = 0, 0, [], None
        for entry_id in entry_ids:
            entry = self.store.get(teacher_id, entry_id)
            if entry is None or entry["status"] != "pending" or entry["source_notice_version"] != source_version:
                continue  # changed by the teacher while the job was waiting
            body = texts[entry["block_id"]]
            block = BlockCtx(
                block_id=entry["block_id"], child_id=None if entry["block_kind"] == "common" else entry["child_id"],
                text=body, areas=tuple(entry["areas"]), place=entry["place"], time_text=entry["time_text"],
            )
            try:
                shared = None
                if entry["block_kind"] == "common":
                    shared = self.store.find_shared_content(
                        entry["session_id"], entry["block_id"], entry["source_hash"], entry["areas"], entry["place"], entry["time_text"]
                    )
                if shared is not None:
                    content, reused = shared, reused + 1
                else:
                    if entry["block_kind"] == "common":
                        request = prompts.build_journal_common(
                            self.rules, cls=cls, text=body, common=block, from_inputs=bool(entry["from_inputs"]),
                        )
                    else:
                        request = prompts.build_journal_individual(
                            self.rules, cls=cls, child=child, text=body, block=block, common=None,
                            incident=notice["incident"], from_inputs=bool(entry["from_inputs"]),
                        )
                    result = self.ai.call(request, teacher_id=teacher_id, session_id=notice["session_id"])
                    content = mask_names(schemas.require_text(result.data, "content"), other_names)
                    generated += 1
                self.store.mark_ready(entry_id, content, entry["version"])
            except AIError as error:
                self.store.mark_failed(entry_id, error.code, entry["version"])
                failed.append({"entry_id": entry_id, "error_code": error.code})
                first_error = first_error or error
        if failed and generated + reused == 0:
            raise first_error
        return {"generated": generated, "reused": reused, "failed": failed}
