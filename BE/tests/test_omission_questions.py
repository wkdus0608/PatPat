"""하지 않은 일(불참, 안 먹음 등)에는 이유와 그 시간에 한 일을 묻는다(2026-11-21 사용자 결정)."""
import pytest

from app.ai import prompts
from app.ai.omissions import find_omissions
from app.ai.prompts import BlockCtx, ChildCtx, ClassCtx
from app.ai.types import AITask
from app.core.config import Settings
from app.rules.loader import load_rules
from tests.flow_helpers import V2, add_children, block_of, fill, get_session, open_session, running_env

CLS = ClassCtx("만 2세", "2세")


@pytest.fixture(scope="module")
def bundle():
    return load_rules(Settings().rules_path)


def generate(env, session_id):
    response = env.client.post(f"{V2}/sessions/{session_id}/generate", headers=env.headers)
    assert response.status_code == 202, response.text
    return response.json()


# --- 찾기 ---------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("text", [
    "간식을 받았지만 먹지 않았다.", "색종이 접기에 참여하지 않았다.", "점심을 안 먹었다.", "낮잠을 못 잤다.", "밥을 많이 남겼어요.",
    "그림 그리기를 싫다고 했다.", "활동에는 불참했다.", "블록 놀이를 하지 못했다.", "간식을 먹지 못",
    "친구들과 놀지 않고 혼자 앉아 있었다.",
])
def test_things_the_child_did_not_do_are_found(text):
    found = find_omissions(text)
    assert [item["sentence"] for item in found] == [text.rstrip(". ")] and found[0]["has_reason"] is False


@pytest.mark.parametrize("text", [
    "친구와 다투지 않고 잘 놀았다.", "한 번도 울지 않았다.", "넘어졌지만 다치지 않았다.", "친구를 밀지 않았다.",
    "안아 주었다.", "안전하게 놀았다.", "안녕 하고 인사했다.", "오늘은 즐겁게 놀았다.",
])
def test_not_doing_something_bad_is_not_asked_about(text):
    assert find_omissions(text) == []


@pytest.mark.parametrize("unconfirmed", [
    "누가 씻었는지는 보지 못했지만 물로 씻은 건 확인했다.",
    "어느 쪽이 다쳤는지는 확인하지 못했다.",
    "누가 밴드를 붙였는지 못 봤다.",
])
def test_unconfirmed_observations_are_not_things_the_child_did_not_do(unconfirmed):
    assert find_omissions(unconfirmed) == []
    assert find_omissions(unconfirmed + " 간식은 먹지 않았다.") == [
        {"sentence": "간식은 먹지 않았다", "has_reason": False},
    ]


def test_a_reason_already_in_the_input_is_marked():
    found = find_omissions("색종이 접기에 참여하지 않았다. 열이 나서 보건실에서 쉬었다.")
    assert [item["sentence"] for item in found] == ["색종이 접기에 참여하지 않았다"]
    assert found[0]["has_reason"] is True
    assert find_omissions("배가 불러서 간식을 먹지 않았다.")[0]["has_reason"] is True


# --- 프롬프트 -----------------------------------------------------------------------------------------------------
def test_review_prompt_lists_the_omissions_only_when_there_are_some(bundle):
    roster = [ChildCtx("A", "다온")]
    blocks = [BlockCtx("b1", "A", "간식을 받았지만 먹지 않았다.", ("사회관계",))]
    plain = prompts.build_review(bundle, cls=CLS, roster=roster, common=None, blocks=blocks)
    assert "[하지 않은 일 확인]" not in plain.user_text and "omissions" not in plain.payload
    asked = prompts.build_review(
        bundle, cls=CLS, roster=roster, common=None, blocks=blocks,
        omissions=[{"child_id": "A", "name": "다온", "sentences": ["간식을 받았지만 먹지 않았다."]}],
    )
    assert "[하지 않은 일 확인]" in asked.user_text
    assert "- A (다온): 간식을 받았지만 먹지 않았다." in asked.user_text
    assert "이유와 그 시간에 한 일을 한 문장으로 함께" in asked.user_text
    assert asked.payload["omissions"][0]["child_id"] == "A"


