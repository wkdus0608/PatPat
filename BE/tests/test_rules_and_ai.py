"""B2: rule loader, privacy masking, lint, prompts, fake and Claude clients, usage gateway."""
import json
import shutil
from types import SimpleNamespace

import pytest

from app.ai import prompts, schemas
from app.ai.anthropic_client import AnthropicClient, NotConfiguredAIClient
from app.ai.factory import create_ai_client
from app.ai.fake import FakeAIClient
from app.ai.gateway import AIGateway
from app.ai.lint import lint_notice
from app.ai.privacy import find_names, mask_names
from app.ai.prompts import BlockCtx, ChildCtx, ClassCtx
from app.ai.types import (
    AIBadOutput, AINotConfigured, AIRateLimited, AIRefusal, AIRequest, AITask, AITruncated, AIUnavailable,
)
from app.core.config import Settings
from app.core.database import Database
from app.rules.loader import RULE_FILES, RulesError, age_band_from_label, child_term, load_rules

RULES_PATH = Settings().rules_path


@pytest.fixture(scope="module")
def bundle():
    return load_rules(RULES_PATH)


# --- rule loader ---------------------------------------------------------------------------------------
def test_real_rules_load_and_are_deterministic(bundle):
    again = load_rules(RULES_PATH)
    assert again.text == bundle.text and again.rules_hash == bundle.rules_hash
    assert len(bundle.rules_hash) == 16
    for name in RULE_FILES:
        assert f"=== 규칙 파일: {name} ===" in bundle.text
    assert bundle.text.index("common/trend.md") < bundle.text.index("observation/examples.md")


def test_loader_rejects_missing_empty_and_headingless_files(tmp_path):
    copy = tmp_path / "rules"
    shutil.copytree(RULES_PATH, copy)
    (copy / "common/sensitive.md").write_text("   \n", encoding="utf-8")
    (copy / "notice/incident.md").unlink()
    (copy / "observation/guide.md").write_text("제목 없는 본문\n", encoding="utf-8")
    with pytest.raises(RulesError) as caught:
        load_rules(copy)
    message = str(caught.value)
    assert "common/sensitive.md: 비어 있습니다" in message
    assert "notice/incident.md: 파일이 없습니다" in message
    assert "observation/guide.md: 첫 줄이" in message


@pytest.mark.parametrize("label,band", [
    ("만 0세", "0-1세"), ("1세반", "0-1세"), ("0~1세", "0-1세"), ("만 2세", "2세"), ("2세", "2세"),
    ("만 3세", "3-5세"), ("4세반", "3-5세"), ("5", "3-5세"), ("", None), (None, None), ("햇살반", None), ("만 7세", None),
])
def test_age_band_from_teacher_label(label, band):
    assert age_band_from_label(label) == band


def test_child_term_follows_the_band():
    assert [child_term(band) for band in ("0-1세", "2세", "3-5세", None)] == ["영아", "영아", "유아", "영유아"]


# --- privacy -------------------------------------------------------------------------------------------
@pytest.mark.parametrize("text,names,expected", [
    ("서윤이를 밀침", ["서윤"], "친구를 밀침"),
    ("서윤이가 울음", ["서윤"], "친구가 울음"),
    ("서윤이 넘어짐", ["서윤"], "친구 넘어짐"),
    ("서윤을 쓰다듬음", ["서윤"], "친구를 쓰다듬음"),
    ("서윤은 웃음", ["서윤"], "친구는 웃음"),
    ("서아는 웃음", ["서아"], "친구는 웃음"),
    ("서윤이랑 이든이가 놀이", ["서윤", "이든"], "친구랑 친구가 놀이"),
    ("서윤이와 함께", ["서윤"], "친구와 함께"),
    ("민들레를 봄", ["민"], "민들레를 봄"),
    ("이름 없음", ["서윤"], "이름 없음"),
])
def test_mask_names_handles_korean_particles(text, names, expected):
    assert mask_names(text, names) == expected


