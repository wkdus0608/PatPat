from io import BytesIO

from docx import Document
from docx.enum.table import WD_ROW_HEIGHT_RULE
from docx.shared import Pt

from app.ai.types import AITask
from app.journal.word import WORD_MIME
from tests.flow_helpers import V2, running_env
from tests.test_journal_api import confirm, day, journal

TEMPLATE = f"{V2}/teacher/journal-template"
RULES = "이름과 성별은 같은 칸에 적고 관찰일과 관찰내용을 채워 주세요."


def form(title: str) -> bytes:
    document = Document()
    document.add_heading(title)
    table = document.add_table(rows=3, cols=2)
    table.style = "Table Grid"
    for row, label in zip(table.rows, ["이름/성별", "관찰일", "관찰내용"]):
        row.cells[0].text = label
    table.rows[2].height = Pt(80)
    table.rows[2].height_rule = WD_ROW_HEIGHT_RULE.EXACTLY
    buffer = BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def choose_fields(request):
    assert request.payload["teacher_rules"] == RULES
    rows = request.payload["layout"][1]["table"]
    return {"placements": [
        {"slot": row[1]["paragraphs"][0]["slot"], "fields": fields}
        for row, fields in zip(rows, [["이름", "성별"], ["관찰일"], ["관찰내용"]])
    ]}


def test_raw_word_upload_preserves_file_bytes_and_handles_missing_payload(tmp_path):
    with running_env(tmp_path) as env:
        data = form("가상 Word 양식")
        filename = "맥북에서 고른 양식.DOCX"
        saved = env.client.post(TEMPLATE, params={"filename": filename}, content=data,
                                headers={**env.headers, "Content-Type": "application/octet-stream"})
        assert saved.json() == {"filename": filename}
        with env.app.state.database.connect() as db:
            assert db.execute("SELECT document FROM teacher_journal_templates").fetchone()[0] == data

        for invalid in (
            env.client.post(TEMPLATE, headers=env.headers, params={"filename": "빈 양식.docx"}, content=b""),
            env.client.put(TEMPLATE, headers=env.headers, data={"file": "파일 이름만 전송됨"}),
        ):
            assert invalid.status_code == 422
            assert invalid.json()["error"]["code"] == "WORD_FILE_MISSING"
        assert env.client.get(TEMPLATE, headers=env.headers).json() == {"filename": filename}


def test_word_output_is_an_editable_snapshot_replaced_only_by_reoutput(tmp_path):
    with running_env(tmp_path, ai_handlers={AITask.JOURNAL_WORD_LAYOUT: choose_fields}) as env:
        ids, _, notices = day(env)
        confirm(env, notices["다온"]["notice_id"], 1)
        _, _, later = day(env, ids, date="2026-11-07")
        confirm(env, later["다온"]["notice_id"], 1)
        child = ids["다온"]
        route = f"{V2}/children/{child}/journal"
        assert env.client.patch(f"{V2}/children/{child}/details", headers=env.headers, json={"gender": "여"}).is_success

        def generate():
            response = env.client.post(route + "/output", headers=env.headers)
            assert response.is_success, response.text
            return response.json()

        def upload(title):
            return env.client.put(TEMPLATE, headers=env.headers, files={"file": (title + ".docx", form(title), WORD_MIME)})

        def download(revision):
            return env.client.get(route + "/output/word", headers=env.headers, params={"revision": revision})

        first = generate()
        assert not first["has_word"] and "낙엽" in first["text"]
        assert download(first["revision"]).status_code == 404
        assert env.client.put(f"{V2}/teacher/documents/record_format", headers=env.headers, json={"text": RULES}).is_success
        assert upload("가상 원 양식").json() == {"filename": "가상 원 양식.docx"}
        assert env.client.get(TEMPLATE, headers=env.headers_b).json() == {"filename": None}
        assert journal(env, child)["output_stale"]

        snapshot = generate()
        response = download(snapshot["revision"])
        assert response.headers["content-type"] == WORD_MIME
        assert "filename*=UTF-8''" in response.headers["content-disposition"]
        original = response.content
        doc = Document(BytesIO(original))
        assert len(doc.tables) == 2
        assert doc.paragraphs[0].text == "가상 원 양식"
        assert doc.tables[0].style.name == "Table Grid"
        assert doc.tables[0].cell(0, 0).text == "이름/성별"
        assert doc.tables[0].cell(0, 1).text == "다온 / 여"
        assert doc.tables[0].cell(1, 1).text == "2026-11-06"
        assert doc.tables[1].cell(1, 1).text == "2026-11-07"
        assert doc.tables[0].rows[2].height_rule == WD_ROW_HEIGHT_RULE.AT_LEAST
        assert generate() == snapshot
        assert len(env.app.state.ai_client.calls_for(AITask.JOURNAL_WORD_LAYOUT)) == 1

        source = journal(env, child)["days"][0]
        long_text = "교사가 확인한 관찰입니다.\n\n" * 100 + "마지막 문장입니다."
        edited = env.client.patch(route, headers=env.headers, json={"days": [{
            "observed_date": source["observed_date"], "expected_revision": source["revision"], "content": long_text,
        }]})
        assert edited.is_success, edited.text
        assert journal(env, child)["output_stale"]
        assert download(snapshot["revision"]).content == original

        assert upload("교체한 양식").is_success
        invalid = env.client.put(TEMPLATE, headers=env.headers, files={"file": ("손상.docx", b"fake", WORD_MIME)})
        assert invalid.status_code == 422
        assert env.client.get(TEMPLATE, headers=env.headers).json() == {"filename": "교체한 양식.docx"}
        assert download(snapshot["revision"]).content == original

        new = generate()
        assert new["has_word"] and new["revision"] != snapshot["revision"]
        refreshed = Document(BytesIO(download(new["revision"]).content))
        assert refreshed.paragraphs[0].text == "교체한 양식"
        assert refreshed.tables[0].cell(2, 1).text == long_text
        assert download(snapshot["revision"]).status_code == 409
        assert not journal(env, child)["output_stale"]

        assert env.client.delete(TEMPLATE, headers=env.headers).status_code == 204
        assert journal(env, child)["output_stale"]
        assert download(new["revision"]).status_code == 200
        assert not generate()["has_word"]
