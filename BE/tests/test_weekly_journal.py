from app.ai.types import AITask
from tests.flow_helpers import V2, add_children, fill, get_session, open_session, running_env
from tests.test_recording_drafts import FixtureTranscriber, path_for, post, seed_audio


def start(env, path, week="2026-11-06"):
    response = env.client.post(path + "/weekly/draft", headers=env.headers, json={"week_of": week})
    assert response.status_code == 202, response.text
    job = response.json()
    assert job["status"] == "completed", job
    return job


def pick(source, quote, area, content):
    return {"source_id": source["source_id"], "quote": quote, "area": area, "content": content}


def test_week_selects_grounded_scenes_and_adds_only_approved_answers(tmp_path):
    def choose(request):
        sources = request.payload["sources"]
        assert target not in request.user_text and "가상아동가" not in request.user_text and "가상아동나" not in request.user_text
        if "teacher_answer" in sources[0]:
            source, = sources
            assert source["teacher_answer"] == '종이를 가리키며 "나도 그릴래"라고 말했어요.'
            return {"entries": [pick(source, source["text"], "의사소통", '종이를 가리키며 "나도 그릴래"라고 말함.')]}
        monday, common, friday, sunday = sources
        assert [source["date"] for source in sources] == ["2026-11-02", "2026-11-06", "2026-11-06", "2026-11-08"]
        assert "낮잠" in monday["text"]
        assert "여기에서는 다른 아이가 한 기록" not in request.user_text
        assert "결석 장면" not in request.user_text and "지난주" not in request.user_text and "다음 주" not in request.user_text
        assert "신체운동·건강" not in friday["text"]
        quote = friday["text"].splitlines()[0]
        accepted = pick(friday, quote, "자연탐구", "블록의 크기를 비교하여 나눔.")
        return {
            "entries": [
                accepted, accepted,  # repeated model output is ignored
                pick(friday, "원문에 없는 문장", "의사소통", "지어낸 말임."),
                pick(common, common["text"], "신체운동·건강", "미끄럼틀을 탐."),
            ],
            "questions": [{"source_id": sunday["source_id"], "quote": sunday["text"],
                           "question": "종이를 보고 무엇이라고 말했나요?"}],
        }

    with running_env(tmp_path, ai_handlers={AITask.WEEKLY_JOURNAL: choose}) as env:
        target, peer = add_children(env, ["가상아동가", "가상아동나"])
        for date, text in (("2026-11-01", "지난주에 종이를 접음"), ("2026-11-02", "낮잠"),
                           ("2026-11-03", "결석 장면"), ("2026-11-06", "가상아동가가 블록을 크기별로 나눴어요."),
                           ("2026-11-08", "종이를 보고 뭔가 말했다"), ("2026-11-09", "다음 주에 책을 봄")):
            session = open_session(env, date)
            fill(env, session, "가상아동가", text, ("신체운동·건강",), absent=date == "2026-11-03")
            if date == "2026-11-06":
                fill(env, session, None, "반에서 미끄럼틀을 탔어요.", ())
                fill(env, session, "가상아동나", "여기에서는 다른 아이가 한 기록", ())

        client, headers = env.client, env.headers
        path = f"{V2}/children/{target}/journal"
        assert client.get(path, headers=headers).json()["items"] == []
        assert client.post(path + "/weekly/draft", headers=env.headers_b, json={"week_of": "2026-11-06"}).status_code == 404
        job = start(env, path)
        result = job["result"]
        entry, = result["entries"]
        assert (result["week_start"], result["week_end"], result["source_dates"]) == ("2026-11-02", "2026-11-08", 3)
        assert entry["area"] == "자연탐구" and "블록을 크기별로" in entry["evidence"]
        question, = result["questions"]
        assert question["date"] == "2026-11-08"
        assert client.get(path, headers=headers).json()["items"] == []
        initial = path + "/weekly/" + job["job_id"]
        assert client.post(initial + "/answers", headers=headers, json={"answers": {"1": "없는 질문"}}).status_code == 422
        assert client.post(initial + "/confirm", headers=headers, json={"entries": {"1": "질문은 아직 초안이 아님"}}).status_code == 422
        assert client.post(initial + "/confirm", headers=env.headers_b, json={"entries": {"0": "무단 저장"}}).status_code == 404
        other = f"{V2}/children/{peer}/journal/weekly/{job['job_id']}/confirm"
        assert client.post(other, headers=headers, json={"entries": {"0": "다른 아이에 저장"}}).status_code == 404

        # Confirm the grounded scene and leave the unresolved question alone.
        first = {"entries": {"0": "큰 블록과 작은 블록을 나눠 놓음."}}
        assert client.post(initial + "/confirm", headers=headers, json=first).json() == {"saved_dates": ["2026-11-06"]}
        assert client.post(initial + "/confirm", headers=headers, json=first).json() == {"saved_dates": ["2026-11-06"]}
        assert len(client.get(path, headers=headers).json()["days"]) == 1

        # A later answer adds the other date without overwriting the first edit.
        answer = {"answers": {"0": '종이를 가리키며 "나도 그릴래"라고 말했어요.'}}
        followup = client.post(initial + "/answers", headers=headers, json=answer).json()
        assert followup["status"] == "completed", followup
        assert followup["result"]["questions"] == []
        first_scene, confirmed_scene = followup["result"]["entries"]
        assert first_scene["saved"] and confirmed_scene["teacher_answer"] == answer["answers"]["0"]
        confirm_path = path + "/weekly/" + followup["job_id"] + "/confirm"
        assert client.post(confirm_path, headers=headers, json={"entries": {"0": "중복"}}).status_code == 409
        assert client.post(confirm_path, headers=headers, json={"entries": {"1": confirmed_scene["content"]}}).json() == {
            "saved_dates": ["2026-11-08"],
        }
        days = client.get(path, headers=headers).json()["days"]
        assert [(day["observed_date"], day["areas"]) for day in days] == [
            ("2026-11-06", ["자연탐구"]), ("2026-11-08", ["의사소통"]),
        ]
        assert days[0]["content"] == first["entries"]["0"]
        assert client.get(f"{V2}/journal/archive", headers=headers).json()[0]["content"] == days[0]["content"]
        exported = client.get(path + "/export", headers=headers)
        assert all(day["content"] in exported.text for day in days)
        assert len(env.app.state.ai_client.calls_for(AITask.WEEKLY_JOURNAL)) == 2


