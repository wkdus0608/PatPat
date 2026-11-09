"""Notice editing rules on top of NoticeStore: busy guard, text cleanup, AI revision jobs, and the hand-off to the journal."""
from app.ai import prompts, schemas
from app.ai.anthropic_client import NotConfiguredAIClient
from app.ai.gateway import AIGateway
from app.ai.lint import lint_notice
from app.ai.privacy import mask_names
from app.ai.prompts import ChildCtx
from app.core.errors import ApiError
from app.jobs.runner import JobRunner
from app.notices.store import NoticeStore
from app.rules.loader import RulesBundle
from app.sessions.store import SessionStore


def clean_text(text: str) -> str:
    cleaned = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not cleaned:
        raise ApiError(status_code=422, code="EMPTY_TEXT", message="글이 비어 있습니다.")
    return cleaned


class NoticeService:
    def __init__(
        self,
        *,
        rules: RulesBundle,
        store: NoticeStore,
        sessions: SessionStore,
        jobs: JobRunner,
        ai: AIGateway,
        journal=None,
    ):
        self.rules = rules
        self.store = store
        self.sessions = sessions
        self.jobs = jobs
        self.ai = ai
        self.journal = journal
        jobs.register_recovery("revision", lambda job: self.store.fail_revision(job["ref_id"], "SERVER_RESTART"))

    # --- guards --------------------------------------------------------------------------------------------------
    def is_busy(self, notice: dict) -> bool:
        return self.jobs.is_active(f"{notice['session_id']}:{notice['child_id']}")

    def _idle(self, teacher_id: str, notice_id: str) -> dict:
        notice = self.store.require(teacher_id, notice_id)
        if self.is_busy(notice):
            raise ApiError(status_code=409, code="NOTICE_BUSY", message="이 알림장을 다시 쓰는 중이에요. 끝난 뒤에 수정해 주세요.")
        return notice

    # --- edit / confirm --------------------------------------------------------------------------------------------
    def edit(self, teacher_id: str, notice_id: str, expected_version: int, text: str) -> dict:
        self._idle(teacher_id, notice_id)
        return self.store.update_text(teacher_id, notice_id, expected_version, clean_text(text))

    def confirm(
        self, teacher_id: str, notice_id: str, expected_version: int, *, update_journal: bool | None = None,
    ) -> tuple[dict, dict | None]:
        """Confirm the saved text, then start the journal work selected for this version."""
        self._idle(teacher_id, notice_id)
        notice, journal_action = self.store.confirm(teacher_id, notice_id, expected_version, update_journal=update_journal)
        if self.journal is not None:
            if journal_action == "refresh":
                return notice, self.journal.refresh_from_notice(teacher_id, notice)
            if journal_action == "sync":
                return notice, self.journal.on_confirm(teacher_id, notice)
        return notice, None

    def unconfirm(self, teacher_id: str, notice_id: str, expected_version: int) -> dict:
        self._idle(teacher_id, notice_id)
        return self.store.unconfirm(teacher_id, notice_id, expected_version)

    # --- AI revision -------------------------------------------------------------------------------------------------
    def start_revision(self, teacher_id: str, notice_id: str, base_version: int, instruction: str) -> tuple[dict, dict]:
        notice = self._idle(teacher_id, notice_id)
        if isinstance(self.ai.client, NotConfiguredAIClient):
            raise ApiError(status_code=503, code="AI_NOT_CONFIGURED",
                           message="AI 연결 키가 아직 등록되지 않았습니다. 직접 고치거나 키가 등록된 뒤에 요청해 주세요.")
        instruction = instruction.strip()
        if not instruction:
            raise ApiError(status_code=422, code="EMPTY_TEXT", message="수정 요청이 비어 있습니다.")
        revision = self.store.create_revision(teacher_id, notice_id, base_version, instruction)
        revision_id = revision["revision_id"]
        base_text = notice["edited_text"]  # the text of base_version, fixed now
        other_names = self.sessions.other_child_names(notice["session_id"], notice["child_id"])
        source = self.sessions.child_source_text(notice["session_id"], notice["child_id"])
        audio = self.store.recording_source(notice_id)
        if audio:
            source = "\n\n".join(block["text"] for block in audio["blocks"] if block["filled"])
        child = ChildCtx(child_id=notice["child_id"], name=notice["child_name"])

        def work() -> dict:
            self.store.mark_revision_running(revision_id)
            request = prompts.build_revise(
                self.rules, child=child, current_text=base_text, instruction=instruction, source_text=source,
                other_names=other_names,
            )
            result = self.ai.call(request, teacher_id=teacher_id, session_id=notice["session_id"])
            candidate = mask_names(schemas.require_text(result.data, "text"), other_names)
            self.store.finish_revision(revision_id, candidate)
            return {"revision_id": revision_id}

        job = self.jobs.start(teacher_id, "revision", revision_id, work,
                              on_error=lambda code: self.store.fail_revision(revision_id, code))
        self.store.set_revision_job(revision_id, job["job_id"])
        return self.store.get_revision(teacher_id, notice_id, revision_id), job

    def revision_warnings(self, notice: dict, revision: dict) -> list[dict]:
        if revision["status"] != "completed" or not revision["candidate_text"]:
            return []
        return lint_notice(revision["candidate_text"], notice["edited_text"] + " " + revision["instruction"])

    def adopt(self, teacher_id: str, notice_id: str, revision_id: str, expected_version: int) -> dict:
        self._idle(teacher_id, notice_id)
        return self.store.adopt_revision(teacher_id, notice_id, revision_id, expected_version)
