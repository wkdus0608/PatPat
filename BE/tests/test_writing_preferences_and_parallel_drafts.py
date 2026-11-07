from app.ai.types import AITask
from tests.flow_helpers import V2, add_children, block_of, fill, get_session, open_session, running_env


def test_saved_places_and_times_belong_to_the_current_teacher(tmp_path):
    with running_env(tmp_path) as env:
        path = f"{V2}/teacher/writing-preferences"
        response = env.client.put(path, headers=env.headers, json={
            "places": [" 유희실 ", "바깥놀이터", "유희실"], "times": ["오전 자유놀이"],
        })
        assert response.status_code == 200
        saved = {"places": ["유희실", "바깥놀이터"], "times": ["오전 자유놀이"]}
        assert response.json() == saved
        assert env.client.get(path, headers=env.headers).json() == saved
        assert env.client.get(path, headers=env.headers_b).json() == {"places": [], "times": []}


def test_confirmed_metadata_fills_only_blanks_and_both_drafts_use_the_observation(tmp_path):
    def notice(_request):
        return {"text": "보호자에게 전하는 별도 문장입니다."}

    with running_env(tmp_path, ai_handlers={AITask.COMMON: notice, AITask.INDIVIDUAL: notice}) as env:
        first, second = add_children(env, ["다온", "이든"])
        session = open_session(env)
        sid = session["session_id"]
        fill(env, session, None, "오전 10시에 유희실에서 클레이 놀이를 했어요.", (), place="우리 교실")
        fill(env, session, "다온", "클레이를 눌러 그림을 만들었어요.", ("예술경험",), place="바깥놀이터")
        fill(env, session, "이든", "손으로 클레이를 눌렀어요.", ("예술경험",))

        response = env.client.post(f"{V2}/sessions/{sid}/generate?prepare_journals=true", headers=env.headers)
        assert response.status_code == 202 and response.json()["result"]["phase"] == "asking"
        flags = get_session(env, sid)["flags"]
        assert [(flag["kind"], flag["child_ids"], flag["options"]) for flag in flags] == [
            ("time_text", [], ["오전 10시"]),
        ]
        assert block_of(get_session(env, sid), None)["time_text"] is None
        response = env.client.post(f"{V2}/sessions/{sid}/answers", headers=env.headers, json={
            "answers": [{"flag_id": flags[0]["flag_id"], "answer": "오전 10시"}],
        })
        assert response.status_code == 202 and response.json()["result"]["phase"] == "reviewing"
        journal = f"{V2}/children/{first}/journal"
        rows = env.client.get(journal, headers=env.headers).json()["items"]
        own = rows[-1]
        other = env.client.get(f"{V2}/children/{second}/journal", headers=env.headers).json()["items"][-1]
        assert own["is_draft"] and own["areas"] == ["예술경험"]
        assert (own["place"], own["time_text"]) == ("바깥놀이터", "오전 10시")
        assert (other["place"], other["time_text"]) == ("우리 교실", "오전 10시")
        assert "그림을 만들었어요" in own["content"] and "보호자에게" not in own["content"]
        assert env.client.get(journal + "/export", headers=env.headers).headers["X-Exported-Count"] == "0"

        first_notice = next(item for item in get_session(env, sid)["notices"] if item["child_id"] == first)
        path = f"{V2}/notices/{first_notice['notice_id']}"
        confirmed = env.client.post(path + "/confirm", headers=env.headers, json={"expected_version": first_notice["version"]})
        assert confirmed.status_code == 200 and confirmed.json()["journal_job"] is None
        assert not env.client.get(journal, headers=env.headers).json()["items"][-1]["is_draft"]
        output = env.client.get(journal + "/export?from=2026-11-06&to=2026-11-06", headers=env.headers)
        assert output.headers["X-Exported-Count"] == "2"
        assert output.text.index("관찰영역: 예술경험") < output.text.index("그림을 만들었어요")
        assert env.client.get(journal + "/export?from=2026-11-07", headers=env.headers).headers["X-Exported-Count"] == "0"
