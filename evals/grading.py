"""Dataset validation, deterministic checks and score aggregation."""

from collections import Counter
import json


METRICS = ("AC1", "AC2", "AC3", "AC4", "AC5", "AC6", "표시·안내")
CASE_SCOPES = ("mvp", "future", "out_of_scope")
OPERATIONS = {"draft", "recording", "save", "confirm", "request_send", "journal", "word"}
CHILD_ROLES = {"C01", "C02", "C03"}
AREA_NAMES = {"신체운동·건강", "의사소통", "사회관계", "예술경험", "자연탐구"}
BLOCK_META_KEYS = {"place", "time_text", "areas"}
EVIDENCE_KEYS = {"flow", "journals", "word"}  # AI 판정에 함께 보여 줄 출력(초안 외)
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
    validate_extensions(query, operation, children)
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


def validate_extensions(query, operation, children):
    """블록 장소·시간·영역, 말투 예시, 관찰일지·Word 실행에 쓰는 선택 입력(기존 사례에는 없다)."""
    meta = query.get("meta", {})
    if (not isinstance(meta, dict) or set(meta) - (set(children) | {"common"})
            or any(not isinstance(item, dict) or set(item) - BLOCK_META_KEYS for item in meta.values())):
        raise ValueError("블록 추가 정보(meta)는 아동 명단과 허용된 키만 가질 수 있습니다.")
    for item in meta.values():
        if (any(not isinstance(item[key], str) or not item[key].strip() for key in ("place", "time_text") if key in item)
                or ("areas" in item and (not isinstance(item["areas"], list) or not set(item["areas"]) <= AREA_NAMES))):
            raise ValueError("블록 추가 정보의 값이 올바르지 않습니다.")
    names = query.get("names", {})
    if (not isinstance(names, dict) or set(names) - set(children)
            or any(not isinstance(name, str) or not name.strip() for name in names.values())
            or len(set(names.values())) != len(names)):
        raise ValueError("가상 이름(names)은 아동 명단의 역할마다 서로 다른 글이어야 합니다.")
    if "writing_examples" in query and (not isinstance(query["writing_examples"], str) or not query["writing_examples"].strip()):
        raise ValueError("말투 예시는 비어 있지 않은 글이어야 합니다.")
    if "prepare_journals" in query and type(query["prepare_journals"]) is not bool:
        raise ValueError("prepare_journals는 true 또는 false여야 합니다.")
    if "incident_answer" in query and query["incident_answer"] not in ("부드럽게", "그대로"):
        raise ValueError("incident_answer는 부드럽게 또는 그대로여야 합니다.")
    if "evidence" in query and (not isinstance(query["evidence"], list) or not set(query["evidence"]) <= EVIDENCE_KEYS):
        raise ValueError("지원하지 않는 AI 판정 근거 항목입니다.")
    if operation == "journal" and query.get("prepare_journals") is not True:
        raise ValueError("관찰일지 사례는 prepare_journals를 true로 실행합니다.")
    if operation == "word":
        fields = query.get("template_fields")
        if (query.get("target") not in children or not isinstance(fields, list) or len(fields) < 2
                or any(not isinstance(field, str) or not field.strip() for field in fields) or len(set(fields)) != len(fields)):
            raise ValueError("Word 사례에는 대상 아동과 중복 없는 양식 항목 목록이 필요합니다.")


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
