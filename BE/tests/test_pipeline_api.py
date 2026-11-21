"""B4: cross-check, questions, and per-child drafting (fictional teachers and children only)."""
import json
import time

import pytest

from app.ai import observations
from app.ai.fake import _review as fake_review
from app.ai.schemas import INCIDENT_NOTICE_SCHEMA
from app.ai.types import AITask, AIUnavailable
from app.pipeline.service import mode_and_answers
from app.core.timeutil import new_id, now_iso
from tests.flow_helpers import V2, add_children, block_of, fill, get_session, open_session, running_env

NAMES = ["다온", "이든", "서윤", "하린", "지안"]


def ask_about_the_pair(request):
    """검토가 이든·서윤에 관한 직접 입력 질문을 만든 것으로 꾸민다(사건사고 질문은 더 하지 않는다)."""
    data = fake_review(request)
    data["flags"] = [{"kind": "missing_fact", "child_ids": data["incident_child_ids"],
                      "question": "이든과 서윤 사이에 있었던 일을 알려 주세요.", "options": []}]
    return data


def class_of_five(env):
    ids = dict(zip(NAMES, add_children(env, NAMES)))
    return ids, open_session(env)


def set_absent(env, session, name):
    block = block_of(session, name)
    response = env.client.patch(f"{V2}/sessions/{session['session_id']}/blocks/{block['block_id']}",
                                headers=env.headers, json={"absent": True})
    assert response.status_code == 200, response.text


def generate(env, session_id, expect=202):
    response = env.client.post(f"{V2}/sessions/{session_id}/generate", headers=env.headers)
    assert response.status_code == expect, response.text
    return response.json()


def answer(env, session_id, body, expect=202):
    response = env.client.post(f"{V2}/sessions/{session_id}/answers", headers=env.headers, json=body)
    assert response.status_code == expect, response.text
    return response.json()


def notice_of(env, session_id, child_id):
    return env.app.state.services.notices.get_by_session_child(session_id, child_id)


def call_counts(env):
    with env.app.state.database.connect() as connection:
        rows = connection.execute("SELECT task, status, COUNT(*) AS n FROM ai_calls GROUP BY task, status").fetchall()
    return {(row["task"], row["status"]): row["n"] for row in rows}


def play_day(env, session):
    """Common block, three children with input, one absent, one empty."""
    fill(env, session, None, "바깥놀이터에서 낙엽을 모았어요.", ("자연탐구",), place="바깥놀이터", time_text="10:30")
    fill(env, session, "다온", "다온이는 낙엽을 두 손 가득 모았어요.", ("자연탐구",))
    fill(env, session, "이든", "이든이는 미끄럼틀을 여러 번 탔어요.", ("신체운동·건강",))
    fill(env, session, "서윤", "서윤이는 친구에게 낙엽을 나눠 주었어요.", ("사회관계",))
    set_absent(env, session, "하린")


def test_generate_drafts_each_present_child_and_logs_every_call(tmp_path):
    with running_env(tmp_path) as env:
        ids, session = class_of_five(env)
        play_day(env, session)
        job = generate(env, session["session_id"])
        assert job["status"] == "completed" and job["result"]["phase"] == "reviewing"
        assert job["result"]["drafted"] == 4 and job["result"]["failed"] == []

        state = get_session(env, session["session_id"])
        assert state["status"] == "reviewing" and state["flags"] == []
        by_name = {notice["child_name"]: notice for notice in state["notices"]}
        assert set(by_name) == {"다온", "이든", "서윤", "지안"}  # 하린 was absent
        assert all(n["status"] == "검토중" and n["version"] == 1 and not n["busy"] for n in by_name.values())
        assert by_name["지안"]["needs_check"] is True and by_name["다온"]["needs_check"] is False

        common_text = notice_of(env, session["session_id"], ids["지안"])["edited_text"]
        assert common_text.startswith("[테스트 문장]") and "낙엽을 모았어요" in common_text
        assert "\n\n" not in common_text  # 지안 only gets the shared paragraph
        daon = notice_of(env, session["session_id"], ids["다온"])["edited_text"]
        shared, own = daon.split("\n\n")
        assert shared == common_text and "다온" in own and "낙엽을 두 손 가득" in own
        assert notice_of(env, session["session_id"], ids["하린"]) is None

        # one cross-check, one common paragraph, one call per child with their own input
        assert call_counts(env) == {("review", "ok"): 1, ("common", "ok"): 1, ("individual", "ok"): 3}
        fake = env.app.state.ai_client
        assert len(fake.calls_for(AITask.REVIEW)) == 1 and len(fake.calls_for(AITask.COMMON)) == 1
        assert len({call.system_text for call in fake.calls}) == 1  # the same fixed rules block every time (cacheable)
        assert state["job"]["status"] == "completed"


