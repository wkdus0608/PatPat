"""The notice pipeline.

1. review   – one call reads every child's input and picks the few things worth asking the teacher
2. asking   – the teacher answers (or skips) the questions
3. common   – one call writes the shared paragraph with the teacher's class-wide answers
4. drafting – one call per child with their own input (a child with no input gets the common paragraph only)

The same rules block is the system prompt of every call, so the later calls read it from the cache the
first call wrote. Calls for different children run in parallel; all database writes stay in the job thread.
"""
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace

from app.ai import prompts, schemas
from app.ai.anthropic_client import NotConfiguredAIClient
from app.ai.gateway import AIGateway
from app.ai.lint import lint_notice
from app.ai.privacy import mask_names
from app.ai.prompts import BlockCtx, ChildCtx, ClassCtx
from app.ai.types import AIError
from app.core.errors import ApiError
from app.jobs.runner import JobRunner
from app.journal.service import JournalService
from app.notices.store import NoticeStore
from app.profile.store import ProfileStore
from app.rules.loader import RulesBundle, age_band_from_label
from app.sessions.store import SessionStore

logger = logging.getLogger(__name__)

EMPTY_REVIEW = {"flags": [], "joint_events": [], "incident_child_ids": []}
METADATA_LABELS = {"place": "장소", "time_text": "시간"}


@dataclass
class DraftContext:
    teacher_id: str
    session: dict
    cls: ClassCtx
    roster: list[ChildCtx]  # every active child of the class, in roster order
    absent: set[str]
    common: BlockCtx | None  # None when the common block is empty
    blocks: dict[str, BlockCtx]  # child_id -> that child's block
    writing_examples: str | None
    areas_missing: list[dict] = field(default_factory=list)

    @property
    def all_names(self) -> list[str]:
        return [child.name for child in self.roster]

    @property
    def present(self) -> list[ChildCtx]:
        return [child for child in self.roster if child.child_id not in self.absent]

    def other_names(self, child_id: str) -> list[str]:
        return [child.name for child in self.roster if child.child_id != child_id]


def common_snapshot(common: BlockCtx | None) -> dict | None:
    if common is None:
        return None
    return {"text": common.text, "areas": list(common.areas), "place": common.place, "time_text": common.time_text}


def mode_and_answers(flags: list[dict], child_id: str) -> tuple[str, list[dict]]:
    """Turn the teacher's answers about this child into a drafting mode and the answers worth passing on."""
    mode, answers = "normal", []
    for flag in flags:
        if flag["kind"] in ("area", *METADATA_LABELS) or child_id not in flag["child_ids"] or flag["status"] != "answered":
            continue
        answer = (flag["answer"] or "").strip()
        if not answer:
            continue
        if flag["kind"] == "incident":
            if answer.startswith("부드럽"):
                mode = "incident_soft"
                continue
            if answer == "그대로":
                continue
        answers.append({"question": flag["question"], "answer": answer})
    return mode, answers


def joint_facts_for(review: dict, child_id: str) -> list[str]:
    """What the other children in the same event wrote, with this child's own name already out of it."""
    facts: list[str] = []
    for event in review.get("joint_events", []):
        if child_id in event["facts"]:
            facts += [fact for other, fact in event["facts"].items() if other != child_id and fact]
    return facts


def incident_ids_of(review: dict, flags: list[dict]) -> set[str]:
    ids = set(review.get("incident_child_ids", []))
    for flag in flags:
        if flag["kind"] == "incident":
            ids.update(flag["child_ids"])
    return ids