def test_find_names_ignores_one_letter_names():
    assert find_names("서윤이가 민들레를 봄", ["서윤", "민"]) == ["서윤"]


# --- lint / schemas ---------------------------------------------------------------------------------------
def test_lint_flags_teacher_led_words_and_unsupported_feelings_only():
    warnings = lint_notice("선생님이 낙엽 줍기를 유도했어요. 아이들은 신나게 놀았어요.", source_text="낙엽 줍기")
    assert {(item["code"], item["word"]) for item in warnings} == {("TEACHER_LED", "유도했"), ("UNSUPPORTED_FEELING", "신나")}
    assert lint_notice("아이들이 신나서 달렸어요.", source_text="신나서 달림") == []


def test_parse_review_keeps_valid_flags_in_priority_order():
    valid = {"A", "B"}
    data = {
        "flags": [
            {"kind": "ambiguous", "child_ids": ["A"], "question": "애매해요?", "options": ["네", "아니요"]},
            {"kind": "incident", "child_ids": ["A", "Z"], "question": "사건사고?", "options": ["부드럽게", "그대로"]},
            {"kind": "incident", "child_ids": ["Z"], "question": "모르는 아이", "options": ["네", "아니요"]},
            {"kind": "conflict", "child_ids": ["A"], "question": "한 가지 선택지", "options": ["네"]},
            {"kind": "weird", "child_ids": ["A"], "question": "종류 없음", "options": ["네", "아니요"]},
        ],
        "joint_events": [
            {"child_ids": ["A", "B"], "facts": [{"child_id": "A", "fact": "a"}, {"child_id": "B", "fact": "b"}]},
            {"child_ids": ["A"], "facts": [{"child_id": "A", "fact": "혼자"}]},
        ],
        "incident_child_ids": ["A", "Z"],
    }
    parsed = schemas.parse_review(data, valid)
    assert [flag["kind"] for flag in parsed["flags"]] == ["incident", "ambiguous"]
    assert parsed["flags"][0]["child_ids"] == ["A"]
    assert len(parsed["joint_events"]) == 1 and parsed["incident_child_ids"] == ["A"]


def test_parse_review_caps_flags_at_ten():
    flags = [{"kind": "ambiguous", "child_ids": ["A"], "question": f"질문 {i}", "options": ["네", "아니요"]} for i in range(15)]
    assert len(schemas.parse_review({"flags": flags}, {"A"})["flags"]) == 10


def test_json_schemas_close_every_object():
    def walk(node):
        if isinstance(node, dict):
            if node.get("type") == "object":
                assert node["additionalProperties"] is False
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)
    for schema in (schemas.REVIEW_SCHEMA, schemas.TEXT_SCHEMA, schemas.CONTENT_SCHEMA, schemas.AREAS_SCHEMA):
        walk(schema)


# --- prompts ---------------------------------------------------------------------------------------------------
CLS = ClassCtx("만 2세", "2세")


def test_every_task_shares_one_byte_identical_system_block(bundle):
    child = ChildCtx("A", "다온")
    block = BlockCtx("b1", "A", "낙엽 줍기", ("자연탐구",))
    common = BlockCtx("c1", None, "낙엽놀이", ("자연탐구",))
    requests = [
        prompts.build_review(bundle, cls=CLS, roster=[child], common=common, blocks=[block]),
        prompts.build_common(bundle, cls=CLS, common=common, all_names=["다온"], writing_examples=None),
        prompts.build_individual(bundle, cls=CLS, child=child, block=block, common=common, common_paragraph="공통", other_names=[],
                                 mode="normal", answers=[], joint_facts=[], recent_notices=[], writing_examples="내 글"),
        prompts.build_revise(bundle, child=child, current_text="글", instruction="짧게", source_text="입력", other_names=[]),
        prompts.build_journal_common(bundle, cls=CLS, text="공통", common=common),
        prompts.build_journal_individual(bundle, cls=CLS, child=child, text="개별", block=block, common=common, incident=False),
        prompts.build_areas(bundle, text="낙엽"),
    ]
    assert len({request.system_text for request in requests}) == 1
    assert requests[0].system_text.startswith(prompts.SYSTEM_PREFACE)
    assert bundle.text in requests[0].system_text
    assert {request.task for request in requests} == set(AITask)


