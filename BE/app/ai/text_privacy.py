"""Remove roster identifiers at the external model boundary for typed observations."""
import json
import re
import secrets
import unicodedata
from collections import defaultdict

UUID = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
TRANSPORT = rf"⟦C:({UUID})⟧"
CONTACT = r"(?i:[\w.+-]+@[\w.-]+\.[a-z]{2,})|(?<!\d)(?:\+82[ -]?)?0?1[016789][ -]?\d{3,4}[ -]?\d{4}(?!\d)"
RESULT_NAME = re.compile(r"(?<![a-z0-9_])C\d{2,}(?![a-z0-9_])", re.IGNORECASE)


def is_protected(session: dict) -> bool:
    return bool(json.loads(session["snapshot"] or "{}").get("protect_text"))


class TextPrivacy:
    def __init__(self, roster: list[tuple[str, str]], teacher_name: str, visible_child: str | None):
        ids = [child_id for child_id, _ in roster]
        secrets.SystemRandom().shuffle(ids)
        self.names = {child_id: f"C{index:02d}" for index, child_id in enumerate(ids, 1)}
        self.results = {
            alias: f"⟦C:{child_id}⟧" if visible_child is None or child_id == visible_child else "또래"
            for child_id, alias in self.names.items()
        }
        people: dict[str, list[str]] = defaultdict(list)
        for child_id, name in roster:
            name = unicodedata.normalize("NFC", name.strip())
            if name:
                people[name].append(child_id)
                if re.fullmatch(r"[가-힣]{3}", name):
                    people[name[1:]].append(child_id)
        self.replacements = {
            name: self.names[ids[0]] if len(ids) == 1 else "아동"
            for name, ids in people.items()
        }
        if teacher_name.strip():
            self.replacements[unicodedata.normalize("NFC", teacher_name.strip())] = "교사"
        names = "|".join(re.escape(name) for name in sorted(self.replacements, key=len, reverse=True))
        self.pattern = re.compile(f"{TRANSPORT}|(?P<id>{UUID})|(?P<contact>{CONTACT})" + (f"|{names}" if names else ""))
        self.ids: dict[str, str] = {}

    def encode(self, value):
        if isinstance(value, str):
            return self.pattern.sub(self._replace, unicodedata.normalize("NFC", value))
        if isinstance(value, list):
            return [self.encode(item) for item in value]
        if isinstance(value, dict):
            return {self.encode(key) if re.fullmatch(UUID, key) else key: self.encode(item) for key, item in value.items()}
        return value

    def _replace(self, match: re.Match) -> str:
        if match[1]:
            return self.names.get(match[1], "아동")
        if identifier := match["id"]:
            return self.ids.setdefault(identifier, f"I{len(self.ids) + 1:02d}")
        if match["contact"]:
            return "[연락처 생략]"
        return self.replacements[match[0]]

    def decode(self, value):
        return self._decode(value, {alias: original for original, alias in self.ids.items()})

    def _decode(self, value, identifiers: dict[str, str]):
        if isinstance(value, str):
            if value in identifiers:
                return identifiers[value]
            return RESULT_NAME.sub(lambda match: self.results.get(match[0].upper(), "아동"), value)
        if isinstance(value, list):
            return [self._decode(item, identifiers) for item in value]
        if isinstance(value, dict):
            return {self._decode(key, identifiers): self._decode(item, identifiers) for key, item in value.items()}
        return value
