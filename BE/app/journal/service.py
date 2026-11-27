"""Writes journal drafts from reviewed inputs and refreshes journals from confirmed notices."""
import hashlib
import re

from app.ai import observations, prompts, schemas
from app.ai.anthropic_client import NotConfiguredAIClient
from app.ai.gateway import AIGateway
from app.ai.lint import drop_unconfirmed_time_prefix
from app.ai.privacy import mask_names
from app.ai.prompts import BlockCtx, ChildCtx, ClassCtx
from app.ai.text_privacy import is_protected
from app.ai.types import AIError
from app.core.errors import ApiError
from app.journal.schemas import JournalObservation
from app.journal.store import JournalStore
from app.journal.weekly import WeeklyJournal
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


def plan_rows(
    notice_text: str, child_block: dict | None, common_block: dict | None, *, rules_hash: str = "",
) -> list[dict]:
    """Which journal rows a notice text makes, as {block_id, block_kind, text, areas, place, time_text, source_hash}."""
    common_filled = bool(common_block and common_block["filled"])
    child_filled = bool(child_block and child_block["filled"])
    paragraphs = [part.strip() for part in re.split(r"\n\s*\n", notice_text) if part.strip()]
    text = "\n\n".join(paragraphs)

    def spec(block: dict, kind: str, body: str, areas: list[str], place, time_text) -> dict:
        return {"block_id": block["block_id"], "block_kind": kind, "text": body, "areas": areas, "place": place,
                "time_text": time_text, "source_hash": paragraph_hash(f"{rules_hash}\n{body}")}

    if common_filled and child_filled:
        place, time_text = child_block["place"], child_block["time_text"]
        if len(paragraphs) >= 2:
            return [
                spec(common_block, "common", paragraphs[0], common_block["areas"], common_block["place"], common_block["time_text"]),
                spec(child_block, "individual", "\n\n".join(paragraphs[1:]), child_block["areas"], place, time_text),
            ]
        # the teacher merged the shared paragraph into the child's text: one row, with both blocks' areas
        return [spec(child_block, "individual", text, _union_areas(common_block["areas"], child_block["areas"]),
                     place or common_block["place"], time_text or common_block["time_text"])]
    if common_filled:
        return [spec(common_block, "common", text, common_block["areas"], common_block["place"], common_block["time_text"])]
    if child_filled:
        return [spec(child_block, "individual", text, child_block["areas"], child_block["place"], child_block["time_text"])]
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
        self.weekly = WeeklyJournal(rules, store, profile, jobs, ai)
        jobs.register_recovery("journal", lambda job: self.store.fail_all_pending_for_notice(job["ref_id"], "SERVER_RESTART"))

    def draft_standalone(self, teacher_id: str, child_id: str, observation: JournalObservation, *, protect_text: bool = False) -> dict:
        child = self.profile.get_child(teacher_id, child_id)
        if child is None or not child["is_active"]:
            raise ApiError(status_code=404, code="NOT_FOUND", message="명단에서 아동을 찾을 수 없어요.")
        source, has_request = observations.strip_writing_requests(observation.content)
        if has_request:
            raise ApiError(status_code=422, code="OBSERVATION_REVIEW_REQUIRED", message="작성 요청을 빼고 직접 관찰한 내용을 입력해 주세요.")
        if not source:
            raise ApiError(status_code=422, code="EMPTY_TEXT", message="관찰내용을 입력해 주세요.")
        source, unresolved_side = observations.confirmed_observation(source, [], child_id)
        if unresolved_side:
            raise ApiError(status_code=422, code="OBSERVATION_REVIEW_REQUIRED", message="부상 부위를 확인한 뒤 관찰내용을 고쳐 주세요.")
        if isinstance(self.ai.client, NotConfiguredAIClient):
            raise ApiError(status_code=503, code="AI_NOT_CONFIGURED", message="AI 연결을 확인하거나 관찰일지를 직접 작성해 주세요.")
        details = self.profile.get_details(child_id)
        rooms = self.profile.list_classrooms(teacher_id)
        default = rooms[0] if rooms else None
        room = next((room for room in rooms if room["classroom_id"] == details["classroom_id"]), default)
        age_label = room["age_label"] if room else ""
        cls = ClassCtx(age_label=age_label, band=age_band_from_label(age_label))
        other_names = self.profile.other_child_names(teacher_id, child_id)
        block = BlockCtx(
            block_id=child_id, child_id=child_id, text=mask_names(source, other_names, replacement="또래"),
            areas=tuple(area for area in AREAS if area in observation.areas),
            place=(observation.place or "").strip() or None,
            time_text=(observation.time_text or "").strip() or None,
        )
        request = prompts.build_journal_individual(
            self.rules, cls=cls, child=ChildCtx(child_id=child_id, name=child["name"]), text=block.text,
            block=block, common=None, incident=None, from_inputs=True,
        )

        def write() -> dict:
            result = self.ai.call(request, teacher_id=teacher_id, protect_text=protect_text, visible_child=child_id)
            subject = f"⟦C:{child_id}⟧" if protect_text else child["name"]
            content = schemas.render_journal(result.data, block.text, block.areas, subject=subject)
            content = drop_unconfirmed_time_prefix(content, source=block.text, confirmed_time=block.time_text)
            return {"content": mask_names(content, other_names, replacement="또래")}

        return self.jobs.start(teacher_id, "standalone_journal_draft", child_id, write)

    # --- planning ------------------------------------------------------------------------------------------------------
    def _specs(self, notice: dict, notice_text: str) -> list[dict]:
        source = self.notices.recording_source(notice["notice_id"])
        blocks = source["blocks"] if source else self.sessions.list_blocks(notice["session_id"], only_active=False)
        child_block = next((block for block in blocks if block["child_id"] == notice["child_id"]), None)
        common_block = next((block for block in blocks if block["is_common"]), None)
        if notice.get("incident"):
            display_lines = {schemas.NOTICE_INCIDENT_HEADING, *schemas.INJURY_CONFIRMATION_LABELS.values()}
            notice_text = "\n".join(line for line in notice_text.split("\n") if line.strip() not in display_lines)
        return plan_rows(notice_text, child_block, common_block, rules_hash=self.rules.rules_hash)

    def _input_specs(self, notice: dict, flags: list[dict]) -> list[dict]:
        roster_blocks = self.sessions.list_blocks(notice["session_id"], only_active=False)
        source_context = self.notices.recording_source(notice["notice_id"])
        blocks = source_context["blocks"] if source_context else roster_blocks
        child_id = notice["child_id"]
        common = next((block for block in blocks if block["is_common"]), None)
        child = next((block for block in blocks if block["child_id"] == child_id), None)
        all_names = [block["child_name"] for block in roster_blocks if block["child_id"] is not None]
        other_names = [block["child_name"] for block in roster_blocks if block["child_id"] not in (None, child_id)]

        def source(block: dict | None, scoped_id: str | None, names: list[str]) -> str:
            if not block or not block["filled"]:
                return ""
            # A generated summary from a peer's perspective can invert the actor.
            text, _ = observations.confirmed_observation(block["text"], flags, scoped_id)
            parts = [text]
            for flag in flags:
                applies = scoped_id in flag["child_ids"] if scoped_id is not None else not flag["child_ids"]
                if (not applies or flag["status"] != "answered"
                        or flag["kind"] in ("area", "place", "time_text", *observations.SOURCE_CONFIRMATION_KINDS)):
                    continue
                answer = flag["answer"]
                if answer and (flag["kind"] != "incident" or answer not in ("부드럽게", "그대로")):
                    parts.append(f'교사 확인 ({flag["question"]}): {answer}')
            return mask_names(re.sub(r"\n\s*\n", "\n", "\n".join(parts).strip()), names)

        text = "\n\n".join(part for part in (source(common, None, all_names), source(child, child_id, other_names)) if part)
        return plan_rows(text, child, common, rules_hash=self.rules.rules_hash)

    def prepare(self, *, teacher_id: str, notice: dict, flags: list[dict], protect_text: bool = False) -> dict | None:
        specs = self._input_specs(notice, flags)
        entry_ids = self.store.sync_rows(teacher_id=teacher_id, notice=notice, specs=specs, from_inputs=True)
        if not entry_ids:
            return None
        return self._start(teacher_id, notice, entry_ids, {spec["block_id"]: spec["text"] for spec in specs},
                           notice["version"], protect_text=protect_text)

    # --- on confirm ----------------------------------------------------------------------------------------------------------
    def on_confirm(self, teacher_id: str, notice: dict, *, protect_text: bool = False) -> dict | None:
        if self.store.has_input_rows(notice["notice_id"]):
            return None
        source = self.notices.recording_source(notice["notice_id"])
        specs = self._input_specs(notice, source["flags"]) if source else self._specs(notice, notice["edited_text"])
        entry_ids = self.store.sync_rows(teacher_id=teacher_id, notice=notice, specs=specs)
        if not entry_ids:
            return None
        return self._start(teacher_id, notice, entry_ids, {spec["block_id"]: spec["text"] for spec in specs},
                           notice["version"], protect_text=protect_text)

    def refresh_from_notice(self, teacher_id: str, notice: dict, *, protect_text: bool = False) -> dict | None:
        specs = self._specs(notice, notice["edited_text"])
        if not specs:
            return None
        expected_edits = self.store.edit_versions(notice)

        def refresh() -> dict:
            cls, child, other_names = self._writing_context(teacher_id, notice)
            rows, reused = [], 0
            for spec in specs:
                content, shared = self._write_row(
                    teacher_id, notice, spec, spec["text"], cls, child, other_names,
                    protect_text=self._protect_notice(teacher_id, notice, protect_text),
                )
                rows.append({**spec, "content": content})
                reused += int(shared)
            self.store.apply_notice_refresh(notice, rows, expected_edits)
            return {"generated": len(rows) - reused, "reused": reused, "failed": []}

        return self.jobs.start(teacher_id, "journal_refresh", notice["notice_id"], refresh)

    def _protect_notice(self, teacher_id: str, notice: dict, requested: bool = False) -> bool:
        return not self.notices.recording_source(notice["notice_id"]) and (
            requested or is_protected(self.sessions.require(teacher_id, notice["session_id"]))
        )

    def _start(self, teacher_id: str, notice: dict, entry_ids: list[str], texts: dict[str, str], source_version: int,
               *, protect_text: bool = False) -> dict:
        private = self._protect_notice(teacher_id, notice, protect_text)
        return self.jobs.start(
            teacher_id, "journal", notice["notice_id"],
            lambda: self._generate(teacher_id, notice, entry_ids, texts, source_version, protect_text=private),
            on_error=lambda code: self.store.fail_all_pending_for_notice(notice["notice_id"], code, source_version),
        )

    # --- regenerate one row --------------------------------------------------------------------------------------------------------
    def regenerate_entry(self, teacher_id: str, entry_id: str) -> dict:
        entry = self.store.require(teacher_id, entry_id)
        if entry["notice_id"] is None:
            raise ApiError(status_code=409, code="NO_LINKED_NOTICE", message="독립 관찰일지는 본문을 직접 수정해 주세요.")
        if entry["notice_withdrawn"]:
            raise ApiError(status_code=409, code="NOT_CONFIRMED", message="알림장을 다시 확정한 뒤 관찰일지를 만들 수 있어요.")
        if entry["status"] == "pending":
            raise ApiError(status_code=409, code="ENTRY_BUSY", message="이 행을 이미 만드는 중이에요.")
        if isinstance(self.ai.client, NotConfiguredAIClient):
            raise ApiError(status_code=503, code="AI_NOT_CONFIGURED",
                           message="AI 연결 키가 아직 등록되지 않았습니다. 직접 고치거나 키가 등록된 뒤에 요청해 주세요.")
        notice = self.notices.require(teacher_id, entry["notice_id"])
        if entry["from_inputs"]:
            audio = self.notices.recording_source(notice["notice_id"])
            flags = audio["flags"] if audio else self.sessions.list_flags(notice["session_id"])
            specs = self._input_specs(notice, flags)
            source_version = notice["version"]
        else:
            confirmed = self.notices.last_confirmed(notice["notice_id"])
            if confirmed is None:
                raise ApiError(status_code=409, code="NOT_CONFIRMED", message="확정한 알림장이 있어야 관찰일지 행을 만들 수 있어요.")
            specs = self._specs(notice, confirmed["text"])
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
    def _writing_context(self, teacher_id: str, notice: dict) -> tuple[ClassCtx, ChildCtx, list[str]]:
        session = self.sessions.require(teacher_id, notice["session_id"])
        classroom = self.profile.get_classroom(teacher_id, session["classroom_id"])
        cls = ClassCtx(age_label=classroom["age_label"], band=age_band_from_label(classroom["age_label"]))
        traits, _ = self.profile.get_characteristics(notice["child_id"])
        child = ChildCtx(child_id=notice["child_id"], name=notice["child_name"], characteristics=traits)
        other_names = self.sessions.other_child_names(notice["session_id"], notice["child_id"])
        return cls, child, other_names

    def _write_row(
        self, teacher_id: str, notice: dict, row: dict, body: str, cls: ClassCtx, child: ChildCtx, other_names: list[str],
        *, protect_text: bool,
    ) -> tuple[str, bool]:
        common = row["block_kind"] == "common"
        block = BlockCtx(
            block_id=row["block_id"], child_id=None if common else notice["child_id"],
            text=body, areas=tuple(row["areas"]), place=row["place"], time_text=row["time_text"],
        )
        from_inputs = bool(row.get("from_inputs"))
        if common:
            shared = self.store.find_shared_content(
                notice["session_id"], row["block_id"], row["source_hash"], row["areas"], row["place"], row["time_text"],
            )
            if shared is not None:
                return shared, True
            request = prompts.build_journal_common(self.rules, cls=cls, text=body, common=block, from_inputs=from_inputs)
        else:
            request = prompts.build_journal_individual(
                self.rules, cls=cls, child=child, text=body, block=block, common=None,
                incident=notice["incident"], from_inputs=from_inputs,
            )
        result = self.ai.call(request, teacher_id=teacher_id, session_id=notice["session_id"],
                              protect_text=protect_text, visible_child="" if common else child.child_id)
        subject = "" if common else f"⟦C:{child.child_id}⟧" if protect_text else child.name
        written = schemas.render_journal(result.data, body, block.areas, subject=subject)
        if not common:
            written = drop_unconfirmed_time_prefix(written, source=body, confirmed_time=block.time_text)
        return mask_names(written, other_names), False

    def _generate(self, teacher_id: str, notice: dict, entry_ids: list[str], texts: dict[str, str], source_version: int,
                  *, protect_text: bool) -> dict:
        cls, child, other_names = self._writing_context(teacher_id, notice)
        generated, reused, failed, first_error = 0, 0, [], None
        for entry_id in entry_ids:
            entry = self.store.get(teacher_id, entry_id)
            if entry is None or entry["status"] != "pending" or entry["source_notice_version"] != source_version:
                continue  # changed by the teacher while the job was waiting
            try:
                content, shared = self._write_row(
                    teacher_id, notice, entry, texts[entry["block_id"]], cls, child, other_names, protect_text=protect_text,
                )
                reused += int(shared)
                generated += int(not shared)
                self.store.mark_ready(entry_id, content, entry["version"])
            except AIError as error:
                self.store.mark_failed(entry_id, error.code, entry["version"])
                failed.append({"entry_id": entry_id, "error_code": error.code})
                first_error = first_error or error
        if failed and generated + reused == 0:
            raise first_error
        return {"generated": generated, "reused": reused, "failed": failed}
