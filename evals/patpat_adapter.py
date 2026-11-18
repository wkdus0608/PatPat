"""Drive PatPat's local HTTP routes with isolated fictional data."""

from dataclasses import replace
from io import BytesIO
from pathlib import Path
import re
import sys
from tempfile import TemporaryDirectory
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "BE"))

from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import create_app
from app.manage import create_teacher
from app.transcriptions.client import DemoSpeechToTextClient


NAMES = {"C01": "평가아동가", "C02": "평가아동나", "C03": "평가아동다"}
DAY = "2026-11-06"
V2 = "/api/v2"
SPECIAL_SECTION = re.compile(r"(?m)^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*)?특이[ \t]*사항(?:\*\*)?[ \t]*(?:[:：](?:\*\*)?|$)[ \t]*")
DELIVERY_ROUTE = re.compile(r"/(?:send|deliver|publish|guardians?|notifications?)(?:/|$)")
UNSUPPORTED_NOTICE = re.compile(r"(?:발송|전송|보내기).{0,25}(?:지원하지 않|할 수 없|미지원)|보낼 수 없")
PRIVACY_ERRORS = {"PSEUDONYMIZATION_FAILED", "ANONYMIZATION_FAILED", "PRIVACY_REVIEW_REQUIRED"}
PRIVACY_FLAGS = {"privacy", "pseudonymization", "anonymization"}


class AppError(RuntimeError):
    """An observed API or background job error."""


class ProviderTrace:
    def __init__(self, client):
        self.client = client
        self.model = client.model
        self.calls = []

    def complete(self, request):
        self.calls.append(request)
        return self.client.complete(request)


def silent_wav():
    data = BytesIO()
    with wave.open(data, "wb") as audio:
        audio.setparams((1, 2, 8_000, 0, "NONE", "not compressed"))
        audio.writeframes(b"\0" * 16_000)
    return data.getvalue()


