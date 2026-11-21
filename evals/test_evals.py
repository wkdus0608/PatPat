"""Fault injection for the evaluator itself, independent of product and judge services."""

from pathlib import Path
import unittest

from grading import grade_case, load_evalset, mvp_cases, normalize_judge, summarize, validate_case
from patpat_adapter import build_template, find_foreign_names, find_time_ranges, read_template_cells
from run_evals import judge_agreement, judge_evidence


CASES = {case["id"]: case for case in load_evalset(Path(__file__).with_name("evalset.jsonl"))}


class EvalPolicyTests(unittest.TestCase):
    def test_premature_completion_is_a_hard_failure(self):
        row = grade_case(CASES["EV-15"], {"action": {"status": "완료", "can_share": True, "confirmed_at": "2026-11-06"}})
        self.assertEqual(row["status"], "fail")
        self.assertEqual(summarize([row])["hard_failures"], 1)

    def test_unmasked_name_in_provider_request_is_a_hard_failure(self):
        row = grade_case(CASES["EV-17"], {"provider": {"calls": 1, "roles_with_unmasked_names": ["C01"]}})
        self.assertEqual(row["status"], "fail")
        self.assertFalse(row["tolerated"])

    def test_incident_flag_alone_does_not_satisfy_special_section(self):
        row = grade_case(CASES["EV-12"], {"notices": {"C02": {"incident": True, "special_notes": ""}}})
        self.assertEqual(row["status"], "fail")
        self.assertEqual(row["checks"][0]["status"], "fail")
        self.assertEqual(row["checks"][1]["status"], "pending")

    def test_care_confirmation_alone_does_not_satisfy_conflicting_side_check(self):
        output = {"notices": {"C02": {"text": "무릎이 까졌다.\n처치 확인 필요"}}}
        row = grade_case(CASES["EV-14"], output)
        self.assertEqual(row["checks"][0]["status"], "fail")
        output["notices"]["C02"]["text"] += "\n좌우 확인 필요"
        self.assertEqual(grade_case(CASES["EV-14"], output)["checks"][0]["status"], "pass")

    def test_absent_key_is_different_from_observed_null(self):
        row = grade_case(CASES["EV-15"], {"action": {"status": "검토중", "can_share": False}})
        missing = next(check for check in row["checks"] if check["name"] == "no_confirmation_timestamp")
        self.assertEqual(missing["status"], "fail")
        self.assertTrue(missing["missing"])

    def test_invalid_judge_reply_is_counted_as_an_error(self):
        case = CASES["EV-03"]
        with self.assertRaises(ValueError):
            normalize_judge("통과입니다", case["expect"]["judge"])
        with self.assertRaises(ValueError):
            normalize_judge({"preserve_negation": {"reason": "문장 비교", "pass": "true"}}, case["expect"]["judge"])
        row = grade_case(case, {}, judge_error="BAD_JUDGE_OUTPUT")
        self.assertEqual(summarize([row])["error"], 1)
        self.assertEqual(summarize([row])["hard_failures"], 1)

    def test_missing_common_observation_accepts_an_individual_only_draft(self):
        case = CASES["EV-09"]
        output = {"common_text": "", "notices": {"C01": {"individual_text": "종이배를 만들었다."}}}
        passing = grade_case(case, output)
        self.assertEqual(passing["status"], "pass")
        self.assertEqual(summarize([passing])["minimum_passes"], 1)
        self.assertEqual(grade_case(case, {**output, "common_text": "반 전체가 종이를 접었다."})["status"], "fail")
        self.assertEqual(grade_case(case, {**output, "notices": {}})["status"], "fail")

    def test_mvp_excludes_future_privacy_and_out_of_scope_delivery(self):
        selected = {case["id"] for case in mvp_cases(CASES.values())}
        excluded = set(CASES) - selected
        self.assertEqual(len(selected), 24)  # 기존 17건 + 동료 피드백에서 도출한 EV-21~27
        self.assertEqual({case_id: CASES[case_id]["scope"] for case_id in excluded},
                         {"EV-17": "future", "EV-18": "future", "EV-19": "out_of_scope"})

    def test_legacy_notice_tolerance_covers_one_failure_and_never_sharing(self):
        action = {"has_delivery_route": False, "can_share": False, "share_text": None, "unsupported": False}
        support_failure = grade_case(CASES["EV-19"], {"action": action})
        sharing_failure = grade_case(CASES["EV-19"], {"action": {**action, "can_share": True}})
        self.assertEqual(summarize([support_failure])["status"], "pass")
        self.assertEqual(summarize([support_failure, {**support_failure, "id": "테스트-안내"}])["status"], "fail")
        self.assertFalse(sharing_failure["tolerated"])

    def test_unvalidated_llm_passes_cannot_certify_a_run(self):
        case = CASES["EV-03"]
        verdict = {"preserve_negation": {"reason": "입력의 부정이 보존됐다.", "pass": True}}
        row = grade_case(case, {}, judge=normalize_judge(verdict, case["expect"]["judge"]))
        self.assertEqual(summarize([row])["status"], "pending")
        self.assertEqual(summarize([row], judge_validated=True)["status"], "pass")

    def test_missing_judge_verdict_counts_against_agreement(self):
        labels = {"EV-01": {"grounded_sand": True}, "EV-03": {"preserve_negation": False}}
        verdicts = {"EV-01": {"grounded_sand": {"pass": True}}}
        result = judge_agreement(labels, verdicts, "fixture-run")
        self.assertEqual(result["agreement"], 0.5)
        self.assertFalse(result["passed"])

    def test_judge_agreement_requires_eighty_percent(self):
        labels = {"EV-01": {f"check-{index}": True for index in range(10)}}
        for matches, passed in ((7, False), (8, True)):
            with self.subTest(matches=matches):
                verdicts = {"EV-01": {name: {"pass": index < matches} for index, name in enumerate(labels["EV-01"])}}
                result = judge_agreement(labels, verdicts, "fixture-run")
                self.assertEqual(result["threshold"], 0.80)
                self.assertEqual(result["agreement"], matches / 10)
                self.assertEqual(result["passed"], passed)


