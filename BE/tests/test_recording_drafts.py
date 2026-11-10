from uuid import uuid4

from app.ai.types import AITask
from app.transcriptions.models import SpeechToTextResult
from tests.flow_helpers import V2, add_children, fill, get_session, open_session, running_env


class FixtureTranscriber:
    def __init__(self):
        self.calls = []
        self.texts = {}

    async def transcribe(self, *, audio, content_type):
        assert content_type == "audio/wav"
        key = b"".join([chunk async for chunk in audio]).decode()
        self.calls.append(key)
        if key not in self.texts:
            raise RuntimeError("fictional provider failure")
        return SpeechToTextResult(self.texts[key])


def seed_audio(env, key, *, teacher=None, at="2026-11-05T15:30:00+00:00"):
    recording_id = str(uuid4())
    service = env.app.state.recording_service
    service.root.mkdir(exist_ok=True)
    service.path(recording_id).write_bytes(key.encode())
    with env.app.state.database.connect() as connection:
        connection.execute(
            "INSERT INTO recordings(recording_id, teacher_id, title, recorded_at, duration_seconds, size_bytes, "
            "content_type, status, created_at, digest) VALUES (?,?,?,?,1,?,'audio/wav','대기',?,?)",
            (recording_id, teacher or env.teacher_id, key, at, len(key), at, key),
        )
    return recording_id


def path_for(session):
    return f"{V2}/sessions/{session['session_id']}/recording-drafts"


def post(env, path, body=None):
    response = env.client.post(path, headers=env.headers, json=body)
    assert response.status_code in (200, 202), response.text
    return response.json()


def test_audio_only_questions_and_failed_file_retry_reuse_successful_transcripts(tmp_path):
    with running_env(tmp_path) as env:
        first, second = add_children(env, ["다온", "이든"])
        env.client.patch(f"{V2}/children/{first}/details", headers=env.headers, json={"gender": "여", "birth_date": "2023-04-12"})
        env.client.put(f"{V2}/children/{first}/characteristics", headers=env.headers, json={"text": "블록에 관심이 많음"})
        session = open_session(env)
        path = path_for(session)
        good, retry = seed_audio(env, "good"), seed_audio(env, "retry")
        stt = FixtureTranscriber()
        stt.texts["good"] = "다온이는 블록을 세 개 쌓았어요.\n블록을 줄지어 놓았어요."
        env.app.state.services.recording_drafts.transcripts.client = stt
        assert env.client.get(path, headers=env.headers).json()["run"] is None and not stt.calls
        assert env.client.get(f"/api/v1/recordings?date_from=2026-11-06&date_to=2026-11-06",
                              headers=env.headers).json()["total"] == 2

        failed = post(env, path, {"recording_ids": [good, retry]})["run"]
        assert failed["stage"] == "transcription_failed" and failed["failed_recordings"] == [{"recording_id": retry, "code": "STT_FAILED"}]
        assert stt.calls == ["good", "retry"]
        assert get_session(env, session["session_id"])["notices"] == []

        stt.texts["retry"] = "이든이는 종이를 반으로 접었어요."
        asking = post(env, f"{path}/{failed['run_id']}/transcriptions/retry")["run"]
        assert asking["stage"] == "asking" and stt.calls == ["good", "retry", "retry"]
        flag, = asking["flags"]
        assert flag["kind"] == "recording_scope" and "블록을 줄지어 놓았어요" in flag["question"]
        result = post(env, f"{path}/{failed['run_id']}/answers", {"answers": {flag["flag_id"]: "다온"}})
        assert result == {"used_recordings": {first: [good, retry], second: [good, retry]}, "run": None}
        notices = get_session(env, session["session_id"])["notices"]
        texts = {item["child_id"]: env.client.get(f"{V2}/notices/{item['notice_id']}", headers=env.headers).json()["text"]
                 for item in notices}
        assert "블록을 줄지어 놓았어요" in texts[first] and "종이를 반으로" not in texts[first]
        assert "종이를 반으로 접었어요" in texts[second] and "블록" not in texts[second]
        calls = env.app.state.ai_client.calls
        assert not any(call.task == AITask.AREAS for call in calls)
        review = next(call for call in calls if call.task == AITask.REVIEW)
        assert review.payload["child_profiles"][0] == {
            "child_id": first, "characteristics": "블록에 관심이 많음", "gender": "여", "birth_date": "2023-04-12",
        }
        assert env.client.get(f"{V2}/children/{first}/journal", headers=env.headers).json()["items"][0]["is_draft"]


