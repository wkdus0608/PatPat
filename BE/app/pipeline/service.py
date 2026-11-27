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
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace

from app.ai import observations, prompts, schemas
from app.ai.omissions import find_omissions, has_recorded_alternative
from app.ai.anthropic_client import NotConfiguredAIClient
from app.ai.gateway import AIGateway
from app.ai.lint import drop_unconfirmed_time_prefix, keep_example_emoticons, lint_notice
from app.ai.privacy import mask_names
from app.ai.prompts import BlockCtx, ChildCtx, ClassCtx
from app.ai.text_privacy import is_protected
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
THIN_INPUT_MAX_CHARS = 150  # 이 길이 이하의 개별 입력은 알림장에 쓸 사실이 부족하다고 본다(규칙 '역질문 정책').
MAX_THIN_CHILDREN = 6  # 보충 질문을 받을 아이는 학급 전체에서 6명까지, 입력이 짧은 아이부터다.


def thin_input_children(names: dict[str, str], blocks: dict[str, BlockCtx], skip: set[str],
                        limit: int = MAX_THIN_CHILDREN) -> list[dict]:
    """입력이 짧은 아이를 짧은 순서로 limit명까지 고른다. 입력이 없거나 이미 다른 질문이 정해진 아이(skip)는 뺀다."""
    items = []
    for child_id, name in names.items():
        text = blocks[child_id].text.replace("\n", "").strip()
        if not text or len(text) > THIN_INPUT_MAX_CHARS or child_id in skip:
            continue
        sentences = [part for part in re.split(r"[.!?]+", text) if part.strip()]
        items.append({"child_id": child_id, "name": name, "chars": len(text), "single": len(sentences) <= 1})
    items.sort(key=lambda item: item["chars"])
    return items[:max(0, limit)]


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
    protect_text: bool = False

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
        if (flag["kind"] in ("area", *METADATA_LABELS, *observations.SOURCE_CONFIRMATION_KINDS)
                or child_id not in flag["child_ids"] or flag["status"] != "answered"):
            continue
        answer = (flag["answer"] or "").strip()
        if not answer:
            continue
        if flag["kind"] == "incident":
            if answer.startswith("부드럽"):
                mode = "incident_soft"
                continue
            if answer == "그대로":
                mode = "incident_plain"  # 예전 앱이나 API가 직접 고른 경우만. 새 질문은 더 하지 않는다.
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
        if flag["kind"] in ("incident", observations.INJURY_SIDE):
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
    def _load(self, teacher_id: str, session_id: str, *, input_blocks: list[dict] | None = None) -> DraftContext:
        session = self.sessions.require(teacher_id, session_id)
        classroom = self.profile.get_classroom(teacher_id, session["classroom_id"])
        cls = ClassCtx(age_label=classroom["age_label"], band=age_band_from_label(classroom["age_label"]))
        blocks = self.sessions.list_blocks(session_id) if input_blocks is None else input_blocks
        common_block = next((block for block in blocks if block["is_common"]), None)
        roster, absent, child_blocks, missing = [], set(), {}, []
        for block in blocks:
            if block["is_common"]:
                continue
            traits, _ = self.profile.get_characteristics(block["child_id"])
            profile = self.profile.get_child(teacher_id, block["child_id"]) if input_blocks is not None else None
            roster.append(ChildCtx(child_id=block["child_id"], name=block["child_name"], characteristics=traits,
                                   birth_date=(profile or {}).get("birth_date"), gender=(profile or {}).get("gender")))
            if block["absent"]:
                absent.add(block["child_id"])
            child_blocks[block["child_id"]] = self._ctx_block(block)
            if block["filled"] and not block["absent"] and not block["areas"]:
                missing.append({"block_id": block["block_id"], "child_id": block["child_id"]})
        common = None
        if common_block is not None and common_block["filled"]:
            common = self._ctx_block(common_block)
        examples, _ = self.profile.get_document(teacher_id, "writing_examples")
        return DraftContext(
            teacher_id=teacher_id, session=session, cls=cls, roster=roster, absent=absent, common=common,
            blocks=child_blocks, writing_examples=examples, areas_missing=missing,
            protect_text=input_blocks is None and is_protected(session),
        )

    @staticmethod
    def _ctx_block(block: dict) -> BlockCtx:
        return BlockCtx(
            block_id=block["block_id"], child_id=block["child_id"], text=block["text"], areas=tuple(block["areas"]),
            place=block["place"], time_text=block["time_text"],
        )

    def _call(self, request, ctx: DraftContext, visible_child: str | None = None):
        return self.ai.call(request, teacher_id=ctx.teacher_id, session_id=ctx.session["session_id"],
                            protect_text=ctx.protect_text, visible_child=visible_child)

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
        manual_areas: bool = False, protect_text: bool = False,
    ) -> dict:
        session = self.sessions.require(teacher_id, session_id)
        if session["status"] not in ("writing", "failed"):
            raise ApiError(status_code=409, code="SESSION_BUSY", message="이미 만들고 있거나 만든 세션이에요.",
                           details={"status": session["status"]})
        self._ensure_ai_ready()
        self.sessions.ensure_blocks(teacher_id, session_id)
        ctx = self._load(teacher_id, session_id)
        self._check_inputs(ctx, allow_missing_areas=manual_areas or ask_missing_areas)
        self.sessions.begin_generation(
            session_id, snapshot=json.dumps({"common": common_snapshot(ctx.common), "protect_text": protect_text}, ensure_ascii=False),
            rules_hash=self.rules.rules_hash, model=self.ai.model,
        )
        return self.jobs.start(
            teacher_id, "generate", session_id,
            lambda: self._run_generate(
                teacher_id, session_id, ask_missing_areas=ask_missing_areas,
                prepare_journals=prepare_journals, manual_areas=manual_areas,
            ),
            on_error=lambda code: self.sessions.set_status(session_id, "failed", error_code=code),
        )

    def review_context(
        self, ctx: DraftContext, *, prepare_journals: bool, previous_answers: list[dict] | None = None,
        include_profiles: bool = False, ask_thin: bool = False,
    ) -> dict:
        """ask_thin이 참이면 입력이 얇은 아이와 하지 않은 일이 적힌 아이에게 사실을 더 묻게 한다(알림장 생성 경로)."""
        names = {child.child_id: child.name for child in ctx.present}
        blocks = [ctx.blocks[child_id] for child_id in names]
        if ctx.common is not None:
            blocks.insert(0, ctx.common)
        reviewed_blocks: dict[str | None, BlockCtx] = {}
        local_flags, confirmation_sources = [], {}
        for block in blocks:
            child_id = block.child_id
            cleaned, has_request = observations.strip_writing_requests(block.text)
            conflict = observations.conflicting_injury_side(cleaned) if child_id is not None else None
            reviewed_blocks[child_id] = replace(block, text=conflict.shared_text if conflict else cleaned)
            if has_request or conflict is not None:
                confirmation_sources[block.block_id] = observations.source_digest(block.text)
            if has_request:
                label = names[child_id] + "의" if child_id is not None else "반 공통"
                local_flags.append({
                    "kind": observations.OBSERVATION_INSTRUCTION,
                    "child_ids": [child_id] if child_id is not None else [],
                    "question": f"{label} 메모에 있는 작성 요청과 관련해 실제로 관찰한 내용은 무엇인가요?",
                    "options": [],
                })
            if conflict is not None:
                local_flags.append({
                    "kind": observations.INJURY_SIDE,
                    "child_ids": [child_id],
                    "question": f"{names[child_id]}의 부상 부위가 {conflict.part}인데 어느 쪽인가요?",
                    "options": list(observations.SIDE_OPTIONS),
                })
        sources = {}
        if prepare_journals:
            for block in reviewed_blocks.values():
                missing = [key for key in METADATA_LABELS if not (getattr(block, key) or "").strip()]
                if block.text.strip() and missing:
                    sources[block.block_id] = {
                        "block_id": block.block_id, "child_id": block.child_id, "text": block.text, "fields": missing,
                    }
        thin, omissions, detail_rank = [], {}, {}
        if ask_thin:
            asked = {child_id for flag in local_flags for child_id in flag["child_ids"]}
            for child_id in names:
                found = [] if child_id in asked else [item for item in find_omissions(reviewed_blocks[child_id].text) if not item["has_reason"]]
                if found:
                    omissions[child_id] = [item["sentence"] for item in found]
            # 하지 않은 일 질문이 먼저이고, 보충 질문은 학급 전체 6개에서 그만큼을 뺀 수만 받는다.
            thin = thin_input_children(names, reviewed_blocks, asked | set(omissions),
                                       limit=min(MAX_THIN_CHILDREN, schemas.MAX_DETAIL_QUESTIONS - len(omissions)))
            by_length = lambda child_id: len(reviewed_blocks[child_id].text.replace("\n", "").strip())  # noqa: E731
            detail_rank = {child_id: position for position, child_id in enumerate(
                [*sorted(omissions, key=by_length), *(item["child_id"] for item in thin)])}
        review_request = prompts.build_review(
            self.rules, cls=ctx.cls, roster=ctx.present, common=reviewed_blocks.get(None),
            blocks=[reviewed_blocks[child_id] for child_id in names],
            metadata_sources=list(sources.values()), previous_answers=previous_answers, include_profiles=include_profiles,
            thin_children=thin,
            omissions=[{"child_id": child_id, "name": names[child_id], "sentences": sentences} for child_id, sentences in omissions.items()],
        )
        data = self._call(review_request, ctx).data
        review = schemas.parse_review(data, set(names), allow_common=ctx.common is not None, detail_rank=detail_rank)
        if omissions:
            fallback = self._omission_questions(review["flags"], omissions, names, reviewed_blocks)
            review["flags"] = schemas.cap_detail_questions([*fallback, *review["flags"]], detail_rank)
        review["flags"] = [*local_flags, *review["flags"]][:schemas.MAX_FLAGS]
        if confirmation_sources:
            review["confirmation_sources"] = confirmation_sources
        review["prepare_journals"] = prepare_journals
        review["flags"].extend(self._metadata_questions(ctx, data, sources))
        return review

    def _run_generate(
        self, teacher_id: str, session_id: str, *, ask_missing_areas: bool, prepare_journals: bool, manual_areas: bool,
    ) -> dict:
        ctx = self._load(teacher_id, session_id)
        review = self.review_context(ctx, prepare_journals=prepare_journals, ask_thin=True)
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
    def _omission_questions(
        flags: list[dict], omissions: dict[str, list[str]], names: dict[str, str], blocks: dict[str | None, BlockCtx],
    ) -> list[dict]:
        """하지 않은 일에 대한 질문이 없으면 빠진 항목만 따로 묻는다."""
        asked = {child_id for flag in flags if flag["kind"] == "missing_fact" for child_id in flag["child_ids"]}
        questions = []
        for child_id, sentences in omissions.items():
            if child_id in asked:
                continue
            omitted = sentences[0].rstrip(".")
            detail = "이유를" if has_recorded_alternative(blocks[child_id].text, omitted) else "이유와 그 시간에 한 일을"
            questions.append({
                "kind": "missing_fact", "child_ids": [child_id], "options": [],
                "question": f"{names[child_id]}의 메모 ‘{omitted}’에 대해, {detail} 알려 주세요.",
            })
        return questions

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
        assert ctx.common is not None
        common_text, _ = observations.confirmed_observation(ctx.common.text, flags, None)
        if not common_text:
            return ""
        answers = [
            {"question": flag["question"], "answer": flag["answer"]}
            for flag in flags
            if flag["kind"] not in (*METADATA_LABELS, *observations.SOURCE_CONFIRMATION_KINDS)
            and not flag["child_ids"] and flag["status"] == "answered" and flag["answer"]
        ]
        request = prompts.build_common(
            self.rules, cls=ctx.cls, common=replace(ctx.common, text=common_text), all_names=ctx.all_names,
            writing_examples=ctx.writing_examples, answers=answers,
        )
        text = schemas.require_text(self._call(request, ctx, visible_child="").data, "text")
        source = "\n".join([common_text, *(item["answer"] for item in answers)])
        return mask_names(schemas.clean_routine_notice(text, source), ctx.all_names)

    # --- answers ---------------------------------------------------------------------------------------------------------------------
    def submit_answers(self, teacher_id: str, session_id: str, answers: list[dict], skip_remaining: bool,
                       *, protect_text: bool = False) -> dict:
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
        self.sessions.finish_review(teacher_id, session_id, decided, area_updates, metadata_updates, protect_text=protect_text)
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
    def _draft_inputs(self, ctx: DraftContext, child: ChildCtx, flags, review, common_paragraph, *, incident: bool) -> dict:
        block = ctx.blocks[child.child_id]
        text, unresolved_side = observations.confirmed_observation(block.text, flags, child.child_id)
        mode, answers = mode_and_answers(flags, child.child_id)
        if (incident or unresolved_side) and mode == "normal":
            mode = "incident_soft"  # 사건사고로 보이면 묻지 않고 부드러운 사건사고 알림장으로 쓴다
        return {
            "child": child, "block": replace(block, text=text), "has_input": bool(text),
            "mode": mode, "answers": answers, "incident": incident or unresolved_side, "unresolved_side": unresolved_side,
            "joint_facts": joint_facts_for(review, child.child_id), "common_paragraph": common_paragraph,
            "recent": self.notices.recent_texts(ctx.teacher_id, child.child_id, ctx.session["target_date"]),
        }

    def _write_individual(self, ctx: DraftContext, inputs: dict) -> str:
        child = inputs["child"]
        request = prompts.build_individual(
            self.rules, cls=ctx.cls, child=child, block=inputs["block"], common=ctx.common,
            common_paragraph=inputs["common_paragraph"], other_names=ctx.other_names(child.child_id),
            mode=inputs["mode"], answers=inputs["answers"], joint_facts=inputs["joint_facts"],
            recent_notices=inputs["recent"], writing_examples=ctx.writing_examples, incident=inputs["incident"],
        )
        source = "\n".join([request.payload["text"], *(item["answer"] for item in request.payload["answers"])])
        text = schemas.render_notice(
            self._call(request, ctx, visible_child=child.child_id).data,
            incident=inputs["incident"], unresolved_side=inputs["unresolved_side"],
            source=source, subject=f"⟦C:{child.child_id}⟧" if ctx.protect_text else child.name,
        )
        text = drop_unconfirmed_time_prefix(
            text, source=source, confirmed_time=inputs["block"].time_text, child_name=child.name,
        )
        return mask_names(text, ctx.other_names(child.child_id))

    @staticmethod
    def draft_payload(ctx: DraftContext, inputs: dict, individual: str) -> dict:
        block = inputs["block"]
        text = "\n\n".join(part for part in (inputs["common_paragraph"], individual) if part)
        source = " ".join([block.text, ctx.common.text if ctx.common else "", *(item["answer"] for item in inputs["answers"])])
        text = keep_example_emoticons(text, ctx.writing_examples, source)
        return {"text": text, "needs_check": not block.text.strip(), "incident": inputs["incident"], "warnings": lint_notice(text, source)}

    def _save_notice(self, ctx: DraftContext, inputs: dict, individual: str) -> dict:
        return self.notices.save_generated(
            teacher_id=ctx.teacher_id, session_id=ctx.session["session_id"], child_id=inputs["child"].child_id,
            target_date=ctx.session["target_date"], rules_hash=self.rules.rules_hash, model=self.ai.model,
            **self.draft_payload(ctx, inputs, individual),
        )

    def draft_outcomes(
        self, ctx: DraftContext, *, flags: list[dict], review: dict, common_paragraph: str, targets: set[str] | None = None,
    ) -> list[tuple[dict, str | AIError]]:
        incident_ids = incident_ids_of(review, flags)
        work: list[dict] = []
        for child in ctx.present:
            if targets is not None and child.child_id not in targets:
                continue
            if not ctx.blocks[child.child_id].text.strip() and not common_paragraph:
                continue
            inputs = self._draft_inputs(ctx, child, flags, review, common_paragraph, incident=child.child_id in incident_ids)
            if inputs["has_input"] or common_paragraph:
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
        return list(zip(work, outcomes))

    def _draft_all(self, ctx: DraftContext, *, flags: list[dict], review: dict, common_paragraph: str) -> dict:
        work = self.draft_outcomes(ctx, flags=flags, review=review, common_paragraph=common_paragraph)
        if not work:
            raise ApiError(status_code=422, code="NOTHING_TO_WRITE", message="작성할 관찰 내용이 없어요. 실제로 관찰한 일을 적어 주세요.")
        errors = [outcome for _, outcome in work if isinstance(outcome, AIError)]
        attempted = sum(1 for inputs, _ in work if inputs["has_input"])
        if attempted and len(errors) == attempted:
            raise errors[0]  # the AI answered nobody: fail the session instead of saving half-empty drafts
        drafted, failed = 0, []
        for inputs, outcome in work:
            child_id = inputs["child"].child_id
            if isinstance(outcome, AIError):
                failed.append({"child_id": child_id, "error_code": outcome.code})
                continue
            notice = self._save_notice(ctx, inputs, outcome)
            if self.journal and review.get("prepare_journals"):
                self.journal.prepare(teacher_id=ctx.teacher_id, notice=notice, flags=flags)
            drafted += 1
        self.sessions.set_status(ctx.session["session_id"], "reviewing", error_code=None)
        return {"phase": "reviewing", "drafted": drafted, "failed": failed}

    # --- regenerate one child ----------------------------------------------------------------------------------------------------
    def start_regenerate_child(self, teacher_id: str, session_id: str, child_id: str, *, protect_text: bool = False) -> dict:
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
        return self.jobs.start(
            teacher_id, "regenerate_child", ref_id, lambda: self._run_regenerate(teacher_id, session_id, child_id, protect_text),
        )

    def _run_regenerate(self, teacher_id: str, session_id: str, child_id: str, protect_text: bool = False) -> dict:
        ctx = self._load(teacher_id, session_id)
        ctx.protect_text = ctx.protect_text or protect_text
        session = ctx.session
        review = json.loads(session["review_json"]) if session["review_json"] else dict(EMPTY_REVIEW)
        flags = self.sessions.list_flags(session_id)
        confirmed_sources = review.get("confirmation_sources", {})
        for block in (ctx.common, ctx.blocks[child_id]):
            if block is None or confirmed_sources.get(block.block_id) == observations.source_digest(block.text):
                continue
            if observations.strip_writing_requests(block.text)[1]:
                raise ApiError(status_code=409, code="OBSERVATION_REVIEW_REQUIRED",
                               message="메모의 작성 요청을 확인한 관찰 내용으로 바꾼 뒤 다시 써 주세요.")
            scope = [block.child_id] if block.child_id is not None else []
            flags = [flag for flag in flags if flag["child_ids"] != scope
                     or flag["kind"] not in observations.SOURCE_CONFIRMATION_KINDS]
        common_paragraph = session["common_paragraph"] or ""
        stored = json.loads(session["snapshot"]) if session["snapshot"] else {}
        if stored.get("common") != common_snapshot(ctx.common):  # the common block changed since it was written
            common_paragraph = self._write_common(ctx, flags) if ctx.common else ""
            self.sessions.set_status(
                session_id, session["status"], common_paragraph=common_paragraph,
                snapshot=json.dumps({**stored, "common": common_snapshot(ctx.common), "protect_text": ctx.protect_text}, ensure_ascii=False),
            )
        child = next(item for item in ctx.roster if item.child_id == child_id)
        incident = child_id in incident_ids_of(review, flags)
        inputs = self._draft_inputs(ctx, child, flags, review, common_paragraph, incident=incident)
        if not inputs["has_input"] and not common_paragraph:
            raise ApiError(status_code=422, code="NOTHING_TO_WRITE", message="이 아이에 대해 적은 내용이 없어요.")
        individual = self._write_individual(ctx, inputs) if inputs["has_input"] else ""
        notice = self._save_notice(ctx, inputs, individual)
        if self.journal and review.get("prepare_journals"):
            self.journal.prepare(teacher_id=ctx.teacher_id, notice=notice, flags=flags, protect_text=ctx.protect_text)
        if session["status"] == "failed":
            self.sessions.set_status(session_id, "reviewing", error_code=None)
        return {"notice_id": notice["notice_id"], "version": notice["version"]}

    # --- recovery -------------------------------------------------------------------------------------------------------------------------
    def _recover_session_job(self, job: dict) -> None:
        self.sessions.set_status(job["ref_id"], "failed", error_code="SERVER_RESTART")