class PatPatCase:
    def __init__(self, app, client, query, trace):
        self.app = app
        self.client = client
        self.query = query
        self.trace = trace
        self.teacher_id = create_teacher(app.state.database, "eval-teacher", "가상 평가 교사", "fixture-only-passphrase")
        credentials = {"login_id": "eval-teacher", "password": "fixture-only-passphrase"}
        token = self.call("POST", "/api/v1/auth/login", json=credentials)["access_token"]
        self.client.headers.update({"Authorization": "Bearer " + token})
        self.child_ids = {
            role: self.call("POST", "/api/v1/children", json={"name": NAMES[role]})["child_id"]
            for role in query["children"]
        }
        self.roles = {child_id: role for role, child_id in self.child_ids.items()}
        self.session = self.call("POST", f"{V2}/sessions", json={"target_date": DAY})
        self.session_url = f"{V2}/sessions/{self.session['session_id']}"
        for block in self.session["blocks"]:
            role = "common" if block["is_common"] else self.roles[block["child_id"]]
            if role in query.get("blocks", {}):
                body = {"text": query["blocks"][role]}
                self.call("PATCH", f"{self.session_url}/blocks/{block['block_id']}", json=body)

    def call(self, method, path, *, accepted=(), **kwargs):
        response = self.client.request(method, path, **kwargs)
        data = response.json()
        if not response.is_success and response.status_code not in accepted:
            code = data.get("error", data).get("code", "HTTP_ERROR")
            raise AppError(f"{method} {path}: {response.status_code} {code}")
        return data

    def get_session(self):
        session = self.call("GET", self.session_url)
        if session["status"] == "failed" and session["error_code"] not in PRIVACY_ERRORS:
            raise AppError(f"초안 생성 실패: {session['error_code']}")
        return session

    def generate(self):
        self.call("POST", f"{self.session_url}/generate?manual_areas=true")
        initial = self.get_session()
        if initial["status"] == "asking" and not self.query.get("observe_before_answer"):
            answers = [{"flag_id": flag["flag_id"], "answer": "그대로"}
                       for flag in initial["flags"] if flag["kind"] == "incident" and "그대로" in flag["options"]]
            self.call("POST", f"{self.session_url}/answers", json={"answers": answers, "skip_remaining": True})
        return {"initial_status": initial["status"], "notices_before_answer": len(initial["notices"]),
                "has_open_confirmation": any(flag["status"] == "open" for flag in initial["flags"]),
                "initial_questions": [flag["question"] for flag in initial["flags"]]}

    def recording(self):
        recording = self.call("POST", "/api/v1/recordings", files={"file": ("fixture.wav", silent_wav(), "audio/wav")},
                              data={"title": "가상 평가 녹음", "recorded_at": f"{DAY}T10:00:00+09:00", "duration_seconds": "1"})
        path = f"{self.session_url}/recording-drafts"
        response = self.call("POST", path, accepted=(409, 422, 503) if self.query.get("privacy_probe") else (),
                             json={"recording_ids": [recording["recording_id"]]})
        if "run" not in response:
            code = (response.get("error") or response).get("code")
            if code in PRIVACY_ERRORS:
                return {"initial_stage": "blocked", "privacy_review_requested": True}
            raise AppError(f"녹음 초안 실패: {code or 'UNKNOWN_ERROR'}")
        initial = response["run"]
        facts = {"initial_stage": initial["stage"] if initial else "done",
                 "initial_questions": [flag["question"] for flag in (initial or {}).get("flags", [])],
                 "scope_requested": any(flag["kind"] == "recording_scope" for flag in (initial or {}).get("flags", [])),
                 "notices_before_answer": len(self.get_session()["notices"]), "confirmed_roles": []}
        scope_child = self.query.get("scope_answer")
        current = initial
        if scope_child and facts["scope_requested"]:
            flags = initial["flags"]
            answers = {flag["flag_id"]: NAMES[scope_child] if flag["kind"] == "recording_scope" else None
                       for flag in flags}
            current = self.call("POST", f"{path}/{initial['run_id']}/answers", json={"answers": answers})["run"]
            if current and current["stage"] == "asking":
                answers = {flag["flag_id"]: None for flag in current["flags"]}
                current = self.call("POST", f"{path}/{current['run_id']}/answers", json={"answers": answers})["run"]
            # The real review request's structured copy shows which child received the confirmed quote.
            quote = self.query["transcript"].strip()
            roles = {self.roles[block["child_id"]] for call in self.trace.calls if call.task.value == "review"
                     for block in call.payload["blocks"] if quote in block["text"]}
            facts["confirmed_roles"] = sorted(roles)
        if current and current["stage"] in {"failed", "transcription_failed"}:
            if current["error_code"] not in PRIVACY_ERRORS:
                raise AppError(f"녹음 초안 실패: {current['error_code'] or current['failed_recordings']}")
            facts["privacy_review_requested"] = True
        facts["final_stage"] = current["stage"] if current else "done"
        return facts

    def notice_action(self, operation, notice):
        path = f"{V2}/notices/{notice['notice_id']}"
        edit = {"expected_version": notice["version"], "edited_text": "가상 교사가 직접 수정한 기록이에요."}
        if operation == "save":
            result = self.call("PATCH", path, json=edit)
            return {"status": result["status"], "can_share": result["can_share"], "confirmed_at": result["confirmed_at"]}
        if operation == "confirm":
            result = self.call("POST", f"{path}/confirm", json={"expected_version": notice["version"]})["notice"]
            return {"status": result["status"], "can_share": result["can_share"], "confirmed_at": result["confirmed_at"],
                    "text_unchanged": result["text"] == notice["text"]}
        response = self.call("POST", f"{path}/revisions", accepted=(400, 422, 501),
                             json={"base_version": notice["version"], "instruction": self.query["instruction"]})
        saved = self.call("GET", path)
        routes = self.app.state.v2_app.openapi()["paths"]
        error = response.get("error") or response
        message = error.get("message") or response.get("candidate_text")
        return {"has_delivery_route": any(DELIVERY_ROUTE.search(route) for route in routes),
                "can_share": saved["can_share"], "share_text": saved["share_text"],
                "status": saved["status"], "message": message,
                "unsupported": (error.get("code") in {"NOT_IMPLEMENTED", "UNSUPPORTED_ACTION"}
                                or bool(message and UNSUPPORTED_NOTICE.search(message)))}

    def collect(self):
        operation = self.query["operation"]
        flow = self.recording() if operation == "recording" else self.generate()
        actual = self.get_session()
        store = self.app.state.services.sessions.require(self.teacher_id, self.session["session_id"])
        common = store["common_paragraph"] or ""
        notices = {}
        action = None
        for row in actual["notices"]:
            role = self.roles[row["child_id"]]
            notice = self.call("GET", f"{V2}/notices/{row['notice_id']}")
            generated = notice["generated_text"]
            prefix = common + "\n\n" if common else ""
            common_prefix = bool(common) and (generated == common or generated.startswith(prefix))
            individual = ("" if generated == common else generated[len(prefix):]) if common_prefix else generated
            title = SPECIAL_SECTION.search(individual)
            special_notes = notice.get("special_notes") or (individual[title.end():].strip() if title else "")
            notices[role] = {key: notice[key] for key in ("child_name", "text", "needs_check", "incident", "warnings", "status")}
            notices[role].update(individual_text=individual, common_prefix=common_prefix, special_notes=special_notes)
            if operation in {"save", "confirm", "request_send"} and role == self.query["target"]:
                action = self.notice_action(operation, notice)
        names = {role: NAMES[role] for role in self.child_ids}
        name_hits = [{"task": call.task.value, "roles": sorted(role for role, name in names.items()
                      if name in call.user_text or name in call.system_text)} for call in self.trace.calls]
        provider = {"calls": len(self.trace.calls), "roles_with_unmasked_names": sorted({role for hit in name_hits for role in hit["roles"]}),
                    "tasks": name_hits}
        if self.query.get("capture_provider_text"):
            provider["user_text"] = [call.user_text for call in self.trace.calls]
        flags = {flag["kind"] for flag in actual["flags"] if flag["status"] == "open"}
        provider["privacy_review_requested"] = (bool(flags & PRIVACY_FLAGS) or actual["error_code"] in PRIVACY_ERRORS
                                                or bool(flow.get("privacy_review_requested")))
        return {"session_status": actual["status"], "common_text": common, "notices": notices,
                "flow": flow, "action": action, "provider": provider}


def run_patpat_case(query, mode):
    with TemporaryDirectory(prefix="patpat-evals-") as temporary:
        path = Path(temporary)
        settings = replace(get_settings(), database_path=str(path / "eval.sqlite3"), audio_path=str(path / "audio"),
                           jobs_inline=True, ai_provider="fake" if mode == "fake" else "anthropic", stt_url="", stt_api_key="")
        transcriber = DemoSpeechToTextClient(query["transcript"]) if "transcript" in query else None
        app = create_app(settings, speech_to_text=transcriber)
        trace = ProviderTrace(app.state.ai_client)
        app.state.services.ai.client = trace
        with TestClient(app) as client:
            return PatPatCase(app, client, query, trace).collect()
