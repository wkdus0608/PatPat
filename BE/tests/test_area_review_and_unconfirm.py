from app.ai.types import AITask
from tests.flow_helpers import V2, add_children, block_of, fill, get_session, open_session, running_env


def test_area_review_asks_only_for_missing_areas_and_accepts_a_skip(tmp_path):
    with running_env(tmp_path) as env:
        selected, missing, skipped = add_children(env, ["다온", "이든", "서윤"])
        session = open_session(env)
        sid = session["session_id"]
        fill(env, session, "다온", "낙엽을 모았어요.", ("자연탐구",))
        fill(env, session, "이든", "그림을 그렸어요.", ())
        fill(env, session, "서윤", "바깥에서 놀이했어요.", ())
        response = env.client.post(f"{V2}/sessions/{sid}/generate?ask_missing_areas=true", headers=env.headers)
        assert response.status_code == 202 and response.json()["result"]["phase"] == "asking"
        flags = get_session(env, sid)["flags"]
        assert [(flag["kind"], flag["child_ids"]) for flag in flags] == [("area", [missing]), ("area", [skipped])]
        assert flags[0]["options"] == ["예술경험"]
        assert len(env.app.state.ai_client.calls_for(AITask.AREAS)) == 2
        response = env.client.post(f"{V2}/sessions/{sid}/answers", headers=env.headers, json={
            "answers": [
                {"flag_id": flags[0]["flag_id"], "areas": ["예술경험"]},
                {"flag_id": flags[1]["flag_id"], "areas": []},
            ],
        })
        assert response.status_code == 202 and response.json()["result"]["phase"] == "reviewing"
        result = get_session(env, sid)
        assert block_of(result, "다온")["areas"] == ["자연탐구"]
        assert block_of(result, "이든")["areas"] == ["예술경험"]
        assert block_of(result, "서윤")["areas"] == []
        assert {item["child_id"] for item in result["notices"]} == {selected, missing, skipped}


def test_manual_areas_accept_blanks_without_suggestions_and_keep_context_review(tmp_path):
    with running_env(tmp_path) as env:
        selected, blank = add_children(env, ["다온", "이든"])
        session = open_session(env)
        sid = session["session_id"]
        fill(env, session, None, "오전 10시에 유희실에서 블록을 쌓았어요.", (), place="유희실")
        fill(env, session, "다온", "나무 블록을 여러 개 쌓았어요.", ("자연탐구",))
        fill(env, session, "이든", "블록을 나란히 두었어요.", ())
        response = env.client.post(f"{V2}/sessions/{sid}/generate?manual_areas=true&prepare_journals=true", headers=env.headers)
        assert response.status_code == 202 and response.json()["result"]["phase"] == "asking"
        flags = get_session(env, sid)["flags"]
        assert [(flag["kind"], flag["options"]) for flag in flags] == [("time_text", ["오전 10시"])]
        assert not env.app.state.ai_client.calls_for(AITask.AREAS)
        response = env.client.post(f"{V2}/sessions/{sid}/answers", headers=env.headers, json={
            "answers": [{"flag_id": flags[0]["flag_id"], "answer": "오전 10시"}],
        })
        assert response.status_code == 202 and response.json()["result"]["phase"] == "reviewing"
        result = get_session(env, sid)
        assert block_of(result, "다온")["areas"] == ["자연탐구"]
        assert block_of(result, "이든")["areas"] == []
        assert {item["child_id"] for item in result["notices"]} == {selected, blank}
        response = env.client.post(f"{V2}/sessions/{sid}/children/{blank}/regenerate", headers=env.headers)
        assert response.status_code == 202 and response.json()["status"] == "completed"
        journal = env.client.get(f"{V2}/children/{blank}/journal", headers=env.headers).json()
        assert journal["items"][-1]["areas"] == []
        assert not env.app.state.ai_client.calls_for(AITask.AREAS)


def test_unconfirm_hides_the_journal_and_reconfirm_keeps_the_teachers_edit(tmp_path):
    with running_env(tmp_path) as env:
        child = add_children(env, ["다온"])[0]
        session = open_session(env)
        sid = session["session_id"]
        fill(env, session, "다온", "낙엽을 모았어요.", ("자연탐구",))
        assert env.client.post(f"{V2}/sessions/{sid}/generate", headers=env.headers).status_code == 202
        notice = get_session(env, sid)["notices"][0]
        path = f"{V2}/notices/{notice['notice_id']}"
        journal = f"{V2}/children/{child}/journal"

        confirmed = env.client.post(path + "/confirm", headers=env.headers, json={"expected_version": 1}).json()["notice"]
        entry = env.client.get(journal, headers=env.headers).json()["items"][0]
        edited = env.client.patch(f"{V2}/journal-entries/{entry['entry_id']}", headers=env.headers, json={
            "expected_version": entry["version"], "content": "낙엽을 손으로 주워 모았음.",
        })
        assert edited.status_code == 200
        body = {"expected_version": confirmed["version"]}
        response = env.client.post(path + "/unconfirm", headers=env.headers, json=body)
        assert response.status_code == 200
        withdrawn = response.json()
        assert withdrawn["status"] == "검토중" and withdrawn["text"] == confirmed["text"]
        assert env.client.post(path + "/unconfirm", headers=env.headers, json=body).json() == withdrawn
        assert env.client.get(journal, headers=env.headers).json()["items"] == []
        assert env.client.get(journal + "/export", headers=env.headers).headers["X-Exported-Count"] == "0"
        assert env.client.get(path + "/history", headers=env.headers).json()["items"][-1]["kind"] == "unconfirm"

        assert env.client.post(path + "/confirm", headers=env.headers, json={
            "expected_version": withdrawn["version"],
        }).status_code == 200
        restored = env.client.get(journal, headers=env.headers).json()["items"]
        assert len(restored) == 1 and restored[0]["entry_id"] == entry["entry_id"]
        assert restored[0]["content"] == "낙엽을 손으로 주워 모았음."
