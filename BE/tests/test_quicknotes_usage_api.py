"""B7: quick notes and AI usage (fictional data only)."""
from app.core.timeutil import new_id, now_iso
from tests.flow_helpers import V2, add_children, block_of, fill, get_session, open_session, running_env


def note(env, text="낙엽을 모았어요.", date="2026-11-06", headers=None, **extra):
    return env.client.post(f"{V2}/quick-notes", headers=headers or env.headers,
                           json={"note_date": date, "text": text, **extra})


def add_recording(env, teacher_id=None):
    recording_id = new_id()
    with env.app.state.database.connect() as connection:
        connection.execute(
            "INSERT INTO recordings(recording_id, teacher_id, title, recorded_at, duration_seconds, size_bytes, content_type, "
            "status, created_at, deleted, upload_key, digest) VALUES (?,?,?,?,?,?,?,?,?,0,?,?)",
            (recording_id, teacher_id or env.teacher_id, "녹음", now_iso(), 3.0, 10, "audio/mp4", "ready", now_iso(), None, "d"),
        )
    return recording_id


def test_quick_notes_can_be_added_listed_and_filtered(tmp_path):
    with running_env(tmp_path) as env:
        ids = add_children(env, ["다온", "이든"])
        first = note(env, "  다온이가 낙엽을 모았어요.  ", child_id=ids[0])
        assert first.status_code == 201, first.text
        body = first.json()
        assert body["text"] == "다온이가 낙엽을 모았어요." and body["child_name"] == "다온" and body["imported_session_id"] is None
        note(env, "바깥놀이를 했어요.")
        note(env, "다른 날 메모", date="2026-11-05", child_id=ids[1])
        everything = env.client.get(f"{V2}/quick-notes", headers=env.headers).json()["items"]
        assert [n["note_date"] for n in everything] == ["2026-11-06", "2026-11-06", "2026-11-05"]
        today = env.client.get(f"{V2}/quick-notes?note_date=2026-11-06", headers=env.headers).json()["items"]
        assert [n["text"] for n in today] == ["다온이가 낙엽을 모았어요.", "바깥놀이를 했어요."]  # in the order they were jotted
        only = env.client.get(f"{V2}/quick-notes?child_id={ids[1]}", headers=env.headers).json()["items"]
        assert [n["text"] for n in only] == ["다른 날 메모"]
        assert env.client.get(f"{V2}/quick-notes?imported=true", headers=env.headers).json()["items"] == []
        assert env.client.get(f"{V2}/quick-notes", headers=env.headers_b).json()["items"] == []
        assert env.client.get(f"{V2}/quick-notes").status_code == 401


def test_quick_note_validation_and_links(tmp_path):
    with running_env(tmp_path) as env:
        ids = add_children(env, ["다온"])
        other_child = add_children(env, ["서윤"], headers=env.headers_b)[0]
        assert note(env, "").status_code == 422
        assert note(env, "가" * 2001).status_code == 422
        blank = note(env, "   ")
        assert blank.status_code == 422 and blank.json()["error"]["code"] == "EMPTY_TEXT"
        assert env.client.get(f"{V2}/quick-notes", headers=env.headers).json()["items"] == []
        assert env.client.post(f"{V2}/quick-notes", headers=env.headers, json={"text": "a"}).status_code == 422
        assert env.client.post(f"{V2}/quick-notes", headers=env.headers, json={"note_date": "2026-11-06", "text": "a", "x": 1}).status_code == 422
        assert note(env, child_id=other_child).status_code == 404  # another teacher's child
        assert note(env, recording_id=new_id()).status_code == 404
        mine = add_recording(env)
        theirs = add_recording(env, env.teacher_b_id)
        assert note(env, recording_id=mine).json()["recording_id"] == mine
        assert note(env, recording_id=theirs).status_code == 404
        assert note(env, child_id=ids[0], recording_id=mine).status_code == 201


