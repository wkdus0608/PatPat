"""Cheap, rule-based checks on generated text. They flag; they never block or rewrite."""

# Words that read as teacher-led (rules/common/trend.md). Stems, so conjugations match.
TEACHER_LED_STEMS = ("유도했", "시켰", "하게 했", "가르쳤", "지도했", "이끌었", "진행했")

# Feelings the notice must not add unless the teacher's own input already says so.
UNSUPPORTED_FEELING_STEMS = ("즐거워", "신나", "신이 나", "뿌듯", "기뻐", "행복해", "재미있어", "재밌어", "집중했", "집중하는")


def lint_notice(text: str, source_text: str = "") -> list[dict]:
    warnings: list[dict] = []
    for stem in TEACHER_LED_STEMS:
        if stem in text:
            warnings.append({"code": "TEACHER_LED", "word": stem})
    for stem in UNSUPPORTED_FEELING_STEMS:
        if stem in text and stem not in source_text:
            warnings.append({"code": "UNSUPPORTED_FEELING", "word": stem})
    return warnings