def test_exclude_and_regenerate_preserve_other_notices_and_require_a_current_version(tmp_path):
    with running_env(tmp_path) as env:
        first, second = add_children(env, ["다온", "이든"])
        session = open_session(env)
        sid, path = session["session_id"], path_for(session)
        good, bad = seed_audio(env, "good"), seed_audio(env, "bad")
        other_teacher = seed_audio(env, "foreign", teacher=env.teacher_b_id)
        other_date = seed_audio(env, "next", at="2026-11-06T16:00:00+00:00")
        for recording, status in [(other_teacher, 404), (other_date, 422)]:
            response = env.client.post(path, headers=env.headers, json={"recording_ids": [recording]})
            assert response.status_code == status
        assert env.client.get(path, headers=env.headers_b).status_code == 404

        fill(env, session, None, "오전 10시에 나무 블록으로 놀이했어요.", (), place="교실")
        fill(env, session, "다온", "블록을 세 개 쌓았어요.", ("자연탐구",))
        fill(env, session, "이든", "둥근 모양을 살펴보았어요.", ("자연탐구",))
        post(env, f"{V2}/sessions/{sid}/generate?manual_areas=true&prepare_journals=true")
        flag, = get_session(env, sid)["flags"]
        post(env, f"{V2}/sessions/{sid}/answers", {"answers": [{"flag_id": flag["flag_id"], "answer": "오전 10시"}]})
        first_notice, second_notice = get_session(env, sid)["notices"]
        first_path = f"{V2}/notices/{first_notice['notice_id']}"
        second_path = f"{V2}/notices/{second_notice['notice_id']}"
        post(env, second_path + "/confirm", {"expected_version": 1})
        original_second = env.client.get(second_path, headers=env.headers).json()

        stt = FixtureTranscriber()
        stt.texts["good"] = "다온이는 블록 높이를 비교했어요."
        env.app.state.services.recording_drafts.transcripts.client = stt
        blocked = env.client.post(path, headers=env.headers, json={"recording_ids": [good], "child_ids": [second]})
        assert blocked.status_code == 409
        draft = post(env, path, {"recording_ids": [good, bad], "child_ids": [first]})["run"]
        assert draft["stage"] == "transcription_failed"
        ready = post(env, f"{path}/{draft['run_id']}/transcriptions/exclude")["run"]
        assert ready["stage"] == "ready" and stt.calls == ["good", "bad"]
        assert "블록 높이를 비교했어요" in ready["candidates"][0]["text"]
        assert env.client.get(first_path, headers=env.headers).json()["version"] == 1
        assert env.app.state.ai_client.calls_for(AITask.REVIEW)[-1].payload["previous_answers"][0]["answer"] == "오전 10시"

        env.client.patch(first_path, headers=env.headers, json={"expected_version": 1, "edited_text": "교사가 직접 수정한 글입니다."})
        apply_path = f"{path}/{draft['run_id']}/children/{first}/apply"
        assert env.client.post(apply_path, headers=env.headers).status_code == 409
        assert env.client.get(first_path, headers=env.headers).json()["text"] == "교사가 직접 수정한 글입니다."
        assert env.client.delete(f"{path}/{draft['run_id']}", headers=env.headers).status_code == 200
        newer = post(env, path, {"recording_ids": [good], "child_ids": [first]})["run"]
        result = post(env, f"{path}/{newer['run_id']}/children/{first}/apply")
        assert result == {"used_recordings": {first: [good]}, "run": None}
        assert "블록 높이를 비교했어요" in env.client.get(first_path, headers=env.headers).json()["text"]
        assert env.client.get(second_path, headers=env.headers).json() == original_second
        assert stt.calls == ["good", "bad"]


def test_unique_transcribed_name_is_corrected_and_observations_follow_source_order(tmp_path):
    with running_env(tmp_path) as env:
        child_id, _ = add_children(env, ["정하준", "이도윤"])
        session = open_session(env)
        recording = seed_audio(env, "name-typo")
        early = "정화준이 초록색 블록을 골랐어요."
        late = "정화준이가 블록 두 개를 나란히 놓았어요."
        transcript = early + "\n" + late
        stt = FixtureTranscriber()
        stt.texts["name-typo"] = transcript
        env.app.state.services.recording_drafts.transcripts.client = stt
        env.app.state.ai_client.handlers[AITask.RECORDING_OBSERVATIONS] = lambda _: {"observations": [
            {"recording_id": recording, "quote": quote, "scope": "individual",
             "child_id": child_id, "heard_name": "정화준"}
            for quote in (late, early)
        ]}

        result = post(env, path_for(session), {"recording_ids": [recording]})
        assert result["run"] is None and child_id in result["used_recordings"]
        review, = env.app.state.ai_client.calls_for(AITask.REVIEW)
        block, = review.payload["blocks"]
        assert block["child_id"] == child_id
        assert block["text"] == transcript.replace("정화준", "정하준")
        with env.app.state.database.connect() as connection:
            cached = connection.execute("SELECT text FROM recording_transcripts WHERE recording_id=?", (recording,)).fetchone()
        assert cached["text"] == transcript


def test_two_close_roster_names_require_confirmation_even_if_ai_picks_one(tmp_path):
    with running_env(tmp_path) as env:
        first, second = add_children(env, ["정하준", "정화진"])
        session = open_session(env)
        recording = seed_audio(env, "similar-names")
        quote = "정화준이 초록색 블록을 골랐어요."
        stt = FixtureTranscriber()
        stt.texts["similar-names"] = quote
        env.app.state.services.recording_drafts.transcripts.client = stt
        env.app.state.ai_client.handlers[AITask.RECORDING_OBSERVATIONS] = lambda _: {"observations": [
            {"recording_id": recording, "quote": quote, "scope": "individual",
             "child_id": first, "heard_name": "정화준"}
        ]}

        path = path_for(session)
        run = post(env, path, {"recording_ids": [recording]})["run"]
        assert run["stage"] == "asking"
        flag, = run["flags"]
        assert flag["kind"] == "recording_scope"
        assert "정하준" in flag["options"] and "정화진" in flag["options"]
        assert not env.app.state.ai_client.calls_for(AITask.REVIEW)
        result = post(env, f"{path}/{run['run_id']}/answers", {"answers": {flag["flag_id"]: "정화진"}})
        assert result["run"] is None and second in result["used_recordings"] and first not in result["used_recordings"]
        review, = env.app.state.ai_client.calls_for(AITask.REVIEW)
        assert review.payload["blocks"][0]["text"] == quote.replace("정화준", "정화진")