def test_a_prompt_for_one_child_never_carries_another_childs_name(tmp_path):
    with running_env(tmp_path) as env:
        ids, session = class_of_five(env)
        fill(env, session, None, "다온이와 이든이가 같이 낙엽을 모았어요.", ("자연탐구",))
        fill(env, session, "다온", "다온이는 하린이랑 같이 그림을 그렸어요.", ("예술경험",),
             )
        fill(env, session, "이든", "이든이는 서윤이를 밀었어요.", ("사회관계",))
        fill(env, session, "서윤", "서윤이는 이든이가 밀어서 넘어졌어요.", ("사회관계",))
        set_absent(env, session, "하린")
        assert generate(env, session["session_id"])["result"]["phase"] == "reviewing"  # 사건사고도 묻지 않고 바로 쓴다
        assert get_session(env, session["session_id"])["flags"] == []

        fake = env.app.state.ai_client
        assert len(fake.calls_for(AITask.INDIVIDUAL)) == 3
        for call in fake.calls_for(AITask.INDIVIDUAL):
            own = call.payload["name"]
            for other in NAMES:
                if other != own:
                    assert other not in call.user_text, (own, other)
                    assert other not in json.dumps(call.payload, ensure_ascii=False), (own, other)
        common_call = fake.calls_for(AITask.COMMON)[0]
        assert not any(name in common_call.user_text for name in NAMES)
        for name in ("다온", "이든", "서윤"):
            text = notice_of(env, session["session_id"], ids[name])["edited_text"]
            assert not any(other in text for other in NAMES if other != name), (name, text)


def test_incident_children_are_written_softly_without_asking_the_teacher(tmp_path):
    with running_env(tmp_path) as env:
        ids, session = class_of_five(env)
        fill(env, session, "다온", "다온이는 낙엽을 모았어요.", ("자연탐구",))
        fill(env, session, "이든", "이든이는 서윤이를 밀었어요.", ("사회관계",))
        fill(env, session, "서윤", "서윤이는 이든이가 밀어서 넘어졌어요.", ("사회관계",))
        job = generate(env, session["session_id"])
        assert job["result"]["phase"] == "reviewing" and get_session(env, session["session_id"])["flags"] == []

        modes = {call.payload["name"]: call.payload["mode"] for call in env.app.state.ai_client.calls_for(AITask.INDIVIDUAL)}
        assert modes == {"다온": "normal", "이든": "incident_soft", "서윤": "incident_soft"}
        state = get_session(env, session["session_id"])
        marks = {n["child_name"]: n["incident"] for n in state["notices"]}
        assert marks == {"다온": False, "이든": True, "서윤": True}
        # each child's prompt carries what the other wrote, with names replaced
        joint = {call.payload["name"]: call.payload["joint_facts"] for call in env.app.state.ai_client.calls_for(AITask.INDIVIDUAL)}
        assert joint["이든"] and "친구" in joint["이든"][0] and joint["다온"] == []


def test_injury_draft_places_confirmed_details_in_special_section(tmp_path):
    daily = "종이에 그림을 그렸어요."
    injury = "미끄럼틀 계단에서 넘어져 오른쪽 무릎이 까졌어요. 물로 씻고 밴드를 붙였어요."

    def write_incident(request):
        assert request.schema == INCIDENT_NOTICE_SCHEMA
        return {"text": daily, "special_notes": injury, "missing_injury_details": []}

    with running_env(tmp_path, ai_handlers={AITask.INDIVIDUAL: write_incident}) as env:
        child_id, = add_children(env, ["평가아동가"])
        session = open_session(env)
        sid = session["session_id"]
        fill(env, session, "평가아동가", f"{daily} {injury}")
        generate(env, sid)

        notice = notice_of(env, sid, child_id)
        assert notice["incident"]
        response = env.client.get(f"{V2}/notices/{notice['notice_id']}", headers=env.headers)
        assert response.status_code == 200, response.text
        assert response.json()["text"] == f"{daily}\n\n특이사항\n{injury}"