def test_individual_prompt_contains_nothing_of_other_children(bundle):
    child = ChildCtx("A", "다온", "서윤이와 자주 놂. 낙엽을 좋아함")
    block = BlockCtx("b1", "A", "서윤이를 밀침. 이든이도 옆에 있었음", ("사회관계",))
    request = prompts.build_individual(
        bundle, cls=CLS, child=child, block=block, common=None, common_paragraph="공통 단락", other_names=["서윤", "이든"],
        mode="incident_soft",
        answers=[{"question": "이든·서윤 이야기는 사건사고로 보여요. 부드럽게 쓸까요?", "answer": "부드럽게"}],
        joint_facts=["서윤이가 넘어져 울음"], recent_notices=["어제는 서윤이와 놀았어요"], writing_examples=None,
    )
    serialized = request.user_text + json.dumps(request.payload, ensure_ascii=False)
    for other in ("서윤", "이든"):
        assert other not in serialized
    assert "다온" in request.user_text and "친구" in request.user_text
    assert "사건사고(부드럽게 쓰기)" in request.user_text


def test_common_prompt_masks_every_child_name(bundle):
    common = BlockCtx("c1", None, "다온이가 먼저 낙엽을 주움. 서윤이도 따라 함", ("자연탐구",))
    request = prompts.build_common(bundle, cls=CLS, common=common, all_names=["다온", "서윤"], writing_examples=None)
    assert "다온" not in request.user_text.split("[반 공통 블록]")[1] and "서윤" not in request.user_text


def test_teacher_examples_replace_the_default_tone_and_are_capped(bundle):
    common = BlockCtx("c1", None, "낙엽놀이")
    with_examples = prompts.build_common(bundle, cls=CLS, common=common, all_names=[], writing_examples="가" * 9000)
    assert with_examples.user_text.count("가") < 7000 and "교사가 직접 쓴 글" in with_examples.user_text
    default = prompts.build_common(bundle, cls=CLS, common=common, all_names=[], writing_examples="  ")
    assert "기본 말투 샘플" in default.user_text


def test_unknown_class_age_is_stated_instead_of_guessed(bundle):
    request = prompts.build_common(bundle, cls=ClassCtx("", None), common=BlockCtx("c1", None, "놀이"), all_names=[], writing_examples=None)
    assert "알 수 없음" in request.user_text and "영유아" in request.user_text


# --- fake client -------------------------------------------------------------------------------------------------
def _review_request(bundle, blocks):
    roster = [ChildCtx(child_id, name) for child_id, name, _ in blocks]
    block_ctx = [BlockCtx(f"b-{child_id}", child_id, text, ("사회관계",)) for child_id, _, text in blocks]
    return prompts.build_review(bundle, cls=CLS, roster=roster, common=None, blocks=block_ctx)


def test_fake_review_flags_incidents_and_hides_the_other_childs_name(bundle):
    fake = FakeAIClient()
    result = fake.complete(_review_request(bundle, [("A", "이든", "서윤을 밀침"), ("B", "서윤", "넘어져서 울음"), ("C", "지안", "블록 쌓기")]))
    assert [flag["kind"] for flag in result.data["flags"]] == ["incident"]
    assert result.data["incident_child_ids"] == ["A", "B"]
    facts = {item["child_id"]: item["fact"] for item in result.data["joint_events"][0]["facts"]}
    assert "서윤" not in facts["A"] and "친구" in facts["A"]
    quiet = fake.complete(_review_request(bundle, [("C", "지안", "블록 쌓기")]))
    assert quiet.data["flags"] == [] and quiet.data["incident_child_ids"] == []