def test_notice_and_recording_capture_feed_week_without_automatic_diary(tmp_path):
    with running_env(tmp_path) as env:
        child, = add_children(env, ["가상아동가"])
        headers, client = env.headers, env.client
        journal = f"{V2}/children/{child}/journal"
        no_records = start(env, journal)
        assert no_records["result"]["source_dates"] == 0
        assert not env.app.state.ai_client.calls

        day = open_session(env, "2026-11-04")
        fill(env, day, "가상아동가", "그림책을 펴고 등장한 동물의 이름을 말했어요.", (), place="교실", time_text="오전")
        sid = day["session_id"]
        result = post(env, f"{V2}/sessions/{sid}/generate?manual_areas=true")
        assert result["status"] == "completed", result
        notice, = get_session(env, sid)["notices"]
        assert client.get(journal, headers=headers).json()["items"] == []
        assert post(env, f"{V2}/notices/{notice['notice_id']}/confirm?sync_journal=false",
                    {"expected_version": notice["version"]})["journal_job"] is None

        stt = FixtureTranscriber()
        stt.texts["weekly-audio"] = "가상아동가가 또래에게 그림책을 건네고 같이 보자고 말했어요."
        env.app.state.services.recording_drafts.transcripts.client = stt
        day = open_session(env, "2026-11-06")
        audio = seed_audio(env, "weekly-audio")
        assert post(env, path_for(day), {"recording_ids": [audio], "prepare_journals": False})["run"] is None
        assert client.get(journal, headers=headers).json()["items"] == []
        assert not any(call.task in (AITask.AREAS, AITask.JOURNAL_COMMON, AITask.JOURNAL_INDIVIDUAL)
                       for call in env.app.state.ai_client.calls)

        job = start(env, journal)
        entries = job["result"]["entries"]
        assert [item["date"] for item in entries] == ["2026-11-04", "2026-11-06"]
        assert "그림책을 건네고" in entries[1]["evidence"]
        assert stt.calls == ["weekly-audio"]


def test_weekly_save_can_add_another_scene_on_a_date_with_existing_entries(tmp_path):
    def choose(request):
        source, = request.payload["sources"]
        return {
            "entries": [pick(source, quote, area, quote) for quote, area in zip(
                source["text"].splitlines(), ["자연탐구", "의사소통"],
            )],
            "questions": [],
        }

    with running_env(tmp_path, ai_handlers={AITask.WEEKLY_JOURNAL: choose}) as env:
        child, = add_children(env, ["가상아동가"])
        client, headers = env.client, env.headers
        path = f"{V2}/children/{child}/journal"
        date = "2026-11-06"
        session = open_session(env, date)
        fill(env, session, "가상아동가", "블록을 크기별로 나눔.\n친구에게 더 달라고 말함.", ())
        manual = "점토를 손으로 눌러 무늬를 만듦."
        assert client.post(path, headers=headers, json={"observed_date": date, "content": manual, "areas": ["예술경험"]}).is_success
        job = start(env, path)
        first = path + "/weekly/" + job["job_id"] + "/confirm"
        assert client.post(first, headers=headers, json={"entries": {"0": "큰 블록과 작은 블록을 나눔."}}).is_success
        job = start(env, path)
        assert [entry["saved"] for entry in job["result"]["entries"]] == [True, False]
        second = path + "/weekly/" + job["job_id"] + "/confirm"
        assert client.post(second, headers=headers, json={"entries": {"1": "또래에게 블록을 더 달라고 말함."}}).is_success
        saved, = client.get(path, headers=headers).json()["days"]
        assert saved["content"] == manual + "\n\n큰 블록과 작은 블록을 나눔.\n\n또래에게 블록을 더 달라고 말함."
        assert saved["areas"] == ["의사소통", "예술경험", "자연탐구"]
