"""One whole evening, end to end, with the scripted stand-in for the AI (fictional children only)."""
from collections import Counter

from app.ai.types import AITask
from tests.flow_helpers import V2, add_children, block_of, fill, get_session, open_session, running_env

NAMES = ["다온", "이든", "서윤", "하린", "지안"]


def test_the_whole_evening_from_quick_notes_to_the_journal(tmp_path):
    with running_env(tmp_path) as env:
        client, auth = env.client, env.headers
        fake = env.app.state.ai_client

        # --- setup: class age, roster, traits, the teacher's own writing sample ---
        room = client.get(f"{V2}/classrooms", headers=auth).json()["items"][0]
        assert client.patch(f"{V2}/classrooms/{room['classroom_id']}", headers=auth, json={"age_label": "만 2세"}).json()["age_band"] == "2세"
        ids = dict(zip(NAMES, add_children(env, NAMES)))
        client.patch(f"{V2}/children/{ids['다온']}/details", headers=auth, json={"gender": "여", "birth_date": "2024-05-01"})
        client.put(f"{V2}/children/{ids['다온']}/characteristics", headers=auth, json={"text": "말이 느린 편이에요."})
        client.put(f"{V2}/teacher/documents/writing_examples", headers=auth, json={"text": "오늘은 낙엽 위를 걸어 보았답니다."})

        # --- during the day: two quick notes ---
        client.post(f"{V2}/quick-notes", headers=auth, json={"note_date": "2026-11-06", "text": "바깥놀이터에서 낙엽을 모았어요."})
        client.post(f"{V2}/quick-notes", headers=auth, json={"note_date": "2026-11-06", "child_id": ids["서윤"],
                                                              "text": "서윤이는 이든이가 밀어서 넘어졌어요."})

        # --- evening: open the day, bring the notes in, fill the blocks ---
        session = open_session(env)
        sid = session["session_id"]
        imported = client.post(f"{V2}/sessions/{sid}/quick-notes/import", headers=auth).json()
        assert len(imported["imported"]) == 2 and imported["skipped"] == []
        state = get_session(env, sid)
        assert block_of(state, None)["text"] == "바깥놀이터에서 낙엽을 모았어요."
        fill(env, state, None, "바깥놀이터에서 낙엽을 모았어요.", ("자연탐구",), place="바깥놀이터", time_text="10:30~11:00")
        fill(env, state, "다온", "다온이는 낙엽을 두 손 가득 모았어요. 하린이에게 보여 주고 싶어 했어요.", ("자연탐구", "의사소통"))
        fill(env, state, "이든", "이든이는 서윤이를 밀었어요.", ("사회관계",), place="미끄럼틀 앞")
        fill(env, state, "서윤", block_of(state, "서윤")["text"] + "\n서윤이는 선생님 손을 잡고 진정했어요.", ("사회관계",))
        assert client.patch(f"{V2}/sessions/{sid}/blocks/{block_of(state, '하린')['block_id']}", headers=auth, json={"absent": True}).status_code == 200
        suggested = client.post(f"{V2}/sessions/{sid}/blocks/{block_of(state, '다온')['block_id']}/suggest-areas", headers=auth).json()
        assert "자연탐구" in suggested["areas"]

        # --- one cross-check; the only question is about the incident ---
        job = client.post(f"{V2}/sessions/{sid}/generate", headers=auth).json()
        assert job["status"] == "completed" and job["result"] == {"phase": "asking", "questions": 1}
        asking = get_session(env, sid)
        assert asking["status"] == "asking" and asking["notices"] == []
        flag = asking["flags"][0]
        assert flag["kind"] == "incident" and sorted(flag["child_ids"]) == sorted([ids["이든"], ids["서윤"]])
        drafted = client.post(f"{V2}/sessions/{sid}/answers", headers=auth,
                              json={"answers": [{"flag_id": flag["flag_id"], "answer": "부드럽게"}]}).json()
        assert drafted["status"] == "completed" and drafted["result"]["drafted"] == 4 and drafted["result"]["failed"] == []

        reviewing = get_session(env, sid)
        notices = {n["child_name"]: n for n in reviewing["notices"]}
        assert reviewing["status"] == "reviewing" and set(notices) == {"다온", "이든", "서윤", "지안"}  # 하린 was absent
        assert notices["지안"]["needs_check"] is True and notices["이든"]["incident"] is True and notices["서윤"]["incident"] is True
        assert {n["status"] for n in notices.values()} == {"검토중"}

        # --- review: a manual edit, an AI revision that is adopted, and plain confirms ---
        daon = client.get(f"{V2}/notices/{notices['다온']['notice_id']}", headers=auth).json()
        edited = client.patch(f"{V2}/notices/{daon['notice_id']}", headers=auth,
                              json={"edited_text": daon["text"] + " 낙엽 모으기를 좋아해요.", "expected_version": 1}).json()
        assert edited["version"] == 2 and edited["edit_ratio"] > 0

        revision = client.post(f"{V2}/notices/{notices['이든']['notice_id']}/revisions", headers=auth,
                               json={"instruction": "조금 더 부드럽게", "base_version": 1}).json()
        assert revision["status"] == "completed"
        adopted = client.post(f"{V2}/notices/{notices['이든']['notice_id']}/revisions/{revision['revision_id']}/adopt",
                              headers=auth, json={"expected_version": 1}).json()
        assert adopted["version"] == 2

        versions = {"다온": 2, "이든": 2, "서윤": 1, "지안": 1}
        for name, version in versions.items():
            done = client.post(f"{V2}/notices/{notices[name]['notice_id']}/confirm", headers=auth, json={"expected_version": version})
            assert done.status_code == 200, done.text
            assert done.json()["notice"]["can_share"] is True and done.json()["journal_job"]["status"] == "completed"

        # --- the journal builds itself; the class paragraph is written once ---
        rows = {name: client.get(f"{V2}/children/{ids[name]}/journal", headers=auth).json() for name in NAMES}
        assert [e["block_kind"] for e in rows["다온"]["items"]] == ["common", "individual"]
        assert [e["block_kind"] for e in rows["지안"]["items"]] == ["common"]  # no input of their own
        assert rows["하린"]["items"] == []
        assert all(e["status"] == "ready" and not e["outdated"] for name in NAMES for e in rows[name]["items"])
        shared = {rows[name]["items"][0]["content"] for name in ("다온", "이든", "서윤", "지안")}
        assert len(shared) == 1
        own = rows["이든"]["items"][1]
        assert (own["place"], own["time_text"], own["areas"]) == ("미끄럼틀 앞", "10:30~11:00", ["사회관계"])
        task_counts = Counter(call.task for call in fake.calls)
        assert task_counts[AITask.JOURNAL_COMMON] == 1 and task_counts[AITask.JOURNAL_INDIVIDUAL] == 3

        export = client.get(f"{V2}/children/{ids['다온']}/journal/export", headers=auth)
        assert export.text.startswith("이름: 다온\n성별: 여\n생년월일: 2024-05-01\n") and export.headers["x-skipped-count"] == "0"
        assert "관찰장소: 바깥놀이터" in export.text and "관찰시간: 10:30~11:00" in export.text

        # --- the cost picture: one fixed rules block shared by every call ---
        assert task_counts == {
            AITask.REVIEW: 1, AITask.COMMON: 1, AITask.INDIVIDUAL: 3, AITask.REVISE: 1,
            AITask.JOURNAL_COMMON: 1, AITask.JOURNAL_INDIVIDUAL: 3, AITask.AREAS: 1,
        }
        assert len({call.system_text for call in fake.calls}) == 1
        assert fake.calls[0].task == AITask.AREAS and fake.calls_for(AITask.REVIEW)[0] is fake.calls[1]
        usage = client.get(f"{V2}/usage/ai", headers=auth).json()
        assert usage["totals"]["calls"] == len(fake.calls) == 11 and usage["totals"]["errors"] == 0
        assert {row["task"]: row["calls"] for row in usage["by_task"]} == {task.value: count for task, count in task_counts.items()}

        # --- privacy: no prompt for one child carries another child's name, and no text names another child ---
        for call in fake.calls:
            if call.task == AITask.REVIEW:
                continue  # the class-wide cross-check sees the whole class on purpose
            own_name = call.payload.get("name") or ("다온" if call.task == AITask.AREAS else None)
            leaked = [name for name in NAMES if name != own_name and name in call.user_text]
            assert not leaked, (call.task, own_name, leaked)
        for name in ("다온", "이든", "서윤", "지안"):
            text = client.get(f"{V2}/notices/{notices[name]['notice_id']}", headers=auth).json()["text"]
            assert not [other for other in NAMES if other != name and other in text], (name, text)
            for entry in rows[name]["items"]:
                assert not [other for other in NAMES if other != name and other in entry["content"]], (name, entry["content"])
        assert "하린" not in "".join(call.user_text for call in fake.calls if call.task != AITask.REVIEW)

        # --- next day: the same class, yesterday's notices are passed on to avoid repeating ---
        tomorrow = open_session(env, "2026-11-07")
        fill(env, tomorrow, "다온", "다온이는 그네를 탔어요.", ("신체운동·건강",))
        assert client.post(f"{V2}/sessions/{tomorrow['session_id']}/generate", headers=auth).json()["status"] == "completed"
        last = fake.calls_for(AITask.INDIVIDUAL)[-1]
        assert last.payload["recent_notices"] and "낙엽" in last.payload["recent_notices"][0]
        assert len(client.get(f"{V2}/notices?child_id={ids['다온']}", headers=auth).json()["items"]) == 2