class PipelineService:
    def __init__(
        self,
        *,
        rules: RulesBundle,
        sessions: SessionStore,
        profile: ProfileStore,
        notices: NoticeStore,
        ai: AIGateway,
        jobs: JobRunner,
        journal: JournalService | None = None,
        parallelism: int = 4,
    ):
        self.rules = rules
        self.sessions = sessions
        self.profile = profile
        self.notices = notices
        self.ai = ai
        self.jobs = jobs
        self.journal = journal
        self.parallelism = max(1, parallelism)
        jobs.register_recovery("generate", self._recover_session_job)
        jobs.register_recovery("draft", self._recover_session_job)

    # --- context -------------------------------------------------------------------------------------------------------
    def _load(self, teacher_id: str, session_id: str) -> DraftContext:
        session = self.sessions.require(teacher_id, session_id)
        classroom = self.profile.get_classroom(teacher_id, session["classroom_id"])
        cls = ClassCtx(age_label=classroom["age_label"], band=age_band_from_label(classroom["age_label"]))
        blocks = self.sessions.list_blocks(session_id)
        common_block = next((block for block in blocks if block["is_common"]), None)
        roster, absent, child_blocks, missing = [], set(), {}, []
        for block in blocks:
            if block["is_common"]:
                continue
            traits, _ = self.profile.get_characteristics(block["child_id"])
            roster.append(ChildCtx(child_id=block["child_id"], name=block["child_name"], characteristics=traits))
            if block["absent"]:
                absent.add(block["child_id"])
            child_blocks[block["child_id"]] = replace(
                self._ctx_block(block), place=block["place"] or (common_block or {}).get("place"),
                time_text=block["time_text"] or (common_block or {}).get("time_text"),
            )
            if block["filled"] and not block["absent"] and not block["areas"]:
                missing.append({"block_id": block["block_id"], "child_id": block["child_id"]})
        common = None
        if common_block is not None and common_block["filled"]:
            common = self._ctx_block(common_block)
        examples, _ = self.profile.get_document(teacher_id, "writing_examples")
        return DraftContext(
            teacher_id=teacher_id, session=session, cls=cls, roster=roster, absent=absent, common=common,
            blocks=child_blocks, writing_examples=examples, areas_missing=missing,
        )

    @staticmethod
    def _ctx_block(block: dict) -> BlockCtx:
        return BlockCtx(
            block_id=block["block_id"], child_id=block["child_id"], text=block["text"], areas=tuple(block["areas"]),
            place=block["place"], time_text=block["time_text"],
        )

    def _call(self, request, ctx: DraftContext):
        return self.ai.call(request, teacher_id=ctx.teacher_id, session_id=ctx.session["session_id"])

    def _ensure_ai_ready(self) -> None:
        if isinstance(self.ai.client, NotConfiguredAIClient):
            raise ApiError(
                status_code=503, code="AI_NOT_CONFIGURED",
                message="AI 연결 키가 아직 등록되지 않았습니다. 관리자가 키를 등록한 뒤에 만들 수 있어요.",
            )

    # --- validation ----------------------------------------------------------------------------------------------------------
    @staticmethod
    def _check_inputs(ctx: DraftContext, *, allow_missing_areas: bool) -> None:
        if not ctx.present:
            raise ApiError(status_code=422, code="NO_CHILDREN", message="출석한 아이가 없어요. 아이를 등록하거나 결석 표시를 확인해 주세요.")
        filled = [child for child in ctx.present if ctx.blocks[child.child_id].text.strip()]
        if ctx.common is None and not filled:
            raise ApiError(status_code=422, code="NOTHING_TO_WRITE", message="적은 내용이 없어요. 오늘 있었던 일을 한 곳이라도 적어 주세요.")
        if ctx.areas_missing and not allow_missing_areas:
            raise ApiError(
                status_code=422, code="AREAS_REQUIRED", message="관찰영역을 고르지 않은 입력이 있어요. 영역을 하나 이상 골라 주세요.",
                details={"block_ids": [item["block_id"] for item in ctx.areas_missing]},
            )

    # --- generate --------------------------------------------------------------------------------------------------------------
    def start_generate(
        self, teacher_id: str, session_id: str, *, ask_missing_areas: bool = False, prepare_journals: bool = False,
        manual_areas: bool = False,
    ) -> dict:
        session = self.sessions.require(teacher_id, session_id)
        if session["status"] not in ("writing", "failed"):
            raise ApiError(status_code=409, code="SESSION_BUSY", message="이미 만들고 있거나 만든 세션이에요.",
                           details={"status": session["status"]})
        self._ensure_ai_ready()
        self.sessions.ensure_blocks(teacher_id, session_id)
        ctx = self._load(teacher_id, session_id)
        self._check_inputs(ctx, allow_missing_areas=manual_areas or ask_missing_areas)
        self.sessions.set_status(
            session_id, "analyzing", snapshot=json.dumps({"common": common_snapshot(ctx.common)}, ensure_ascii=False),
            rules_hash=self.rules.rules_hash, model=self.ai.model, error_code=None,
        )
        return self.jobs.start(
            teacher_id, "generate", session_id,
            lambda: self._run_generate(
                teacher_id, session_id, ask_missing_areas=ask_missing_areas,
                prepare_journals=prepare_journals, manual_areas=manual_areas,
            ),
            on_error=lambda code: self.sessions.set_status(session_id, "failed", error_code=code),
        )

    def _run_generate(
        self, teacher_id: str, session_id: str, *, ask_missing_areas: bool, prepare_journals: bool, manual_areas: bool,
    ) -> dict:
        ctx = self._load(teacher_id, session_id)
        valid_ids = {child.child_id for child in ctx.present}
        sources = {}
        if prepare_journals:
            blocks = [ctx.blocks[child.child_id] for child in ctx.present]
            if ctx.common:
                blocks.insert(0, ctx.common)
            for block in blocks:
                missing = [key for key in METADATA_LABELS if not (getattr(block, key) or "").strip()]
                if block.text.strip() and missing:
                    sources[block.block_id] = {
                        "block_id": block.block_id, "child_id": block.child_id, "text": block.text, "fields": missing,
                    }
        review_request = prompts.build_review(
            self.rules, cls=ctx.cls, roster=ctx.present, common=ctx.common,
            blocks=[ctx.blocks[child.child_id] for child in ctx.present],
            metadata_sources=list(sources.values()),
        )
        data = self._call(review_request, ctx).data
        review = schemas.parse_review(data, valid_ids, allow_common=ctx.common is not None)
        review["prepare_journals"] = prepare_journals
        review["flags"].extend(self._metadata_questions(ctx, data, sources))
        if manual_areas:
            review["manual_areas"] = True
        elif ask_missing_areas and ctx.areas_missing:
            missing_ids = {item["child_id"] for item in ctx.areas_missing}
            with ThreadPoolExecutor(max_workers=self.parallelism, thread_name_prefix="patpat-areas") as pool:
                area_flags = list(pool.map(
                    lambda child: self._area_question(ctx, child),
                    (child for child in ctx.present if child.child_id in missing_ids),
                ))
            review["flags"].extend(area_flags)
        self.sessions.replace_flags(session_id, review["flags"])
        stored = {"review_json": json.dumps(review, ensure_ascii=False), "common_paragraph": None}
        if review["flags"]:
            self.sessions.set_status(session_id, "asking", **stored)
            return {"phase": "asking", "questions": len(review["flags"])}
        self.sessions.set_status(session_id, "drafting", **stored)
        return self._run_draft(teacher_id, session_id)

    @staticmethod
    def _metadata_questions(ctx: DraftContext, data: dict, sources: dict) -> list[dict]:
        names = {child.child_id: child.name for child in ctx.present}
        flags = []
        seen = set()
        for item in data.get("metadata") or []:
            if not isinstance(item, dict) or not isinstance(item.get("block_id"), str):
                continue
            source = sources.get(item["block_id"])
            if source is None:
                continue
            child_id = source["child_id"]
            for key in source["fields"]:
                value = item.get(key)
                marker = (item["block_id"], key)
                if not isinstance(value, str) or not value.strip() or len(value) > 100 or marker in seen:
                    continue
                value = value.strip()
                if value not in source["text"]:
                    continue
                seen.add(marker)
                name = "반 공통" if child_id is None else names[child_id]
                label = METADATA_LABELS[key]
                flags.append({
                    "kind": key, "child_ids": [] if child_id is None else [child_id],
                    "question": f"{name} 관찰의 {label}은 ‘{value}’로 기록할까요?", "options": [value],
                })
        return flags

    def _area_question(self, ctx: DraftContext, child: ChildCtx) -> dict:
        block = ctx.blocks[child.child_id]
        request = prompts.build_areas(self.rules, text=mask_names(block.text, ctx.other_names(child.child_id)))
        try:
            areas = schemas.parse_areas(self._call(request, ctx).data)
        except AIError:
            areas = []
        question = (
            f"{child.name}의 추천 관찰영역은 {', '.join(areas)}입니다. 이대로 할까요?"
            if areas else f"{child.name}의 관찰영역을 입력에서 찾기 어려웠어요. 어떤 영역으로 할까요?"
        )
        return {"kind": "area", "child_ids": [child.child_id], "question": question, "options": areas}

    def _write_common(self, ctx: DraftContext, flags: list[dict]) -> str:
        answers = [
            {"question": flag["question"], "answer": flag["answer"]}
            for flag in flags
            if flag["kind"] not in METADATA_LABELS and not flag["child_ids"] and flag["status"] == "answered" and flag["answer"]
        ]
        request = prompts.build_common(
            self.rules, cls=ctx.cls, common=ctx.common, all_names=ctx.all_names,
            writing_examples=ctx.writing_examples, answers=answers,
        )
        return mask_names(schemas.require_text(self._call(request, ctx).data, "text"), ctx.all_names)

    # --- answers ---------------------------------------------------------------------------------------------------------------------
    def submit_answers(self, teacher_id: str, session_id: str, answers: list[dict], skip_remaining: bool) -> dict:
        session = self.sessions.require(teacher_id, session_id)
        if session["status"] != "asking":
            raise ApiError(status_code=409, code="NOT_ASKING", message="지금은 질문에 답하는 단계가 아니에요.",
                           details={"status": session["status"]})
        flags = {flag["flag_id"]: flag for flag in self.sessions.list_flags(session_id)}
        decided: dict[str, str | None] = {}
        area_updates: dict[str, list[str]] = {}
        metadata_updates: dict[str | None, dict[str, str]] = {}
        for item in answers:
            flag_id = item["flag_id"]
            flag = flags.get(flag_id)
            if flag is None:
                raise ApiError(status_code=422, code="UNKNOWN_FLAG", message="없는 질문입니다.", details={"flag_id": item["flag_id"]})
            if flag_id in decided:
                raise ApiError(status_code=422, code="DUPLICATE_ANSWER", message="질문마다 답을 하나만 보내 주세요.")
            text = (item.get("answer") or "").strip()
            areas = item.get("areas")
            if flag["kind"] == "area":
                if text:
                    raise ApiError(status_code=422, code="INVALID_AREA_ANSWER", message="관찰영역을 선택하거나 건너뛰어 주세요.")
                if areas:
                    area_updates[flag["child_ids"][0]] = areas
                decided[flag_id] = ", ".join(areas) if areas else None
            else:
                if areas is not None:
                    raise ApiError(status_code=422, code="INVALID_AREA_ANSWER", message="영역 확인 질문에만 관찰영역을 선택할 수 있어요.")
                if text and flag["kind"] in METADATA_LABELS:
                    if len(text) > 100:
                        raise ApiError(status_code=422, code="INVALID_METADATA_ANSWER", message="장소·시간은 100자까지 적어 주세요.")
                    child_id = flag["child_ids"][0] if flag["child_ids"] else None
                    metadata_updates.setdefault(child_id, {})[flag["kind"]] = text
                decided[flag_id] = text or None
        open_ids = [fid for fid, flag in flags.items() if flag["status"] == "open" and fid not in decided]
        if open_ids and not skip_remaining:
            raise ApiError(status_code=422, code="ANSWERS_INCOMPLETE", message="답하지 않은 질문이 있어요. 답하거나 건너뛰어 주세요.",
                           details={"flag_ids": open_ids})
        for flag_id in open_ids:
            decided[flag_id] = None
        self.sessions.finish_review(teacher_id, session_id, decided, area_updates, metadata_updates)
        return self.jobs.start(
            teacher_id, "draft", session_id, lambda: self._run_draft(teacher_id, session_id),
            on_error=lambda code: self.sessions.set_status(session_id, "failed", error_code=code),
        )

    def _run_draft(self, teacher_id: str, session_id: str) -> dict:
        ctx = self._load(teacher_id, session_id)
        review = json.loads(ctx.session["review_json"]) if ctx.session["review_json"] else dict(EMPTY_REVIEW)
        flags = self.sessions.list_flags(session_id)
        common_paragraph = self._write_common(ctx, flags) if ctx.common else ""
        self.sessions.set_status(session_id, "drafting", common_paragraph=common_paragraph)
        return self._draft_all(ctx, flags=flags, review=review, common_paragraph=common_paragraph)

    def reopen(self, teacher_id: str, session_id: str) -> None:
        """Go back from the questions to editing; the questions are dropped and asked again next time."""
        self.sessions.reopen_review(teacher_id, session_id)

    # --- drafting ----------------------------------------------------------------------------------------------------------------------
    def _draft_inputs(self, ctx: DraftContext, child: ChildCtx, flags, review, common_paragraph) -> dict:
        block = ctx.blocks[child.child_id]
        mode, answers = mode_and_answers(flags, child.child_id)
        return {
            "child": child, "block": block, "mode": mode, "answers": answers,
            "joint_facts": joint_facts_for(review, child.child_id), "common_paragraph": common_paragraph,
            "recent": self.notices.recent_texts(ctx.teacher_id, child.child_id, ctx.session["target_date"]),
        }

    def _write_individual(self, ctx: DraftContext, inputs: dict) -> str:
        child = inputs["child"]
        request = prompts.build_individual(
            self.rules, cls=ctx.cls, child=child, block=inputs["block"], common=ctx.common,
            common_paragraph=inputs["common_paragraph"], other_names=ctx.other_names(child.child_id),
            mode=inputs["mode"], answers=inputs["answers"], joint_facts=inputs["joint_facts"],
            recent_notices=inputs["recent"], writing_examples=ctx.writing_examples,
        )
        text = schemas.require_text(self._call(request, ctx).data, "text")
        return mask_names(text, ctx.other_names(child.child_id))

    def _save_notice(self, ctx: DraftContext, inputs: dict, individual: str, incident: bool) -> dict:
        child, block = inputs["child"], inputs["block"]
        text = "\n\n".join(part for part in (inputs["common_paragraph"], individual) if part)
        source = " ".join([block.text, ctx.common.text if ctx.common else "", *(item["answer"] for item in inputs["answers"])])
        return self.notices.save_generated(
            teacher_id=ctx.teacher_id, session_id=ctx.session["session_id"], child_id=child.child_id,
            target_date=ctx.session["target_date"], text=text, needs_check=not block.text.strip(), incident=incident,
            warnings=lint_notice(text, source), rules_hash=self.rules.rules_hash, model=self.ai.model,
        )

    def _draft_all(self, ctx: DraftContext, *, flags: list[dict], review: dict, common_paragraph: str) -> dict:
        incident_ids = incident_ids_of(review, flags)
        work: list[dict] = []
        for child in ctx.present:
            has_input = bool(ctx.blocks[child.child_id].text.strip())
            if not has_input and not common_paragraph:
                continue  # nothing to say about this child today
            inputs = self._draft_inputs(ctx, child, flags, review, common_paragraph)
            inputs["has_input"] = has_input
            work.append(inputs)

        def run(inputs: dict) -> str | AIError:
            if not inputs["has_input"]:
                return ""
            try:
                return self._write_individual(ctx, inputs)
            except AIError as error:
                return error

        with ThreadPoolExecutor(max_workers=self.parallelism, thread_name_prefix="patpat-draft") as pool:
            outcomes = list(pool.map(run, work))

        errors = [outcome for outcome in outcomes if isinstance(outcome, AIError)]
        attempted = sum(1 for inputs in work if inputs["has_input"])
        if attempted and len(errors) == attempted:
            raise errors[0]  # the AI answered nobody: fail the session instead of saving half-empty drafts
        drafted, failed = 0, []
        for inputs, outcome in zip(work, outcomes):
            child_id = inputs["child"].child_id
            if isinstance(outcome, AIError):
                failed.append({"child_id": child_id, "error_code": outcome.code})
                continue
            notice = self._save_notice(ctx, inputs, outcome, child_id in incident_ids)
            if self.journal and review.get("prepare_journals"):
                self.journal.prepare(teacher_id=ctx.teacher_id, notice=notice, flags=flags, review=review)
            drafted += 1
        self.sessions.set_status(ctx.session["session_id"], "reviewing", error_code=None)
        return {"phase": "reviewing", "drafted": drafted, "failed": failed}

    # --- regenerate one child ----------------------------------------------------------------------------------------------------
    def start_regenerate_child(self, teacher_id: str, session_id: str, child_id: str) -> dict:
        session = self.sessions.require(teacher_id, session_id)
        if session["status"] not in ("reviewing", "failed"):
            raise ApiError(status_code=409, code="SESSION_BUSY", message="아직 처음 초안을 만드는 중이거나 만들기 전이에요.",
                           details={"status": session["status"]})
        ref_id = f"{session_id}:{child_id}"
        if self.jobs.is_active(ref_id):
            raise ApiError(status_code=409, code="NOTICE_BUSY", message="이 아이의 알림장을 이미 다시 쓰는 중이에요.")
        self._ensure_ai_ready()
        ctx = self._load(teacher_id, session_id)
        child = next((item for item in ctx.roster if item.child_id == child_id), None)
        if child is None:
            raise ApiError(status_code=404, code="NOT_FOUND", message="이 세션의 아이를 찾을 수 없습니다.")
        if child_id in ctx.absent:
            raise ApiError(status_code=422, code="CHILD_ABSENT", message="결석으로 표시된 아이예요.")
        if not ctx.blocks[child_id].text.strip() and ctx.common is None:
            raise ApiError(status_code=422, code="NOTHING_TO_WRITE", message="이 아이에 대해 적은 내용이 없어요.")
        missing_blocks = [item["block_id"] for item in ctx.areas_missing if item["child_id"] == child_id]
        if missing_blocks:
            review = json.loads(session["review_json"] or "{}")
            if not review.get("manual_areas") and not any(
                flag["kind"] == "area" and child_id in flag["child_ids"] and flag["status"] == "skipped"
                for flag in self.sessions.list_flags(session_id)
            ):
                raise ApiError(status_code=422, code="AREAS_REQUIRED", message="관찰영역을 하나 이상 골라 주세요.",
                               details={"block_ids": missing_blocks})
        return self.jobs.start(teacher_id, "regenerate_child", ref_id, lambda: self._run_regenerate(teacher_id, session_id, child_id))

    def _run_regenerate(self, teacher_id: str, session_id: str, child_id: str) -> dict:
        ctx = self._load(teacher_id, session_id)
        session = ctx.session
        review = json.loads(session["review_json"]) if session["review_json"] else dict(EMPTY_REVIEW)
        flags = self.sessions.list_flags(session_id)
        common_paragraph = session["common_paragraph"] or ""
        stored = json.loads(session["snapshot"]) if session["snapshot"] else {}
        if stored.get("common") != common_snapshot(ctx.common):  # the common block changed since it was written
            common_paragraph = self._write_common(ctx, flags) if ctx.common else ""
            self.sessions.set_status(
                session_id, session["status"], common_paragraph=common_paragraph,
                snapshot=json.dumps({"common": common_snapshot(ctx.common)}, ensure_ascii=False),
            )
        child = next(item for item in ctx.roster if item.child_id == child_id)
        inputs = self._draft_inputs(ctx, child, flags, review, common_paragraph)
        has_input = bool(inputs["block"].text.strip())
        individual = self._write_individual(ctx, inputs) if has_input else ""
        notice = self._save_notice(ctx, inputs, individual, child_id in incident_ids_of(review, flags))
        if self.journal and review.get("prepare_journals"):
            self.journal.prepare(teacher_id=ctx.teacher_id, notice=notice, flags=flags, review=review)
        if session["status"] == "failed":
            self.sessions.set_status(session_id, "reviewing", error_code=None)
        return {"notice_id": notice["notice_id"], "version": notice["version"]}

    # --- recovery -------------------------------------------------------------------------------------------------------------------------
    def _recover_session_job(self, job: dict) -> None:
        self.sessions.set_status(job["ref_id"], "failed", error_code="SERVER_RESTART")
