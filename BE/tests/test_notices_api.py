"""B5: notice list, versioned edits, confirm, history, and AI revision candidates (fictional data only)."""
from app.ai.fake import DEFAULT_HANDLERS
from app.ai.types import AITask, AIUnavailable
from app.core.timeutil import new_id, now_iso
from tests.flow_helpers import V2, add_children, fill, get_session, open_session, running_env

NAMES = ["다온", "이든", "서윤"]


def drafted_class(env, date="2026-11-06", ids=None):
    ids = ids or dict(zip(NAMES, add_children(env, NAMES)))
    session = open_session(env, date)
    fill(env, session, None, "바깥놀이터에서 낙엽을 모았어요.", ("자연탐구",))
    fill(env, session, "다온", "다온이는 낙엽을 두 손 가득 모았어요.", ("자연탐구",))
    fill(env, session, "이든", "이든이는 미끄럼틀을 여러 번 탔어요.", ("신체운동·건강",))
    job = env.client.post(f"{V2}/sessions/{session['session_id']}/generate", headers=env.headers)
    assert job.status_code == 202 and job.json()["status"] == "completed", job.text
    notices = {n["child_name"]: n for n in get_session(env, session["session_id"])["notices"]}
    return ids, session, notices


def get_notice(env, notice_id, headers=None):
    response = env.client.get(f"{V2}/notices/{notice_id}", headers=headers or env.headers)
    assert response.status_code == 200, response.text
    return response.json()


def patch(env, notice_id, text, version, headers=None):
    return env.client.patch(f"{V2}/notices/{notice_id}", headers=headers or env.headers,
                            json={"edited_text": text, "expected_version": version})


def confirm(env, notice_id, version, headers=None):
    return env.client.post(f"{V2}/notices/{notice_id}/confirm", headers=headers or env.headers,
                           json={"expected_version": version})