def test_quick_notes_can_be_changed_until_they_are_imported(tmp_path):
    with running_env(tmp_path) as env:
        ids = add_children(env, ["다온", "이든"])
        created = note(env, "처음 메모", child_id=ids[0]).json()
        url = f"{V2}/quick-notes/{created['note_id']}"
        assert env.client.patch(url, headers=env.headers, json={}).status_code == 422
        assert env.client.patch(url, headers=env.headers, json={"text": None}).status_code == 422
        assert env.client.patch(url, headers=env.headers, json={"text": "  "}).status_code == 422
        assert env.client.patch(url, headers=env.headers, json={"child_id": new_id()}).status_code == 404
        assert env.client.patch(url, headers=env.headers_b, json={"text": "x"}).status_code == 404
        changed = env.client.patch(url, headers=env.headers, json={"text": "고친 메모", "child_id": ids[1]}).json()
        assert changed["text"] == "고친 메모" and changed["child_name"] == "이든"
        whole_class = env.client.patch(url, headers=env.headers, json={"child_id": None}).json()
        assert whole_class["child_id"] is None and whole_class["child_name"] is None and whole_class["text"] == "고친 메모"
        session = open_session(env)
        assert env.client.post(f"{V2}/sessions/{session['session_id']}/quick-notes/import", headers=env.headers).status_code == 200
        locked = env.client.patch(url, headers=env.headers, json={"text": "늦은 수정"})
        assert locked.status_code == 409 and locked.json()["error"]["code"] == "ALREADY_IMPORTED"


def test_deleting_a_note_is_idempotent_and_private(tmp_path):
    with running_env(tmp_path) as env:
        created = note(env).json()
        url = f"{V2}/quick-notes/{created['note_id']}"
        assert env.client.delete(url, headers=env.headers_b).status_code == 204  # not theirs: nothing happens
        assert len(env.client.get(f"{V2}/quick-notes", headers=env.headers).json()["items"]) == 1
        assert env.client.delete(url, headers=env.headers).status_code == 204
        assert env.client.delete(url, headers=env.headers).status_code == 204
        assert env.client.get(f"{V2}/quick-notes", headers=env.headers).json()["items"] == []


def test_importing_adds_the_days_notes_to_the_right_blocks_once(tmp_path):
    with running_env(tmp_path) as env:
        ids = add_children(env, ["다온", "이든"])
        note(env, "바깥놀이터에 다녀왔어요.")
        note(env, "다온이가 낙엽을 모았어요.", child_id=ids[0])
        note(env, "다온이가 낙엽을 세었어요.", child_id=ids[0])
        note(env, "어제 메모", date="2026-11-05", child_id=ids[1])
        session = open_session(env)
        fill(env, session, "이든", "이든이는 그네를 탔어요.", ("신체운동·건강",))
        imported = env.client.post(f"{V2}/sessions/{session['session_id']}/quick-notes/import", headers=env.headers)
        assert imported.status_code == 200, imported.text
        assert [n["text"] for n in imported.json()["imported"]] == [
            "바깥놀이터에 다녀왔어요.", "다온이가 낙엽을 모았어요.", "다온이가 낙엽을 세었어요."]
        assert imported.json()["skipped"] == []
        state = get_session(env, session["session_id"])
        assert block_of(state, None)["text"] == "바깥놀이터에 다녀왔어요."
        assert block_of(state, "다온")["text"] == "다온이가 낙엽을 모았어요.\n다온이가 낙엽을 세었어요."
        assert block_of(state, "이든")["text"] == "이든이는 그네를 탔어요."  # the other day's note was not brought in
        again = env.client.post(f"{V2}/sessions/{session['session_id']}/quick-notes/import", headers=env.headers).json()
        assert again == {"imported": [], "skipped": []}
        assert get_session(env, session["session_id"])["blocks"] == state["blocks"]
        assert {n["imported_session_id"] for n in env.client.get(f"{V2}/quick-notes?imported=true", headers=env.headers).json()["items"]} == {session["session_id"]}
        # a later note for the same day can be brought in afterwards and is added below the text already there
        note(env, "다온이가 낙엽을 친구에게 주었어요.", child_id=ids[0])
        env.client.post(f"{V2}/sessions/{session['session_id']}/quick-notes/import", headers=env.headers)
        assert block_of(get_session(env, session["session_id"]), "다온")["text"].endswith("\n다온이가 낙엽을 친구에게 주었어요.")