def test_missing_injury_details_are_shown_and_do_not_become_journal_evidence(tmp_path):
    with running_env(tmp_path) as env:
        child_id, = add_children(env, ["평가아동가"])
        session = open_session(env)
        sid = session["session_id"]
        fill(env, session, "평가아동가", "바깥놀이 중 다쳤다.")
        generate(env, sid)

        notice = notice_of(env, sid, child_id)
        assert notice["edited_text"].splitlines() == [
            "특이사항", "[테스트 문장] 평가아동가: 바깥놀이 중 다쳤다. (사건사고 구성)", "부위 확인 필요", "처치 확인 필요",
        ]

        confirmation = env.client.post(f"{V2}/notices/{notice['notice_id']}/confirm", headers=env.headers,
                                       json={"expected_version": notice["version"]})
        assert confirmation.status_code == 200, confirmation.text
        assert notice_of(env, sid, child_id)["edited_text"] == notice["edited_text"]
        journal_call, = env.app.state.ai_client.calls_for(AITask.JOURNAL_INDIVIDUAL)
        assert "바깥놀이 중 다쳤다." in journal_call.payload["text"]
        assert "확인 필요" not in journal_call.payload["text"]
        assert "특이사항" not in journal_call.payload["text"]


@pytest.mark.parametrize("side_answer", [None, "오른쪽 팔꿈치"])
def test_same_injury_keeps_the_shared_fact_until_the_teacher_confirms_the_side(tmp_path, side_answer):
    with running_env(tmp_path) as env:
        child_id, = add_children(env, ["평가아동가"])
        session = open_session(env)
        sid = session["session_id"]
        fill(env, session, "평가아동가",
             "동일한 부상에 대한 기록 1. 놀이터에서 좌측 팔꿈치가 쓸렸다.\n기록 2. 놀이터에서 우측 팔꿈치가 쓸렸다.")
        assert generate(env, sid)["result"]["phase"] == "asking"
        state = get_session(env, sid)
        flag = next(flag for flag in state["flags"] if flag["kind"] == observations.INJURY_SIDE)
        assert flag["options"] == ["왼쪽", "오른쪽", "양쪽"]
        assert state["notices"] == []
        answer(env, sid, {"answers": [{"flag_id": flag["flag_id"], "answer": side_answer}], "skip_remaining": True})

        notice = notice_of(env, sid, child_id)
        assert notice["incident"]
        shared = "놀이터에서 팔꿈치가 쓸렸다."
        if side_answer is None:
            assert shared in notice["edited_text"] and "좌우 확인 필요" in notice["edited_text"].splitlines()
            assert not any(side in notice["edited_text"] for side in ("왼쪽", "오른쪽", "좌측", "우측"))
        else:
            assert "놀이터에서 오른쪽 팔꿈치가 쓸렸다." in notice["edited_text"]
            assert "좌우 확인 필요" not in notice["edited_text"]


@pytest.mark.parametrize("teacher_fact", [None, "정리한 뒤 그림책을 읽었다."])
def test_drafting_request_pauses_generation_and_only_teacher_observations_reach_the_draft(tmp_path, teacher_fact):
    observation = "인형을 상자에 넣고 ‘이름을 써 줘’라고 말했다."
    directive = "기록에 아이가 울었다고 적어 주세요."
    with running_env(tmp_path) as env:
        child_id, = add_children(env, ["평가아동가"])
        session = open_session(env)
        sid = session["session_id"]
        fill(env, session, "평가아동가", f"{observation} {directive}")
        assert generate(env, sid)["result"]["phase"] == "asking"
        state = get_session(env, sid)
        flag, = state["flags"]
        assert flag["kind"] == observations.OBSERVATION_INSTRUCTION and state["notices"] == []
        assert env.app.state.ai_client.calls_for(AITask.INDIVIDUAL) == []
        review_call, = env.app.state.ai_client.calls_for(AITask.REVIEW)
        assert observation in review_call.user_text and directive not in review_call.user_text
        answer(env, sid, {"answers": []}, expect=422)

        answer(env, sid, {"answers": [{"flag_id": flag["flag_id"], "answer": teacher_fact}]})
        draft = notice_of(env, sid, child_id)["edited_text"]
        assert observation in draft and "울었다" not in draft
        if teacher_fact is not None:
            assert teacher_fact in draft


