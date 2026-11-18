"""Dataset validation, deterministic checks and score aggregation."""

from collections import Counter
import json


METRICS = ("AC1", "AC2", "AC3", "AC4", "AC5", "AC6", "표시·안내")
CASE_SCOPES = ("mvp", "future", "out_of_scope")
OPERATIONS = {"draft", "recording", "save", "confirm", "request_send"}
CHILD_ROLES = {"C01", "C02", "C03"}
CHECK_OPERATIONS = {"equals", "contains", "one_of", "at_least", "nonempty"}
MISSING = object()


def load_evalset(path):
    cases = []
    seen = set()
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            case = json.loads(line)
            validate_case(case)
            if case["id"] in seen:
                raise ValueError("중복 ID")
        except (ValueError, TypeError, KeyError) as error:
            raise ValueError(f"{path.name} {line_number}행: {error}") from error
        cases.append(case)
        seen.add(case["id"])
    if len(cases) < 20:
        raise ValueError("평가 케이스는 20개 이상이어야 합니다.")
    return cases


def validate_case(case):
    if not isinstance(case, dict) or set(case) - {"scope"} != {"id", "category", "query", "expect", "graders", "note"}:
        raise ValueError("케이스 키를 확인하세요.")
    if case.get("scope", "mvp") not in CASE_SCOPES:
        raise ValueError("지원하지 않는 평가 범위")
    if any(not isinstance(case[key], str) or not case[key].strip() for key in ("id", "category", "note")):
        raise ValueError("케이스 ID·분류·메모는 필수입니다.")
    query, expected = case["query"], case["expect"]
    operation, children = query["operation"], query["children"]
    if (operation not in OPERATIONS or not isinstance(children, list) or not children
            or len(set(children)) != len(children) or not set(children) <= CHILD_ROLES):
        raise ValueError("지원하지 않는 평가 실행 입력")
    blocks = query.get("blocks", {})
    if (not isinstance(blocks, dict) or set(blocks) - (set(children) | {"common"})
            or any(not isinstance(text, str) for text in blocks.values())):
        raise ValueError("관찰 입력과 아동 명단이 일치해야 합니다.")
    if operation == "recording" and (not isinstance(query.get("transcript"), str) or not query["transcript"].strip()):
        raise ValueError("녹음 사례에는 가상 전사문이 필요합니다.")
    if "scope_answer" in query and query["scope_answer"] not in children:
        raise ValueError("교사 확인 대상이 아동 명단에 없습니다.")
    if operation in {"save", "confirm", "request_send"} and query.get("target") not in children:
        raise ValueError("동작을 적용할 아동이 아동 명단에 없습니다.")
    if operation == "request_send" and not str(query.get("instruction") or "").strip():
        raise ValueError("발송 요청에는 예시 지시가 필요합니다.")
    if set(expected) != {"code", "judge"} or any(not isinstance(rows, list) for rows in expected.values()):
        raise ValueError("expect는 code·judge 목록이어야 합니다.")
    required_graders = {key for key, rows in expected.items() if rows}
    if not required_graders or set(case["graders"]) != required_graders or len(case["graders"]) != len(required_graders):
        raise ValueError("graders가 expect와 일치해야 합니다.")
    names = set()
    for grader, rows in expected.items():
        for rule in rows:
            if rule["metric"] not in METRICS or not isinstance(rule["name"], str) or not rule["name"].strip() or rule["name"] in names:
                raise ValueError("미등록 지표 또는 중복 판정 기준")
            names.add(rule["name"])
            if grader == "judge":
                if not isinstance(rule["rule"], str) or not rule["rule"].strip() or rule.get("tolerated"):
                    raise ValueError("AI 판정 문장과 필수 기준을 확인하세요.")
                continue
            if not isinstance(rule["path"], str) or not rule["path"].strip() or rule["op"] not in CHECK_OPERATIONS:
                raise ValueError("잘못된 검사 경로 또는 연산자")
            if rule["op"] != "nonempty" and "value" not in rule:
                raise ValueError("검사의 기대값이 없습니다.")
            if ((rule["op"] == "one_of" and not isinstance(rule["value"], list))
                    or (rule["op"] == "contains" and not isinstance(rule["value"], str))
                    or (rule["op"] == "at_least" and type(rule["value"]) not in (int, float))):
                raise ValueError("검사의 기대값 형식이 올바르지 않습니다.")
            if rule.get("tolerated", False) and rule["metric"] != "표시·안내":
                raise ValueError("표시·안내 이외에는 실패를 허용할 수 없습니다.")