def test_import_skips_children_of_other_classrooms_and_respects_the_session_state(tmp_path):
    with running_env(tmp_path) as env:
        first, second = add_children(env, ["다온", "이든"])
        env.client.get(f"{V2}/classrooms", headers=env.headers)  # creates the default classroom first
        room = env.client.post(f"{V2}/classrooms", headers=env.headers, json={"name": "해바라기반", "age_label": "만 3세"}).json()
        env.client.patch(f"{V2}/children/{second}/details", headers=env.headers, json={"classroom_id": room["classroom_id"]})
        kept = note(env, "다온 메모", child_id=first).json()
        away = note(env, "이든 메모", child_id=second).json()
        session = open_session(env)
        result = env.client.post(f"{V2}/sessions/{session['session_id']}/quick-notes/import", headers=env.headers).json()
        assert [n["note_id"] for n in result["imported"]] == [kept["note_id"]]
        assert result["skipped"] == [{"note_id": away["note_id"], "reason": "CHILD_NOT_IN_CLASS"}]
        other_room_session = open_session(env, classroom_id=room["classroom_id"])
        moved = env.client.post(f"{V2}/sessions/{other_room_session['session_id']}/quick-notes/import", headers=env.headers).json()
        assert [n["note_id"] for n in moved["imported"]] == [away["note_id"]]  # picked up by the class it belongs to
        env.app.state.services.sessions.set_status(session["session_id"], "asking")
        busy = env.client.post(f"{V2}/sessions/{session['session_id']}/quick-notes/import", headers=env.headers)
        assert busy.status_code == 409 and busy.json()["error"]["code"] == "SESSION_BUSY"
        assert env.client.post(f"{V2}/sessions/{session['session_id']}/quick-notes/import", headers=env.headers_b).status_code == 404


def test_usage_counts_calls_tokens_and_cache_reuse(tmp_path):
    with running_env(tmp_path) as env:
        ids = add_children(env, ["다온", "이든"])
        session = open_session(env)
        fill(env, session, None, "바깥놀이터에서 놀았어요.", ("자연탐구",))
        fill(env, session, "다온", "다온이는 낙엽을 모았어요.", ("자연탐구",))
        fill(env, session, "이든", "이든이는 그네를 탔어요.", ("신체운동·건강",))
        env.client.post(f"{V2}/sessions/{session['session_id']}/generate", headers=env.headers)
        usage = env.client.get(f"{V2}/usage/ai", headers=env.headers).json()
        assert usage["totals"]["calls"] == 4 and usage["totals"]["errors"] == 0
        assert [row["task"] for row in usage["by_task"]] == ["review", "common", "individual"]
        assert {row["task"]: row["calls"] for row in usage["by_task"]} == {"review": 1, "common": 1, "individual": 2}
        assert usage["models"] == ["fake"] and len(usage["rules_hashes"]) == 1
        assert usage["totals"]["input_tokens"] > 0 and usage["totals"]["output_tokens"] > 0
        assert usage["totals"]["cache_hit_ratio"] == 0.0  # the fake never reads a cache

        with env.app.state.database.connect() as connection:  # what a real, cache-hitting run records
            connection.execute("DELETE FROM ai_calls")
            for index, (created, read, write) in enumerate([("2026-11-05T09:00:00+00:00", 0, 9000), ("2026-11-06T09:00:00+00:00", 9000, 0)]):
                connection.execute(
                    "INSERT INTO ai_calls(call_id, teacher_id, session_id, task, model, rules_hash, status, input_tokens, "
                    "cache_creation_input_tokens, cache_read_input_tokens, output_tokens, latency_ms, created_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (f"c{index}", env.teacher_id, None, "review", "claude-opus-5-5", "h1", "ok", 1000, write, read, 500, 2000 + index * 1000, created))
        full = env.client.get(f"{V2}/usage/ai", headers=env.headers).json()
        assert full["totals"]["cache_hit_ratio"] == round(9000 / 20000, 3) and full["totals"]["avg_latency_ms"] == 2500
        one_day = env.client.get(f"{V2}/usage/ai?date_from=2026-11-06&date_to=2026-11-06", headers=env.headers).json()
        assert one_day["totals"]["calls"] == 1 and one_day["totals"]["cache_hit_ratio"] == round(9000 / 10000, 3)
        assert one_day["date_from"] == "2026-11-06"
        empty = env.client.get(f"{V2}/usage/ai", headers=env.headers_b).json()
        assert empty["totals"]["calls"] == 0 and empty["totals"]["cache_hit_ratio"] is None and empty["by_task"] == []
        assert env.client.get(f"{V2}/usage/ai?date_from=bad", headers=env.headers).status_code == 422
        assert env.client.get(f"{V2}/usage/ai").status_code == 401
