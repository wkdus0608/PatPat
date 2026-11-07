"""Shared helpers for the notice-first flow tests (fictional teachers and children only)."""
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from app.manage import create_teacher


@dataclass
class Env:
    app: object
    client: TestClient
    headers: dict
    headers_b: dict
    teacher_id: str
    teacher_b_id: str


def login(client: TestClient, login_id: str, password: str) -> dict:
    response = client.post("/api/v1/auth/login", json={"login_id": login_id, "password": password})
    assert response.status_code == 200, response.text
    return {"Authorization": "Bearer " + response.json()["access_token"]}


@contextmanager
def running_env(tmp_path: Path, *, ai_handlers=None, **settings_overrides):
    options = {"ai_provider": "fake", "jobs_inline": True, **settings_overrides}
    settings = Settings(
        database_path=str(tmp_path / "flow.sqlite3"),
        audio_path=str(tmp_path / "audio"),
        **options,
    )
    app = create_app(settings)
    if ai_handlers is not None:
        app.state.ai_client.handlers.update(ai_handlers)
    first = create_teacher(app.state.database, "teacher-a", "가상 교사 A", "fictional-password-a")
    second = create_teacher(app.state.database, "teacher-b", "가상 교사 B", "fictional-password-b")
    with TestClient(app) as client:
        yield Env(
            app=app,
            client=client,
            headers=login(client, "teacher-a", "fictional-password-a"),
            headers_b=login(client, "teacher-b", "fictional-password-b"),
            teacher_id=first,
            teacher_b_id=second,
        )


V2 = "/api/v2"


def open_session(env: Env, date: str = "2026-11-06", headers=None, **body) -> dict:
    response = env.client.post(f"{V2}/sessions", headers=headers or env.headers, json={"target_date": date, **body})
    assert response.status_code in (200, 201), response.text
    return response.json()


def block_of(session: dict, name: str | None) -> dict:
    """The block of the child with this name; None selects the common block."""
    for block in session["blocks"]:
        if block["child_name"] == name:
            return block
    raise AssertionError(f"no block for {name!r}")


def fill(env: Env, session: dict, name: str | None, text: str, areas=("사회관계",), headers=None, **extra) -> dict:
    block = block_of(session, name)
    response = env.client.patch(
        f"{V2}/sessions/{session['session_id']}/blocks/{block['block_id']}",
        headers=headers or env.headers,
        json={"text": text, "areas": list(areas), **extra},
    )
    assert response.status_code == 200, response.text
    return response.json()


def get_session(env: Env, session_id: str, headers=None) -> dict:
    response = env.client.get(f"{V2}/sessions/{session_id}", headers=headers or env.headers)
    assert response.status_code == 200, response.text
    return response.json()


def add_children(env: Env, names, headers=None) -> list[str]:
    headers = headers or env.headers
    ids = []
    for name in names:
        response = env.client.post("/api/v1/children", headers=headers, json={"name": name})
        assert response.status_code == 201, response.text
        ids.append(response.json()["child_id"])
    return ids
