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


def test_demo_mode_exports_word_with_standard_labeled_fields(tmp_path):
    with running_env(tmp_path) as env:
        ids, _, notices = day(env)
        confirm(env, notices["다온"]["notice_id"], 1)
        child = ids["다온"]
        route = f"{V2}/children/{child}/journal"
        upload = env.client.post(TEMPLATE, params={"filename": "시연 양식.docx"},
                                 content=form("시연 양식"), headers={**env.headers, "Content-Type": WORD_MIME})
        assert upload.is_success, upload.text
        preview = env.client.post(route + "/output", headers=env.headers)
        assert preview.is_success, preview.text
        response = env.client.post(route + "/output/word", headers=env.headers,
                                   params={"revision": preview.json()["revision"]})
        assert response.is_success, response.text
        table = Document(BytesIO(response.content)).tables[0]
        assert table.cell(0, 1).text == "다온"
        assert table.cell(1, 1).text == "2026-11-06"
        assert "낙엽" in table.cell(2, 1).text


def test_word_output_is_an_editable_snapshot_replaced_only_by_reoutput(tmp_path):
    with running_env(tmp_path, ai_handlers={AITask.JOURNAL_WORD_LAYOUT: choose_fields}) as env:
        ids, _, notices = day(env)
        confirm(env, notices["다온"]["notice_id"], 1)
        _, _, later = day(env, ids, date="2026-11-07")
        confirm(env, later["다온"]["notice_id"], 1)
        child = ids["다온"]
        route = f"{V2}/children/{child}/journal"
        assert env.client.patch(f"{V2}/children/{child}/details", headers=env.headers, json={"gender": "여"}).is_success

        def preview():
            response = env.client.post(route + "/output", headers=env.headers)
            assert response.is_success, response.text
            return response.json()

        def upload(title):
            return env.client.put(TEMPLATE, headers=env.headers, files={"file": (title + ".docx", form(title), WORD_MIME)})

        def download(revision):
            return env.client.get(route + "/output/word", headers=env.headers, params={"revision": revision})

        def generate_word(revision):
            return env.client.post(route + "/output/word", headers=env.headers, params={"revision": revision})

        first = preview()
        assert not first["has_word"] and first["can_export_word"] and "낙엽" in first["text"]  # 양식이 없어도 기본 양식이 있다
        assert download(first["revision"]).status_code == 404
        default = generate_word(first["revision"])
        assert default.is_success, default.text
        default_table = Document(BytesIO(default.content)).tables[0]
        assert [row.cells[0].text for row in default_table.rows][:2] == ["이름", "성별"]
        assert default_table.cell(0, 1).text == "다온" and not env.app.state.ai_client.calls_for(AITask.JOURNAL_WORD_LAYOUT)
        assert env.client.put(f"{V2}/teacher/documents/record_format", headers=env.headers, json={"text": RULES}).is_success
        assert upload("가상 원 양식").json() == {"filename": "가상 원 양식.docx"}
        assert env.client.get(TEMPLATE, headers=env.headers_b).json() == {"filename": None}
        assert journal(env, child)["output_stale"]

        snapshot = preview()
        assert snapshot["can_export_word"] and not snapshot["has_word"]
        assert not env.app.state.ai_client.calls_for(AITask.JOURNAL_WORD_LAYOUT)
        assert download(snapshot["revision"]).status_code == 404
        response = generate_word(snapshot["revision"])
        assert response.is_success, response.text
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
        assert preview() == {**snapshot, "has_word": True}
        assert generate_word(snapshot["revision"]).content == original
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

        new = preview()
        assert new["can_export_word"] and not new["has_word"] and new["revision"] != snapshot["revision"]
        assert long_text in new["text"]
        assert len(env.app.state.ai_client.calls_for(AITask.JOURNAL_WORD_LAYOUT)) == 1
        assert download(snapshot["revision"]).content == original
        assert download(new["revision"]).status_code == 404
        response = generate_word(new["revision"])
        assert response.is_success, response.text
        refreshed = Document(BytesIO(response.content))
        assert refreshed.paragraphs[0].text == "교체한 양식"
        assert refreshed.tables[0].cell(2, 1).text == long_text
        assert download(snapshot["revision"]).status_code == 409
        assert not journal(env, child)["output_stale"]

        assert env.client.delete(TEMPLATE, headers=env.headers).status_code == 204
        assert journal(env, child)["output_stale"]
        assert download(new["revision"]).status_code == 200
        assert preview()["can_export_word"]  # 올린 양식을 지워도 기본 양식으로 출력할 수 있다
        assert download(new["revision"]).status_code == 200


def wide_form() -> bytes:
    """동료 피드백 ④의 양식: 관찰 기간, 해석 및 지원 계획, 작성 교사 칸이 있는 표."""
    labels = ["이름", "관찰 기간", "관찰일", "관찰 내용", "교사의 해석 및 지원 계획", "작성 교사"]
    document = Document()
    table = document.add_table(rows=len(labels), cols=2)
    table.style = "Table Grid"
    for row, label in zip(table.rows, labels):
        row.cells[0].text = label
    buffer = BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def write_with_interpretation(_request):
    return {"content": "낙엽을 두 손 가득 모음. 자연물을 모아 가며 탐색하는 경험을 함.", "learning": [], "incident": ""}


