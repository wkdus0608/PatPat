"""Real audio bytes, SQLite, authenticated HTTP and private files."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from io import BytesIO
import wave
import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.manage import create_teacher
from app.core.database import Database


def wav():
    buffer = BytesIO()
    with wave.open(buffer, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b'\0\0' * 800)
    return buffer.getvalue()


@pytest.fixture
def audio_app():
    app = create_app()
    for who in ('one', 'two'):
        create_teacher(app.state.database, who, '가상 교사', 'fictional-password')
    with TestClient(app) as client:
        def login(who):
            token = client.post('/api/v1/auth/login', json={'login_id': who, 'password': 'fictional-password'}).json()['access_token']
            return {'Authorization': 'Bearer ' + token}
        yield app, client, login('one'), login('two')


def upload(client, headers, key='upload-one', body=None, **fields):
    return client.post('/api/v1/recordings', headers={**headers, 'Idempotency-Key': key},
        data={'title': '가상 녹음.wav', 'recorded_at': '2026-11-03T23:30:00+09:00', 'duration_seconds': '0.1', **fields},
        files={'file': ('../../untrusted.wav', wav() if body is None else body, 'audio/wav')})


def test_upload_playback_restart_filter_and_delete(audio_app):
    app, client, a, b = audio_app
    response = upload(client, a)
    assert response.status_code == 201, response.text
    row = response.json()
    assert row['status'] == '대기' and row['size_bytes'] == len(wav())
    path = '/api/v1/recordings/' + row['recording_id']
    played = client.get(path + '/audio', headers=a)
    assert played.status_code == 200 and played.content == wav()
    assert played.headers['cache-control'] == 'private, no-store'
    assert client.get('/api/v1/recordings?date_from=2026-11-04', headers=a).json()['total'] == 0
    assert client.get('/api/v1/recordings?date_to=2026-11-03', headers=a).json()['total'] == 1
    assert client.get('/api/v1/recordings?offset=10', headers=a).json()['items'] == []
    with TestClient(create_app()) as restarted:
        assert restarted.get(path + '/audio', headers=a).content == wav()
    assert client.get('/api/v1/recordings', headers=b).json()['items'] == []
    for suffix in ('', '/audio'):
        assert client.get(path + suffix, headers=b).status_code == 404
    assert client.delete(path, headers=b).status_code == 404
    assert client.delete(path, headers=a).status_code == 204
    assert client.delete(path, headers=a).status_code == 204
    assert client.get(path + '/audio', headers=a).status_code == 404
    assert client.get('/api/v1/recordings', headers=a).json()['total'] == 0
    assert upload(client, a).status_code == 409
    assert not list(app.state.recording_service.root.glob('*.audio'))


def test_retries_and_concurrent_uploads_are_one_record_per_owner(audio_app):
    app, client, a, b = audio_app
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: upload(client, a), range(2)))
    assert [r.status_code for r in responses] == [201, 201]
    assert len({r.json()['recording_id'] for r in responses}) == 1
    assert upload(client, a, title='다른 제목').status_code == 409
    assert upload(client, b).status_code == 201
    assert len(list(app.state.recording_service.root.glob('*.audio'))) == 2
    assert not list(app.state.recording_service.root.glob('*.pending'))


@pytest.mark.parametrize('body', [b'', b'not an audio file'])
def test_invalid_bytes_do_not_create_records_or_files(audio_app, body):
    app, client, a, _ = audio_app
    assert upload(client, a, body=body).status_code == 415
    assert client.get('/api/v1/recordings', headers=a).json()['total'] == 0
    assert not list(app.state.recording_service.root.iterdir())


def test_size_limit_and_failed_publication_preserve_database(audio_app, monkeypatch):
    app, client, a, _ = audio_app
    service = app.state.recording_service
    service.settings = replace(service.settings, audio_max_bytes=8)
    assert upload(client, a).status_code == 413
    assert not list(service.root.iterdir())
    service.settings = replace(service.settings, audio_max_bytes=10000)
    from pathlib import Path
    def fail(*args):
        raise OSError('disk full')
    monkeypatch.setattr(Path, 'replace', fail)
    with TestClient(app, raise_server_exceptions=False) as failing:
        assert upload(failing, a).status_code == 500
    assert client.get('/api/v1/recordings', headers=a).json()['total'] == 0
    assert not list(service.root.iterdir())


def test_delete_failure_is_hidden_and_retryable(audio_app, monkeypatch):
    app, client, a, _ = audio_app
    row = upload(client, a).json()
    path = '/api/v1/recordings/' + row['recording_id']
    from pathlib import Path
    unlink = Path.unlink
    def fail(target, *args, **kwargs):
        if target.suffix == '.audio': raise OSError('disk unavailable')
        return unlink(target, *args, **kwargs)
    monkeypatch.setattr(Path, 'unlink', fail)
    with TestClient(app, raise_server_exceptions=False) as failing:
        assert failing.delete(path, headers=a).status_code == 500
    assert client.get(path + '/audio', headers=a).status_code == 404
    monkeypatch.setattr(Path, 'unlink', unlink)
    assert client.delete(path, headers=a).status_code == 204


def test_version_one_migration_keeps_existing_accounts(audio_app):
    app, client, a, _ = audio_app
    with app.state.database.connect() as connection:
        connection.execute('DROP TABLE recordings')
        connection.execute('PRAGMA user_version=1')
    Database(app.state.database.path).initialize()
    with TestClient(create_app()) as restarted:
        assert restarted.get('/api/v1/auth/me', headers=a).status_code == 200
        assert restarted.get('/api/v1/recordings', headers=a).json()['total'] == 0


def test_mime_mismatch_and_invalid_upload_key_are_rejected(audio_app):
    _, client, a, _ = audio_app
    bad_type = client.post('/api/v1/recordings', headers=a,
        data={'title': '가상 녹음', 'recorded_at': '2026-11-04T09:10:00+09:00', 'duration_seconds': '0.1'},
        files={'file': ('not-really-mp4.m4a', wav(), 'audio/mp4')})
    assert bad_type.status_code == 415
    assert upload(client, a, key=' ' * 2).status_code == 422
    assert client.get('/api/v1/recordings', headers=a).json()['total'] == 0
