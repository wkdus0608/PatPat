"""B3: writing sessions and input blocks (fictional teachers and children only)."""
from tests.flow_helpers import V2, add_children, block_of, get_session, open_session, running_env


def test_opening_a_session_creates_a_common_block_and_one_block_per_child(tmp_path):
    with running_env(tmp_path) as env:
        add_children(env, ["다온", "이든", "서윤"])
        created = env.client.post(f"{V2}/sessions", headers=env.headers, json={"target_date": "2026-11-06"})
        assert created.status_code == 201, created.text
        session = created.json()
        assert session["status"] == "writing"
        assert session["target_date"] == "2026-11-06"
        assert session["classroom"]["name"] == "우리 반"
        assert [block["child_name"] for block in session["blocks"]] == [None, "다온", "이든", "서윤"]
        assert session["blocks"][0]["is_common"] is True
        assert all(not block["filled"] and block["areas"] == [] and not block["absent"] for block in session["blocks"])
        assert session["flags"] == [] and session["notices"] == [] and session["job"] is None
        assert session["common_outdated"] is False

        again = env.client.post(f"{V2}/sessions", headers=env.headers, json={"target_date": "2026-11-06"})
        assert again.status_code == 200
        assert again.json()["session_id"] == session["session_id"]
        other_day = open_session(env, "2026-11-07")
        assert other_day["session_id"] != session["session_id"]


def test_children_added_later_get_a_block_and_removed_children_disappear(tmp_path):
    with running_env(tmp_path) as env:
        add_children(env, ["다온"])
        session = open_session(env)
        assert len(session["blocks"]) == 2
        later = add_children(env, ["지안"])[0]
        refreshed = get_session(env, session["session_id"])
        assert [block["child_name"] for block in refreshed["blocks"]] == [None, "다온", "지안"]
        assert env.client.delete(f"{V2}/children/{later}", headers=env.headers).status_code == 204
        assert [block["child_name"] for block in get_session(env, session["session_id"])["blocks"]] == [None, "다온"]


def test_children_of_another_classroom_are_not_in_this_classrooms_session(tmp_path):
    with running_env(tmp_path) as env:
        first, second = add_children(env, ["다온", "이든"])
        default_room = env.client.get(f"{V2}/classrooms", headers=env.headers).json()["items"]
        assert [room["name"] for room in default_room] == ["우리 반"]  # the first classroom is the default one
        room_b = env.client.post(f"{V2}/classrooms", headers=env.headers, json={"name": "해바라기반", "age_label": "만 3세"})
        assert room_b.status_code == 201
        moved = env.client.patch(f"{V2}/children/{second}/details", headers=env.headers,
                                 json={"classroom_id": room_b.json()["classroom_id"]})
        assert moved.status_code == 200, moved.text
        default_names = [b["child_name"] for b in open_session(env)["blocks"]]
        assert default_names == [None, "다온"]
        room_session = open_session(env, classroom_id=room_b.json()["classroom_id"])
        assert [b["child_name"] for b in room_session["blocks"]] == [None, "이든"]
        assert room_session["classroom"]["age_band"] == "3-5세"


def test_block_edit_keeps_only_sent_fields_and_orders_areas(tmp_path):
    with running_env(tmp_path) as env:
        add_children(env, ["다온"])
        session = open_session(env)
        block = block_of(session, "다온")
        url = f"{V2}/sessions/{session['session_id']}/blocks/{block['block_id']}"
        first = env.client.patch(url, headers=env.headers, json={
            "text": "낙엽을 모았어요.", "areas": ["자연탐구", "신체운동·건강"], "place": "바깥놀이터", "time_text": "10:30~11:00"})
        assert first.status_code == 200, first.text
        body = first.json()
        assert body["areas"] == ["신체운동·건강", "자연탐구"]  # canonical order, not request order
        assert body["filled"] is True and body["place"] == "바깥놀이터"

        only_text = env.client.patch(url, headers=env.headers, json={"text": "낙엽을 주웠어요."}).json()
        assert only_text["areas"] == ["신체운동·건강", "자연탐구"] and only_text["time_text"] == "10:30~11:00"
        cleared = env.client.patch(url, headers=env.headers, json={"place": None}).json()
        assert cleared["place"] is None and cleared["text"] == "낙엽을 주웠어요."
        assert env.client.patch(url, headers=env.headers, json={"text": "   "}).json()["filled"] is False


def test_block_edit_rejects_bad_input(tmp_path):
    with running_env(tmp_path) as env:
        add_children(env, ["다온"])
        session = open_session(env)
        common, child = block_of(session, None), block_of(session, "다온")
        base = f"{V2}/sessions/{session['session_id']}/blocks/"
        assert env.client.patch(base + child["block_id"], headers=env.headers, json={"areas": ["수학"]}).status_code == 422
        assert env.client.patch(base + child["block_id"], headers=env.headers, json={"unknown": 1}).status_code == 422
        assert env.client.patch(base + child["block_id"], headers=env.headers, json={"text": None}).status_code == 422
        assert env.client.patch(base + child["block_id"], headers=env.headers, json={"absent": None}).status_code == 422
        assert env.client.patch(base + common["block_id"], headers=env.headers, json={"absent": True}).status_code == 422
        assert env.client.patch(base + child["block_id"], headers=env.headers, json={"text": "가" * 5001}).status_code == 422
        assert env.client.patch(base + "missing", headers=env.headers, json={"text": "a"}).status_code == 404
        absent = env.client.patch(base + child["block_id"], headers=env.headers, json={"absent": True})
        assert absent.status_code == 200 and absent.json()["absent"] is True


