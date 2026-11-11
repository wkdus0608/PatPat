"""Fill the original Word form using only existing journal fields and approved write locations."""
from copy import deepcopy
from dataclasses import dataclass
from io import BytesIO
import json
import re
from zipfile import BadZipFile, ZipFile

from docx import Document
from docx.enum.table import WD_ROW_HEIGHT_RULE
from docx.opc.exceptions import PackageNotFoundError
from docx.oxml.ns import qn
from docx.table import Table, _Row
from docx.text.paragraph import Paragraph
from lxml.etree import XMLSyntaxError, tostring

from app.ai.prompts import build_journal_word_layout
from app.ai.schemas import JOURNAL_WORD_FIELDS
from app.ai.types import AIError
from app.core.errors import ApiError

WORD_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
MAX_TEMPLATE_BYTES = 5 * 1024 * 1024
MAX_XML_BYTES = 30 * 1024 * 1024
FORBIDDEN_PARAGRAPH_TAGS = {qn("w:" + name) for name in ("drawing", "pict", "object", "fldSimple", "fldChar", "sdt")}
INVALID_XML_CHARS = re.compile(r"[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]")


@dataclass
class Slot:
    paragraph: Paragraph
    row: _Row | None

    def fill(self, value: str) -> None:
        if not value:
            return
        paragraph = self.paragraph
        text = INVALID_XML_CHARS.sub("", value)
        if paragraph.text.strip().endswith((":", "：")):
            paragraph.add_run(" " + text)
        elif paragraph.runs:
            paragraph.runs[0].text = text
        else:
            paragraph.add_run(text)
        if self.row is not None:
            if self.row.height_rule == WD_ROW_HEIGHT_RULE.EXACTLY:
                self.row.height_rule = WD_ROW_HEIGHT_RULE.AT_LEAST
            row_properties = self.row._tr.trPr
            if row_properties is not None:
                for locked in row_properties.findall(qn("w:cantSplit")):
                    row_properties.remove(locked)


def _invalid_template() -> ApiError:
    return ApiError(status_code=422, code="INVALID_WORD_TEMPLATE", message="편집 가능한 Word(.docx) 양식 파일을 선택해 주세요.")


def check_template_size(size: int) -> None:
    if size > MAX_TEMPLATE_BYTES:
        raise ApiError(status_code=413, code="WORD_TEMPLATE_TOO_LARGE", message="5MB 이하의 Word 양식 파일을 선택해 주세요.")


def check_archive(package: ZipFile) -> None:
    parts = package.infolist()
    if len(parts) > 1000 or sum(part.file_size for part in parts) > MAX_XML_BYTES:
        raise ApiError(status_code=422, code="WORD_TEMPLATE_COMPLEX", message="양식 파일의 내부 용량이 너무 커요.")


def open_form(data: bytes):
    check_template_size(len(data))
    try:
        with ZipFile(BytesIO(data)) as package:
            check_archive(package)
            parts = package.infolist()
            if any("vbaproject" in part.filename.lower() or "/embeddings/" in part.filename.lower() for part in parts):
                raise ApiError(status_code=422, code="UNSAFE_WORD_TEMPLATE", message="매크로나 첨부 개체가 포함된 .docx는 편집 가능한 양식으로 다시 저장해 주세요.")
        document = Document(BytesIO(data))
        if document.settings.element.find(qn("w:documentProtection")) is not None:
            raise ApiError(status_code=422, code="PROTECTED_WORD_TEMPLATE", message="Word에서 편집 제한을 해제한 뒤 양식을 올려 주세요.")
        return document
    except (BadZipFile, PackageNotFoundError, ValueError, KeyError, XMLSyntaxError, RuntimeError) as error:
        raise _invalid_template() from error


def _layout(document, elements) -> tuple[list, dict[str, Slot]]:
    slots = {}

    def describe(paragraph: Paragraph, key: str, row: _Row | None = None) -> dict:
        label = paragraph.text.strip()
        editable = (not label or label.endswith((":", "："))) and not any(
            node.tag in FORBIDDEN_PARAGRAPH_TAGS for node in paragraph._p.iter()
        )
        if editable:
            slots[key] = Slot(paragraph, row)
        return {"text": label[:300], **({"slot": key} if editable else {})}

    layout = []
    for index, element in enumerate(elements, 1):
        prefix = str(index)
        if element.tag == qn("w:p"):
            layout.append(describe(Paragraph(element, document), prefix))
        elif element.tag == qn("w:tbl"):
            rows = []
            seen = set()
            for row_index, row in enumerate(Table(element, document).rows, 1):
                cells = []
                for column_index, cell in enumerate(row.cells, row.grid_cols_before + 1):
                    if cell._tc in seen:
                        continue
                    seen.add(cell._tc)
                    cells.append({"column": column_index, "paragraphs": [
                        describe(paragraph, f"{prefix}.{row_index}.{column_index}.{number}", row)
                        for number, paragraph in enumerate(cell.paragraphs, 1)
                    ]})
                rows.append(cells)
            layout.append({"table": rows})
    return layout, slots


def _body_elements(document) -> list:
    return [node for node in document.element.body if node.tag != qn("w:sectPr")]


def validate_form(data: bytes) -> None:
    document = open_form(data)
    layout, slots = _layout(document, _body_elements(document))
    if not slots:
        raise ApiError(status_code=422, code="NO_WORD_FIELDS", message="Word 양식에 내용을 넣을 빈칸을 만들어 주세요.")
    if len(json.dumps(layout, ensure_ascii=False)) > 35000:
        raise _invalid_template()


def fill_form(data: bytes, days: list[dict[str, str]], instructions: str, services, teacher_id: str) -> bytes:
    document = open_form(data)
    body = _body_elements(document)
    layout, slots = _layout(document, body)
    if sum(len(tostring(element)) for element in body) * len(days) > MAX_XML_BYTES:
        raise ApiError(status_code=422, code="WORD_OUTPUT_TOO_LARGE", message="출력 기간을 줄여서 다시 시도해 주세요.")
    try:
        raw = services.ai.call(
            build_journal_word_layout(services.rules, layout=layout, instructions=instructions),
            teacher_id=teacher_id,
        ).data
    except AIError as failure:
        raise ApiError(status_code=503, code=failure.code, message="Word 양식의 입력 위치를 확인하지 못했어요. 다시 시도해 주세요.") from failure

    placements = {}
    def bad_layout() -> ApiError:
        return ApiError(status_code=422, code="INVALID_WORD_LAYOUT", message="양식에서 채울 칸을 찾지 못했어요. 작성 규칙에 항목과 위치를 적어 주세요.")

    proposed = raw.get("placements")
    if not isinstance(proposed, list) or not proposed:
        raise bad_layout()
    for item in proposed:
        if not isinstance(item, dict):
            raise bad_layout()
        key, fields = item.get("slot"), item.get("fields")
        if (not isinstance(key, str) or key not in slots or key in placements or not isinstance(fields, list)
                or not fields or any(field not in JOURNAL_WORD_FIELDS for field in fields)):
            raise bad_layout()
        placements[key] = list(dict.fromkeys(fields))

    originals = [deepcopy(element) for element in body]
    for index, values in enumerate(days):
        if index:
            document.add_page_break()
            elements = [deepcopy(element) for element in originals]
            for element in elements:
                document.element.body.insert_element_before(element, "w:sectPr")
            _, slots = _layout(document, elements)
        for key, fields in placements.items():
            slots[key].fill(" / ".join(values[field] for field in fields if values[field]))
    buffer = BytesIO()
    document.save(buffer)
    return buffer.getvalue()
