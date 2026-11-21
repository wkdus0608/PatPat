"""Capture product outputs, then score stored outputs after blind human labeling."""

import argparse
import csv
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import NamedTemporaryFile
from uuid import uuid4

from grading import grade_case, load_evalset, mvp_cases, normalize_judge, summarize


EVALS = Path(__file__).resolve().parent
ROOT = EVALS.parent
JUDGE_PROMPT = EVALS / "judge_prompt.md"
EVALSET = EVALS / "evalset.jsonl"
RESULTS = EVALS / "results"
JUDGE_AGREEMENT = 0.80


def digest(path):
    return sha256(path.read_bytes()).hexdigest()


def now():
    return datetime.now(timezone.utc)


def source_commit():
    result = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else "unknown"


def append_history(directory, metadata, summary):
    row = {key: metadata.get(key) or "" for key in ("run_id", "source_run_id", "commit", "change", "mode", "stage", "evalset_hash",
                                                   "judge_version", "judge_model", "judge_status", "golden", "product_model", "rules_hash")}
    row.update({key: summary[key] for key in ("status", "total", "pass", "fail", "error", "pending", "hard_failures", "tolerated_failures")})
    for metric, counts in summary["metrics"].items():
        for key in ("pass", "fail", "pending", "error", "total"):
            row[f"{metric}_{key}"] = counts[key]
    with (directory / "history.csv").open("a+", encoding="utf-8", newline="") as handle:
        if os.name == "nt":
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        handle.seek(0, os.SEEK_END)
        writer = csv.DictWriter(handle, fieldnames=list(row))
        if handle.tell() == 0:
            writer.writeheader()
        writer.writerow(row)
        handle.flush()