class FeedbackCaseTests(unittest.TestCase):
    """동료 피드백에서 도출한 EV-21~27이 잘못된 출력을 실제로 실패로 판정하는지 확인한다."""

    def test_unobserved_child_journal_fails_on_an_individual_row_or_a_judged_personal_experience(self):
        case = CASES["EV-21"]
        row = grade_case(case, {"journals": {"C03": {"individual_rows": 1}}})
        self.assertEqual(row["checks"][0]["status"], "fail")
        self.assertEqual(row["checks"][1]["status"], "pending")
        ok = {"journals": {"C03": {"individual_rows": 0}}}
        self.assertEqual(grade_case(case, ok)["checks"][0]["status"], "pass")
        verdict = {"unobserved_child_journal_has_no_personal_experience": {"reason": "개인 경험 문장이 있다.", "pass": False}}
        failed = grade_case(case, ok, judge=normalize_judge(verdict, case["expect"]["judge"]))
        self.assertEqual(failed["status"], "fail")

    def test_tone_case_needs_the_greeting_the_emoji_and_the_ending(self):
        text = "어머님~ 오늘도 블록을 쌓았답니다😊"
        self.assertEqual(grade_case(CASES["EV-23"], {"notices": {"C01": {"text": text}}})["status"], "pass")
        for missing in ("어머님", "😊", "답니다"):
            with self.subTest(missing=missing):
                row = grade_case(CASES["EV-23"], {"notices": {"C01": {"text": text.replace(missing, "")}}})
                self.assertEqual(row["status"], "fail")

    def test_time_range_case_fails_when_a_clock_range_is_pasted(self):
        failing = grade_case(CASES["EV-24"], {"notices": {"C01": {"raw_time_ranges": ["10:00~10:30"]}}})
        self.assertEqual(failing["status"], "fail")
        self.assertEqual(grade_case(CASES["EV-24"], {"notices": {"C01": {"raw_time_ranges": []}}})["status"], "pass")

    def test_name_case_fails_when_an_example_name_is_used(self):
        self.assertEqual(grade_case(CASES["EV-25"], {"integrity": {"foreign_names": ["다온"]}})["status"], "fail")
        self.assertEqual(grade_case(CASES["EV-25"], {"integrity": {"foreign_names": []}})["status"], "pass")

    def test_word_case_flags_empty_cells_a_wrong_teacher_and_a_missing_output(self):
        cells = {"반": "우리 반", "아동명": "평가아동가", "관찰 기간": "2026-11-06", "관찰일": "2026-11-06",
                 "관찰 영역": "예술경험", "관찰 내용": "낙엽을 붙임.", "작성 교사": "가상 평가 교사"}
        self.assertEqual(grade_case(CASES["EV-26"], {"word": {"cells": cells}})["status"], "pass")
        for label in ("관찰 기간", "작성 교사", "반"):
            with self.subTest(empty=label):
                self.assertEqual(grade_case(CASES["EV-26"], {"word": {"cells": {**cells, label: ""}}})["status"], "fail")
        wrong = grade_case(CASES["EV-26"], {"word": {"cells": {**cells, "작성 교사": "다른 교사"}}})
        self.assertEqual(wrong["status"], "fail")
        missing = grade_case(CASES["EV-26"], {})
        self.assertEqual(missing["status"], "fail")
        self.assertTrue(all(check["missing"] for check in missing["checks"]))

    def test_foreign_name_detection_ignores_ordinary_words(self):
        self.assertEqual(find_foreign_names("다온이는 낙엽을 모았어요."), ["다온"])
        self.assertEqual(find_foreign_names("이든이가 블록을 쌓았어요.", "서아는 종이를 접었어요."), ["서아", "이든"])
        self.assertEqual(find_foreign_names("무엇이든 해 보려는 모습이었어요.", "서아프리카 이야기를 했어요."), [])
        self.assertEqual(find_foreign_names("평가아동가는 종이를 접었어요."), [])

    def test_time_range_detection_only_matches_clock_ranges(self):
        self.assertEqual(find_time_ranges("오전 자유놀이(10:00 ~ 10:30)에 놀았어요."), ["10:00~10:30"])
        self.assertEqual(find_time_ranges("오전 10시에 놀았어요. 10:30에 마쳤어요."), [])

    def test_word_template_round_trip_reads_empty_cells(self):
        self.assertEqual(read_template_cells(build_template(["반", "작성 교사"])), {"반": "", "작성 교사": ""})

    def test_judge_evidence_adds_only_the_outputs_a_case_asks_for(self):
        output = {"common_text": "공통", "notices": {}, "flow": {"initial_status": "asking", "initial_questions": ["질문"], "x": 1},
                  "journals": {"C03": {"text": "본문", "items": [{"block_kind": "common", "content": "본문", "status": "ready"}]}}}
        plain = judge_evidence({"output": output, "query": {}})
        self.assertEqual(set(plain), {"common_text", "notices"})
        extended = judge_evidence({"output": output, "query": {"evidence": ["flow", "journals"]}})
        self.assertEqual(extended["flow"], {"initial_status": "asking", "initial_questions": ["질문"]})
        self.assertEqual(extended["journals"]["C03"]["items"], [{"block_kind": "common", "content": "본문"}])

    def test_extended_query_fields_are_validated(self):
        word, journal, draft = CASES["EV-26"], CASES["EV-21"], CASES["EV-24"]
        invalid = (
            {**word, "query": {**word["query"], "target": "C02"}},
            {**word, "query": {**word["query"], "template_fields": ["반"]}},
            {**word, "query": {**word["query"], "template_fields": ["반", "반"]}},
            {**journal, "query": {**journal["query"], "prepare_journals": False}},
            {**draft, "query": {**draft["query"], "meta": {"C09": {"place": "교실"}}}},
            {**draft, "query": {**draft["query"], "meta": {"C01": {"areas": ["없는 영역"]}}}},
            {**draft, "query": {**draft["query"], "evidence": ["secret"]}},
        )
        for case in invalid:
            with self.subTest(query=case["query"].get("meta") or case["query"].get("target")):
                with self.assertRaises(ValueError):
                    validate_case(case)
