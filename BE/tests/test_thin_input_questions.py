"""얇은 입력의 아이에게만 질문 1~2개로 사실을 더 모은 뒤 길게 쓴다(2026-11-21 사용자 결정)."""
import pytest

from app.ai import prompts, schemas
from app.ai.prompts import BlockCtx, ChildCtx, ClassCtx
from app.core.config import Settings
from app.pipeline.service import MAX_THIN_CHILDREN, THIN_INPUT_MAX_CHARS, thin_input_children
from app.rules.loader import load_rules

CLS = ClassCtx("만 2세", "2세")


@pytest.fixture(scope="module")
def bundle():
    return load_rules(Settings().rules_path)


def block(child_id, text):
    return BlockCtx(f"b-{child_id}", child_id, text, ("예술경험",))


def missing_fact(child_ids, question="어떻게 했나요?"):
    return {"kind": "missing_fact", "child_ids": child_ids, "question": question, "options": []}


# --- 질문 개수 상한(코드) ---------------------------------------------------------------------------------------------
def test_detail_questions_are_capped_at_two_per_child_and_six_per_class():
    valid = {f"C{n}" for n in range(1, 6)}
    flags = [missing_fact(["C1"], f"C1 질문 {n}") for n in range(4)]
    flags += [missing_fact([f"C{n}"], f"C{n} 질문") for n in range(2, 6)]
    kept = schemas.parse_review({"flags": flags}, valid)["flags"]
    assert [flag["question"] for flag in kept] == ["C1 질문 0", "C1 질문 1", "C2 질문", "C3 질문", "C4 질문", "C5 질문"]
    many = schemas.parse_review({"flags": [missing_fact([child]) for child in sorted(valid)] * 2}, valid)["flags"]
    assert len(many) == 6 and all(sum(flag["child_ids"] == [child] for flag in many) <= 2 for child in valid)


def test_the_detail_cap_leaves_other_question_kinds_alone():
    flags = [{"kind": "conflict", "child_ids": ["A"], "question": "같은 일인가요?", "options": ["같은 상황", "따로"]}]
    flags += [{"kind": "ambiguous", "child_ids": ["A"], "question": f"애매 {n}", "options": ["네", "아니요"]} for n in range(4)]
    flags += [missing_fact(["A"], f"사실 {n}") for n in range(3)]
    kept = schemas.parse_review({"flags": flags}, {"A"})["flags"]
    assert [flag["kind"] for flag in kept].count("conflict") == 1
    assert [flag["kind"] for flag in kept].count("ambiguous") == 4
    assert [flag["kind"] for flag in kept].count("missing_fact") == 2


# --- 대상 아이 고르기(코드) -------------------------------------------------------------------------------------------
def test_thin_children_are_the_short_inputs_shortest_first():
    names = {"A": "가", "B": "나", "C": "다"}
    blocks = {"A": block("A", "블록을 쌓았다. 무너졌다."), "B": block("B", "퍼즐을 맞췄다."), "C": block("C", "가" * (THIN_INPUT_MAX_CHARS + 1))}
    picked = thin_input_children(names, blocks, set())
    assert [item["child_id"] for item in picked] == ["B", "A"]
    assert picked[0] == {"child_id": "B", "name": "나", "chars": 8, "single": True}
    assert picked[1]["single"] is False


def test_thin_children_leave_out_empty_long_and_already_asked_inputs():
    names = {"A": "가", "B": "나", "C": "다", "D": "라"}
    blocks = {"A": block("A", ""), "B": block("B", "가" * THIN_INPUT_MAX_CHARS), "C": block("C", "가" * (THIN_INPUT_MAX_CHARS + 1)),
              "D": block("D", "짧은 입력이다.")}
    assert [item["child_id"] for item in thin_input_children(names, blocks, set())] == ["D", "B"]
    assert [item["child_id"] for item in thin_input_children(names, blocks, {"D"})] == ["B"]


def test_at_most_six_children_are_asked_and_the_shortest_come_first():
    names = {f"C{n}": f"아이{n}" for n in range(8)}
    blocks = {child_id: block(child_id, "가" * (10 + 5 * index)) for index, child_id in enumerate(names)}
    picked = thin_input_children(names, blocks, set())
    assert len(picked) == MAX_THIN_CHILDREN == 6
    assert [item["child_id"] for item in picked] == [f"C{n}" for n in range(6)]


# --- 프롬프트와 규칙 ---------------------------------------------------------------------------------------------------
def test_review_prompt_lists_the_thin_children_only_when_asked(bundle):
    roster = [ChildCtx("A", "다온"), ChildCtx("B", "서윤")]
    blocks = [block("A", "퍼즐을 맞췄다."), block("B", "블록을 쌓았다. 무너졌다.")]
    plain = prompts.build_review(bundle, cls=CLS, roster=roster, common=None, blocks=blocks)
    assert "[얇은 입력 보충 질문]" not in plain.user_text and "thin_children" not in plain.payload
    thin = [{"child_id": "A", "name": "다온", "chars": 8, "single": True}, {"child_id": "B", "name": "서윤", "chars": 13, "single": False}]
    asked = prompts.build_review(bundle, cls=CLS, roster=roster, common=None, blocks=blocks, thin_children=thin)
    assert "[얇은 입력 보충 질문]" in asked.user_text
    assert "- A (다온): 8자, 입력 한 문장(질문 2개까지)" in asked.user_text
    assert "- B (서윤): 13자, 입력 두 문장 이상(질문 1개)" in asked.user_text
    assert asked.payload["thin_children"] == thin
    assert asked.system_text == plain.system_text  # 규칙 묶음은 그대로라 캐시가 유지된다


def test_individual_prompt_asks_for_every_fact_and_a_long_text_without_new_facts(bundle):
    child = ChildCtx("A", "다온")
    request = prompts.build_individual(
        bundle, cls=CLS, child=child, block=block("A", "퍼즐을 맞췄다."), common=None, common_paragraph="", other_names=[],
        mode="normal", answers=[{"question": "어떻게 했나요?", "answer": "조각을 돌려 가며 끼웠다."}], joint_facts=[],
        recent_notices=[], writing_examples=None,
    )
    assert "빠진 사실이 없는지 대조한다" in request.user_text and "분량은 입력 분량에 맞추지 않는다" in request.user_text
    assert "문장을 나누어 사실마다 따로 쓰고" in request.user_text
    assert "- 어떻게 했나요? → 조각을 돌려 가며 끼웠다." in request.user_text


def test_the_rules_state_the_same_limits_the_code_enforces(bundle):
    questioning = bundle.files["common/questioning.md"]
    assert f"{THIN_INPUT_MAX_CHARS}자 이하" in questioning
    assert f"{MAX_THIN_CHILDREN}개" in questioning and "아이마다 1개" in questioning
    guide = bundle.files["notice/guide.md"]
    assert "분량은 입력 분량에 맞추지 않는다" in guide and "긴 예시" in guide
    assert "긴 예시" in bundle.files["notice/incident.md"]