def save_result(directory, metadata, rows, validation=None):
    timestamp = now()
    run_id = f"{timestamp:%Y-%m-%dT%H%M%SZ}-{uuid4().hex[:6]}"
    metadata = {**metadata, "run_id": run_id, "created_at": timestamp.isoformat()}
    summary = summarize(rows, judge_validated=bool(validation and validation["passed"]))
    result = {"run": metadata, "summary": summary, "judge_validation": validation, "cases": rows}
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{run_id}.json"
    with NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory, suffix=".tmp", delete=False) as handle:
        temp_path = Path(handle.name)
        try:
            json.dump(result, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        except BaseException:
            handle.close()
            temp_path.unlink(missing_ok=True)
            raise
    try:
        os.link(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)
    append_history(directory, metadata, summary)
    print(f"{metadata['mode']} / {metadata['stage']} / {summary['status']} — "
          f"통과 {summary['pass']}, 실패 {summary['fail']}, 오류 {summary['error']}, 보류 {summary['pending']} "
          f"(총 {summary['total']}건)")
    print(f"AI 판정 대기 {summary['judge_pending_cases']}건 / {path}")
    return {"pass": 0, "fail": 1, "pending": 2}[summary["status"]]


def capture(args):
    from patpat_adapter import AppError, run_patpat_case
    from app.core.config import get_settings
    from app.rules.loader import load_rules

    catalog = load_evalset(args.evalset)
    cases = mvp_cases(catalog)
    included_ids = {case["id"] for case in cases}
    excluded = [{"id": case["id"], "scope": case["scope"]} for case in catalog if case["id"] not in included_ids]
    settings = get_settings()
    if args.mode == "live" and not settings.anthropic_api_key:
        raise ValueError("실제 생성 모델을 실행하려면 ANTHROPIC_API_KEY를 설정하세요.")
    metadata = {"mode": args.mode, "stage": "capture", "commit": source_commit(), "change": args.change,
                "golden": args.golden, "evalset_hash": digest(args.evalset), "judge_version": digest(JUDGE_PROMPT),
                "judge_model": None, "judge_status": "not_run", "product_model": "fake" if args.mode == "fake" else settings.ai_model,
                "product_effort": None if args.mode == "fake" else settings.ai_effort,
                "rules_hash": load_rules(settings.rules_path).rules_hash, "excluded_cases": excluded}
    rows = []
    for case in cases:
        output, error = {}, None
        try:
            output = run_patpat_case(case["query"], args.mode)
        except AppError as failure:
            error = str(failure)
        except Exception as failure:
            error = f"실행기 오류: {type(failure).__name__}"
            print(f"{case['id']}: {error}", file=sys.stderr)
        row = grade_case(case, output, case_error=error)
        rows.append(row)
        print(f"{case['id']} {row['status']}" + (f" — {error}" if error else ""), flush=True)
    return save_result(args.results, metadata, rows)


def judge_evidence(row):
    """AI 판정과 사람 검토에 보여 줄 초안. query.evidence에 적은 출력(질문·관찰일지·Word)만 덧붙인다."""
    output = row["output"]
    draft = {key: output[key] for key in ("common_text", "notices")}
    for key in row["query"].get("evidence", []):
        if key == "flow":
            draft["flow"] = {name: output["flow"][name] for name in ("initial_status", "initial_questions", "teacher_answers")
                             if name in output["flow"]}
        elif key == "journals":
            draft["journals"] = {role: {"text": view["text"],
                                        "items": [{"block_kind": item["block_kind"], "content": item["content"]} for item in view["items"]]}
                                 for role, view in output["journals"].items()}
        elif key == "word":
            draft["word"] = {"cells": output["word"]["cells"]}
    return draft


def read_capture(path):
    capture_result = json.loads(path.read_text(encoding="utf-8"))
    if capture_result["run"]["stage"] != "capture":
        raise ValueError("초안만 저장한 capture 결과를 지정하세요.")
    return capture_result


def review(args):
    capture_result = read_capture(args.capture)
    run_id = capture_result["run"]["run_id"]
    for row in capture_result["cases"]:
        criteria = row["expect"]["judge"]
        if not criteria or row["case_error"]:
            continue
        if args.template:
            print(json.dumps({"run_id": run_id, "id": row["id"], "labeler": "",
                              "labels": {rule["name"]: None for rule in criteria}}, ensure_ascii=False))
            continue
        print(f"\n{row['id']} {row['category']}\n입력: {json.dumps(row['query']['blocks'], ensure_ascii=False)}")
        print(f"공통문: {row['output']['common_text'] or '(비어 있음)'}")
        for role, notice in row["output"]["notices"].items():
            print(f"{role} 개별 문장: {notice['individual_text'] or '(비어 있음)'}")
            if notice["special_notes"]:
                print(f"{role} 특이사항: {notice['special_notes']}")
        extra = {key: value for key, value in judge_evidence(row).items() if key not in ("common_text", "notices")}
        if extra:
            print(f"추가 근거: {json.dumps(extra, ensure_ascii=False)}")
        for rule in criteria:
            print(f"- {rule['name']}: {rule['rule']}")
    return 0


def judge_client(model):
    sys.path.insert(0, str(ROOT / "BE"))
    from app.ai.anthropic_client import AnthropicClient
    from app.ai.types import AIRequest, AITask

    key = (os.getenv("PATPAT_EVAL_JUDGE_API_KEY") or os.getenv("ANTHROPIC_API_KEY") or "").strip()
    if not model or not key:
        raise ValueError("--judge-model(또는 PATPAT_EVAL_JUDGE_MODEL)과 AI 채점 API 키가 필요합니다.")
    client = AnthropicClient(api_key=key, model=model, max_tokens=1800, fallbacks=False)
    prompt = JUDGE_PROMPT.read_text(encoding="utf-8")
    item = {"type": "object", "additionalProperties": False, "required": ["reason", "pass"],
            "properties": {"reason": {"type": "string"}, "pass": {"type": "boolean"}}}

    def evaluate(row):
        criteria = row["expect"]["judge"]
        names = [rule["name"] for rule in criteria]
        schema = {"type": "object", "additionalProperties": False, "required": names,
                  "properties": {name: item for name in names}}
        evidence = {"id": row["id"], "category": row["category"], "query": row["query"], "criteria": criteria,
                    "draft": judge_evidence(row)}
        request = AIRequest(task=AITask.REVIEW, system_text=prompt,
                            user_text=json.dumps(evidence, ensure_ascii=False), schema=schema)
        return normalize_judge(client.complete(request).data, criteria)

    return evaluate


def read_labels(path, capture_result):
    labels = {}
    run_id = capture_result["run"]["run_id"]
    cases = {row["id"]: row for row in capture_result["cases"] if not row["case_error"] and row["expect"]["judge"]}
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("run_id") != run_id or row.get("id") not in cases or row["id"] in labels or not str(row.get("labeler") or "").strip():
            raise ValueError(f"라벨 {number}행의 실행 ID, 케이스 ID, 라벨 작성자를 확인하세요.")
        values = row["labels"]
        names = {item["name"] for item in cases[row["id"]]["expect"]["judge"]}
        if not isinstance(values, dict) or set(values) != names or any(type(value) is not bool for value in values.values()):
            raise ValueError(f"라벨 {number}행에 모든 기준별 true/false를 입력하세요.")
        labels[row["id"]] = values
    if not labels:
        raise ValueError("사람 판정이 비어 있습니다.")
    return labels


def judge_agreement(labels, verdicts, source_run_id):
    total = correct = 0
    mismatches = []
    for case_id, expected in labels.items():
        for criterion, human_value in expected.items():
            total += 1
            case_verdict = verdicts.get(case_id, {}).get(criterion)
            if case_verdict is not None and case_verdict["pass"] == human_value:
                correct += 1
            else:
                mismatches.append({"id": case_id, "criterion": criterion})
    agreement = correct / total
    return {"source_run_id": source_run_id, "labeled_cases": len(labels), "total": total,
            "matched": correct, "agreement": agreement, "threshold": JUDGE_AGREEMENT,
            "passed": agreement >= JUDGE_AGREEMENT,
            "mismatches": mismatches}


def score(args):
    captured = read_capture(args.capture)
    source = captured["run"]
    definitions = mvp_cases(load_evalset(args.evalset))
    if source["evalset_hash"] != digest(args.evalset):
        raise ValueError("평가 데이터셋 버전이 달라 새로 실행해야 합니다.")
    rows = captured["cases"]
    if len(rows) != len(definitions) or any((row["id"], row["query"], row["expect"]) != (case["id"], case["query"], case["expect"])
                                          for row, case in zip(rows, definitions, strict=True)):
        raise ValueError("저장 결과의 케이스와 데이터셋이 일치하지 않습니다.")
    metadata = {**source, "stage": "judge", "source_run_id": source["run_id"], "judge_version": digest(JUDGE_PROMPT),
                "judge_model": args.judge_model}
    labels = read_labels(args.labels, captured) if args.labels else None
    validation = None
    if args.calibration:
        prior = json.loads(args.calibration.read_text(encoding="utf-8"))
        keys = ("mode", "evalset_hash", "judge_version", "judge_model")
        prior_validation = prior.get("judge_validation") or {}
        if (prior_validation.get("agreement", 0) < JUDGE_AGREEMENT
                or any(prior["run"][key] != metadata[key] for key in keys)):
            raise ValueError("같은 실행 모드·데이터셋·프롬프트·모델에서 통과한 AI 채점 검증 결과가 필요합니다.")
        validation = {**prior_validation, "threshold": JUDGE_AGREEMENT, "passed": True}
    evaluate = judge_client(args.judge_model)
    from app.ai.types import AIError

    verdicts, scored = {}, []
    for row, case in zip(rows, definitions, strict=True):
        decision, error = None, None
        if case["expect"]["judge"] and not row["case_error"]:
            try:
                decision = evaluate(row)
                verdicts[row["id"]] = decision
            except (AIError, ValueError) as failure:
                error = getattr(failure, "code", "BAD_JUDGE_OUTPUT")
        scored.append(grade_case(case, row["output"], case_error=row["case_error"], judge=decision, judge_error=error))
    if labels is not None:
        validation = judge_agreement(labels, verdicts, source["run_id"])
        print(f"AI 채점 일치율 {validation['agreement']:.1%} ({validation['matched']}/{validation['total']})")
    metadata["judge_status"] = "validated" if validation and validation["passed"] else "unvalidated"
    return save_result(args.results, metadata, scored, validation)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="실제 로컬 앱 경로를 실행하고 초안과 자동 판정을 저장")
    run.add_argument("--mode", choices=("fake", "live"), default="fake")
    run.add_argument("--change", required=True, help="해당 실행의 변경점")
    run.add_argument("--golden", default="미확인", help="별도로 확인한 골든 테스트 상태")
    run.set_defaults(main=capture)
    blind = commands.add_parser("review", help="AI 판정 없이 초안과 사람이 체크할 기준 표시")
    blind.add_argument("capture", type=Path)
    blind.add_argument("--template", action="store_true", help="비어 있는 사람 라벨 JSONL을 표준 출력에 기록")
    blind.set_defaults(main=review)
    judge = commands.add_parser("judge", help="저장된 초안을 AI로 판정")
    judge.add_argument("capture", type=Path)
    judge.add_argument("--judge-model", default=os.getenv("PATPAT_EVAL_JUDGE_MODEL"))
    calibration = judge.add_mutually_exclusive_group()
    calibration.add_argument("--labels", type=Path)
    calibration.add_argument("--calibration", type=Path, help="먼저 검증한 AI 채점 결과 JSON")
    judge.set_defaults(main=score)
    for command in (run, judge):
        command.add_argument("--evalset", type=Path, default=EVALSET)
        command.add_argument("--results", type=Path, default=RESULTS)
    args = parser.parse_args()
    try:
        return args.main(args)
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.exit(2, f"오류: {error}\n")


if __name__ == "__main__":
    sys.exit(main())