def test_sessions_are_private_to_their_teacher(tmp_path):
    with running_env(tmp_path) as env:
        add_children(env, ["다온"])
        session = open_session(env)
        block = block_of(session, "다온")
        url = f"{V2}/sessions/{session['session_id']}"
        assert env.client.get(url, headers=env.headers_b).status_code == 404
        assert env.client.patch(f"{url}/blocks/{block['block_id']}", headers=env.headers_b, json={"text": "x"}).status_code == 404
        assert env.client.post(f"{url}/generate", headers=env.headers_b).status_code == 404
        assert env.client.get(url).status_code == 401
        b_session = open_session(env, headers=env.headers_b)
        assert [b["child_name"] for b in b_session["blocks"]] == [None]  # teacher B has no children
        foreign_room = env.client.post(f"{V2}/sessions", headers=env.headers_b,
                                       json={"target_date": "2026-11-06", "classroom_id": session["classroom"]["classroom_id"]})
        assert foreign_room.status_code == 404


def test_blocks_cannot_be_edited_while_the_ai_is_working(tmp_path):
    with running_env(tmp_path) as env:
        add_children(env, ["다온"])
        session = open_session(env)
        block = block_of(session, "다온")
        env.app.state.services.sessions.set_status(session["session_id"], "analyzing")
        busy = env.client.patch(f"{V2}/sessions/{session['session_id']}/blocks/{block['block_id']}",
                                headers=env.headers, json={"text": "x"})
        assert busy.status_code == 409 and busy.json()["error"]["code"] == "SESSION_BUSY"
        env.app.state.services.sessions.set_status(session["session_id"], "failed")
        assert env.client.patch(f"{V2}/sessions/{session['session_id']}/blocks/{block['block_id']}",
                                headers=env.headers, json={"text": "x"}).status_code == 200


def test_area_suggestion_is_a_preview_and_needs_text(tmp_path):
    with running_env(tmp_path) as env:
        add_children(env, ["다온"])
        session = open_session(env)
        block = block_of(session, "다온")
        url = f"{V2}/sessions/{session['session_id']}/blocks/{block['block_id']}/suggest-areas"
        assert env.client.post(url, headers=env.headers).status_code == 422
        env.client.patch(f"{V2}/sessions/{session['session_id']}/blocks/{block['block_id']}", headers=env.headers,
                         json={"text": "낙엽을 모으며 친구와 이야기했어요."})
        suggestion = env.client.post(url, headers=env.headers)
        assert suggestion.status_code == 200, suggestion.text
        assert set(suggestion.json()["areas"]) <= {"신체운동·건강", "의사소통", "사회관계", "예술경험", "자연탐구"}
        assert suggestion.json()["areas"]  # the fake finds 낙엽, 이야기, 친구
        assert get_session(env, session["session_id"])["blocks"][1]["areas"] == []  # nothing was saved


def test_area_suggestion_never_sends_another_childs_name(tmp_path):
    from app.ai.types import AITask

    with running_env(tmp_path) as env:
        add_children(env, ["다온", "하린"])
        session = open_session(env)
        url = f"{V2}/sessions/{session['session_id']}/blocks"
        child, common = block_of(session, "다온"), block_of(session, None)
        env.client.patch(f"{url}/{child['block_id']}", headers=env.headers, json={"text": "다온이는 하린이와 낙엽을 모았어요."})
        env.client.patch(f"{url}/{common['block_id']}", headers=env.headers, json={"text": "다온이와 하린이가 함께 놀았어요."})
        for block in (child, common):
            assert env.client.post(f"{url}/{block['block_id']}/suggest-areas", headers=env.headers).status_code == 200
        first, second = env.app.state.ai_client.calls_for(AITask.AREAS)
        assert "하린" not in first.user_text and "다온" in first.user_text  # its own child's name is fine
        assert "하린" not in second.user_text and "다온" not in second.user_text  # the shared note names nobody


def test_ai_features_answer_503_without_a_key_but_the_rest_still_works(tmp_path):
    with running_env(tmp_path, ai_provider="anthropic", anthropic_api_key="") as env:
        add_children(env, ["다온"])
        session = open_session(env)
        block = block_of(session, "다온")
        url = f"{V2}/sessions/{session['session_id']}"
        env.client.patch(f"{url}/blocks/{block['block_id']}", headers=env.headers, json={"text": "낙엽을 모았어요."})
        response = env.client.post(f"{url}/blocks/{block['block_id']}/suggest-areas", headers=env.headers)
        assert response.status_code == 503 and response.json()["error"]["code"] == "AI_NOT_CONFIGURED"
        assert "sk-" not in response.text
