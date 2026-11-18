"""Run the current PatPat API contract against the YAML golden cases."""

from pathlib import Path
import re

from fastapi.testclient import TestClient
import pytest
import yaml

from evals.grading import get_path, matches
from evals.patpat_adapter import run_patpat_case

from app.core.config import Settings
from app.main import create_app


CASE_FILE = Path(__file__).with_name("harness") / "golden_cases.yaml"
CASES = yaml.safe_load(CASE_FILE.read_text(encoding="utf-8"))["cases"]
if not CASES or len({case["id"] for case in CASES}) != len(CASES):
    raise ValueError("골든 케이스는 고유한 ID와 함께 하나 이상 등록해야 합니다.")


def assert_golden(case, output):
    assert case["ac"] and case["expect"], f'{case["id"]}: 수용 기준과 기대 결과가 필요합니다.'
    for check in case["expect"]:
        path, operation, expected = check["path"], check["op"], check.get("value")
        actual = get_path(output, path)
        if operation == "not_contains":
            passed = isinstance(actual, str) and expected not in actual
        else:
            passed = matches(actual, operation, expected)
        assert passed, f'{case["id"]} [{case["ac"]}] {path}: {operation} {expected!r}, 실제 {actual!r}'


@pytest.mark.parametrize("case", CASES, ids=[case["id"] for case in CASES])
def test_patpat_golden_case(case, tmp_path):
    query = case["query"]
    if query["operation"] == "health":
        settings = Settings(database_path=str(tmp_path / "golden.sqlite3"), ai_provider="fake")
        with TestClient(create_app(settings)) as client:
            response = client.get("/health")
        output = {"status_code": response.status_code, "body": response.json()}
    else:
        output = run_patpat_case(query, mode="fake")
    assert_golden(case, output)


@pytest.mark.parametrize(("case_id", "path", "fault"), [
    ("GC-V2-06", "flow.notices_before_answer", 1),
    ("GC-V2-07", "action.status", "완료"),
])
def test_golden_harness_detects_a_fault_in_api_output(case_id, path, fault):
    case = next(case for case in CASES if case["id"] == case_id)
    output = run_patpat_case(case["query"], mode="fake")
    assert_golden(case, output)

    section, key = path.rsplit(".", 1)
    get_path(output, section)[key] = fault
    with pytest.raises(AssertionError, match=rf"{case_id}.*{re.escape(path)}"):
        assert_golden(case, output)
