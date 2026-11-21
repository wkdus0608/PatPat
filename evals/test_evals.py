"""Fault injection for the evaluator itself, independent of product and judge services."""

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from grading import grade_case, load_evalset, mvp_cases, normalize_judge, summarize, validate_case
from patpat_adapter import (
    PatPatCase, build_template, count_chars, find_foreign_names, find_plain_style, find_time_ranges, read_template_cells,
    split_sentences,
)
from run_evals import judge_agreement, judge_evidence
from teacher_sim import NO_MEMORY, FakeTeacher, build_user_text


CASES = {case["id"]: case for case in load_evalset(Path(__file__).with_name("evalset.jsonl"))}
HOLDOUT = {case["id"]: case for case in load_evalset(Path(__file__).with_name("evalset_holdout.jsonl"))}


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
        self.assertEqual(len(selected), 36)  # 기존 17건 + 동료 피드백 EV-21~28 + 사용자 기준 EV-29~34 + 질문 경로 EV-35~39
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

    def test_two_unobserved_children_case_fails_on_any_individual_row_or_judged_experience(self):
        case = CASES["EV-28"]
        failed = grade_case(case, {"journals": {"C02": {"individual_rows": 0}, "C03": {"individual_rows": 1}}})
        self.assertEqual([check["status"] for check in failed["checks"]], ["pass", "fail", "pending"])
        verdict = {"unobserved_children_journals_have_no_personal_experience": {"reason": "개인 경험 문장이 있다.", "pass": False}}
        clean = {"journals": {"C02": {"individual_rows": 0}, "C03": {"individual_rows": 0}}}
        self.assertEqual(grade_case(case, clean, judge=normalize_judge(verdict, case["expect"]["judge"]))["status"], "fail")

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
        answered = judge_evidence({"output": {**output, "flow": {**output["flow"], "teacher_answers": [{"role": "C01", "answered": True}]}},
                                   "query": {"evidence": ["flow"]}})
        self.assertEqual(answered["flow"]["teacher_answers"], [{"role": "C01", "answered": True}])
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
            {**draft, "query": {**draft["query"], "names": {"C09": "민서"}}},
            {**CASES["EV-25"], "query": {**CASES["EV-25"]["query"], "names": {"C01": "민서", "C02": "민서"}}},
            {**CASES["EV-31"], "query": {**CASES["EV-31"]["query"], "incident_answer": "모르겠음"}},
        )
        for case in invalid:
            with self.subTest(query=case["query"].get("meta") or case["query"].get("target")):
                with self.assertRaises(ValueError):
                    validate_case(case)


