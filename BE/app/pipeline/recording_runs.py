"""Recording-backed initial drafts and version-checked regeneration candidates."""
from collections import Counter

from app.ai import prompts
from app.ai.types import AIError
from app.auth.models import TeacherContext
from app.core.errors import ApiError
from app.core.timeutil import new_id
from app.pipeline.recording_store import RecordingDraftStore, WORKING, changed
from app.pipeline.service import METADATA_LABELS, PipelineService, incident_ids_of
from app.transcriptions.cache import RecordingTranscripts


def question_key(flag: dict) -> tuple:
    return flag["kind"], tuple(sorted(flag["child_ids"])), flag["question"], tuple(flag["options"])


def for_children(flag: dict, targets: set[str]) -> bool:
    return not flag["child_ids"] or bool(targets.intersection(flag["child_ids"]))


def nothing_to_write() -> ApiError:
    return ApiError(status_code=422, code="NOTHING_TO_WRITE", message="알림장에 쓸 관찰 내용을 확인하지 못했어요.")


class RecordingDrafts:
    def __init__(self, store: RecordingDraftStore, pipeline: PipelineService, transcripts: RecordingTranscripts):
        self.store = store
        self.pipeline = pipeline
        self.transcripts = transcripts
        self.jobs = pipeline.jobs
        self.jobs.register_recovery("recording_draft", lambda job: self.store.fail(job["ref_id"], "SERVER_RESTART"))

    def state(self, teacher: TeacherContext, session_id: str) -> tuple[dict | None, dict[str, dict]]:
        self.pipeline.sessions.require(teacher.teacher_id, session_id)
        return self.store.get(session_id), self.store.sources(session_id)

    def _require(self, teacher: TeacherContext, session_id: str, run_id: str, stage: str | None = None) -> dict:
        self.pipeline.sessions.require(teacher.teacher_id, session_id)
        draft = self.store.get(session_id)
        if not draft or draft["run_id"] != run_id or (stage is not None and draft["stage"] != stage):
            raise changed()
        return draft

    def start(self, teacher: TeacherContext, session_id: str, recording_ids: list[str], child_ids: list[str] | None) -> None:
        self.pipeline.sessions.require(teacher.teacher_id, session_id)
        self.pipeline._ensure_ai_ready()
        self.pipeline.sessions.ensure_blocks(teacher.teacher_id, session_id)
        blocks = self.pipeline.sessions.list_blocks(session_id)
        sources = self.store.sources(session_id)
        targets = set(child_ids or ())
        prior_flags = self.pipeline.sessions.list_flags(session_id)
        prior_facts = []
        for child_id, source in sources.items():
            prior_facts.extend(source.get("resolved_facts", []))
            if child_id in targets:
                prior_flags.extend(source["flags"])
        prior = {}
        conflicts = set()
        for flag in prior_flags:
            if flag["status"] != "answered" or flag["kind"] in ("area", "recording_scope") or not for_children(flag, targets):
                continue
            key = question_key(flag)
            if key in prior and prior[key]["answer"] != flag["answer"]:
                conflicts.add(key)
            prior[key] = flag
        draft = self.store.begin(teacher.teacher_id, session_id, blocks, recording_ids, child_ids,
                                 [flag for key, flag in prior.items() if key not in conflicts], prior_facts)
        self._job(draft, lambda: self._transcribe(teacher, draft))

    def _job(self, draft: dict, work) -> None:
        self.jobs.start(
            draft["payload"]["teacher_id"], "recording_draft", draft["run_id"], work,
            on_error=lambda code: self.store.fail(draft["run_id"], code),
        )

    def retry(self, teacher: TeacherContext, session_id: str, run_id: str, *, exclude_failed: bool) -> None:
        draft = self._require(teacher, session_id, run_id, "transcription_failed")
        payload = draft["payload"]
        ids = payload["recording_ids"]
        if exclude_failed:
            failed = {item["recording_id"] for item in payload["failed_recordings"]}
            ids = [recording_id for recording_id in ids if recording_id not in failed]
            if not ids and not any(block["filled"] and not block["absent"] for block in payload["blocks"]
                                   if block["child_id"] is None or block["child_id"] in payload["targets"]):
                raise nothing_to_write()
        draft = self.store.advance(draft, "transcribing", recording_ids=ids, failed_recordings=[])
        self._job(draft, lambda: self._transcribe(teacher, draft))

    def _transcribe(self, teacher: TeacherContext, draft: dict) -> None:
        transcripts, failed = {}, []
        for recording_id in draft["payload"]["recording_ids"]:
            try:
                transcripts[recording_id] = self.transcripts.text(teacher, recording_id)
            except (ApiError, AIError) as failure:
                failed.append({"recording_id": recording_id, "code": failure.code})
            except Exception:
                failed.append({"recording_id": recording_id, "code": "STT_FAILED"})
        if failed:
            self.store.advance(draft, "transcription_failed", failed_recordings=failed)
            return
        draft = self.store.advance(draft, "analyzing")
        self._extract(draft, transcripts)

    def _context(self, draft: dict):
        payload = draft["payload"]
        blocks = []
        for block in payload["blocks"]:
            child_id = block["child_id"]
            quotes = [fact["quote"] for fact in payload.get("facts", [])
                      if fact["target"] is not None and fact["target"] == (child_id or "")]
            text = "\n".join(dict.fromkeys(part for part in [block["text"].strip(), *quotes] if part))
            metadata = {}
            for flag in payload.get("flags", []):
                if flag["kind"] in METADATA_LABELS and flag["status"] == "answered" and flag["child_ids"] == ([child_id] if child_id else []):
                    if not block[flag["kind"]]:
                        metadata[flag["kind"]] = flag["answer"]
            blocks.append({**block, **metadata, "text": text, "filled": bool(text)})
        return self.pipeline._load(payload["teacher_id"], draft["session_id"], input_blocks=blocks), blocks

    def _extract(self, draft: dict, transcripts: dict[str, str]) -> None:
        if not transcripts:
            self._review(draft)
            return
        ctx, _ = self._context(draft)
        request = prompts.build_recording_observations(self.pipeline.rules, transcripts=transcripts, roster=ctx.present)
        data = self.pipeline._call(request, ctx).data
        prior = {}
        for item in draft["payload"].get("prior_facts", []):
            key = item["recording_id"], item["quote"]
            target = item["target"]
            prior[key] = target if prior.get(key, target) == target else None
        facts, flags, seen = [], [], set()
        names = Counter(child.name for child in ctx.present)
        options = {"반 공통": ""}
        for index, child in enumerate(ctx.present, 1):
            label = child.name if names[child.name] == 1 and child.name not in options else f"{child.name} ({index})"
            options[label] = child.child_id
        for row in data.get("observations") or []:
            if not isinstance(row, dict) or not isinstance(row.get("recording_id"), str) or not isinstance(row.get("quote"), str):
                continue
            recording_id, quote = row["recording_id"], row["quote"].strip()
            key = (recording_id, quote)
            if not quote or quote not in transcripts.get(recording_id, "") or key in seen:
                continue
            seen.add(key)
            matched = [child.child_id for child in ctx.roster if child.name in quote]
            target = None
            if row.get("scope") == "common" and not matched:
                target = ""
            elif row.get("scope") == "individual" and matched == [row.get("child_id")] and matched[0] in options.values():
                target = matched[0]
            if key in prior:
                previous_target = prior[key]
                if previous_target is None or previous_target in options.values():
                    target = previous_target if target in (None, previous_target) else None
            fact = {"recording_id": recording_id, "quote": quote, "target": target, "resolved": key in prior and target == prior[key]}
            if target is None:
                flag_id = new_id()
                fact["flag_id"] = flag_id
                flags.append({"flag_id": flag_id, "kind": "recording_scope", "child_ids": [],
                              "question": f"녹음의 ‘{quote}’는 누구의 관찰인가요?", "options": list(options),
                              "answer": None, "status": "open"})
            facts.append(fact)
        if flags:
            self.store.advance(draft, "asking", facts=facts, flags=flags, scope_options=options, question_stage="scope")
        else:
            self._review(self.store.advance(draft, "analyzing", facts=facts))

    def _review(self, draft: dict) -> None:
        ctx, _ = self._context(draft)
        payload = draft["payload"]
        targets = set(payload["targets"])
        if ctx.common is None and not any(ctx.blocks[child_id].text for child_id in targets):
            raise nothing_to_write()
        old = payload["previous_flags"]
        previous = [{key: flag[key] for key in ("kind", "child_ids", "question", "answer")} for flag in old]
        review = self.pipeline.review_context(ctx, prepare_journals=True, previous_answers=previous, include_profiles=True)
        old_keys = {question_key(flag) for flag in old}
        questions = [flag for flag in review["flags"] if for_children(flag, targets)
                     and (flag["kind"] == "conflict" or question_key(flag) not in old_keys)]
        # A newly reported conflict takes precedence over the previous answer in that scope.
        reasked = {question_key(flag) for flag in questions}
        conflicts = [set(flag["child_ids"]) for flag in questions if flag["kind"] == "conflict"]
        kept = [flag for flag in old if question_key(flag) not in reasked
                and not any((not ids and not flag["child_ids"]) or ids.intersection(flag["child_ids"]) for ids in conflicts)]
        flags = [*kept, *[{**flag, "flag_id": new_id(), "answer": None, "status": "open"} for flag in questions]]
        if questions:
            self.store.advance(draft, "asking", review=review, flags=flags, question_stage="context")
        else:
            self._draft(self.store.advance(draft, "drafting", review=review, flags=flags))

    def answer(self, teacher: TeacherContext, session_id: str, run_id: str, answers: dict[str, str | None]) -> None:
        draft = self._require(teacher, session_id, run_id, "asking")
        payload = draft["payload"]
        flags = payload["flags"]
        if answers.keys() != {flag["flag_id"] for flag in flags if flag["status"] == "open"}:
            raise changed()
        if payload["question_stage"] == "scope":
            options = payload["scope_options"]
            if any(answer and answer not in options for answer in answers.values()):
                raise ApiError(status_code=422, code="INVALID_RECORDING_SCOPE", message="관찰 대상을 선택해 주세요.")
            facts = [
                {**fact, "target": options.get(answers[fact["flag_id"]]), "resolved": bool(answers[fact["flag_id"]])}
                if fact.get("flag_id") in answers else fact for fact in payload["facts"]
            ]
            draft = self.store.advance(draft, "analyzing", facts=facts, flags=[])
            self._job(draft, lambda: self._review(draft))
            return
        decided = []
        for flag in flags:
            if flag["status"] != "open":
                decided.append(flag)
                continue
            answer = answers[flag["flag_id"]]
            if flag["kind"] in METADATA_LABELS and answer and len(answer) > 100:
                raise ApiError(status_code=422, code="INVALID_METADATA_ANSWER", message="장소·시간은 100자까지 적어 주세요.")
            decided.append({**flag, "answer": answer, "status": "answered" if answer else "skipped"})
        draft = self.store.advance(draft, "drafting", flags=decided)
        self._job(draft, lambda: self._draft(draft))

    def _draft(self, draft: dict) -> None:
        payload = draft["payload"]
        flags, review = payload["flags"], payload["review"]
        ctx, blocks = self._context(draft)
        common = self.pipeline._write_common(ctx, flags) if ctx.common else ""
        incidents = incident_ids_of(review, flags)
        targets = set(payload["targets"])
        candidates = []
        for inputs, outcome in self.pipeline.draft_outcomes(ctx, flags=flags, review=review, common_paragraph=common, targets=targets):
            if isinstance(outcome, AIError):
                raise outcome
            child = inputs["child"]
            child_id = child.child_id
            notice = self.pipeline.draft_payload(ctx, inputs, outcome, child_id in incidents)
            candidates.append({
                "child_id": child_id, "child_name": child.name, "applied": False,
                "notice": {**notice, "model": self.pipeline.ai.model, "rules_hash": self.pipeline.rules.rules_hash},
                "source": {
                    "recording_ids": payload["recording_ids"],
                    "blocks": [block for block in blocks if block["child_id"] in (None, child_id)],
                    "flags": [flag for flag in flags if for_children(flag, {child_id})],
                    "resolved_facts": [fact for fact in payload.get("facts", []) if fact["resolved"] and fact["target"] in ("", child_id)],
                    "review": {"joint_events": [event for event in review["joint_events"] if child_id in event["facts"]]},
                },
            })
        if not candidates:
            raise nothing_to_write()
        if payload["initial"]:
            self._prepare_journals(payload["teacher_id"], self.store.publish(draft, candidates))
        else:
            missing = [child.name for child in ctx.present
                       if child.child_id in targets and not any(item["child_id"] == child.child_id for item in candidates)]
            self.store.advance(draft, "ready", candidates=candidates, missing_children=missing)

    def _prepare_journals(self, teacher_id: str, notice_ids: list[str]) -> None:
        if self.pipeline.journal:
            for notice_id in notice_ids:
                notice = self.pipeline.notices.require(teacher_id, notice_id)
                source = self.pipeline.notices.recording_source(notice_id)
                self.pipeline.journal.prepare(teacher_id=teacher_id, notice=notice, flags=source["flags"], review=source["review"])

    def apply(self, teacher: TeacherContext, session_id: str, run_id: str, child_id: str) -> None:
        draft = self._require(teacher, session_id, run_id, "ready")
        self._prepare_journals(teacher.teacher_id, self.store.publish(draft, [], child_id=child_id))

    def dismiss(self, teacher: TeacherContext, session_id: str, run_id: str) -> None:
        draft = self._require(teacher, session_id, run_id)
        if draft["stage"] in WORKING:
            raise changed()
        self.store.advance(draft, "dismissed", blocks=[], facts=[], prior_facts=[], flags=[], candidates=[])
