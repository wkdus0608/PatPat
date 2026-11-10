"""Keep other children's names out of a child's prompt and notice.

A notice must never name another child ("친구" is used instead), and the prompt for
one child must not carry another child's name or record.
"""
import re
from collections.abc import Iterable

_AFTER_I = r"(?=[를은는가와랑의도만에께]|[\s.,!?;:()\[\]\"'“”‘’/]|$)"
_PARTICLE_FIX = (("을", "를"), ("은", "는"), ("과", "와"))


def _usable(names: Iterable[str]) -> list[str]:
    # One-letter names cannot be matched safely inside ordinary words.
    unique = {name.strip() for name in names if name and len(name.strip()) >= 2}
    return sorted(unique, key=len, reverse=True)


def mask_names(text: str, names: Iterable[str], replacement: str = "친구") -> str:
    """Replace each name (with its 이-suffix and a following particle) by `replacement`."""
    for name in _usable(names):
        escaped = re.escape(name)
        text = re.sub(escaped + "이" + _AFTER_I, replacement, text)
        text = re.sub(escaped, replacement, text)
    for wrong, right in _PARTICLE_FIX:
        text = text.replace(replacement + wrong, replacement + right)
    return text


def find_names(text: str, names: Iterable[str]) -> list[str]:
    return [name for name in _usable(names) if name in text]