def test_the_review_prompt_no_longer_offers_the_incident_question(bundle):
    request = prompts.build_review(bundle, cls=CLS, roster=[ChildCtx("A", "다온")], common=None,
                                   blocks=[BlockCtx("b1", "A", "넘어졌다.", ("신체운동·건강",))])
    assert "사건사고는 질문하지 않으므로" in request.user_text
    assert "부드럽게" not in request.user_text.split("[작업] 교차 검토")[1].split("[반 정보]")[0].replace("부드러운", "")


def test_the_rules_state_the_omission_policy_and_the_default_soft_mode(bundle):
    questioning = bundle.files["common/questioning.md"]
    assert "## 하지 않은 일 확인" in questioning and "이유와 그 시간에 한 일" in questioning
    assert "보호자 안내용으로 부드럽게 쓸지 묻지 않는다" in questioning
    assert "묻지 않고 항상 이 글로 쓴다" in bundle.files["notice/incident.md"]


# --- 흐름 ---------------------------------------------------------------------------------------------------------
def test_fallback_asks_only_why_when_the_same_time_activity_is_already_recorded(tmp_path):
    with running_env(tmp_path) as env:
        add_children(env, ["평가아동가"])
        session = open_session(env)
        fill(env, session, "평가아동가", "종이컵 놀이에 참여하지 않았다. 그 시간에는 자동차를 굴렸다.")
        assert generate(env, session["session_id"])["result"]["phase"] == "asking"
        flag, = get_session(env, session["session_id"])["flags"]
        assert flag["question"] == "평가아동가의 메모 ‘종이컵 놀이에 참여하지 않았다’에 대해, 이유를 알려 주세요."


def test_doing_no_treatment_is_not_treated_as_an_omission_by_the_child():
    assert find_omissions("오른쪽 손바닥이 쓸렸다. 따로 씻거나 밴드를 붙이지 않았다.") == []
    assert find_omissions("오른쪽 손바닥이 쓸렸다. 별도 처치를 하지 않았다. 간식은 먹지 않았다.") == [
        {"sentence": "간식은 먹지 않았다", "has_reason": False},
    ]


def test_a_child_who_did_not_do_something_is_asked_why_and_what_they_did_instead(tmp_path):
    with running_env(tmp_path) as env:
        child_id, = add_children(env, ["평가아동가"])
        session = open_session(env)
        fill(env, session, "평가아동가", "간식을 받았지만 먹지 않았다.")
        assert generate(env, session["session_id"])["result"]["phase"] == "asking"
        state = get_session(env, session["session_id"])
        flag, = state["flags"]
        assert flag["kind"] == "missing_fact" and flag["child_ids"] == [child_id] and flag["options"] == []
        assert "간식을 받았지만 먹지 않았다" in flag["question"] and "이유와 그 시간에 한 일" in flag["question"]
        review_call, = env.app.state.ai_client.calls_for(AITask.REVIEW)
        assert review_call.payload["omissions"] == [
            {"child_id": child_id, "name": "평가아동가", "sentences": ["간식을 받았지만 먹지 않았다"]}]
        assert review_call.payload.get("thin_children") is None  # 이 질문이 보충 질문을 대신한다

        answer = "점심을 많이 먹어 배가 부르다고 했고 대신 물을 한 컵 마셨다."
        response = env.client.post(f"{V2}/sessions/{session['session_id']}/answers", headers=env.headers,
                                   json={"answers": [{"flag_id": flag["flag_id"], "answer": answer}]})
        assert response.status_code == 202, response.text
        individual, = env.app.state.ai_client.calls_for(AITask.INDIVIDUAL)
        assert [item["answer"] for item in individual.payload["answers"]] == [answer]


def test_a_question_the_model_already_asked_is_not_asked_twice(tmp_path):
    asked = "평가아동가가 간식을 먹지 않은 이유와 그때 한 일을 알려 주세요."

    def model_asks(request):
        child_id = request.payload["blocks"][0]["child_id"]
        return {"flags": [{"kind": "missing_fact", "child_ids": [child_id], "question": asked, "options": []}],
                "joint_events": [], "incident_child_ids": []}

    with running_env(tmp_path, ai_handlers={AITask.REVIEW: model_asks}) as env:
        add_children(env, ["평가아동가"])
        session = open_session(env)
        fill(env, session, "평가아동가", "간식을 받았지만 먹지 않았다.")
        generate(env, session["session_id"])
        assert [flag["question"] for flag in get_session(env, session["session_id"])["flags"]] == [asked]