def test_a_fresh_draft_has_the_fields_the_screen_needs(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = drafted_class(env)
        notice = get_notice(env, notices["다온"]["notice_id"])
        assert notice["status"] == "검토중" and notice["version"] == 1
        assert notice["text"] == notice["generated_text"] and notice["edit_ratio"] == 0.0
        assert notice["can_share"] is False and notice["share_text"] is None and notice["busy"] is False
        assert notice["child_name"] == "다온" and notice["target_date"] == "2026-11-06"
        assert notice["session_id"] == session["session_id"] and notice["confirmed_at"] is None
        assert notice["rules_hash"] and notice["model"] == "fake"


def test_listing_filters_by_child_period_and_status(tmp_path):
    with running_env(tmp_path) as env:
        ids, day1, notices1 = drafted_class(env, "2026-11-05")
        _, day2, notices2 = drafted_class(env, "2026-11-06", ids)
        everything = env.client.get(f"{V2}/notices", headers=env.headers).json()["items"]
        assert [(n["target_date"], n["child_name"]) for n in everything] == [
            ("2026-11-06", "다온"), ("2026-11-06", "이든"), ("2026-11-06", "서윤"),
            ("2026-11-05", "다온"), ("2026-11-05", "이든"), ("2026-11-05", "서윤"),
        ]
        one_child = env.client.get(f"{V2}/notices?child_id={ids['다온']}", headers=env.headers).json()["items"]
        assert [n["target_date"] for n in one_child] == ["2026-11-06", "2026-11-05"]
        recent = env.client.get(f"{V2}/notices?date_from=2026-11-06", headers=env.headers).json()["items"]
        assert {n["target_date"] for n in recent} == {"2026-11-06"}
        old = env.client.get(f"{V2}/notices?date_to=2026-11-05&child_id={ids['이든']}", headers=env.headers).json()["items"]
        assert [n["target_date"] for n in old] == ["2026-11-05"]
        confirm(env, notices1["다온"]["notice_id"], 1)
        done = env.client.get(f"{V2}/notices?status=완료", headers=env.headers).json()["items"]
        assert [n["notice_id"] for n in done] == [notices1["다온"]["notice_id"]]
        page = env.client.get(f"{V2}/notices?limit=2&offset=1", headers=env.headers).json()["items"]
        assert len(page) == 2 and page[0]["notice_id"] == everything[1]["notice_id"]
        assert env.client.get(f"{V2}/notices?limit=0", headers=env.headers).status_code == 422
        assert env.client.get(f"{V2}/notices?status=끝", headers=env.headers).status_code == 422
        assert env.client.get(f"{V2}/notices", headers=env.headers_b).json()["items"] == []


def test_manual_edit_makes_a_new_version_and_stale_edits_are_refused(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = drafted_class(env)
        notice_id = notices["다온"]["notice_id"]
        edited = patch(env, notice_id, "다온이는 낙엽을 두 손 가득 모아 자랑했어요.\r\n", 1)
        assert edited.status_code == 200, edited.text
        body = edited.json()
        assert body["version"] == 2 and body["status"] == "검토중"
        assert body["text"] == "다온이는 낙엽을 두 손 가득 모아 자랑했어요."  # trimmed, newlines normalised
        assert body["generated_text"] != body["text"] and 0 < body["edit_ratio"] <= 1
        stale = patch(env, notice_id, "다른 화면에서 고친 글", 1)
        assert stale.status_code == 409 and stale.json()["error"]["code"] == "VERSION_CONFLICT"
        assert stale.json()["error"]["details"]["current_version"] == 2
        assert get_notice(env, notice_id)["text"] == body["text"]  # the stale edit changed nothing
        same = patch(env, notice_id, body["text"], 2)
        assert same.status_code == 200 and same.json()["version"] == 2  # no change, no new version
        history = env.client.get(f"{V2}/notices/{notice_id}/history", headers=env.headers).json()["items"]
        assert [(h["version"], h["kind"]) for h in history] == [(1, "generated"), (2, "manual_edit")]
        assert history[0]["text"] == body["generated_text"] and history[1]["text"] == body["text"]


def test_edit_rejects_empty_text_and_unknown_fields(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = drafted_class(env)
        notice_id = notices["다온"]["notice_id"]
        assert patch(env, notice_id, "", 1).status_code == 422
        blank = patch(env, notice_id, "  \n ", 1)
        assert blank.status_code == 422 and blank.json()["error"]["code"] == "EMPTY_TEXT"
        assert patch(env, notice_id, "가" * 6001, 1).status_code == 422
        assert patch(env, notice_id, "글", 0).status_code == 422
        assert env.client.patch(f"{V2}/notices/{notice_id}", headers=env.headers,
                                json={"edited_text": "글", "expected_version": 1, "status": "완료"}).status_code == 422
        assert get_notice(env, notice_id)["version"] == 1


def test_confirm_keeps_the_text_without_calling_the_ai(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = drafted_class(env)
        notice_id = notices["다온"]["notice_id"]
        patch(env, notice_id, "다온이는 낙엽을 모았어요.", 1)
        calls_before = len(env.app.state.ai_client.calls)
        confirmed = confirm(env, notice_id, 2)
        assert confirmed.status_code == 200, confirmed.text
        notice = confirmed.json()["notice"]
        assert notice["status"] == "완료" and notice["version"] == 3 and notice["text"] == "다온이는 낙엽을 모았어요."
        assert notice["can_share"] is True and notice["share_text"] == notice["text"] and notice["confirmed_at"]
        after = env.app.state.ai_client.calls[calls_before:]
        # confirming never rewrites the notice; the only calls after it write observation-journal rows
        assert after and {call.task for call in after} <= {AITask.JOURNAL_COMMON, AITask.JOURNAL_INDIVIDUAL}
        again = confirm(env, notice_id, 2)  # a retry of the same request
        assert again.status_code == 200 and again.json()["notice"]["version"] == 3 and again.json()["journal_job"] is None
        assert confirm(env, notice_id, 1).status_code == 409
        history = env.client.get(f"{V2}/notices/{notice_id}/history", headers=env.headers).json()["items"]
        assert [h["kind"] for h in history] == ["generated", "manual_edit", "confirm"]


def test_editing_a_confirmed_notice_reopens_it(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = drafted_class(env)
        notice_id = notices["이든"]["notice_id"]
        confirm(env, notice_id, 1)
        reopened = patch(env, notice_id, "이든이는 미끄럼틀을 타고 또 타고 싶어 했어요.", 2).json()
        assert reopened["status"] == "검토중" and reopened["version"] == 3
        assert reopened["can_share"] is False and reopened["share_text"] is None and reopened["confirmed_at"] is None
        assert confirm(env, notice_id, 3).json()["notice"]["version"] == 4


def test_two_screens_cannot_overwrite_each_other(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = drafted_class(env)
        notice_id = notices["다온"]["notice_id"]
        first = patch(env, notice_id, "화면 1에서 고친 글", 1)
        second = patch(env, notice_id, "화면 2에서 고친 글", 1)
        assert first.status_code == 200 and second.status_code == 409
        assert get_notice(env, notice_id)["text"] == "화면 1에서 고친 글"
        assert confirm(env, notice_id, 1).status_code == 409


def test_notices_are_private_to_their_teacher(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = drafted_class(env)
        notice_id = notices["다온"]["notice_id"]
        for response in (
            env.client.get(f"{V2}/notices/{notice_id}", headers=env.headers_b),
            patch(env, notice_id, "x", 1, headers=env.headers_b),
            confirm(env, notice_id, 1, headers=env.headers_b),
            env.client.get(f"{V2}/notices/{notice_id}/history", headers=env.headers_b),
            env.client.post(f"{V2}/notices/{notice_id}/revisions", headers=env.headers_b, json={"instruction": "x", "base_version": 1}),
        ):
            assert response.status_code == 404, response.text
        assert env.client.get(f"{V2}/notices/{notice_id}").status_code == 401
        assert get_notice(env, notice_id)["version"] == 1


def test_a_notice_being_rewritten_cannot_be_edited_or_confirmed(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = drafted_class(env)
        notice_id = notices["다온"]["notice_id"]
        with env.app.state.database.connect() as connection:
            connection.execute("INSERT INTO jobs(job_id, teacher_id, kind, ref_id, status, created_at) VALUES (?,?,?,?,?,?)",
                               (new_id(), env.teacher_id, "regenerate_child", f"{session['session_id']}:{ids['다온']}", "running", now_iso()))
        assert get_notice(env, notice_id)["busy"] is True
        for response in (
            patch(env, notice_id, "x", 1),
            confirm(env, notice_id, 1),
            env.client.post(f"{V2}/notices/{notice_id}/revisions", headers=env.headers, json={"instruction": "x", "base_version": 1}),
        ):
            assert response.status_code == 409 and response.json()["error"]["code"] == "NOTICE_BUSY", response.text


def test_ai_revision_is_a_candidate_until_the_teacher_adopts_it(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = drafted_class(env)
        notice_id = notices["다온"]["notice_id"]
        original = get_notice(env, notice_id)["text"]
        requested = env.client.post(f"{V2}/notices/{notice_id}/revisions", headers=env.headers,
                                    json={"instruction": "조금 더 부드럽게", "base_version": 1})
        assert requested.status_code == 202, requested.text
        revision = requested.json()
        assert revision["status"] == "completed" and revision["base_version"] == 1 and revision["job_id"]
        assert "조금 더 부드럽게" in revision["candidate_text"] and revision["adopted_at"] is None
        assert get_notice(env, notice_id)["text"] == original  # asking does not change the notice
        fetched = env.client.get(f"{V2}/notices/{notice_id}/revisions/{revision['revision_id']}", headers=env.headers).json()
        assert fetched["candidate_text"] == revision["candidate_text"]

        adopted = env.client.post(f"{V2}/notices/{notice_id}/revisions/{revision['revision_id']}/adopt",
                                  headers=env.headers, json={"expected_version": 1})
        assert adopted.status_code == 200, adopted.text
        assert adopted.json()["version"] == 2 and adopted.json()["text"] == revision["candidate_text"]
        history = env.client.get(f"{V2}/notices/{notice_id}/history", headers=env.headers).json()["items"]
        assert (history[-1]["kind"], history[-1]["revision_id"]) == ("adopt_revision", revision["revision_id"])
        again = env.client.post(f"{V2}/notices/{notice_id}/revisions/{revision['revision_id']}/adopt",
                                headers=env.headers, json={"expected_version": 2})
        assert again.status_code == 409 and again.json()["error"]["code"] == "ALREADY_ADOPTED"
        assert env.client.get(f"{V2}/jobs/{revision['job_id']}", headers=env.headers).json()["status"] == "completed"


def test_a_revision_cannot_be_adopted_after_the_text_changed(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = drafted_class(env)
        notice_id = notices["다온"]["notice_id"]
        wrong_base = env.client.post(f"{V2}/notices/{notice_id}/revisions", headers=env.headers,
                                     json={"instruction": "짧게", "base_version": 5})
        assert wrong_base.status_code == 409 and wrong_base.json()["error"]["code"] == "VERSION_CONFLICT"
        revision = env.client.post(f"{V2}/notices/{notice_id}/revisions", headers=env.headers,
                                   json={"instruction": "짧게", "base_version": 1}).json()
        patch(env, notice_id, "내가 직접 고친 글", 1)
        stale = env.client.post(f"{V2}/notices/{notice_id}/revisions/{revision['revision_id']}/adopt",
                                headers=env.headers, json={"expected_version": 2})
        assert stale.status_code == 409 and stale.json()["error"]["code"] == "VERSION_CONFLICT"
        assert get_notice(env, notice_id)["text"] == "내가 직접 고친 글"
        missing = env.client.post(f"{V2}/notices/{notice_id}/revisions/{new_id()}/adopt", headers=env.headers, json={"expected_version": 2})
        assert missing.status_code == 404
        assert env.client.get(f"{V2}/notices/{notice_id}/revisions/{new_id()}", headers=env.headers).status_code == 404


def test_a_failed_revision_changes_nothing_and_cannot_be_adopted(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = drafted_class(env)
        notice_id = notices["다온"]["notice_id"]

        def down(_request):
            raise AIUnavailable("AI 서비스에 연결할 수 없습니다.")

        env.app.state.ai_client.handlers[AITask.REVISE] = down
        revision = env.client.post(f"{V2}/notices/{notice_id}/revisions", headers=env.headers,
                                   json={"instruction": "짧게", "base_version": 1}).json()
        assert revision["status"] == "failed" and revision["error_code"] == "AI_UNAVAILABLE" and revision["candidate_text"] is None
        blocked = env.client.post(f"{V2}/notices/{notice_id}/revisions/{revision['revision_id']}/adopt",
                                  headers=env.headers, json={"expected_version": 1})
        assert blocked.status_code == 409 and blocked.json()["error"]["code"] == "REVISION_NOT_READY"
        assert get_notice(env, notice_id)["version"] == 1
        env.app.state.ai_client.handlers[AITask.REVISE] = DEFAULT_HANDLERS[AITask.REVISE]
        assert env.client.post(f"{V2}/notices/{notice_id}/revisions", headers=env.headers,
                               json={"instruction": "짧게", "base_version": 1}).json()["status"] == "completed"


def test_revision_prompt_keeps_other_childrens_names_out_and_checks_the_result(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = drafted_class(env)
        notice_id = notices["다온"]["notice_id"]

        def eager(request):
            return {"text": request.payload["current_text"] + " 서윤이와 신나게 놀았어요."}

        env.app.state.ai_client.handlers[AITask.REVISE] = eager
        revision = env.client.post(f"{V2}/notices/{notice_id}/revisions", headers=env.headers,
                                   json={"instruction": "서윤이랑 같이 놀았다고 써줘", "base_version": 1}).json()
        call = env.app.state.ai_client.calls_for(AITask.REVISE)[0]
        assert "서윤" not in call.user_text and "이든" not in call.user_text
        assert "서윤" not in revision["candidate_text"] and "친구와 신나게" in revision["candidate_text"]
        assert {(w["code"], w["word"]) for w in revision["warnings"]} == {("UNSUPPORTED_FEELING", "신나")}


def test_revision_without_an_ai_key_answers_503_while_editing_still_works(tmp_path):
    with running_env(tmp_path, ai_provider="anthropic", anthropic_api_key="") as env:
        add_children(env, ["다온"])
        session = open_session(env)
        child_id = next(b["child_id"] for b in session["blocks"] if b["child_name"] == "다온")
        notice = env.app.state.services.notices.save_generated(
            teacher_id=env.teacher_id, session_id=session["session_id"], child_id=child_id, target_date="2026-11-06",
            text="다온이는 낙엽을 모았어요.", needs_check=False, incident=False, warnings=[], rules_hash="x", model="fake")
        response = env.client.post(f"{V2}/notices/{notice['notice_id']}/revisions", headers=env.headers,
                                   json={"instruction": "짧게", "base_version": 1})
        assert response.status_code == 503 and response.json()["error"]["code"] == "AI_NOT_CONFIGURED"
        assert patch(env, notice["notice_id"], "직접 고친 글", 1).status_code == 200  # editing and confirming need no AI
        assert confirm(env, notice["notice_id"], 2).status_code == 200


def test_edit_ratio_grows_with_the_amount_of_change(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = drafted_class(env)
        notice_id = notices["다온"]["notice_id"]
        text = get_notice(env, notice_id)["text"]
        small = patch(env, notice_id, text + " 좋았어요.", 1).json()["edit_ratio"]
        large = patch(env, notice_id, "완전히 새로 쓴 아주 다른 글입니다. 낙엽 이야기는 없어요.", 2).json()["edit_ratio"]
        assert 0 < small < large <= 1
