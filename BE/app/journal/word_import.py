"""Normalize editable Word-compatible templates before storing them as DOCX."""
from io import BytesIO
from pathlib import Path
from shutil import which
import subprocess
from tempfile import TemporaryDirectory
from zipfile import BadZipFile, ZipFile

from lxml import etree

from app.core.errors import ApiError
from app.journal import word

EXTENSIONS = {".docx", ".doc", ".dotx", ".dot", ".docm", ".dotm", ".rtf", ".odt", ".ott", ".xml", ".fodt", ".word"}
COMPOUND_DOCUMENT = bytes.fromhex("D0CF11E0A1B11AE1")
ZIP_TYPES = {
    b"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml": ".docx",
    b"application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml": ".dotx",
    b"application/vnd.ms-word.document.macroenabled.main+xml": ".docm",
    b"application/vnd.ms-word.template.macroenabledtemplate.main+xml": ".dotm",
}
XML_DOCUMENTS = {
    "{http://schemas.microsoft.com/office/word/2003/wordml}wordDocument": ".xml",
    "{http://schemas.microsoft.com/office/2006/xmlPackage}package": ".xml",
    "{urn:oasis:names:tc:opendocument:xmlns:office:1.0}document": ".fodt",
}
SAFE_PROFILE = """<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
  <item oor:path="/org.openoffice.Office.Common/Security/Scripting">
    <prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>
    <prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop>
  </item>
  <item oor:path="/org.openoffice.Office.Writer/Content/Update">
    <prop oor:name="Link" oor:op="fuse"><value>2</value></prop>
  </item>
</oor:items>"""


def clean_filename(filename: str) -> str:
    filename = filename.replace("\\", "/").rsplit("/", 1)[-1].strip()
    if len(filename) > 255 or Path(filename).suffix.lower() not in EXTENSIONS:
        raise ApiError(
            status_code=422, code="UNSUPPORTED_WORD_TEMPLATE",
            message="Word 문서 또는 호환 양식(.docx, .doc, .dotx, .rtf, .odt 등)을 선택해 주세요.",
        )
    return filename


def _invalid_file() -> ApiError:
    return ApiError(
        status_code=422, code="INVALID_WORD_TEMPLATE",
        message="양식 파일을 열 수 없어요. Word에서 열리는지 확인하거나 .docx로 다시 저장해 주세요.",
    )


def _format(data: bytes, suffix: str) -> str:
    if data.startswith(COMPOUND_DOCUMENT):
        return ".dot" if suffix == ".dot" else ".doc"
    if data.removeprefix(b"\xef\xbb\xbf").lstrip().startswith(b"{\\rtf"):
        return ".rtf"
    if data.startswith(b"PK"):
        try:
            with ZipFile(BytesIO(data)) as package:
                word.check_archive(package)
                names = set(package.namelist())
                if "[Content_Types].xml" in names:
                    content_types = package.read("[Content_Types].xml").lower()
                    for mime, extension in ZIP_TYPES.items():
                        if mime in content_types:
                            return extension
                if {"mimetype", "content.xml"} <= names:
                    mime = package.read("mimetype")
                    if mime == b"application/vnd.oasis.opendocument.text":
                        return ".odt"
                    if mime == b"application/vnd.oasis.opendocument.text-template":
                        return ".ott"
        except (BadZipFile, KeyError, RuntimeError, NotImplementedError) as error:
            raise _invalid_file() from error
    if suffix in {".xml", ".fodt", ".word"}:
        try:
            root = etree.fromstring(data, parser=etree.XMLParser(resolve_entities=False, no_network=True))
            if not root.getroottree().docinfo.doctype and root.tag in XML_DOCUMENTS:
                kind = XML_DOCUMENTS[root.tag]
                if kind != ".fodt" or root.get("{urn:oasis:names:tc:opendocument:xmlns:office:1.0}mimetype") == "application/vnd.oasis.opendocument.text":
                    return kind
        except (etree.XMLSyntaxError, ValueError):
            pass
    raise _invalid_file()


def _convert(data: bytes, suffix: str, converter: str) -> bytes:
    program = converter or which("soffice")
    if not program:
        raise ApiError(status_code=503, code="WORD_CONVERTER_UNAVAILABLE", message="호환 양식 변환 서비스에 연결하지 못했어요. .docx로 저장한 파일은 바로 올릴 수 있어요.")
    with TemporaryDirectory(prefix="patpat-word-") as temporary:
        directory = Path(temporary)
        source = directory / ("template" + suffix)
        source.write_bytes(data)
        destination = directory / "output"
        destination.mkdir()
        profile = directory / "profile"
        user_profile = profile / "user"
        user_profile.mkdir(parents=True)
        (user_profile / "registrymodifications.xcu").write_text(SAFE_PROFILE, encoding="utf-8")
        try:
            subprocess.run(
                [program, "-env:UserInstallation=" + profile.as_uri(), "--headless", "--norestore",
                 "--convert-to", "docx:Office Open XML Text", "--outdir", str(destination), str(source)],
                check=True, timeout=40, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            with (destination / "template.docx").open("rb") as converted:
                return converted.read(word.MAX_TEMPLATE_BYTES + 1)
        except subprocess.TimeoutExpired as error:
            raise ApiError(status_code=422, code="WORD_CONVERSION_TIMEOUT", message="양식 변환에 시간이 너무 오래 걸렸어요. .docx로 다시 저장한 뒤 올려 주세요.") from error
        except FileNotFoundError as error:
            if error.filename == program:
                raise ApiError(status_code=503, code="WORD_CONVERTER_UNAVAILABLE", message="호환 양식 변환 서비스에 연결하지 못했어요.") from error
            raise _invalid_file() from error
        except (OSError, subprocess.CalledProcessError) as error:
            raise _invalid_file() from error


def normalize(data: bytes, filename: str, converter: str) -> bytes:
    word.check_template_size(len(data))
    if not data:
        raise ApiError(status_code=422, code="WORD_FILE_MISSING", message="업로드할 양식 파일이 비어 있어요. 파일을 다시 선택해 주세요.")
    kind = _format(data, Path(filename).suffix.lower())
    if kind == ".docx":
        try:
            word.validate_form(data)
            return data
        except ApiError as error:
            if error.code != "INVALID_WORD_TEMPLATE":
                raise
            # Strict Open XML documents also use .docx, but may need import first.
    converted = _convert(data, kind, converter)
    word.validate_form(converted)
    return converted
