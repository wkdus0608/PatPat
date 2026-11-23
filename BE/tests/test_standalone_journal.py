from io import BytesIO

from docx import Document

from app.ai.types import AITask
from flow_helpers import V2, add_children, running_env


def test_standalone_journal_saves_edits_and_exports_without_a_notice(tmp_path):
    with running_env(tmp_path) as env:
        child, = add_children(env, ["가상아동가"])
        route = f"{V2}/children/{child}/journal"
        content = "빨간 블록 두 개를 포개어 놓음.\n무너지자 받침을 바꿔 다시 놓음."
        edit = "블록 두 개로 받침을 놓고 자동차를 굴림."
        payload = {"observed_date": "2026-11-18", "content": content,
                   "place": "쌓기 영역", "time_text": "오전 자유놀이", "areas": ["자연탐구"]}
        client, headers = env.client, env.headers

        assert client.post(route, headers=env.headers_b, json=payload).status_code == 404
        assert client.post(route, headers=headers, json={**payload, "content": "  "}).status_code == 422
        created = client.post(route, headers=headers, json=payload)
        assert created.status_code == 201, created.text
        row = created.json()
        assert row["content"] == content
        assert row["notice_id"] is None and row["session_id"] is None and not row["is_draft"]
        assert client.post(route, headers=headers, json=payload).json() == row
        assert client.post(route, headers=headers, json={**payload, "content": edit}).status_code == 409

        day, = client.get(route, headers=headers).json()["days"]
        assert day["places"] == ["쌓기 영역"]
        assert day["times"] == ["오전 자유놀이"]
        response = client.patch(route, headers=headers, json={"days": [{
            "observed_date": day["observed_date"], "expected_revision": day["revision"], "content": edit,
        }]})
        assert response.status_code == 200, response.text
        assert client.get(route, headers=headers).json()["days"][0]["content"] == edit
        archive, = client.get(f"{V2}/journal/archive", headers=headers).json()
        assert archive["content"] == edit
        assert client.get(f"{V2}/journal/archive", headers=env.headers_b).json() == []

        preview = client.post(route + "/output", headers=headers).json()
        assert edit in preview["text"]
        response = client.post(route + "/output/word", headers=headers, params={"revision": preview["revision"]})
        assert response.status_code == 200, response.text
        assert any(edit in cell.text for row in Document(BytesIO(response.content)).tables[0].rows for cell in row.cells)
        with env.app.state.database.connect() as db:
            assert db.execute("SELECT COUNT(*) FROM notices").fetchone()[0] == 0
            assert db.execute("SELECT COUNT(*) FROM writing_sessions").fetchone()[0] == 0
        assert not env.app.state.ai_client.calls


def test_ai_draft_is_private_and_only_the_confirmed_text_is_saved(tmp_path):
    def write(request):
        assert "가상아동나" not in request.user_text
        assert "또래와" in request.payload["text"]
        assert "오른쪽 무릎" in request.payload["text"]
        return {"content": "", "learning": [], "incident": "또래와 놀던 중 넘어져 오른쪽 무릎이 까짐. 물로 씻음."}

    with running_env(tmp_path, ai_handlers={AITask.JOURNAL_INDIVIDUAL: write}) as env:
        child, _ = add_children(env, ["가상아동가", "가상아동나"])
        route = f"{V2}/children/{child}/journal"
        client, headers = env.client, env.headers
        notes = {"content": "가상아동나와 놀던 중 넘어져 오른쪽 무릎이 까졌다. 물로 씻었다.", "areas": ["신체운동·건강"]}
        assert client.post(route + "/draft", headers=env.headers_b, json=notes).status_code == 404
        response = client.post(route + "/draft", headers=headers, json=notes)
        assert response.status_code == 202, response.text
        job_route = V2 + "/jobs/" + response.json()["job_id"]
        assert client.get(job_route, headers=env.headers_b).status_code == 404
        job = client.get(job_route, headers=headers).json()
        assert job["status"] == "completed", job
        for fact in ("오른쪽 무릎", "물로 씻음"):
            assert fact in job["result"]["content"]
        assert client.get(route, headers=headers).json()["items"] == []

        confirmed = "놀이 중 넘어져 오른쪽 무릎이 까짐. 교사가 물로 씻음."
        saved = client.post(route, headers=headers, json={**notes, "content": confirmed, "observed_date": "2026-11-18"})
        assert saved.json()["content"] == confirmed
        assert len(env.app.state.ai_client.calls) == 1