def test_word_output_fills_what_the_app_already_knows_and_splits_the_interpretation(tmp_path):
    with running_env(tmp_path, ai_handlers={AITask.JOURNAL_INDIVIDUAL: write_with_interpretation}) as env:
        ids, _, notices = day(env)
        confirm(env, notices["다온"]["notice_id"], 1)
        route = f"{V2}/children/{ids['다온']}/journal"
        upload = env.client.post(TEMPLATE, params={"filename": "감사용 양식.docx"}, content=wide_form(),
                                 headers={**env.headers, "Content-Type": WORD_MIME})
        assert upload.is_success, upload.text
        preview = env.client.post(route + "/output", headers=env.headers)
        response = env.client.post(route + "/output/word", headers=env.headers, params={"revision": preview.json()["revision"]})
        assert response.is_success, response.text
        cells = {row.cells[0].text: row.cells[1].text for row in Document(BytesIO(response.content)).tables[0].rows}
        assert cells["이름"] == "다온"
        assert cells["관찰 기간"] == "2026-11-06" and cells["관찰일"] == "2026-11-06"
        assert cells["작성 교사"] == "가상 교사 A"  # 설정에 등록한 교사 이름
        assert "낙엽을 두 손 가득 모음." in cells["관찰 내용"] and "경험을 함" not in cells["관찰 내용"]
        assert cells["교사의 해석 및 지원 계획"] == "자연물을 모아 가며 탐색하는 경험을 함."


def test_the_period_spans_every_day_in_the_output(tmp_path):
    with running_env(tmp_path, ai_handlers={AITask.JOURNAL_INDIVIDUAL: write_with_interpretation}) as env:
        ids, _, notices = day(env)
        confirm(env, notices["다온"]["notice_id"], 1)
        _, _, later = day(env, ids, date="2026-11-09")
        confirm(env, later["다온"]["notice_id"], 1)
        route = f"{V2}/children/{ids['다온']}/journal"
        assert env.client.post(TEMPLATE, params={"filename": "양식.docx"}, content=wide_form(),
                               headers={**env.headers, "Content-Type": WORD_MIME}).is_success
        preview = env.client.post(route + "/output", headers=env.headers)
        response = env.client.post(route + "/output/word", headers=env.headers, params={"revision": preview.json()["revision"]})
        tables = Document(BytesIO(response.content)).tables
        periods = [{row.cells[0].text: row.cells[1].text for row in table.rows}["관찰 기간"] for table in tables]
        assert periods == ["2026-11-06 ~ 2026-11-09", "2026-11-06 ~ 2026-11-09"]  # 날짜마다 한 쪽, 기간은 출력 전체


def test_without_an_interpretation_cell_the_content_keeps_every_sentence(tmp_path):
    with running_env(tmp_path, ai_handlers={AITask.JOURNAL_INDIVIDUAL: write_with_interpretation}) as env:
        ids, _, notices = day(env)
        confirm(env, notices["다온"]["notice_id"], 1)
        route = f"{V2}/children/{ids['다온']}/journal"
        assert env.client.post(TEMPLATE, params={"filename": "간단 양식.docx"}, content=form("간단 양식"),
                               headers={**env.headers, "Content-Type": WORD_MIME}).is_success
        preview = env.client.post(route + "/output", headers=env.headers)
        response = env.client.post(route + "/output/word", headers=env.headers, params={"revision": preview.json()["revision"]})
        assert "경험을 함" in Document(BytesIO(response.content)).tables[0].cell(2, 1).text


def test_the_default_form_needs_no_upload_and_carries_every_known_value(tmp_path):
    """동료 피드백 ③: 양식을 찾지 못해 Word 출력을 못 해 봤다. 기본 양식이 있으면 바로 받을 수 있다."""
    with running_env(tmp_path, ai_handlers={AITask.JOURNAL_INDIVIDUAL: write_with_interpretation}) as env:
        ids, _, notices = day(env)
        confirm(env, notices["다온"]["notice_id"], 1)
        route = f"{V2}/children/{ids['다온']}/journal"
        assert env.client.get(TEMPLATE, headers=env.headers).json() == {"filename": None}
        preview = env.client.post(route + "/output", headers=env.headers).json()
        assert preview["can_export_word"]
        response = env.client.post(route + "/output/word", headers=env.headers, params={"revision": preview["revision"]})
        assert response.is_success, response.text
        assert response.headers["content-type"] == WORD_MIME
        cells = {row.cells[0].text: row.cells[1].text for row in Document(BytesIO(response.content)).tables[0].rows}
        assert cells["이름"] == "다온" and cells["관찰 기간"] == "2026-11-06" and cells["작성 교사"] == "가상 교사 A"
        assert cells["관찰 영역"] and cells["관찰 장소"] == "바깥놀이터"
        assert "낙엽을 두 손 가득 모음." in cells["관찰 내용"] and "경험을 함" not in cells["관찰 내용"]
        assert cells["교사의 해석 및 지원 계획"] == "자연물을 모아 가며 탐색하는 경험을 함."
        assert not env.app.state.ai_client.calls_for(AITask.JOURNAL_WORD_LAYOUT)
