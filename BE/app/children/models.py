from dataclasses import dataclass


@dataclass(frozen=True)
class Child:
    """Stable roster identity; deactivation must preserve historical references."""

    child_id: str
    teacher_id: str
    name: str
    is_active: bool