def test_fake_handlers_can_be_replaced_and_calls_are_recorded(bundle):
    fake = FakeAIClient({AITask.AREAS: lambda request: {"areas": ["예술경험"]}})
    request = prompts.build_areas(bundle, text="그림 그리기")
    assert fake.complete(request).data == {"areas": ["예술경험"]}
    assert fake.calls_for(AITask.AREAS) == [request]
    del fake.handlers[AITask.AREAS]
    with pytest.raises(AIUnavailable):
        fake.complete(request)


def test_fake_area_suggestion_uses_keywords(bundle):
    result = FakeAIClient().complete(prompts.build_areas(bundle, text="낙엽을 던지며 큰거! 하고 말함"))
    assert result.data["areas"] == ["신체운동·건강", "의사소통", "자연탐구"]


# --- Claude client -----------------------------------------------------------------------------------------------
class StubMessages:
    def __init__(self, response=None, error=None):
        self.response, self.error, self.calls = response, error, []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.response


class StubSDK:
    def __init__(self, response=None, error=None):
        self.messages = StubMessages(response, error)
        self.beta = SimpleNamespace(messages=StubMessages(response, error))


def _response(payload=None, *, stop_reason="end_turn", text=None):
    body = text if text is not None else json.dumps(payload or {"text": "결과"}, ensure_ascii=False)
    return SimpleNamespace(
        stop_reason=stop_reason, model="claude-opus-5-5",
        content=[SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text=body)],
        usage=SimpleNamespace(input_tokens=12, output_tokens=7, cache_creation_input_tokens=300, cache_read_input_tokens=None),
    )


def _request(bundle):
    return prompts.build_areas(bundle, text="낙엽 줍기")


def test_claude_request_marks_the_rules_block_for_caching(bundle):
    client = AnthropicClient(api_key="x", model="claude-opus-5-5", effort="medium")
    kwargs = client.build_kwargs(_request(bundle))
    assert kwargs["model"] == "claude-opus-5-5" and kwargs["max_tokens"] == 16000
    assert kwargs["system"] == [{"type": "text", "text": _request(bundle).system_text, "cache_control": {"type": "ephemeral"}}]
    assert kwargs["messages"] == [{"role": "user", "content": _request(bundle).user_text}]
    assert kwargs["output_config"]["effort"] == "medium"
    assert kwargs["output_config"]["format"] == {"type": "json_schema", "schema": schemas.AREAS_SCHEMA}
    assert "thinking" not in kwargs  # Opus 5.5 always thinks; no parameter needed


@pytest.mark.parametrize("model,expected", [
    ("claude-opus-5-5", True), ("claude-sonnet-5-5", True), ("claude-haiku-5-5", False), ("claude-opus-4-8", False)])
def test_server_side_fallbacks_follow_the_model(model, expected):
    kwargs = AnthropicClient(api_key="x", model=model).build_kwargs(AIRequest(AITask.AREAS, "s", "u", None))
    assert ("fallbacks" in kwargs) is expected
    if expected:
        assert kwargs["betas"] == ["server-side-fallback-2026-07-01"] and kwargs["fallbacks"] == "default"
        assert "output_config" not in kwargs  # no schema and no effort given
    assert "fallbacks" not in AnthropicClient(api_key="x", model=model, fallbacks=False).build_kwargs(AIRequest(AITask.AREAS, "s", "u", None))


def test_claude_success_parses_json_and_maps_usage(bundle):
    sdk = StubSDK(_response({"areas": ["자연탐구"]}))
    result = AnthropicClient(api_key="x", model="claude-opus-5-5", sdk=sdk).complete(_request(bundle))
    assert result.data == {"areas": ["자연탐구"]} and result.model == "claude-opus-5-5"
    assert (result.usage.input_tokens, result.usage.cache_creation_input_tokens, result.usage.cache_read_input_tokens) == (12, 300, 0)
    assert len(sdk.beta.messages.calls) == 1 and sdk.messages.calls == []  # fallbacks need the beta endpoint