def mvp_cases(cases):
    selected = [case for case in cases if case.get("scope", "mvp") == "mvp"]
    if not selected:
        raise ValueError("MVP 범위에 해당하는 평가 케이스가 필요합니다.")
    return selected


def get_path(value, path):
    for part in path.split("."):
        if not isinstance(value, dict) or part not in value:
            return MISSING
        value = value[part]
    return value


def matches(actual, operation, expected):
    if actual is MISSING:
        return False
    if operation == "equals":
        return type(actual) is type(expected) and actual == expected
    if operation == "contains":
        return isinstance(actual, str) and isinstance(expected, str) and expected in actual
    if operation == "one_of":
        return any(type(actual) is type(choice) and actual == choice for choice in expected)
    if operation == "at_least":
        return type(actual) in (int, float) and actual >= expected
    if operation == "nonempty":
        return bool(actual.strip() if isinstance(actual, str) else actual)
    raise ValueError(f"지원하지 않는 검사 {operation}")


def normalize_judge(data, criteria):
    names = {rule["name"] for rule in criteria}
    if not isinstance(data, dict) or set(data) != names:
        raise ValueError("AI 판정 기준의 키가 일치하지 않습니다.")
    for value in data.values():
        if (not isinstance(value, dict) or set(value) != {"reason", "pass"}
                or type(value["pass"]) is not bool or not isinstance(value["reason"], str) or not value["reason"].strip()):
            raise ValueError("AI 판정에는 근거 문자열과 true/false가 필요합니다.")
    return data


def grade_case(case, output, *, case_error=None, judge=None, judge_error=None):
    checks = []
    for rule in case["expect"]["code"]:
        actual = get_path(output, rule["path"])
        try:
            passed = matches(actual, rule["op"], rule.get("value")) if not case_error else None
            status = "error" if case_error else "pass" if passed else "fail"
        except (ValueError, TypeError):
            status = "error"
        checks.append({"grader": "code", "name": rule["name"], "metric": rule["metric"], "status": status,
                       "missing": actual is MISSING, "actual": None if actual is MISSING else actual,
                       "tolerated": bool(rule.get("tolerated"))})
    for rule in case["expect"]["judge"]:
        value = judge[rule["name"]] if judge is not None else None
        error = case_error or judge_error
        if error:
            status = "error"
        elif value is None:
            status = "pending"
        else:
            status = "pass" if value["pass"] else "fail"
        checks.append({"grader": "judge", "name": rule["name"], "metric": rule["metric"], "status": status,
                       "reason": error or (value["reason"] if value else None), "tolerated": False})
    status = group_status(checks)
    failures = [check for check in checks if check["status"] == "fail"]
    tolerated = (status == "fail" and all(check["tolerated"] for check in failures)
                 and all(check["status"] in {"pass", "fail"} for check in checks))
    return {"id": case["id"], "category": case["category"], "graders": case["graders"], "query": case["query"],
            "expect": case["expect"], "output": output, "case_error": case_error, "judge_error": judge_error,
            "checks": checks, "status": status, "tolerated": tolerated}


def group_status(checks):
    statuses = {check["status"] for check in checks}
    for status in ("error", "fail", "pending"):
        if status in statuses:
            return status
    return "pass"


def summarize(rows, judge_validated=False):
    counts = Counter(row["status"] for row in rows)
    allowed_failures = int(any(check["tolerated"] for row in rows for check in row["checks"]))
    minimum_passes = len(rows) - allowed_failures
    tolerated_failures = sum(row["tolerated"] for row in rows)
    hard_failures = counts["fail"] + counts["error"] - tolerated_failures
    judge_used = any("judge" in row["graders"] for row in rows)
    judged_pending = sum(any(check["status"] == "pending" and check["grader"] == "judge" for check in row["checks"])
                         for row in rows)
    if hard_failures or tolerated_failures > allowed_failures:
        status = "fail"
    elif counts["pending"] or (judge_used and not judge_validated):
        status = "pending"
    else:
        status = "pass" if counts["pass"] >= minimum_passes else "fail"
    metrics = {}
    for metric in METRICS:
        outcomes = []
        for row in rows:
            checks = [check for check in row["checks"] if check["metric"] == metric]
            if checks:
                outcomes.append(group_status(checks))
        metric_counts = Counter(outcomes)
        metrics[metric] = {"total": len(outcomes), **{status: metric_counts[status] for status in ("pass", "fail", "error", "pending")}}
    return {"status": status, "total": len(rows), **{status: counts[status] for status in ("pass", "fail", "error", "pending")},
            "judge_pending_cases": judged_pending, "tolerated_failures": tolerated_failures, "hard_failures": hard_failures,
            "minimum_passes": minimum_passes, "metrics": metrics}