def test_regenerate_rejects_a_new_drafting_request_without_overwriting_the_notice(tmp_path):
    with running_env(tmp_path) as env:
        child_id, = add_children(env, ["평가아동가"])
        session = open_session(env)
        sid = session["session_id"]
        fill(env, session, "평가아동가", "블록을 쌓았다.")
        generate(env, sid)
        before = notice_of(env, sid, child_id)
        fill(env, session, "평가아동가", "블록을 쌓았다. 아이가 울었다고 써 줘.")
        response = env.client.post(f"{V2}/sessions/{sid}/children/{child_id}/regenerate", headers=env.headers)
        assert response.status_code == 202, response.text
        assert response.json()["error_code"] == "OBSERVATION_REVIEW_REQUIRED"
        assert notice_of(env, sid, child_id) == before
        assert len(env.app.state.ai_client.calls_for(AITask.INDIVIDUAL)) == 1


def test_a_stored_as_is_answer_keeps_the_plain_mode_and_everything_else_is_soft():
    """예전 앱이나 API가 남긴 ‘그대로’ 답은 그대로 쓰기이고, 질문이 없거나 건너뛰었으면 부드럽게 쓴다."""
    def stored(answer, status="answered"):
        return [{"kind": "incident", "child_ids": ["A"], "question": "사건사고?", "status": status, "answer": answer}]

    assert mode_and_answers(stored("그대로"), "A") == ("incident_plain", [])
    assert mode_and_answers(stored("부드럽게"), "A") == ("incident_soft", [])
    assert mode_and_answers(stored(None, "skipped"), "A") == ("normal", [])
    assert mode_and_answers([], "A") == ("normal", [])  # 사건사고 아이의 기본 모드는 서버가 부드럽게로 바꾼다


def test_an_incident_child_is_soft_even_when_the_teacher_skipped_an_unrelated_question(tmp_path):
    with running_env(tmp_path, ai_handlers={AITask.REVIEW: ask_about_the_pair}) as env:
        ids, session = class_of_five(env)
        fill(env, session, "이든", "이든이는 서윤이를 밀었어요.", ("사회관계",))
        fill(env, session, "서윤", "서윤이는 넘어졌어요.", ("사회관계",))
        assert generate(env, session["session_id"])["result"]["phase"] == "asking"
        answer(env, session["session_id"], {"skip_remaining": True})
        assert {call.payload["mode"] for call in env.app.state.ai_client.calls_for(AITask.INDIVIDUAL)} == {"incident_soft"}
        state = get_session(env, session["session_id"])
        assert state["status"] == "reviewing" and state["flags"][0]["status"] == "skipped"


def test_a_free_text_answer_reaches_only_the_children_it_is_about_and_is_masked(tmp_path):
    with running_env(tmp_path, ai_handlers={AITask.REVIEW: ask_about_the_pair}) as env:
        ids, session = class_of_five(env)
        fill(env, session, "이든", "이든이는 서윤이를 밀었어요.", ("사회관계",))
        fill(env, session, "서윤", "서윤이는 넘어졌어요.", ("사회관계",))
        fill(env, session, "다온", "다온이는 그림을 그렸어요.", ("예술경험",))
        generate(env, session["session_id"])
        flag = get_session(env, session["session_id"])["flags"][0]
        answer(env, session["session_id"], {"answers": [{"flag_id": flag["flag_id"], "answer": "서윤이는 다치지 않았고 이든이가 먼저 사과했어요."}]})
        calls = {call.payload["name"]: call for call in env.app.state.ai_client.calls_for(AITask.INDIVIDUAL)}
        assert "친구" in calls["이든"].user_text and "서윤" not in calls["이든"].user_text
        assert "먼저 사과했어요" not in calls["다온"].user_text  # an answer about other children is not passed on


