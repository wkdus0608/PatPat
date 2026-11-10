"""Real SQLite + real auth and roster services; fictional accounts only."""
from concurrent.futures import ThreadPoolExecutor
import sqlite3
import time

import pytest
from fastapi.testclient import TestClient

from app.auth.security import token_digest, verify_password
from app.core.database import Database
from app.main import create_app
from app.manage import create_teacher


@pytest.fixture
def real_app():
    app = create_app()
    first = create_teacher(app.state.database, "fictional-one", "가상 교사 1", "fictional-password-one")
    second = create_teacher(app.state.database, "fictional-two", "가상 교사 2", "fictional-password-two")
    return app, first, second


def login(client, second=False):
    response = client.post("/api/v1/auth/login", json={
        "login_id": "fictional-two" if second else "fictional-one",
        "password": "fictional-password-two" if second else "fictional-password-one",
    })
    assert response.status_code == 200
    result = response.json()
    assert result["token_type"] == "bearer" and result["expires_in"] == 604800
    return {"Authorization": "Bearer " + result["access_token"]}, result["access_token"]


def test_restart_preserves_sessions_and_roster(real_app):
    app, first, _ = real_app
    with TestClient(app) as client:
        headers, _ = login(client)
        child = client.post("/api/v1/children", headers=headers, json={"name": "가상 아동"})
        assert child.status_code == 201
        assert child.headers["cache-control"] == "no-store"
        child_id = child.json()["child_id"]
        renamed = client.patch(f"/api/v1/children/{child_id}", headers=headers, json={"name": "  가상 새 이름  "})
        assert renamed.json() == {"child_id": child_id, "name": "  가상 새 이름  ", "is_active": True}
    with TestClient(create_app()) as restarted:
        assert restarted.get("/api/v1/auth/me", headers=headers).json()["teacher_id"] == first
        assert restarted.get("/api/v1/children", headers=headers).json() == {"items": [renamed.json()]}


def test_real_roster_isolation_duplicates_and_inactive_history(real_app):
    app, _, _ = real_app
    with TestClient(app) as client:
        a, _ = login(client)
        b, _ = login(client, second=True)
        children = [client.post("/api/v1/children", headers=a, json={"name": "동일한 가상 이름"}).json() for _ in range(2)]
        assert children[0]["child_id"] != children[1]["child_id"]
        child_id = children[0]["child_id"]
        assert client.get("/api/v1/children?teacher_id=spoof", headers=b).json() == {"items": []}
        for path, method, body in [(f"/children/{child_id}", "PATCH", {"name": "다른 교사 수정"}),
                                   (f"/children/{child_id}/deactivate", "POST", None)]:
            assert client.request(method, "/api/v1" + path, headers=b, json=body).status_code == 404
        for _ in range(2):
            response = client.post(f"/api/v1/children/{child_id}/deactivate", headers=a)
            assert response.status_code == 200
            assert response.json() == {**children[0], "is_active": False}
        assert client.get("/api/v1/children", headers=a).json()["items"] == [children[1]]
        assert client.get("/api/v1/children?include_inactive=true", headers=a).json()["items"] == [{**children[0], "is_active": False}, children[1]]


@pytest.mark.parametrize("login_id,password", [("fictional-one", "wrong"), ("missing", "wrong")])
def test_invalid_password_is_generic_and_safe(real_app, login_id, password):
    with TestClient(real_app[0]) as client:
        result = client.post("/api/v1/auth/login", json={"login_id": login_id, "password": password})
        assert result.status_code == 401
        assert result.json()["error"]["code"] == "INVALID_CREDENTIALS"
        assert password not in result.text
        assert result.headers["www-authenticate"] == "Bearer"


def test_expired_tampered_and_inactive_account_tokens(real_app):
    app, first, _ = real_app
    with TestClient(app) as client:
        headers, token = login(client)
        assert client.get("/api/v1/auth/me", headers={"Authorization": "Bearer " + token + "tampered"}).status_code == 401
        with app.state.database.connect() as connection:
            connection.execute("UPDATE sessions SET expires_at=?", (int(time.time()) - 1,))
        assert client.get("/api/v1/auth/me", headers=headers).status_code == 401
        headers, _ = login(client)
        with app.state.database.connect() as connection:
            connection.execute("UPDATE teachers SET is_active=0 WHERE teacher_id=?", (first,))
        assert client.get("/api/v1/auth/me", headers=headers).status_code == 401
        assert client.post("/api/v1/auth/login", json={"login_id": "fictional-one", "password": "fictional-password-one"}).status_code == 401


def test_logout_revokes_only_current_session(real_app):
    with TestClient(real_app[0]) as client:
        first, _ = login(client)
        second, _ = login(client)
        assert client.post("/api/v1/auth/logout").status_code == 401
        result = client.post("/api/v1/auth/logout", headers=first)
        assert result.status_code == 204 and not result.content
        assert client.get("/api/v1/auth/me", headers=first).status_code == 401
        assert client.get("/api/v1/auth/me", headers=second).status_code == 200


def test_only_hashes_are_stored_and_reinitialization_preserves_data(real_app):
    app, _, _ = real_app
    with TestClient(app) as client:
        _, token = login(client)
    Database(app.state.database.path).initialize()
    with app.state.database.connect() as connection:
        account = connection.execute("SELECT * FROM teachers WHERE login_id='fictional-one'").fetchone()
        stored = connection.execute("SELECT token_hash FROM sessions").fetchone()[0]
        assert stored == token_digest(token) and token not in stored
        assert account["password_hash"].startswith("$argon2id$")
        assert "fictional-password-one" not in account["password_hash"]
        assert verify_password(account["password_hash"], "fictional-password-one")
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 2
    with pytest.raises(sqlite3.IntegrityError):
        create_teacher(app.state.database, "fictional-one", "중복 가상 계정", "another-password")


def test_concurrent_registrations_keep_every_child_and_treat_names_as_data(real_app):
    app, _, _ = real_app
    with TestClient(app) as client:
        headers, _ = login(client)
        def register(index):
            return client.post("/api/v1/children", headers=headers, json={"name": f"가상 아동 {index}'); DROP TABLE teachers;--"})
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(register, range(8)))
        assert all(result.status_code == 201 for result in results)
        assert len({result.json()["child_id"] for result in results}) == 8
        assert len(client.get("/api/v1/children", headers=headers).json()["items"]) == 8
        assert client.get("/api/v1/auth/me", headers=headers).status_code == 200


def test_unknown_schema_version_is_rejected_without_replacing_data(tmp_path):
    path = tmp_path / "future.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.execute("PRAGMA user_version=99")
        connection.execute("CREATE TABLE preserved (value TEXT)")
        connection.execute("INSERT INTO preserved VALUES ('keep')")
    with pytest.raises(RuntimeError):
        Database(str(path)).initialize()
    with sqlite3.connect(path) as connection:
        assert connection.execute("SELECT value FROM preserved").fetchone()[0] == "keep"
