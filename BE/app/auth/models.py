from dataclasses import dataclass, field


@dataclass(frozen=True)
class TeacherContext:
    """Teacher identity supplied only by the authentication service."""

    teacher_id: str
    display_name: str


@dataclass(frozen=True)
class LoginCredentials:
    login_id: str
    password: str = field(repr=False)


@dataclass(frozen=True)
class LoginResult:
    access_token: str = field(repr=False)
    expires_in: int
    teacher: TeacherContext


@dataclass(frozen=True)
class TeacherAccount:
    """Future stored account; plaintext passwords are never stored here."""

    teacher: TeacherContext
    login_id: str
    password_hash: str = field(repr=False)
    is_active: bool