def test_answer_validation(tmp_path):
    with running_env(tmp_path, ai_handlers={AITask.REVIEW: ask_about_the_pair}) as env:
        ids, session = class_of_five(env)
        sid = session["session_id"]
        fill(env, session, "이든", "이든이는 서윤이를 밀었어요.", ("사회관계",))
        fill(env, session, "서윤", "서윤이는 넘어졌어요.", ("사회관계",))
        early = env.client.post(f"{V2}/sessions/{sid}/answers", headers=env.headers, json={"answers": []})
        assert early.status_code == 409 and early.json()["error"]["code"] == "NOT_ASKING"
        generate(env, sid)
        flag = get_session(env, sid)["flags"][0]
        incomplete = env.client.post(f"{V2}/sessions/{sid}/answers", headers=env.headers, json={"answers": []})
        assert incomplete.status_code == 422 and incomplete.json()["error"]["code"] == "ANSWERS_INCOMPLETE"
        unknown = env.client.post(f"{V2}/sessions/{sid}/answers", headers=env.headers,
                                  json={"answers": [{"flag_id": "nope", "answer": "그대로"}]})
        assert unknown.status_code == 422 and unknown.json()["error"]["code"] == "UNKNOWN_FLAG"
        assert env.client.post(f"{V2}/sessions/{sid}/answers", headers=env.headers,
                               json={"answers": [{"flag_id": flag["flag_id"], "answer": "가" * 501}]}).status_code == 422
        assert get_session(env, sid)["flags"][0]["status"] == "open"  # nothing was saved by the rejected requests
        assert get_session(env, sid)["status"] == "asking"


def test_editing_is_closed_while_asking_and_reopen_goes_back_to_writing(tmp_path):
    with running_env(tmp_path, ai_handlers={AITask.REVIEW: ask_about_the_pair}) as env:
        ids, session = class_of_five(env)
        sid = session["session_id"]
        fill(env, session, "이든", "이든이는 서윤이를 밀었어요.", ("사회관계",))
        fill(env, session, "서윤", "서윤이는 넘어졌어요.", ("사회관계",))
        assert env.client.post(f"{V2}/sessions/{sid}/reopen", headers=env.headers).status_code == 409
        generate(env, sid)
        block = block_of(get_session(env, sid), "이든")
        assert env.client.patch(f"{V2}/sessions/{sid}/blocks/{block['block_id']}", headers=env.headers,
                                json={"text": "x"}).status_code == 409
        assert generate(env, sid, expect=409) is not None  # cannot start twice
        reopened = env.client.post(f"{V2}/sessions/{sid}/reopen", headers=env.headers)
        assert reopened.status_code == 200 and reopened.json()["status"] == "writing" and reopened.json()["flags"] == []
        assert env.client.patch(f"{V2}/sessions/{sid}/blocks/{block['block_id']}", headers=env.headers,
                                json={"text": "이든이는 서윤이와 손을 잡았어요."}).status_code == 200
        other = block_of(get_session(env, sid), "서윤")
        assert env.client.patch(f"{V2}/sessions/{sid}/blocks/{other['block_id']}", headers=env.headers,
                                json={"text": "서윤이는 블록을 쌓았어요."}).status_code == 200
        assert generate(env, sid)["result"]["phase"] == "reviewing"  # no incident words any more


def test_generate_checks_the_input_first(tmp_path):
    with running_env(tmp_path) as env:
        ids, session = class_of_five(env)
        sid = session["session_id"]
        empty = env.client.post(f"{V2}/sessions/{sid}/generate", headers=env.headers)
        assert empty.status_code == 422 and empty.json()["error"]["code"] == "NOTHING_TO_WRITE"
        env.client.patch(f"{V2}/sessions/{sid}/blocks/{block_of(session, '다온')['block_id']}",
                         headers=env.headers, json={"text": "다온이는 낙엽을 모았어요."})
        no_area = env.client.post(f"{V2}/sessions/{sid}/generate", headers=env.headers)
        assert no_area.status_code == 422 and no_area.json()["error"]["code"] == "AREAS_REQUIRED"
        assert no_area.json()["error"]["details"]["block_ids"] == [block_of(session, "다온")["block_id"]]
        for name in NAMES:
            set_absent(env, session, name)
        none_present = env.client.post(f"{V2}/sessions/{sid}/generate", headers=env.headers)
        assert none_present.status_code == 422 and none_present.json()["error"]["code"] == "NO_CHILDREN"
        assert get_session(env, sid)["status"] == "writing"
        assert env.app.state.ai_client.calls == []  # nothing was sent to the AI


def test_without_an_ai_key_generate_answers_503_and_leaves_the_session_writable(tmp_path):
    with running_env(tmp_path, ai_provider="anthropic", anthropic_api_key="") as env:
        ids, session = class_of_five(env)
        fill(env, session, "다온", "다온이는 낙엽을 모았어요.", ("자연탐구",))
        blocked = env.client.post(f"{V2}/sessions/{session['session_id']}/generate", headers=env.headers)
        assert blocked.status_code == 503 and blocked.json()["error"]["code"] == "AI_NOT_CONFIGURED"
        assert get_session(env, session["session_id"])["status"] == "writing"


