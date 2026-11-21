"""관찰일지 본문에서 ‘~경험을 함’처럼 아이가 무엇을 경험했는지 풀어 쓴 해석 문장을 가려 낸다.

Word 양식에 ‘교사의 해석 및 지원 계획’ 칸이 있으면 해석 문장은 그 칸에 따로 넣고, 관찰내용 칸에는 관찰한 사실만 남긴다.
"""
import re

SENTENCE_BREAK = re.compile(r"(?<=[.!?])\s+")
INTERPRETATION = re.compile(r"(?:경험을\s*함|경험함|연습을\s*함|연습함|익힘|익혀\s*감)\s*[.!?]?$")


def split_interpretation(text: str) -> tuple[str, str]:
    """(관찰한 사실, 해석 문장)을 돌려준다. 해석 문장만 있어 관찰이 비면 원문 전체를 관찰로 둔다."""
    observed: list[str] = []
    interpreted: list[str] = []
    for paragraph in text.split("\n"):
        kept = []
        for sentence in SENTENCE_BREAK.split(paragraph.strip()):
            if not sentence:
                continue
            (interpreted if INTERPRETATION.search(sentence) else kept).append(sentence)
        if kept:
            observed.append(" ".join(kept))
    if not observed:
        return text, ""
    return "\n".join(observed), " ".join(interpreted)
