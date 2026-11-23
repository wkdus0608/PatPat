"""Prepare explicit confirmation cases in teacher observations."""

import re
from dataclasses import dataclass
from hashlib import sha256

OBSERVATION_INSTRUCTION = "observation_instruction"
INJURY_SIDE = "injury_side"
SOURCE_CONFIRMATION_KINDS = (OBSERVATION_INSTRUCTION, INJURY_SIDE)
SIDE_OPTIONS = ("왼쪽", "오른쪽", "양쪽")
_SIDE_LABELS = {"왼쪽": "left", "좌측": "left", "오른쪽": "right", "우측": "right"}

_CLAUSE_START = r"(?m)(?:^|(?<=[.!?。]))[ \t]*"
_CLAUSE_END = r"[ \t]*(?:[.!?。]+|$)"
_WRITE_REQUEST = r"(?:써|적어|기록해|작성해|넣어|추가해|써라|적으라|기록하라|작성하라)(?:[ \t]*(?:줘|주세요|주십시오))?"
_QUOTED_REQUEST = re.compile(
    rf"{_CLAUSE_START}(?:메모(?:에는|에)[ \t]*)?[‘“\"'][^’”\"'\n]+?{_WRITE_REQUEST}"
    rf"[.!?]?[’”\"'][ \t]*이?라는[ \t]*(?:작성[ \t]*)?(?:지시|요청)"
    rf"(?:[이가][ \t]*있(?:다|어요|습니다))?{_CLAUSE_END}"
)
_DIRECT_REQUEST = re.compile(rf"{_CLAUSE_START}[^.!?。，,\n]+?(?:다고|라고)[ \t]+{_WRITE_REQUEST}{_CLAUSE_END}")

_SAME_INJURY_NOTE = re.compile(
    r"\s*(?:같은|동일한)\s*(?:부상|상처|사고|사건)(?:에\s*대한)?\s*(?=(?:메모|기록)\s*\d+)"
)
_REPORT_LABEL = re.compile(r"(?:^|\n)[ \t]*(?:메모|기록)[ \t]*\d+[ \t]*[.:)][ \t]*")
_SIDE_AND_PART = re.compile(
    r"(?P<side>왼쪽|오른쪽|좌측|우측)[ \t]*"
    r"(?P<part>무릎|팔꿈치|발목|손목|어깨|손가락|발가락|손바닥|발바닥|손등|발등|이마|허벅지|종아리|팔|다리|손|발|눈|귀|볼)"
    r"(?=(?:에서|부터|까지|으로|인지|일|인|은|는|이|가|을|를|에|의|도)?(?:[\s.!?。，,]|$))"
)


_OBSERVATION_CLAUSES = re.compile(r"[^.!?。\n]+")
_PEER_SUBJECT = re.compile(r"(?:친구|또래)(?:의|가|는|도|\s+(?:손|발|이마|무릎|팔|다리))")
_INJURY_RESULT = re.compile(
    r"^(?:이|가|은|는)?\s*(?:(?:살짝|약간|조금|가볍게)\s+)?"
    r"(?:까졌|까짐|쓸렸|쓸림|긁혔|긁힘|부었|부음|멍이\s*들었)"
)
_INJURY_FACT = re.compile(r"까졌|까짐|쓸렸|쓸림|긁혔|긁힘|부었|부음|멍이\s*들었|다쳤|다침")
_CARE_ACTION = re.compile(
    r"씻었(?=다|어요|고|으며|으나|지만)|씻음|"
    r"밴드(?:를)?\s*붙(?:였(?=다|어요|고|으며|으나|지만)|임|여\s*주었(?=다|어요|고))"
)
_UNKNOWN = re.compile(r"는지|인지|모르|모름|미확인|확인(?:이|되지|하지|할\s*수)\s*(?:안|못|않)|아직|아니|않")
# These connectors can separate a confirmed action from uncertainty about who did it.
_CARE_CLAUSES = re.compile(r"(?<=었으나)\s+|(?<=었지만)\s+")