def test_a_failed_cross_check_fails_the_session_and_can_be_retried(tmp_path):
    with running_env(tmp_path) as env:
        ids, session = class_of_five(env)
        play_day(env, session)

        def down(_request):
            raise AIUnavailable("AI 서비스에 연결할 수 없습니다.")

        env.app.state.ai_client.handlers[AITask.REVIEW] = down
        job = generate(env, session["session_id"])
        assert job["status"] == "failed" and job["error_code"] == "AI_UNAVAILABLE"
        state = get_session(env, session["session_id"])
        assert state["status"] == "failed" and state["error_code"] == "AI_UNAVAILABLE" and state["notices"] == []
        assert call_counts(env)[("review", "error")] == 1

        from app.ai.fake import DEFAULT_HANDLERS
        env.app.state.ai_client.handlers[AITask.REVIEW] = DEFAULT_HANDLERS[AITask.REVIEW]
        block = block_of(state, "다온")  # input can still be corrected after a failure
        assert env.client.patch(f"{V2}/sessions/{session['session_id']}/blocks/{block['block_id']}",
                                headers=env.headers, json={"text": "다온이는 낙엽을 세어 봤어요."}).status_code == 200
        retry = generate(env, session["session_id"])
        assert retry["status"] == "completed"
        recovered = get_session(env, session["session_id"])
        assert recovered["status"] == "reviewing" and recovered["error_code"] is None and len(recovered["notices"]) == 4


def test_one_childs_failure_does_not_lose_the_others_and_can_be_retried_alone(tmp_path):
    with running_env(tmp_path) as env:
        ids, session = class_of_five(env)
        play_day(env, session)
        from app.ai.fake import DEFAULT_HANDLERS

        def flaky(request):
            if request.payload["name"] == "이든":
                raise AIUnavailable("AI 서비스에 연결할 수 없습니다.")
            return DEFAULT_HANDLERS[AITask.INDIVIDUAL](request)

        env.app.state.ai_client.handlers[AITask.INDIVIDUAL] = flaky
        job = generate(env, session["session_id"])
        assert job["status"] == "completed"
        assert job["result"]["drafted"] == 3
        assert job["result"]["failed"] == [{"child_id": ids["이든"], "error_code": "AI_UNAVAILABLE"}]
        state = get_session(env, session["session_id"])
        assert state["status"] == "reviewing" and {n["child_name"] for n in state["notices"]} == {"다온", "서윤", "지안"}

        env.app.state.ai_client.handlers[AITask.INDIVIDUAL] = DEFAULT_HANDLERS[AITask.INDIVIDUAL]
        retry = env.client.post(f"{V2}/sessions/{session['session_id']}/children/{ids['이든']}/regenerate", headers=env.headers)
        assert retry.status_code == 202 and retry.json()["status"] == "completed"
        created = notice_of(env, session["session_id"], ids["이든"])
        assert created["version"] == 1 and "미끄럼틀" in created["edited_text"]


def test_when_every_child_fails_the_session_fails(tmp_path):
    with running_env(tmp_path) as env:
        ids, session = class_of_five(env)
        play_day(env, session)

        def down(_request):
            raise AIUnavailable("AI 서비스에 연결할 수 없습니다.")

        env.app.state.ai_client.handlers[AITask.INDIVIDUAL] = down
        job = generate(env, session["session_id"])
        assert job["status"] == "failed" and job["error_code"] == "AI_UNAVAILABLE"
        state = get_session(env, session["session_id"])
        assert state["status"] == "failed" and state["notices"] == []


def test_regenerating_one_child_makes_a_new_version_and_keeps_the_old_one_in_the_history(tmp_path):
    with running_env(tmp_path) as env:
        ids, session = class_of_five(env)
        sid = session["session_id"]
        play_day(env, session)
        generate(env, sid)
        first = notice_of(env, sid, ids["이든"])
        fill(env, get_session(env, sid), "이든", "이든이는 미끄럼틀을 거꾸로 올라가 보았어요.", ("신체운동·건강",))
        url = f"{V2}/sessions/{sid}/children/{ids['이든']}/regenerate"
        again = env.client.post(url, headers=env.headers)
        assert again.status_code == 202 and again.json()["status"] == "completed"
        second = notice_of(env, sid, ids["이든"])
        assert second["notice_id"] == first["notice_id"] and second["version"] == 2
        assert "거꾸로" in second["edited_text"]
        history = env.app.state.services.notices.history(env.teacher_id, first["notice_id"])
        assert [(row["version"], row["kind"]) for row in history] == [(1, "generated"), (2, "regenerated")]
        assert "미끄럼틀을 여러 번" in history[0]["text"]
        # the other children were not touched
        assert notice_of(env, sid, ids["다온"])["version"] == 1


