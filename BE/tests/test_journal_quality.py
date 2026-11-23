"""동료 피드백 ④·⑥·⑦: 관찰 없는 아이의 일지에 해석 문장이 들어가고, 같은 내용이 되풀이된다."""
from app.ai.lint import drop_unconfirmed_time_prefix
from app.ai.schemas import drop_repeated_sentences, render_journal
from app.ai.types import AITask
from app.journal.store import NO_INDIVIDUAL_NOTE
from tests.flow_helpers import V2, add_children, fill, get_session, open_session, running_env
from tests.test_journal_api import confirm, day


def interpreting_common(_request):
    return {"content": "낙엽을 모음. 낙엽을 색에 따라 모아 보는 경험을 함.", "learning": [], "incident": ""}


def test_a_child_without_own_observation_gets_no_interpretation_and_a_note(tmp_path):
    with running_env(tmp_path, ai_handlers={AITask.JOURNAL_COMMON: interpreting_common}) as env:
        ids, _, notices = day(env)  # 다온·이든은 개별 관찰이 있고 서윤은 없다
        for name in ("다온", "서윤"):
            confirm(env, notices[name]["notice_id"], 1)
        observed = env.client.get(f"{V2}/children/{ids['다온']}/journal", headers=env.headers).json()["items"]
        unobserved = env.client.get(f"{V2}/children/{ids['서윤']}/journal", headers=env.headers).json()["items"]
        assert [item["block_kind"] for item in unobserved] == ["common"]
        assert "경험을 함" in observed[0]["content"]  # 관찰이 있는 아이에게는 공통 행의 해석이 그대로 간다
        assert unobserved[0]["content"] == f"낙엽을 모음.\n{NO_INDIVIDUAL_NOTE}"
        exported = env.client.get(f"{V2}/children/{ids['서윤']}/journal/export", headers=env.headers).text
        assert "경험을 함" not in exported and NO_INDIVIDUAL_NOTE in exported


def test_a_teacher_edit_of_the_common_row_is_never_rewritten(tmp_path):
    with running_env(tmp_path, ai_handlers={AITask.JOURNAL_COMMON: interpreting_common}) as env:
        ids, _, notices = day(env)
        confirm(env, notices["서윤"]["notice_id"], 1)
        route = f"{V2}/children/{ids['서윤']}/journal"
        item = env.client.get(route, headers=env.headers).json()["items"][0]
        response = env.client.patch(f"{V2}/journal-entries/{item['entry_id']}", headers=env.headers,
                                    json={"expected_version": item["version"], "content": "교사가 직접 쓴 글. 경험을 함."})
        assert response.is_success, response.text
        assert env.client.get(route, headers=env.headers).json()["items"][0]["content"] == "교사가 직접 쓴 글. 경험을 함."


def test_repeated_sentences_across_content_and_incident_are_dropped():
    data = {
        "content": "또래가 잡고 있던 빨간 삽 손잡이를 자기 쪽으로 당김. 교사가 차례를 말로 부탁해 보자고 안내함.",
        "learning": [],
        "incident": "빨간 삽 손잡이를 자기 쪽으로 당긴 일이 있음. 교사의 안내로 차례를 말로 부탁함. 또래에게 미안해라고 말함.",
    }
    text = render_journal(data, "입력", ())
    assert text.count("삽 손잡이") == 1 and text.count("차례를 말로 부탁") == 1
    assert "미안해라고 말함" in text  # 앞에 없던 사실은 남는다


def test_a_handoff_does_not_imply_that_children_played_together():
    evidence = "또래에게 자동차 한 대를 건넸다."
    observed = "또래에게 자동차 한 대를 건넴."
    together = "또래와 자동차를 건네며 함께 놀이하는 경험을 함."
    data = {"content": observed, "learning": [{"areas": ["사회관계"], "evidence": evidence, "text": together}]}
    assert render_journal(data, evidence, ("사회관계",)) == observed
    assert render_journal(data, f"{evidence} 또래가 자동차를 받았다.", ("사회관계",)) == observed
    assert render_journal(data, f"{evidence} 또래와 함께 자동차 놀이를 했다.", ("사회관계",)) == f"{observed} {together}"


def test_individual_draft_only_uses_an_activity_time_with_evidence():
    source = "두 손으로 초록색 공을 한 번 굴렸다."
    notice = "유나는 오늘 오후 자유놀이 시간에 두 손으로 초록색 공을 한 번 굴렸어요."
    journal = "오후 자유놀이 시간(14:10~14:40) 두 손으로 초록색 공을 한 번 굴림."
    assert drop_unconfirmed_time_prefix(notice, source=source, confirmed_time=None, child_name="유나") == (
        "유나는 두 손으로 초록색 공을 한 번 굴렸어요."
    )
    assert drop_unconfirmed_time_prefix(journal, source=source, confirmed_time=None) == "두 손으로 초록색 공을 한 번 굴림."
    assert drop_unconfirmed_time_prefix(journal, source=source, confirmed_time="오후 자유놀이") == journal
    assert drop_unconfirmed_time_prefix(journal, source=f"그 시간에는 {source}", confirmed_time=None) == journal


def test_different_facts_that_share_a_few_words_are_kept():
    parts = ["친구에게 삽을 건넴.", "친구에게 미안하다고 말함.", "낙엽을 두 손 가득 모음.", "낙엽을 바구니에 담음."]
    assert drop_repeated_sentences(parts) == parts


def test_a_longer_later_sentence_with_a_new_fact_is_not_dropped():
    parts = ["블록으로 다리를 만듦.", "블록으로 다리를 만들다 무너지자 받침을 하나 더 놓아 다시 시험해 봄."]
    assert drop_repeated_sentences(parts) == parts


def test_exact_repeats_are_dropped_but_short_sentences_are_left_alone():
    assert drop_repeated_sentences(["낙엽을 두 손 가득 모음.", "낙엽을 두 손 가득 모음."]) == ["낙엽을 두 손 가득 모음."]
    assert drop_repeated_sentences(["웃음.", "웃음."]) == ["웃음.", "웃음."]