def test_the_v2_api_documents_itself_and_requires_a_login(tmp_path):
    with running_env(tmp_path) as env:
        spec = env.client.get("/api/v2/openapi.json").json()
        assert spec["info"]["title"].endswith("(v2)")
        operations = [(path, method, op) for path, item in spec["paths"].items() for method, op in item.items()]
        assert len(operations) >= 35
        for path, method, operation in operations:
            assert operation.get("summary"), (method, path)
            assert operation.get("security"), (method, path)  # every endpoint needs the teacher's bearer token
            assert "401" in operation["responses"], (method, path)
        no_login = [(m.upper(), p) for p, m, op in operations if m != "post" or "/sessions" in p]
        assert no_login
        for method, path in [("GET", "/sessions/x"), ("POST", "/sessions/x/generate"), ("GET", "/notices"),
                             ("GET", "/children/x/journal"), ("GET", "/jobs/x"), ("GET", "/usage/ai"), ("GET", "/quick-notes"),
                             ("GET", "/classrooms"), ("GET", "/teacher/documents/writing_examples")]:
            assert env.client.request(method, f"/api/v2{path}").status_code == 401, (method, path)
        # the v1 API and its documentation are untouched
        assert "/api/v1/auth/login" in env.client.get("/openapi.json").json()["paths"]
        assert not any(path.startswith("/api/v2") for path in env.client.get("/openapi.json").json()["paths"])