def test_regenerate_rules(tmp_path):
    with running_env(tmp_path) as env:
        ids, session = class_of_five(env)
        sid = session["session_id"]
        play_day(env, session)
        url = lambda name: f"{V2}/sessions/{sid}/children/{ids[name]}/regenerate"
        assert env.client.post(url("다온"), headers=env.headers).status_code == 409  # not drafted yet
        generate(env, sid)
        assert env.client.post(url("하린"), headers=env.headers).status_code == 422  # absent
        assert env.client.post(f"{V2}/sessions/{sid}/children/{new_id()}/regenerate", headers=env.headers).status_code == 404
        assert env.client.post(url("다온"), headers=env.headers_b).status_code == 404
        # a job still running for the child blocks a second one
        with env.app.state.database.connect() as connection:
            connection.execute("INSERT INTO jobs(job_id, teacher_id, kind, ref_id, status, created_at) VALUES (?,?,?,?,?,?)",
                               (new_id(), env.teacher_id, "regenerate_child", f"{sid}:{ids['다온']}", "running", now_iso()))
        busy = env.client.post(url("다온"), headers=env.headers)
        assert busy.status_code == 409 and busy.json()["error"]["code"] == "NOTICE_BUSY"
        assert {n["child_name"]: n["busy"] for n in get_session(env, sid)["notices"]}["다온"] is True


def test_editing_the_common_block_is_flagged_and_regenerating_rewrites_the_shared_paragraph(tmp_path):
    with running_env(tmp_path) as env:
        ids, session = class_of_five(env)
        sid = session["session_id"]
        play_day(env, session)
        generate(env, sid)
        assert get_session(env, sid)["common_outdated"] is False
        fill(env, get_session(env, sid), None, "바깥놀이터에서 낙엽 밟는 소리를 들었어요.", ("자연탐구",))
        assert get_session(env, sid)["common_outdated"] is True
        env.client.post(f"{V2}/sessions/{sid}/children/{ids['다온']}/regenerate", headers=env.headers)
        assert len(env.app.state.ai_client.calls_for(AITask.COMMON)) == 2
        assert "밟는 소리" in notice_of(env, sid, ids["다온"])["edited_text"]
        assert get_session(env, sid)["common_outdated"] is False
        assert "밟는 소리" not in notice_of(env, sid, ids["이든"])["edited_text"]  # others are rewritten on request only


def test_a_child_with_nothing_and_no_common_text_gets_no_notice(tmp_path):
    with running_env(tmp_path) as env:
        ids, session = class_of_five(env)
        fill(env, session, "다온", "다온이는 낙엽을 모았어요.", ("자연탐구",))
        job = generate(env, session["session_id"])
        assert job["result"]["drafted"] == 1
        assert [n["child_name"] for n in get_session(env, session["session_id"])["notices"]] == ["다온"]
        assert env.app.state.ai_client.calls_for(AITask.COMMON) == []


def test_tone_and_traits_reach_the_right_prompts(tmp_path):
    with running_env(tmp_path) as env:
        ids, session = class_of_five(env)
        play_day(env, session)
        env.client.put(f"{V2}/children/{ids['다온']}/characteristics", headers=env.headers, json={"text": "말이 느린 편이에요."})
        env.client.put(f"{V2}/children/{ids['이든']}/characteristics", headers=env.headers, json={"text": "몸을 쓰는 놀이를 좋아해요."})
        env.client.put(f"{V2}/teacher/documents/writing_examples", headers=env.headers, json={"text": "오늘도 즐겁게 놀았답니다 :)"})
        env.client.put(f"{V2}/teacher/documents/record_format", headers=env.headers, json={"text": "우리 어린이집 양식 메모"})
        generate(env, session["session_id"])
        calls = {c.payload["name"]: c for c in env.app.state.ai_client.calls_for(AITask.INDIVIDUAL)}
        assert "말이 느린 편" in calls["다온"].user_text and "몸을 쓰는 놀이" not in calls["다온"].user_text
        assert "몸을 쓰는 놀이" in calls["이든"].user_text and "말이 느린 편" not in calls["이든"].user_text
        assert "말이 느린 편" not in calls["서윤"].user_text
        common = env.app.state.ai_client.calls_for(AITask.COMMON)[0]
        assert "오늘도 즐겁게 놀았답니다" in common.user_text and "오늘도 즐겁게 놀았답니다" in calls["다온"].user_text
        everything = "".join(call.user_text for call in env.app.state.ai_client.calls)
        assert "우리 어린이집 양식 메모" not in everything  # the record format is stored only


