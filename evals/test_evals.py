"""Fault injection for the evaluator itself, independent of product and judge services."""

from pathlib import Path
import unittest

from grading import grade_case, load_evalset, mvp_cases, normalize_judge, summarize
from run_evals import judge_agreement


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
        self.assertEqual(len(selected), 17)
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