def test_claude_uses_plain_endpoint_when_fallbacks_are_off(bundle):
    sdk = StubSDK(_response({"areas": []}))
    AnthropicClient(api_key="x", model="claude-haiku-5-5", sdk=sdk).complete(_request(bundle))
    assert len(sdk.messages.calls) == 1 and sdk.beta.messages.calls == []


@pytest.mark.parametrize("response,error", [
    (_response(stop_reason="refusal", text=""), AIRefusal),
    (_response(stop_reason="max_tokens", text="{"), AITruncated),
    (_response(text="JSON 아님"), AIBadOutput),
    (_response(text="[1, 2]"), AIBadOutput),
])
def test_claude_response_problems_raise_typed_errors(bundle, response, error):
    with pytest.raises(error):
        AnthropicClient(api_key="x", model="claude-opus-5-5", sdk=StubSDK(response)).complete(_request(bundle))


class StatusError(Exception):
    def __init__(self, status_code=None):
        super().__init__("boom")
        self.status_code = status_code


@pytest.mark.parametrize("status,error,code", [
    (429, AIRateLimited, "AI_RATE_LIMITED"), (401, AINotConfigured, "AI_AUTH"), (503, AIUnavailable, "AI_UNAVAILABLE"),
    (None, AIUnavailable, "AI_UNAVAILABLE")])
def test_claude_api_errors_are_mapped_by_status(bundle, status, error, code):
    client = AnthropicClient(api_key="x", model="claude-opus-5-5", sdk=StubSDK(error=StatusError(status)))
    with pytest.raises(error) as caught:
        client.complete(_request(bundle))
    assert caught.value.code == code


def test_factory_builds_the_configured_client():
    assert isinstance(create_ai_client(Settings(ai_provider="fake")), FakeAIClient)
    unconfigured = create_ai_client(Settings(ai_provider="anthropic", anthropic_api_key=""))
    assert isinstance(unconfigured, NotConfiguredAIClient)
    with pytest.raises(AINotConfigured):
        unconfigured.complete(AIRequest(AITask.AREAS, "s", "u", None))
    configured = create_ai_client(Settings(ai_provider="anthropic", anthropic_api_key="key", ai_model="claude-sonnet-5-5", ai_effort="low"))
    assert isinstance(configured, AnthropicClient) and configured.model == "claude-sonnet-5-5" and configured.effort == "low"
    with pytest.raises(ValueError):
        create_ai_client(Settings(ai_provider="other"))


def test_default_settings_leave_the_api_key_empty():
    assert Settings().anthropic_api_key == "" and Settings().ai_provider == "anthropic"


# --- usage gateway ---------------------------------------------------------------------------------------------------
def test_gateway_records_usage_and_failures(tmp_path, bundle):
    database = Database(str(tmp_path / "usage.sqlite3"))
    fake = FakeAIClient({AITask.COMMON: lambda request: (_ for _ in ()).throw(AIUnavailable("끊김"))})
    gateway = AIGateway(fake, database, "hash123")
    gateway.call(_request(bundle), teacher_id="T", session_id="S")
    with pytest.raises(AIUnavailable):
        gateway.call(prompts.build_common(bundle, cls=CLS, common=BlockCtx("c", None, "놀이"), all_names=[], writing_examples=None),
                     teacher_id="T", session_id="S")
    with database.connect() as connection:
        rows = connection.execute("SELECT task, status, error_code, rules_hash, session_id FROM ai_calls ORDER BY rowid").fetchall()
    assert [tuple(row) for row in rows] == [("areas", "ok", None, "hash123", "S"), ("common", "error", "AI_UNAVAILABLE", "hash123", "S")]
