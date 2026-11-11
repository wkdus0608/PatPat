"""Conservative matching of a name found in a recording to the class roster."""
import re
from unicodedata import normalize

# A transcribed name is often attached to a Korean subject or topic particle.
_NAME_END = r"(?=(?:이?(?:가|는|를|랑|하고|한테|에게|께|와|의|도|만)|이|은|을|과|아|야)?(?!\w))"


def _name_pattern(name: str) -> re.Pattern:
    return re.compile(r"(?<!\w)" + re.escape(name) + _NAME_END)


def contains_name(text: str, name: str) -> bool:
    return bool(name and _name_pattern(name).search(text))


def _one_jamo_apart(left: str, right: str) -> bool:
    if len(left) != len(right) or len(left) < 2 or not all("가" <= char <= "힣" for char in left + right):
        return False
    left_parts = "".join(normalize("NFD", char).ljust(3, " ") for char in left)
    right_parts = "".join(normalize("NFD", char).ljust(3, " ") for char in right)
    return sum(a != b for a, b in zip(left_parts, right_parts)) == 1


def matching_name(heard: str, registered: str) -> str | None:
    names = [registered]
    if len(registered) == 3 and all("가" <= char <= "힣" for char in registered):
        names.append(registered[1:])
    return next((name for name in names if heard == name or _one_jamo_apart(heard, name)), None)


def corrected_quote(quote: str, heard: str, registered: str) -> str:
    canonical = matching_name(heard, registered) if heard and registered else None
    if not canonical or canonical == heard:
        return quote
    return _name_pattern(heard).sub(canonical, quote)


def correct_transcription_typos(quote: str, corrections: object, names: set[str]) -> str:
    if not isinstance(corrections, list):
        return quote
    edits = []
    for correction in corrections:
        if not isinstance(correction, dict):
            continue
        original, replacement = correction.get("original"), correction.get("replacement")
        if not all(isinstance(part, str) and re.fullmatch(r"[가-힣]+(?: [가-힣]+)?", part)
                   and len(part) <= 12 for part in (original, replacement)):
            continue
        if original == replacement:
            continue
        starts = [match.start() for match in re.finditer(r"(?=" + re.escape(original) + r")", quote)]
        occurrence = correction.get("occurrence", 1 if len(starts) == 1 else None)
        if type(occurrence) is not int or not 1 <= occurrence <= len(starts):
            continue
        start = starts[occurrence - 1]
        edits.append((start, start + len(original), replacement))
    result = quote
    previous_start = len(quote)
    for start, end, replacement in sorted(edits, reverse=True):
        if end > previous_start:
            return quote
        result = result[:start] + replacement + result[end:]
        previous_start = start
    for name in names:
        pattern = _name_pattern(name)
        if len(pattern.findall(quote)) != len(pattern.findall(result)):
            return quote
    return result