class UserStandardTests(unittest.TestCase):
    """2026-11-21 사용자 기준(색칠 사실, 불참 이유, 부상은 길고 상세하게, 존댓말, 사소한 일도 길고 상세하게)의 오답 주입."""

    LONG_POLITE = {"chars": 520, "individual_chars": 520, "polite_violations": []}

    def test_plain_style_detector_flags_plain_and_record_endings_only(self):
        self.assertEqual(find_plain_style("바깥놀이 중 다친 일이 있었다. 다친 부위는 확인되지 않았다."),
                         ["바깥놀이 중 다친 일이 있었다.", "다친 부위는 확인되지 않았다."])
        self.assertEqual(find_plain_style("이든이는 블록을 쌓았답니다^^ 선생님이 안내했습니다. 친구에게 \"미안해\"라고 말했어요😊"), [])
        self.assertEqual(find_plain_style("특이사항\n오른쪽 무릎이 까졌어요.\n부위 확인 필요\n처치 확인 필요"), [])
        self.assertEqual(find_plain_style("다치지 않았음. 안내 드렸어요."), ["다치지 않았음."])
        self.assertEqual(find_plain_style("하원 시 안내 드리도록 하겠습니다..! 좋을 것 같습니다^^"), [])

    def test_length_helpers_count_characters_without_newlines_and_split_sentences(self):
        self.assertEqual(count_chars("가나 다\n라"), 5)
        self.assertEqual(split_sentences("첫째예요. 둘째예요!\n셋째예요.."), ["첫째예요.", "둘째예요!", "셋째예요.."])

    def test_injury_cases_fail_on_a_one_line_notice_and_pass_on_a_long_polite_one(self):
        short = {"notices": {"C02": {"chars": 33, "individual_chars": 33, "polite_violations": []}}}
        for case_id in ("EV-11", "EV-33"):
            with self.subTest(case=case_id):
                row = grade_case(CASES[case_id], short)
                self.assertEqual(row["status"], "fail")
                self.assertEqual({c["name"]: c["status"] for c in row["checks"]}["injury_notice_is_long_enough"], "fail")
                longer = grade_case(CASES[case_id], {"notices": {"C02": {**self.LONG_POLITE, "special_notes": "x"}}})
                statuses = {c["name"]: c["status"] for c in longer["checks"] if c["grader"] == "code"}
                self.assertEqual(statuses["injury_notice_is_long_enough"], "pass")
                self.assertEqual(statuses["injury_notice_is_polite"], "pass")

    def test_every_injury_case_fails_on_a_plain_style_sentence(self):
        for case_id in ("EV-11", "EV-13", "EV-14", "EV-33"):
            with self.subTest(case=case_id):
                output = {"notices": {"C02": {**self.LONG_POLITE, "text": "x", "incident": True, "special_notes": "x",
                                              "polite_violations": ["다친 일이 있었다."]}}}
                row = grade_case(CASES[case_id], output)
                polite = [c for c in row["checks"] if c["name"] in ("notice_is_polite", "injury_notice_is_polite")]
                self.assertEqual([c["status"] for c in polite], ["fail"])

    def test_nonparticipation_cases_need_the_reason(self):
        for case_id, name in (("EV-10", "nonparticipation_reason_handled"), ("EV-29", "nonparticipation_reason_in_notice")):
            with self.subTest(case=case_id):
                criteria = {rule["name"] for rule in CASES[case_id]["expect"]["judge"]}
                self.assertIn(name, criteria)
                verdict = {rule["name"]: {"reason": "근거", "pass": rule["name"] != name} for rule in CASES[case_id]["expect"]["judge"]}
                output = {"notices": {"C03": {"common_prefix": True, "polite_violations": []}}}
                row = grade_case(CASES[case_id], output, judge=normalize_judge(verdict, CASES[case_id]["expect"]["judge"]))
                self.assertEqual(row["status"], "fail")
        self.assertEqual(CASES["EV-10"]["query"]["evidence"], ["flow"])

    def test_coloring_must_be_stated_for_the_child_who_colored(self):
        rule = CASES["EV-07"]["expect"]["judge"][0]["rule"]
        self.assertIn("색칠까지 했다는 사실이 문장으로 직접 서술", rule)
        self.assertIn("‘확인 필요’ 표기로 바꾸거나 빠뜨리면 실패", rule)

    def test_long_detailed_cases_fail_when_short_or_plain_and_wait_for_the_judge_when_long(self):
        for case_id, role, floor in (("EV-30", "C01", 500), ("EV-31", "C01", 500)):
            with self.subTest(case=case_id):
                short = grade_case(CASES[case_id], {"notices": {role: {"individual_chars": floor - 1, "polite_violations": []}}})
                self.assertEqual(short["status"], "fail")
                plain = grade_case(CASES[case_id], {"notices": {role: {"individual_chars": floor, "polite_violations": ["했다."]}}})
                self.assertEqual(plain["status"], "fail")
                ok = grade_case(CASES[case_id], {"notices": {role: {"individual_chars": floor, "polite_violations": []}}})
                self.assertEqual({c["status"] for c in ok["checks"] if c["grader"] == "code"}, {"pass"})
                self.assertEqual(ok["status"], "pending")

    def test_journal_length_case_fails_below_the_floor(self):
        self.assertEqual(grade_case(CASES["EV-32"], {"journals": {"C01": {"chars": 249}}})["checks"][0]["status"], "fail")
        self.assertEqual(grade_case(CASES["EV-32"], {"journals": {"C01": {"chars": 250}}})["checks"][0]["status"], "pass")

    def test_thin_input_case_needs_a_long_polite_notice_and_a_judged_absence_of_new_facts(self):
        case = CASES["EV-34"]
        short = grade_case(case, {"notices": {"C01": {"chars": 40, "polite_violations": []}}})
        self.assertEqual(short["status"], "fail")
        plain = grade_case(case, {"notices": {"C01": {"chars": 520, "polite_violations": ["쌓았다."]}}})
        self.assertEqual(plain["status"], "fail")
        long_polite = {"notices": {"C01": {"chars": 520, "polite_violations": []}}}
        self.assertEqual(grade_case(case, long_polite)["status"], "pending")
        verdict = {"long_without_new_facts": {"reason": "새 사실이 있다.", "pass": False}}
        failed = grade_case(case, long_polite, judge=normalize_judge(verdict, case["expect"]["judge"]))
        self.assertEqual(failed["status"], "fail")

    def test_length_floors_do_not_depend_on_how_much_was_entered(self):
        floors = {}
        for case_id in ("EV-11", "EV-30", "EV-31", "EV-33", "EV-34"):
            rules = [rule for rule in CASES[case_id]["expect"]["code"] if rule["op"] == "at_least"]
            self.assertEqual(len(rules), 1, case_id)
            floors[case_id] = rules[0]["value"]
        # 사용자 결정: 분량은 입력 분량에 비례하지 않는다. 입력이 한 줄이든 여덟 줄이든 같은 기준이다.
        self.assertEqual(set(floors.values()), {500})


