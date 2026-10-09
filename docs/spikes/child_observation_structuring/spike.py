#!/usr/bin/env python3
"""SP-01 아동별 관찰 구조화 스파이크의 실행 코드.

스파이크용 실험 코드다. 제품 코드가 아니고 제품의 기술 스택을 정하지 않는다.
판정이 끝나면 버려도 된다. 남길 것은 ../child_observation_structuring.md 의 판단과 실행 기록이다.
절차와 명령은 같은 폴더의 README.md를 본다.

필요한 패키지: PyYAML, jsonschema. 실제 모델을 붙이면 그 공급자의 SDK가 더 필요하다.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import time
import unicodedata
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import yaml
from jsonschema import Draft7Validator

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
PROMPT_PATH = ROOT / "src/patpat/prompts/parse_query.md"
SCHEMA_PATH = ROOT / "src/patpat/schemas/observation.schema.json"
DATA_DIR = HERE / "data"
RUNS_DIR = HERE / "runs"

LABELERS = ("labeler_1", "labeler_2")
LABEL_COLUMNS = ["memo_id", "request_child_ids", "memo", "child_ids", "activity", "text", "note"]
REVIEW_COLUMNS = [
    "memo_id", "메모", "정답 관찰", "모델 관찰", "자동_아동집합", "자동_문장", "자동_활동", "자동_원문대조",
    "검토자1_판정", "검토자2_판정", "합의_판정", "오류_유형", "치명_오류", "비고",
]
ERROR_TYPES = ("아동 혼동", "사실 추가", "사실 누락", "활동 연결 오류", "형식·호출 오류")  # SP-01 문서 5절
NO_OBSERVATION = "없음"
NOT_RUN = "미실행"
YES = {"예", "y", "yes", "o", "있음", "1", "true"}
UNITS = ("child_set", "strict")
CODE = re.compile(r"C[0-9]+")
LOOSE_DROP = re.compile(r"[\s.,!?~…·'\"‘’“”]")  # 비교할 때 무시하는 공백과 문장부호


def die(message: str):
    sys.exit(f"중단: {message}")


def rel(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(ROOT))
    except ValueError:
        return str(path)


def now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def loose(text: str | None) -> str:
    """공백과 문장부호를 지운 비교용 문자열."""
    return LOOSE_DROP.sub("", unicodedata.normalize("NFC", text or ""))


def load_yaml(path: Path) -> dict:
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f)


def read_csv(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def write_csv(path: Path, columns: list[str], rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:  # 엑셀에서 한글이 깨지지 않게 BOM을 붙인다
        writer = csv.DictWriter(f, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def read_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


# ---------------------------------------------------------------- 데이터와 기준

def load_memos(split: str) -> tuple[dict, list[dict]]:
    path = DATA_DIR / f"{split}.yaml"
    doc = load_yaml(path)
    memos = doc.get("memos") or []
    seen = set()
    for memo in memos:
        memo_id = memo.get("memo_id")
        if not memo_id or memo_id in seen:
            die(f"{rel(path)}: memo_id가 비었거나 중복이다 ({memo_id})")
        seen.add(memo_id)
        child_ids = memo.get("child_ids") or []
        if not child_ids or not all(CODE.fullmatch(str(c)) for c in child_ids):
            die(f"{rel(path)} {memo_id}: child_ids는 C01 같은 가명 코드 목록이어야 한다")
        if not str(memo.get("text") or "").strip():
            die(f"{rel(path)} {memo_id}: text가 비었다")
    return doc, memos


def load_criteria(path: Path, require_confirmed: bool) -> dict:
    criteria = json.loads(json.dumps(load_yaml(path), default=str))  # 따옴표 없는 날짜도 문자열로 맞춘다
    if require_confirmed:
        missing = [key for key in ("confirmed_by", "confirmed_at") if not criteria.get(key)]
        if criteria.get("judgement_unit") not in UNITS:
            missing.insert(0, "judgement_unit")
        if missing:
            die(f"{rel(path)}의 {', '.join(missing)}을(를) 팀이 먼저 채운다. 기준은 실험 전에 확정한다(SP-01 문서 3절)")
    return criteria


def load_prompt() -> tuple[str, str]:
    """parse_query.md의 마커 사이(시스템 프롬프트)와 prompt_version을 읽는다."""
    raw = PROMPT_PATH.read_text(encoding="utf-8")
    if raw.count("<!-- prompt:start -->") != 1 or raw.count("<!-- prompt:end -->") != 1:
        die(f"{rel(PROMPT_PATH)}: 시작·끝 마커가 각각 하나여야 한다")
    body = raw.split("<!-- prompt:start -->")[1].split("<!-- prompt:end -->")[0].strip()
    found = re.search(r"^\|\s*prompt_version\s*\|\s*([^|]+?)\s*\|", raw, re.M)
    if not found:
        die(f"{rel(PROMPT_PATH)}: prompt_version을 찾지 못했다")
    return body, found.group(1)


def user_message(memo: dict) -> str:
    """parse_query.md '사용자 메시지 형식'과 같은 두 줄."""
    return f"요청 아동: {', '.join(memo['child_ids'])}\n메모: {memo['text']}"


def git_state() -> dict:
    def git(*args: str) -> str:
        done = subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True)
        return done.stdout.strip()

    paths = [rel(p) for p in (PROMPT_PATH, SCHEMA_PATH, DATA_DIR, Path(__file__))]
    return {
        "commit": git("rev-parse", "HEAD") or "알 수 없음",
        "uncommitted": git("status", "--porcelain", "--", *paths).splitlines(),
    }


# ---------------------------------------------------------------- 모델 호출

@dataclass
class Reply:
    text: str               # 모델 응답 원문. JSON 객체 문자열이어야 한다
    input_tokens: int = 0
    output_tokens: int = 0
    stop: str = ""          # 공급자가 알려 준 종료 사유 그대로


def call_mock(system: str, user: str, schema: dict, model: str | None) -> Reply:
    """배관 점검용 규칙 분할기. 모델이 아니며 이 출력은 측정 결과가 아니다.

    문장마다 가명 코드를 찾아 관찰로 만든다. '다 같이'와 '반 전체'는 요청 아동 전체로 본다.
    """
    request = CODE.findall(user.splitlines()[0])
    memo = user.split("메모:", 1)[1].strip()
    sentences = [s.strip().rstrip(".") for s in re.split(r"(?<=\.)\s+", memo) if s.strip()]
    activity = sentences.pop(0) if sentences and not CODE.search(sentences[0]) else None
    observations = []
    for sentence in sentences:
        if "다 같이" in sentence or "반 전체" in sentence:
            child_ids = list(request)
        else:
            child_ids = [c for c in dict.fromkeys(CODE.findall(sentence)) if c in request]
        if child_ids:
            observations.append({"child_ids": child_ids, "activity": activity, "text": sentence})
    return Reply(json.dumps({"observations": observations}, ensure_ascii=False), stop="mock")


# 실제 모델은 팀이 하나를 고른 뒤 call_mock과 같은 형태의 함수 하나로 여기에 추가한다.
#   받는 것: system(마커 사이 프롬프트), user(위 두 줄), schema(observation.schema.json), model(모델 ID)
#   돌려줄 것: Reply(응답 원문, 입력·출력 토큰 수, 종료 사유)
#   settings에는 결과에 영향을 주는 설정(최대 출력 토큰, 추론 강도, 구조화 출력 사용 여부 등)을 적는다.
# API 키는 환경 변수로만 읽는다. 저장소, 채팅, 실행 기록에 남기지 않는다.
PROVIDERS = {
    "mock": {"call": call_mock, "settings": {"설명": "배관 점검용 규칙 분할기, 모델 아님"}},
}


def check_observation(observation: dict, memo: dict) -> list[str]:
    """parse_query.md 필드→함수 표의 check_child_ids, check_text_in_memo에 해당하는 점검."""
    flags = []
    outside = [c for c in observation["child_ids"] if c not in memo["child_ids"]]
    if outside:
        flags.append("요청 밖 코드 " + ",".join(outside))
    if loose(observation["text"]) not in loose(memo["text"]):
        flags.append("원문에 없는 text")
    if observation["activity"] is not None and loose(observation["activity"]) not in loose(memo["text"]):
        flags.append("원문에 없는 activity")
    return flags


def parse_reply(text: str, validator: Draft7Validator, memo: dict) -> dict:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        return {"status": "형식 오류", "error": f"JSON 파싱 실패: {error}"}
    errors = sorted(validator.iter_errors(parsed), key=lambda e: str(list(e.absolute_path)))
    if errors:
        return {"status": "형식 오류", "error": "; ".join(e.message for e in errors[:3])}
    # observation_id는 모델이 아니라 코드가 배열 순서대로 붙인다(parse_query.md)
    observations = [{"observation_id": f"O{i}", **o} for i, o in enumerate(parsed["observations"], start=1)]
    checks = {o["observation_id"]: flags for o in observations if (flags := check_observation(o, memo))}
    return {"status": "정상", "observations": observations, "checks": checks}


# ---------------------------------------------------------------- 라벨

def label_rows(memo: dict, observations: list[dict] | None) -> list[dict]:
    """라벨 시트 행. observations가 None이면 빈 행 하나, 빈 목록이면 '없음' 행 하나."""
    base = {"memo_id": memo["memo_id"], "request_child_ids": ";".join(memo["child_ids"]), "memo": memo["text"], "note": ""}
    if observations is None:
        return [{**base, "child_ids": "", "activity": "", "text": ""}]
    if not observations:
        return [{**base, "child_ids": NO_OBSERVATION, "activity": "", "text": ""}]
    return [
        {**base, "child_ids": ";".join(o["child_ids"]), "activity": o["activity"] or "", "text": o["text"]}
        for o in observations
    ]


def read_labels(path: Path, memos: list[dict]) -> tuple[dict[str, list[dict]], list[str]]:
    """라벨 시트를 메모별 관찰 목록으로 읽는다. 두 번째 값은 고칠 점(미작성 포함)."""
    if not path.exists():
        return {}, [f"{rel(path)} 없음"]
    by_id = {m["memo_id"]: m for m in memos}
    labels: dict[str, list[dict]] = {memo_id: [] for memo_id in by_id}
    marked_none: set[str] = set()
    problems: list[str] = []
    rows = read_csv(path)
    missing_columns = set(LABEL_COLUMNS) - set(rows[0].keys() if rows else [])
    if missing_columns:
        return {}, [f"{rel(path)}: 열이 없다 {sorted(missing_columns)}"]
    for line, row in enumerate(rows, start=2):
        cell = {key: (row.get(key) or "").strip() for key in LABEL_COLUMNS}
        memo = by_id.get(cell["memo_id"])
        if memo is None:
            if cell["memo_id"] or cell["child_ids"] or cell["text"]:
                problems.append(f"{line}행: 데이터에 없는 memo_id '{cell['memo_id']}'")
            continue
        if cell["memo"] and loose(cell["memo"]) != loose(memo["text"]):
            problems.append(f"{line}행 {memo['memo_id']}: 메모가 데이터 파일과 다르다. 라벨 시트를 다시 만든다")
        if cell["child_ids"] == NO_OBSERVATION:
            marked_none.add(memo["memo_id"])
            continue
        if not cell["child_ids"] and not cell["text"]:
            continue
        child_ids = list(dict.fromkeys(CODE.findall(cell["child_ids"])))
        outside = [c for c in child_ids if c not in memo["child_ids"]]
        if not child_ids or not cell["text"]:
            problems.append(f"{line}행 {memo['memo_id']}: child_ids와 text를 모두 채운다")
        elif outside:
            problems.append(f"{line}행 {memo['memo_id']}: 요청 밖 코드 {','.join(outside)}")
        else:
            labels[memo["memo_id"]].append({"child_ids": child_ids, "activity": cell["activity"] or None, "text": cell["text"]})
    for memo_id in by_id:
        if memo_id in marked_none and labels[memo_id]:
            problems.append(f"{memo_id}: '{NO_OBSERVATION}'과 관찰 행이 함께 있다")
        elif memo_id not in marked_none and not labels[memo_id]:
            problems.append(f"{memo_id}: 미작성")
    return labels, problems


# ---------------------------------------------------------------- 대조

@dataclass
class Diff:
    sets_equal: bool
    only_a: list[tuple[str, ...]]
    only_b: list[tuple[str, ...]]
    text_equal: bool
    activity_equal: bool

    @property
    def same(self) -> bool:
        return self.sets_equal and self.text_equal and self.activity_equal


def child_set(observation: dict) -> tuple[str, ...]:
    return tuple(sorted(observation["child_ids"]))


def grouped(observations: list[dict], memo_text: str) -> dict[tuple[str, ...], tuple[tuple[str, ...], str]]:
    """같은 아동 집합의 관찰을 묶는다. 값은 (활동 목록, 원문 순서로 이어 붙인 text)."""
    memo = loose(memo_text)

    def position(observation: dict) -> int:
        found = memo.find(loose(observation["text"]))
        return found if found >= 0 else len(memo)

    groups: dict[tuple[str, ...], list[dict]] = {}
    for observation in observations:
        groups.setdefault(child_set(observation), []).append(observation)
    return {
        key: (tuple(sorted({loose(o["activity"]) for o in group})), "".join(loose(o["text"]) for o in sorted(group, key=position)))
        for key, group in groups.items()
    }


def compare(a: list[dict], b: list[dict], memo_text: str, unit: str) -> Diff:
    """판정 단위(criteria.yaml judgement_unit)에 따라 두 관찰 목록을 대조한다."""
    if unit == "strict":
        count_a, count_b = Counter(map(child_set, a)), Counter(map(child_set, b))

        def texts(observations: list[dict]) -> list:
            return sorted((child_set(o), loose(o["text"])) for o in observations)

        def activities(observations: list[dict]) -> list:
            return sorted((child_set(o), loose(o["activity"])) for o in observations)

        return Diff(count_a == count_b, sorted((count_a - count_b).elements()), sorted((count_b - count_a).elements()),
                    texts(a) == texts(b), activities(a) == activities(b))
    group_a, group_b = grouped(a, memo_text), grouped(b, memo_text)
    sets_equal = group_a.keys() == group_b.keys()
    return Diff(sets_equal, sorted(group_a.keys() - group_b.keys()), sorted(group_b.keys() - group_a.keys()),
                sets_equal and all(group_a[k][1] == group_b[k][1] for k in group_a),
                sets_equal and all(group_a[k][0] == group_b[k][0] for k in group_a))


def show(observations: list[dict]) -> str:
    if not observations:
        return "(관찰 없음)"
    return "\n".join(f"[{','.join(o['child_ids'])}] ({o['activity'] or '-'}) {o['text']}" for o in observations)


def show_sets(sets: list[tuple[str, ...]]) -> str:
    return " ".join("{" + ",".join(s) + "}" for s in sets) or "-"


# ---------------------------------------------------------------- 명령

def cmd_sheets(args: argparse.Namespace) -> None:
    _, memos = load_memos("eval")
    for name in LABELERS:
        path = args.labels / f"{name}.csv"
        if path.exists() and not args.force:
            die(f"{rel(path)}가 이미 있다. 다시 만들려면 --force (작성한 라벨이 지워진다)")
        write_csv(path, LABEL_COLUMNS, [row for memo in memos for row in label_rows(memo, None)])
        print(f"만듦: {rel(path)} (평가 메모 {len(memos)}건)")


def cmd_compare_labels(args: argparse.Namespace) -> None:
    unit = load_criteria(args.criteria, require_confirmed=True)["judgement_unit"]
    _, memos = load_memos("eval")
    sheets = {}
    for name in LABELERS:
        labels, problems = read_labels(args.labels / f"{name}.csv", memos)
        if problems:
            die(f"{name} 라벨을 먼저 고친다:\n  " + "\n  ".join(problems))
        sheets[name] = labels
    first, second = (sheets[name] for name in LABELERS)
    disagreements, consensus_rows, counts = [], [], Counter()
    for memo in memos:
        memo_id = memo["memo_id"]
        diff = compare(first[memo_id], second[memo_id], memo["text"], unit)
        if diff.same:
            counts["같음"] += 1
            consensus_rows += label_rows(memo, first[memo_id])
            continue
        kind = "문장·활동" if diff.sets_equal else "아동 집합"
        counts[kind] += 1
        disagreements.append({"memo_id": memo_id, "메모": memo["text"], "구분": kind,
                              LABELERS[0]: show(first[memo_id]), LABELERS[1]: show(second[memo_id]), "합의 메모": ""})
        consensus_rows += label_rows(memo, None)  # 두 사람이 원문을 함께 읽고 합의해 채운다
    write_csv(args.labels / "disagreements.csv", ["memo_id", "메모", "구분", *LABELERS, "합의 메모"], disagreements)
    agreement = {"judgement_unit": unit, "평가 메모": len(memos), "아동 집합 불일치": counts["아동 집합"],
                 "문장·활동 차이": counts["문장·활동"], "같음": counts["같음"], "compared_at": now()}
    (args.labels / "agreement.json").write_text(json.dumps(agreement, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"평가 메모 {len(memos)}건: 같음 {counts['같음']}, 아동 집합 불일치 {counts['아동 집합']}, 문장·활동 차이 {counts['문장·활동']}")
    print(f"합의할 메모: {rel(args.labels / 'disagreements.csv')}")
    consensus = args.labels / "consensus.csv"
    if consensus.exists():
        print(f"{rel(consensus)}가 이미 있어 그대로 둔다")
    else:
        write_csv(consensus, LABEL_COLUMNS, consensus_rows)
        print(f"만듦: {rel(consensus)} (같은 메모는 채워 두었고, 합의할 메모 {len(disagreements)}건은 비어 있다)")


def cmd_run(args: argparse.Namespace) -> None:
    provider = PROVIDERS[args.provider]
    is_mock = args.provider == "mock"
    data_doc, memos = load_memos(args.split)
    if args.split == "eval":
        if is_mock:
            die("mock은 배관 점검용이다. 평가 메모에는 실제 모델만 쓴다")
        criteria = load_criteria(args.criteria, require_confirmed=True)
        if not data_doc.get("reviewed_by"):
            die("data/eval.yaml의 reviewed_by가 비었다. 팀이 메모를 검토하고 확정한 뒤 실행한다")
        _, problems = read_labels(args.labels / "consensus.csv", memos)
        if problems:
            die("합의 정답을 먼저 완성한다(정답이 모델 출력보다 먼저다):\n  " + "\n  ".join(problems))
    else:
        criteria = load_criteria(args.criteria, require_confirmed=False)
    prices = (args.price_in_usd, args.price_out_usd, args.krw_per_usd)
    if not is_mock and (not args.model or None in prices):
        die("실제 모델은 --model, --price-in-usd, --price-out-usd, --krw-per-usd를 모두 준다(예산 상한을 지키기 위해)")

    system, prompt_version = load_prompt()
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    validator = Draft7Validator(schema)
    if args.out:
        out = args.out
    elif is_mock:
        out = Path(tempfile.mkdtemp(prefix="sp01_mock_"))  # mock 출력은 저장소에 남기지 않는다
    else:
        out = RUNS_DIR / f"{datetime.now():%Y%m%d-%H%M%S}_{args.split}_{args.provider}"
    if out.exists() and any(out.iterdir()):
        die(f"{out}가 비어 있지 않다")
    out.mkdir(parents=True, exist_ok=True)

    budget = float(criteria["budget_krw"])
    spent, largest, results, stopped = 0.0, 0.0, [], None
    started = now()
    for memo in memos:
        if spent + largest > budget:  # 지금까지 가장 비싼 호출 한 번이 더 들면 상한을 넘는다
            stopped = f"예산 상한 {budget:,.0f}원"
            break
        record = {"memo_id": memo["memo_id"], "child_ids": memo["child_ids"], "text": memo["text"]}
        began = time.monotonic()
        try:
            reply = provider["call"](system, user_message(memo), schema, args.model)
        except Exception as error:  # 호출 실패도 실패 건으로 센다(SP-01 문서 3절)
            record.update(status="호출 오류", error=f"{type(error).__name__}: {error}")
        else:
            price_in, price_out, krw_per_usd = (p or 0.0 for p in prices)
            cost = (reply.input_tokens * price_in + reply.output_tokens * price_out) / 1_000_000 * krw_per_usd
            spent, largest = spent + cost, max(largest, cost)
            record.update(response=reply.text, stop=reply.stop, input_tokens=reply.input_tokens,
                          output_tokens=reply.output_tokens, cost_krw=round(cost, 2))
            record.update(parse_reply(reply.text, validator, memo))
        record["seconds"] = round(time.monotonic() - began, 2)
        results.append(record)
        print(f"{memo['memo_id']}: {record['status']}" + (f" ({record['error']})" if record.get("error") else ""))

    data_path = DATA_DIR / f"{args.split}.yaml"
    meta = {
        "spike": "SP-01",
        "split": args.split,
        "provider": args.provider,
        "model": args.model,
        "settings": provider["settings"],
        "note": "mock은 배관 점검용 규칙 분할기다. 측정 결과가 아니다." if is_mock else "",
        "prompt": {"path": rel(PROMPT_PATH), "prompt_version": prompt_version, "sha256": sha256(system.encode("utf-8"))},
        "schema": {"path": rel(SCHEMA_PATH), "sha256": sha256(SCHEMA_PATH.read_bytes())},
        "data": {"path": rel(data_path), "version": data_doc.get("version"), "status": data_doc.get("status"),
                 "reviewed_by": data_doc.get("reviewed_by"), "sha256": sha256(data_path.read_bytes())},
        "criteria": criteria,
        "git": git_state(),
        "command": " ".join(sys.argv),
        "started_at": started,
        "ended_at": now(),
        "planned": len(memos),
        "completed": len(results),
        "stopped": stopped,
        "status_counts": dict(Counter(r["status"] for r in results)),
        "tokens": {"input": sum(r.get("input_tokens", 0) for r in results),
                   "output": sum(r.get("output_tokens", 0) for r in results)},
        "cost_krw": round(spent, 2),
        "price": {"input_usd_per_mtok": args.price_in_usd, "output_usd_per_mtok": args.price_out_usd,
                  "krw_per_usd": args.krw_per_usd},
    }
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")
    with (out / "outputs.jsonl").open("w", encoding="utf-8") as f:
        for record in results:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    print(f"완료 {len(results)}/{len(memos)}건, {dict(meta['status_counts'])}, 비용 약 {spent:,.0f}원"
          + (f", 중단: {stopped}" if stopped else ""))
    print(f"출력: {out}")


def cmd_review(args: argparse.Namespace) -> None:
    meta = json.loads((args.run / "meta.json").read_text(encoding="utf-8"))
    results = {r["memo_id"]: r for r in read_jsonl(args.run / "outputs.jsonl")}
    criteria = load_criteria(args.criteria, require_confirmed=True)
    if criteria != meta["criteria"]:
        die(f"{rel(args.criteria)}가 실행 때와 다르다. 기준은 실험 전에 확정하고 바꾸지 않는다(SP-01 문서 3절)")
    unit = criteria["judgement_unit"]
    data_path = DATA_DIR / f"{meta['split']}.yaml"
    if sha256(data_path.read_bytes()) != meta["data"]["sha256"]:
        die(f"{rel(data_path)}가 실행 때와 다르다. 실행한 메모로만 검토한다")
    _, memos = load_memos(meta["split"])
    gold, problems = read_labels(args.labels / "consensus.csv", memos)
    if problems:
        die("합의 정답을 먼저 완성한다:\n  " + "\n  ".join(problems))
    rows = []
    for memo in memos:
        memo_id = memo["memo_id"]
        row = dict.fromkeys(REVIEW_COLUMNS, "")
        row.update({"memo_id": memo_id, "메모": memo["text"], "정답 관찰": show(gold[memo_id])})
        result = results.get(memo_id)
        if result is None:  # 예산 상한 등으로 실행하지 못한 메모. 판단 보류의 근거가 된다
            row["자동_아동집합"] = NOT_RUN
        elif result["status"] != "정상":
            row.update({"모델 관찰": result.get("response", ""), "자동_아동집합": result["status"],
                        "합의_판정": "실패", "오류_유형": "형식·호출 오류", "비고": result.get("error", "")})
        else:
            diff = compare(gold[memo_id], result["observations"], memo["text"], unit)
            row["모델 관찰"] = show(result["observations"])
            if diff.sets_equal:
                row["자동_아동집합"] = "일치"
            else:  # 아동 집합은 자동 대조로 판정한다(SP-01 문서 3절)
                row["자동_아동집합"] = f"불일치: 정답에만 {show_sets(diff.only_a)} / 모델에만 {show_sets(diff.only_b)}"
                row["합의_판정"] = "실패"
            row["자동_문장"] = "같음" if diff.text_equal else "다름"
            row["자동_활동"] = "같음" if diff.activity_equal else "다름"
            checks = result.get("checks", {})
            row["자동_원문대조"] = "; ".join(f"{oid} {', '.join(flags)}" for oid, flags in checks.items()) or "이상 없음"
        rows.append(row)
    path = args.run / "review.csv"
    if path.exists():
        die(f"{path}가 이미 있다. 검토 중인 표를 덮어쓰지 않는다")
    write_csv(path, REVIEW_COLUMNS, rows)
    print(f"만듦: {path} (판정 단위 {unit})")
    print("팀원 2명이 검토자1·2_판정에 통과/실패를 적고, 합의_판정·오류_유형·치명_오류를 채운다")


def cmd_summarize(args: argparse.Namespace) -> None:
    meta = json.loads((args.run / "meta.json").read_text(encoding="utf-8"))
    criteria = meta["criteria"]
    rows = read_csv(args.run / "review.csv")
    done = [r for r in rows if r["자동_아동집합"] != NOT_RUN]
    problems = []
    for row in done:
        verdict, types = row["합의_판정"].strip(), [t.strip() for t in re.split(r"[;,/\n]", row["오류_유형"]) if t.strip()]
        if verdict not in ("통과", "실패"):
            problems.append(f"{row['memo_id']}: 합의_판정은 통과 또는 실패")
        if verdict == "통과" and row["치명_오류"].strip().lower() in YES:
            problems.append(f"{row['memo_id']}: 치명 오류가 있는데 통과로 적혀 있다")
        if verdict == "실패" and not types:
            problems.append(f"{row['memo_id']}: 실패 메모의 오류_유형이 비었다")
        if unknown := [t for t in types if t not in ERROR_TYPES]:
            problems.append(f"{row['memo_id']}: 모르는 오류_유형 {unknown}. 다음 중에서 쓴다: {', '.join(ERROR_TYPES)}")
    if problems:
        die("검토표를 먼저 고친다:\n  " + "\n  ".join(problems))

    passed = sum(r["합의_판정"].strip() == "통과" for r in done)
    critical = sum(r["치명_오류"].strip().lower() in YES for r in done)
    type_counts: Counter = Counter()
    type_examples: dict[str, str] = {}
    for row in done:
        if row["합의_판정"].strip() == "실패":
            for error_type in dict.fromkeys(t.strip() for t in re.split(r"[;,/\n]", row["오류_유형"]) if t.strip()):
                type_counts[error_type] += 1
                type_examples.setdefault(error_type, row["memo_id"])

    target, pass_min = criteria["eval_count"], criteria["pass_min"]
    if meta["provider"] == "mock":
        verdict = "판정 없음 (mock 배관 점검)"
    elif meta["split"] != "eval":
        verdict = "판정 없음 (준비용 실행)"
    elif len(done) < target:
        verdict = "판단 보류 (평가 미완료)"
    elif passed >= pass_min and critical <= criteria["critical_errors_max"]:
        verdict = "기준 충족"
    else:
        verdict = "기준 미달"

    agreement_path = args.labels / "agreement.json"
    if agreement_path.exists():
        agreement = json.loads(agreement_path.read_text(encoding="utf-8"))
        disagreement = f"아동 집합 {agreement['아동 집합 불일치']}건, 문장·활동 {agreement['문장·활동 차이']}건"
        if agreement["judgement_unit"] != criteria.get("judgement_unit"):
            disagreement += f" (주의: 라벨 대조의 판정 단위 {agreement['judgement_unit']}가 실행 기준과 다르다)"
    else:
        disagreement = "agreement.json 없음"
    minutes = (datetime.fromisoformat(meta["ended_at"]) - datetime.fromisoformat(meta["started_at"])).total_seconds() / 60
    hours = f"팀 기록 {args.hours:g}시간" if args.hours is not None else "팀 기록 필요"
    rate = f"{passed}/{len(done)} = {passed / len(done):.0%}" if done else "-"
    lines = [
        f"## SP-01 집계 ({rel(args.run)})",
        "",
        f"모델 {meta['provider']} {meta['model'] or ''}, prompt_version {meta['prompt']['prompt_version']}, "
        f"데이터 {meta['data']['path']} v{meta['data']['version']}, 판정 단위 {criteria.get('judgement_unit')}",
        "",
        "| 항목 | 결과 |",
        "|---|---|",
        f"| 평가 완료 건수 | {len(done)}건 / 목표 {target}건 |",
        f"| 일치 건수·일치율 | {passed}건 ({rate}) / 기준 {pass_min}건 이상({pass_min / target:.0%}) |",
        f"| 치명 오류 건수 | {critical}건 / 기준 {criteria['critical_errors_max']}건 |",
        f"| 사람 간 라벨 불일치 건수 | {disagreement} |",
        f"| 실제 소요 시간·API 비용 | {hours} / 모델 실행 {minutes:.1f}분, 약 {meta['cost_krw']:,.0f}원 |",
        f"| 실험 판정 | {verdict} |",
        f"| 실제 모델 출력·합의 정답·채점 파일 위치 | `{rel(args.run / 'outputs.jsonl')}`, `{rel(args.labels / 'consensus.csv')}`, `{rel(args.run / 'review.csv')}` |",
        "",
        "오류 유형 (실패 메모 기준, 한 메모에 여러 유형이 있으면 유형별로 중복 집계)",
        "",
        "| 유형 | 건수 | 예 |",
        "|---|---|---|",
        *[f"| {t} | {type_counts[t]} | {type_examples.get(t, '-')} |" for t in ERROR_TYPES],
    ]
    if meta["note"]:
        lines += ["", meta["note"]]
    text = "\n".join(lines) + "\n"
    (args.run / "summary.md").write_text(text, encoding="utf-8")
    print(text)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="SP-01 아동별 관찰 구조화 스파이크 실행 코드(실험용, 폐기 가능)")
    parser.add_argument("--criteria", type=Path, default=HERE / "criteria.yaml", help="성공 조건 파일")
    parser.add_argument("--labels", type=Path, default=HERE / "labels", help="라벨 폴더")
    sub = parser.add_subparsers(dest="command", required=True)

    sheets = sub.add_parser("sheets", help="평가 메모의 빈 라벨 시트 두 장을 만든다")
    sheets.add_argument("--force", action="store_true", help="있는 시트를 다시 만든다(작성한 라벨이 지워진다)")
    sub.add_parser("compare-labels", help="두 팀원의 라벨을 대조하고 합의할 메모를 뽑는다")

    run = sub.add_parser("run", help="모델 출력을 만든다")
    run.add_argument("--split", choices=("prep", "eval"), required=True)
    run.add_argument("--provider", choices=sorted(PROVIDERS), required=True)
    run.add_argument("--model", help="모델 ID")
    run.add_argument("--out", type=Path, help="출력 폴더(기본: runs/<시각>_<split>_<provider>, mock은 임시 폴더)")
    run.add_argument("--price-in-usd", type=float, help="입력 100만 토큰당 가격(달러)")
    run.add_argument("--price-out-usd", type=float, help="출력 100만 토큰당 가격(달러)")
    run.add_argument("--krw-per-usd", type=float, help="원/달러 환율")

    review = sub.add_parser("review", help="합의 정답과 모델 출력을 나란히 놓은 검토표를 만든다")
    review.add_argument("--run", type=Path, required=True, help="run 출력 폴더")
    summarize = sub.add_parser("summarize", help="채운 검토표로 SP-01 문서 5절 결과표를 만든다")
    summarize.add_argument("--run", type=Path, required=True, help="run 출력 폴더")
    summarize.add_argument("--hours", type=float, help="팀이 기록한 총 작업 시간")

    args = parser.parse_args(argv)
    commands = {"sheets": cmd_sheets, "compare-labels": cmd_compare_labels, "run": cmd_run,
                "review": cmd_review, "summarize": cmd_summarize}
    commands[args.command](args)


if __name__ == "__main__":
    main()