@pytest.mark.parametrize("text", [
    "색종이 접기에 참여하지 않았다. 열이 나서 보건실에서 쉬었다.",  # 이유와 대신 한 일이 입력에 있다
    "친구와 다투지 않고 블록을 쌓았다. 탑 위에 지붕 블록을 올렸다. 다 쌓은 뒤 선생님께 보여 주었다. 정리 시간에 블록을 통에 담았다. 통을 선반에 올려 두었다. 손을 씻고 간식 자리에 앉았다.",
])
def test_no_omission_question_when_the_reason_is_given_or_nothing_was_left_undone(tmp_path, text):
    with running_env(tmp_path) as env:
        add_children(env, ["평가아동가"])
        session = open_session(env)
        fill(env, session, "평가아동가", text)
        generate(env, session["session_id"])
        calls = env.app.state.ai_client.calls_for(AITask.REVIEW)
        assert calls[0].payload.get("omissions") is None
        assert all("이유와 그 시간에 한 일" not in flag["question"] for flag in get_session(env, session["session_id"])["flags"])


def test_the_omission_questions_share_the_six_question_limit(tmp_path):
    names = [f"아이{n}" for n in range(8)]
    with running_env(tmp_path) as env:
        add_children(env, names)
        session = open_session(env)
        for name in names:
            fill(env, session, name, "점심을 안 먹었다.")
        generate(env, session["session_id"])
        flags = get_session(env, session["session_id"])["flags"]
        assert len(flags) == 6 and {flag["kind"] for flag in flags} == {"missing_fact"}
        assert all(len(flag["child_ids"]) == 1 for flag in flags)


# --- 질문 상한: 순위·개수·이유 표지 (2026-11-21 대역 검증에서 찾은 결함) -------------------------------------------------
def test_an_ordinary_sequence_is_not_taken_for_a_reason():
    assert find_omissions("자리에 앉아서 간식을 먹지 않았다.")[0]["has_reason"] is False
    assert find_omissions("무서워서 미끄럼틀을 타지 않았다.")[0]["has_reason"] is True


def test_the_cap_keeps_the_children_the_rules_rank_first_not_the_model_order():
    from app.ai.schemas import cap_detail_questions

    flags = [{"kind": "missing_fact", "child_ids": [name], "question": name, "options": []} for name in "ABCDEFGH"]
    ranked = cap_detail_questions(flags, {"G": 0, "H": 1, "A": 2, "B": 3, "C": 4, "D": 5})
    assert [flag["child_ids"][0] for flag in ranked] == ["A", "B", "C", "D", "G", "H"]  # 남긴 질문은 원래 순서
    assert [flag["child_ids"][0] for flag in cap_detail_questions(flags)] == list("ABCDEF")  # 순위가 없으면 먼저 온 순서


def test_the_thin_children_share_the_six_questions_with_the_omissions(tmp_path):
    names = [f"아이{n}" for n in range(8)]
    with running_env(tmp_path) as env:
        add_children(env, names)
        session = open_session(env)
        for index, name in enumerate(names):
            fill(env, session, name, "점심을 안 먹었다." if index < 2 else "블록을 쌓았다.")
        generate(env, session["session_id"])
        review_call, = env.app.state.ai_client.calls_for(AITask.REVIEW)
        assert len(review_call.payload["omissions"]) == 2 and len(review_call.payload["thin_children"]) == 4


def test_a_model_that_lists_the_longest_child_first_cannot_push_out_the_shortest(tmp_path):
    names = [f"아이{n}" for n in range(8)]

    def model_asks_in_roster_order(request):
        return {"flags": [{"kind": "missing_fact", "child_ids": [block["child_id"]], "options": [],
                           "question": f"{block['child_id']}의 장면을 알려 주세요."} for block in request.payload["blocks"]],
                "joint_events": [], "incident_child_ids": []}

    with running_env(tmp_path, ai_handlers={AITask.REVIEW: model_asks_in_roster_order}) as env:
        ids = dict(zip(names, add_children(env, names)))
        session = open_session(env)
        for index, name in enumerate(names):  # 아이0이 가장 길고 아이7이 가장 짧다
            fill(env, session, name, "블록을 쌓았다." + " 친구와 나눠 썼다." * (7 - index))
        generate(env, session["session_id"])
        asked = {flag["child_ids"][0] for flag in get_session(env, session["session_id"])["flags"]}
        assert asked == {ids[name] for name in names[2:]}  # 가장 긴 두 아이(아이0, 아이1)가 빠진다