class ThinInputQuestionTests(unittest.TestCase):
    """2026-11-21 사용자 결정: 얇은 입력의 아이에게만 질문 1~2개로 사실을 더 모은 뒤 길게 쓴다(질문 경로 평가)."""
    DEV = ("EV-35", "EV-36", "EV-37", "EV-38", "EV-39")

    @staticmethod
    def stub(query, teacher=None):
        case = PatPatCase.__new__(PatPatCase)
        case.child_ids = {"C01": "id-1", "C02": "id-2", "C03": "id-3"}
        case.roles = {value: key for key, value in case.child_ids.items()}
        case.query = query
        case.teacher = teacher
        return case

    @staticmethod
    def flag(flag_id, kind, child_id, *, options=(), status="open"):
        return {"flag_id": flag_id, "kind": kind, "child_ids": [child_id] if child_id else [], "question": f"{flag_id}?",
                "options": list(options), "status": status}

    def test_at_most_passes_up_to_the_limit_and_never_for_an_absent_key(self):
        case = CASES["EV-37"]
        output = {"flow": {"questions_by_role": {"C01": 2, "C02": 2, "C03": 0}, "question_count": 6},
                  "notices": {role: {"polite_violations": []} for role in ("C01", "C02", "C03")}}
        row = grade_case(case, output)
        self.assertEqual({c["status"] for c in row["checks"] if c["grader"] == "code"}, {"pass"})
        over = {"flow": {"questions_by_role": {"C01": 3, "C02": 2, "C03": 1}, "question_count": 7}, "notices": output["notices"]}
        failed = {c["name"] for c in grade_case(case, over)["checks"] if c["status"] == "fail"}
        self.assertEqual(failed, {"c01_questions_within_two", "rich_child_is_not_asked", "class_questions_within_six"})
        absent = grade_case(case, {"flow": {}, "notices": output["notices"]})
        self.assertTrue(all(c["status"] == "fail" for c in absent["checks"] if c["name"] == "rich_child_is_not_asked"))

    def test_thin_input_question_case_needs_a_question_a_long_polite_notice_and_a_judged_absence_of_new_facts(self):
        case = CASES["EV-35"]
        good = {"flow": {"questions_by_role": {"C01": 1}}, "notices": {"C01": {"chars": 520, "polite_violations": []}}}
        self.assertEqual(grade_case(case, good)["status"], "pending")
        no_question = {**good, "flow": {"questions_by_role": {"C01": 0}}}
        self.assertEqual(grade_case(case, no_question)["checks"][0]["status"], "fail")
        three = {**good, "flow": {"questions_by_role": {"C01": 3}}}
        self.assertEqual(grade_case(case, three)["checks"][1]["status"], "fail")
        short = {**good, "notices": {"C01": {"chars": 120, "polite_violations": []}}}
        self.assertEqual(grade_case(case, short)["status"], "fail")
        verdict = {rule["name"]: {"reason": "근거", "pass": rule["name"] != "answers_kept_in_detail_without_new_facts"}
                   for rule in case["expect"]["judge"]}
        failed = grade_case(case, good, judge=normalize_judge(verdict, case["expect"]["judge"]))
        self.assertEqual(failed["status"], "fail")

    def test_rich_control_cases_must_not_ask_and_must_stay_long(self):
        for case in (CASES["EV-39"], HOLDOUT["HO-04"]):
            with self.subTest(case=case["id"]):
                self.assertNotIn("teacher_facts", case["query"])
                role = case["query"]["children"][0]
                asked = grade_case(case, {"flow": {"questions_by_role": {role: 1}},
                                          "notices": {role: {"chars": 600, "polite_violations": []}}})
                self.assertEqual(asked["checks"][0]["status"], "fail")
                short = grade_case(case, {"flow": {"questions_by_role": {role: 0}},
                                          "notices": {role: {"chars": 300, "polite_violations": []}}})
                self.assertEqual(short["status"], "fail")

    def test_teacher_facts_are_validated(self):
        base = CASES["EV-35"]
        invalid = (
            {**base, "query": {**base["query"], "teacher_facts": {"C02": ["사실"]}}},
            {**base, "query": {**base["query"], "teacher_facts": {"C01": []}}},
            {**base, "query": {**base["query"], "teacher_facts": {"C01": [" "]}}},
            {**base, "query": {**base["query"], "teacher_facts": ["사실"]}},
            {**base, "query": {**base["query"], "evidence": []}},
        )
        for case in invalid:
            with self.subTest(facts=case["query"].get("teacher_facts"), evidence=case["query"].get("evidence")):
                with self.assertRaises(ValueError):
                    validate_case(case)

    def test_holdout_files_may_be_small_but_the_main_set_may_not(self):
        with TemporaryDirectory() as directory:
            lines = [Path(__file__).with_name("evalset_holdout.jsonl").read_text(encoding="utf-8")]
            small = Path(directory) / "evalset_holdout.jsonl"
            small.write_text(lines[0], encoding="utf-8")
            self.assertEqual(len(load_evalset(small)), 5)
            plain = Path(directory) / "evalset_dev.jsonl"
            plain.write_text(lines[0], encoding="utf-8")
            with self.assertRaises(ValueError):
                load_evalset(plain)

    def test_the_simulated_teacher_answers_only_free_text_questions_about_children_with_facts(self):
        case = self.stub({"blocks": {"C01": "메모"}, "teacher_facts": {"C01": ["사실 하나.", "사실 둘."]}}, FakeTeacher())
        flags = [self.flag("f1", "missing_fact", "id-1"), self.flag("f2", "incident", "id-1", options=("부드럽게", "그대로")),
                 self.flag("f3", "missing_fact", "id-2"), self.flag("f4", "ambiguous", "id-1", options=("네", "아니요")),
                 self.flag("f5", "missing_fact", "id-1", status="skipped")]
        log = []
        self.assertEqual(case.teacher_answers(flags, log), [{"flag_id": "f1", "answer": "사실 하나. 사실 둘."}])
        self.assertEqual([item["question"] for item in log], ["f1?"])

    def test_a_teacher_who_does_not_remember_skips_the_question(self):
        class Forgetful:
            def answer(self, **_):
                return NO_MEMORY
        case = self.stub({"blocks": {"C01": "메모"}, "teacher_facts": {"C01": ["사실"]}}, Forgetful())
        log = []
        self.assertEqual(case.teacher_answers([self.flag("f1", "missing_fact", "id-1")], log), [])
        self.assertEqual([item["answered"] for item in log], [False])

    def test_question_counts_include_every_role_and_leave_out_incident_confirmation(self):
        case = self.stub({})
        case.child_ids = {"C01": "id-1", "C02": "id-2"}
        flags = [self.flag("a", "missing_fact", "id-1"), self.flag("b", "missing_fact", "id-1"), self.flag("c", "incident", "id-2"),
                 self.flag("d", "ambiguous", None)]
        self.assertEqual(case.question_counts(flags), {"C01": 2, "C02": 0, "common": 1})

    def test_the_teacher_prompt_carries_only_that_childs_facts_and_the_question(self):
        text = build_user_text(memo="그림책을 읽었다.", facts=["곰을 가리켰다."], question="무엇을 했나요?")
        for expected in ("그림책을 읽었다.", "- 곰을 가리켰다.", "무엇을 했나요?"):
            self.assertIn(expected, text)

    def test_holdout_scenes_do_not_reuse_development_inputs(self):
        def texts(cases):
            return {block for case in cases for block in case["query"].get("blocks", {}).values()}
        self.assertFalse(texts(CASES.values()) & texts(HOLDOUT.values()))
        self.assertFalse(set(CASES) & set(HOLDOUT))
        facts = {fact for case in HOLDOUT.values() for items in case["query"].get("teacher_facts", {}).values() for fact in items}
        dev_facts = {fact for case in CASES.values() for items in case["query"].get("teacher_facts", {}).values() for fact in items}
        self.assertFalse(facts & dev_facts)

    def test_every_answering_case_shows_the_judge_the_questions_and_answers(self):
        for case in (*(CASES[case_id] for case_id in self.DEV), *HOLDOUT.values()):
            with self.subTest(case=case["id"]):
                if case["query"].get("teacher_facts"):
                    self.assertIn("flow", case["query"]["evidence"])
                    self.assertTrue(any("teacher_answers" in rule["rule"] for rule in case["expect"]["judge"]))

    def test_all_new_notice_floors_are_the_same_fixed_value(self):
        floors = set()
        for case in (*(CASES[case_id] for case_id in self.DEV), *HOLDOUT.values()):
            floors |= {rule["value"] for rule in case["expect"]["code"] if rule["op"] == "at_least" and rule["path"].endswith("chars")}
        self.assertEqual(floors, {500})