def confirmed_injury_details(text: str) -> set[str]:
    """Clear model flags only for a clearly identified injury in this child's own evidence."""
    clauses = [clause.strip() for clause in _OBSERVATION_CLAUSES.findall(text) if clause.strip()]
    own_clauses = [clause for clause in clauses if not _PEER_SUBJECT.search(clause)]
    own_injuries = [clause for clause in own_clauses if _INJURY_FACT.search(clause)]
    if len(own_injuries) != 1:
        return set()
    injury, = own_injuries
    parts = list(_SIDE_AND_PART.finditer(injury))
    if len(parts) != 1 or _UNKNOWN.search(injury):
        return set()
    match, = parts
    if not _INJURY_RESULT.search(injury[match.end():]):
        return set()
    sides = {_SIDE_LABELS[other["side"]] for clause in own_clauses for other in _SIDE_AND_PART.finditer(clause)
             if other["part"] == match["part"]}
    if len(sides) != 1:
        return set()

    confirmed = {"body_part", "laterality"}
    related_care = re.compile(rf"{match['part']}(?:에는|에|을|를|은|는)?\s+(?:(?:흐르는\s+)?물로\s+)?(?:{_CARE_ACTION.pattern})")
    for clause in own_clauses:
        for action in _CARE_CLAUSES.split(clause):
            if related_care.search(action) and not _UNKNOWN.search(action):
                confirmed.add("care")
    return confirmed


def strip_writing_requests(text: str) -> tuple[str, bool]:
    """Remove explicitly marked drafting requests while keeping observation sentences."""
    without_quotes, quoted = _QUOTED_REQUEST.subn("", text)
    observation, direct = _DIRECT_REQUEST.subn("", without_quotes)
    return observation.strip(), bool(quoted or direct)


@dataclass(frozen=True)
class ConflictingInjurySide:
    shared_text: str
    part: str
    part_offset: int

    def with_confirmed_side(self, side: str) -> str:
        return f"{self.shared_text[:self.part_offset]}{side} {self.shared_text[self.part_offset:]}"


def conflicting_injury_side(text: str) -> ConflictingInjurySide | None:
    """Match reports of the same injury that differ only in left or right."""
    heading = _SAME_INJURY_NOTE.match(text)
    if not heading:
        return None
    reports = [part.strip() for part in _REPORT_LABEL.split(text[heading.end():]) if part.strip()]
    sides = set()
    common = set()
    for report in reports:
        matches = list(_SIDE_AND_PART.finditer(report))
        if len(matches) != 1:
            return None
        match, = matches
        sides.add(_SIDE_LABELS[match["side"]])
        shared = report[:match.start()] + report[match.start("part"):]
        common.add(ConflictingInjurySide(shared, match["part"], match.start()))
    return common.pop() if len(sides) == 2 and len(common) == 1 else None


def source_digest(text: str) -> str:
    return sha256(text.encode("utf-8")).hexdigest()


def confirmed_observation(text: str, flags: list[dict], child_id: str | None) -> tuple[str, bool]:
    """Use only supported observations and flag unresolved laterality."""
    cleaned, has_writing_request = strip_writing_requests(text)
    scope = [child_id] if child_id is not None else []
    answers = {
        flag["kind"]: (flag["answer"] or "").strip()
        for flag in flags if flag["status"] == "answered" and flag["child_ids"] == scope
        and flag["kind"] in SOURCE_CONFIRMATION_KINDS
    }
    conflict = conflicting_injury_side(cleaned) if child_id is not None else None
    unresolved_side = False
    if conflict is not None:
        answer = answers.get(INJURY_SIDE, "")
        side = next((side for side in SIDE_OPTIONS if answer in (side, f"{side} {conflict.part}")), "")
        cleaned = conflict.with_confirmed_side(side) if side else conflict.shared_text
        unresolved_side = not side
    if has_writing_request:
        extra, _ = strip_writing_requests(answers.get(OBSERVATION_INSTRUCTION, ""))
        cleaned = "\n".join(part for part in (cleaned, extra) if part)
    return cleaned, unresolved_side
