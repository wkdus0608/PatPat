"""Rule-based checks and narrowly scoped style cleanup for generated notices."""
import re

_TEXT_EMOTICON = re.compile(r"\^{2,}|[:;]-?[)(DPp](?!\w)")

# Words that read as teacher-led (rules/common/trend.md). Stems, so conjugations match.
TEACHER_LED_STEMS = ("유도했", "시켰", "하게 했", "가르쳤", "지도했", "이끌었", "진행했")

# Feelings the notice must not add unless the teacher's own input already says so.
UNSUPPORTED_FEELING_STEMS = ("즐거워", "신나", "신이 나", "뿌듯", "기뻐", "행복해", "재미있어", "재밌어", "집중했", "집중하는")


def keep_example_emoticons(text: str, examples: str | None, source: str) -> str:
    if not examples or not examples.strip():
        return text
    allowed = set(_TEXT_EMOTICON.findall(examples + "\n" + source))
    return _TEXT_EMOTICON.sub(lambda match: match.group() if match.group() in allowed else "", text).strip()


def lint_notice(text: str, source_text: str = "") -> list[dict]:
    warnings: list[dict] = []
    for stem in TEACHER_LED_STEMS:
        if stem in text:
            warnings.append({"code": "TEACHER_LED", "word": stem})
    for stem in UNSUPPORTED_FEELING_STEMS:
        if stem in text and stem not in source_text:
            warnings.append({"code": "UNSUPPORTED_FEELING", "word": stem})
    return warnings


_ACTIVITY = r"(?:자유놀이|바깥놀이|실내놀이|모임|간식|점심|낮잠|정리|등원|하원|놀이)"
_CLOCK = r"\d{1,2}:\d{2}"
_CLOCK_RANGE = rf"{_CLOCK}(?:\s*[~～–—-]\s*{_CLOCK})?"
_LEADING_ACTIVITY_TIME = re.compile(
    rf"^(?:오늘\s+)?(?:{_CLOCK_RANGE}\s+)?(?:오전|오후)\s+{_ACTIVITY}"
    rf"(?:\s+(?:시간(?:에는|에)?|때(?:는)?))?(?:\s*\(\s*{_CLOCK_RANGE}\s*\))?\s+"
)
_OBSERVED_TIME = re.compile(
    rf"오전|오후|아침|저녁|{_ACTIVITY}\s*(?:시간|때)|{_CLOCK}|\d{{1,2}}\s*시(?:에|\s|$)|(?:그|같은)\s*시간"
)


def drop_unconfirmed_time_prefix(
    text: str, *, source: str, confirmed_time: str | None, child_name: str = "",
) -> str:
    """Remove an added activity slot at the start of an individual draft with no time evidence."""
    if confirmed_time or _OBSERVED_TIME.search(source):
        return text
    if child_name:
        subject = re.match(rf"^{re.escape(child_name)}(?:이는|은|는|이가|가|이)\s+", text)
        offset = subject.end() if subject else 0
    else:
        offset = 0
    activity = text[offset:]
    without_time = _LEADING_ACTIVITY_TIME.sub("", activity, count=1)
    return text[:offset] + without_time if without_time.strip() else text