def test_earlier_notices_are_passed_to_avoid_repetition(tmp_path):
    with running_env(tmp_path) as env:
        ids, day1 = class_of_five(env)
        fill(env, day1, "다온", "다온이는 낙엽을 모았어요.", ("자연탐구",))
        generate(env, day1["session_id"])
        day2 = open_session(env, "2026-11-07")
        fill(env, day2, "다온", "다온이는 이든이와 그네를 탔어요.", ("신체운동·건강",))
        generate(env, day2["session_id"])
        last = env.app.state.ai_client.calls_for(AITask.INDIVIDUAL)[-1]
        assert last.payload["recent_notices"] == [notice_of(env, day1["session_id"], ids["다온"])["edited_text"]]
        assert "낙엽을 모았어요" in last.user_text


def test_generated_text_is_masked_and_checked(tmp_path):
    with running_env(tmp_path) as env:
        ids, session = class_of_five(env)
        play_day(env, session)

        def careless(request):
            return {"text": f"{request.payload['name']}는 서윤이와 신나게 놀며 아이들을 유도했어요."}

        env.app.state.ai_client.handlers[AITask.INDIVIDUAL] = careless
        generate(env, session["session_id"])
        text = notice_of(env, session["session_id"], ids["다온"])
        assert "서윤" not in text["edited_text"] and "친구와" in text["edited_text"]
        codes = {(w["code"], w["word"]) for w in text["warnings"]}
        assert ("TEACHER_LED", "유도했") in codes and ("UNSUPPORTED_FEELING", "신나") in codes
        assert text["generated_text"] == text["edited_text"]


def test_a_restart_fails_interrupted_work_instead_of_leaving_it_spinning(tmp_path):
    with running_env(tmp_path) as env:
        ids, session = class_of_five(env)
        sid = session["session_id"]
        services = env.app.state.services
        services.sessions.set_status(sid, "analyzing")
        with env.app.state.database.connect() as connection:
            connection.execute("INSERT INTO jobs(job_id, teacher_id, kind, ref_id, status, created_at) VALUES (?,?,?,?,?,?)",
                               ("job-1", env.teacher_id, "generate", sid, "running", now_iso()))
        assert services.jobs.recover() == 1
        state = get_session(env, sid)
        assert state["status"] == "failed" and state["error_code"] == "SERVER_RESTART"
        job = env.client.get(f"{V2}/jobs/job-1", headers=env.headers).json()
        assert job["status"] == "failed" and job["error_code"] == "SERVER_RESTART"
        assert services.jobs.recover() == 0


def test_jobs_are_private_to_their_teacher(tmp_path):
    with running_env(tmp_path) as env:
        ids, session = class_of_five(env)
        fill(env, session, "다온", "다온이는 낙엽을 모았어요.", ("자연탐구",))
        job = generate(env, session["session_id"])
        assert env.client.get(f"{V2}/jobs/{job['job_id']}", headers=env.headers_b).status_code == 404
        assert env.client.get(f"{V2}/jobs/{job['job_id']}").status_code == 401
        assert env.client.get(f"{V2}/jobs/{job['job_id']}", headers=env.headers).json()["result"]["drafted"] == 1


def test_work_runs_in_the_background_when_not_inline(tmp_path):
    with running_env(tmp_path, jobs_inline=False) as env:
        ids, session = class_of_five(env)
        play_day(env, session)
        job = generate(env, session["session_id"])
        deadline = time.monotonic() + 10
        while job["status"] in ("queued", "running") and time.monotonic() < deadline:
            time.sleep(0.05)
            job = env.client.get(f"{V2}/jobs/{job['job_id']}", headers=env.headers).json()
        assert job["status"] == "completed", job
        assert get_session(env, session["session_id"])["status"] == "reviewing"
        assert len(get_session(env, session["session_id"])["notices"]) == 4
