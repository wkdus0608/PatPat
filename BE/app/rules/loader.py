"""Load the rule markdown files as one fixed block for the AI system prompt.

The files are read once at startup and joined in a fixed order, so the resulting
text is byte-identical across calls (a prerequisite for prompt caching) and its
hash identifies exactly which rules produced a draft.
"""
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
import re

RULE_FILES: tuple[str, ...] = (
    "common/trend.md",
    "common/StandardCurriculum.md",
    "common/sensitive.md",
    "common/questioning.md",
    "notice/guide.md",
    "notice/incident.md",
    "notice/default_tone.md",
    "observation/guide.md",
    "observation/examples.md",
)


AREAS: tuple[str, ...] = ("신체운동·건강", "의사소통", "사회관계", "예술경험", "자연탐구")


class RulesError(RuntimeError):
    """A rule file is missing, empty, or malformed; the server must not run without them."""


@dataclass(frozen=True)
class RulesBundle:
    files: dict[str, str]
    text: str
    rules_hash: str


def load_rules(root: str | Path) -> RulesBundle:
    base = Path(root)
    problems: list[str] = []
    files: dict[str, str] = {}
    for name in RULE_FILES:
        path = base / name
        if not path.is_file():
            problems.append(f"{name}: 파일이 없습니다.")
            continue
        text = path.read_text(encoding="utf-8")
        if not text.strip():
            problems.append(f"{name}: 비어 있습니다.")
            continue
        if not text.lstrip().startswith("# "):
            problems.append(f"{name}: 첫 줄이 '# 제목'이 아닙니다.")
            continue
        files[name] = text.replace("\r\n", "\n").strip() + "\n"
    if problems:
        raise RulesError("규칙 파일 점검 실패: " + "; ".join(problems))
    body = "\n\n".join(f"=== 규칙 파일: {name} ===\n{files[name]}" for name in RULE_FILES)
    return RulesBundle(files=files, text=body, rules_hash=sha256(body.encode("utf-8")).hexdigest()[:16])


def age_band_from_label(label: str | None) -> str | None:
    """Map a teacher-entered class age ('만 2세', '1세반', '0~1세') to a curriculum band."""
    if not label:
        return None
    match = re.search(r"\d+", label)
    if not match:
        return None
    age = int(match.group())
    if age in (0, 1):
        return "0-1세"
    if age == 2:
        return "2세"
    if 3 <= age <= 5:
        return "3-5세"
    return None


def child_term(band: str | None) -> str:
    """영아(0~2세) / 유아(3~5세); 영유아 when the class age is unknown."""
    if band == "3-5세":
        return "유아"
    if band in ("0-1세", "2세"):
        return "영아"
    return "영유아"
