"""Private audio and SQLite persistence. No speech or AI processing."""
from asyncio import to_thread
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import tempfile
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from app.core.config import Settings
from app.core.database import Database
from app.core.errors import ApiError
from app.recordings.models import Recording, RecordingAudio, RecordingPage, RecordingStatus


def missing():
    return ApiError(status_code=404, code="NOT_FOUND", message="녹음을 찾을 수 없습니다.")


def row_record(row):
    return Recording(**{key: (datetime.fromisoformat(row[key]) if key in ("created_at", "recorded_at")
                              else RecordingStatus(row[key]) if key == "status" else row[key])
                        for key in Recording.__dataclass_fields__})


class SQLiteRecordingService:
    def __init__(self, database: Database, settings: Settings):
        self.database = database
        self.settings = settings
        self.root = Path(settings.audio_path or str(Path(database.path).parent / "audio")).resolve()

    def path(self, recording_id):
        # IDs originate from UUID generation or a teacher-scoped database row.
        if str(UUID(recording_id)) != recording_id:
            raise missing()
        return self.root / (recording_id + ".audio")

    def validate(self, path, content_type):
        try:
            probe = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
                                   capture_output=True, timeout=self.settings.audio_validation_seconds, check=True)
            info = json.loads(probe.stdout)
            audio = [s for s in info["streams"] if s["codec_type"] == "audio"]
            if not audio or any(s["codec_type"] == "video" for s in info["streams"]):
                raise ValueError()
            formats = set(info["format"]["format_name"].split(','))
            expected = {"audio/mp4": {"mov", "mp4", "m4a"}, "audio/m4a": {"mov", "mp4", "m4a"},
                        "audio/x-m4a": {"mov", "mp4", "m4a"}, "audio/mpeg": {"mp3"},
                        "audio/wav": {"wav"}, "audio/x-wav": {"wav"}, "audio/webm": {"webm", "matroska"}, "audio/aac": {"aac"}}
            if not formats.intersection(expected.get(content_type, set())) or float(info["format"]["duration"]) <= 0:
                raise ValueError()
            subprocess.run(["ffmpeg", "-v", "error", "-xerror", "-i", str(path), "-map", "0:a:0", "-f", "null", "-"],
                           capture_output=True, timeout=self.settings.audio_validation_seconds, check=True)
        except FileNotFoundError:
            raise ApiError(status_code=503, code="AUDIO_VALIDATOR_UNAVAILABLE", message="서버 오디오 검증 도구를 확인해 주세요.") from None
        except (ValueError, KeyError, subprocess.SubprocessError):
            raise ApiError(status_code=415, code="INVALID_AUDIO", message="재생 가능한 오디오 파일인지 확인해 주세요.") from None

    async def upload(self, *, teacher, upload):
        def save():
            self.root.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=self.root, suffix=".pending", delete=False) as target:
                temporary = Path(target.name)
                size = 0
                digest = sha256()
                try:
                    while chunk := upload.stream.read(1024 * 1024):
                        size += len(chunk)
                        if size > self.settings.audio_max_bytes:
                            raise ApiError(status_code=413, code="AUDIO_TOO_LARGE", message="녹음 파일이 업로드 한도를 초과했습니다.")
                        digest.update(chunk)
                        target.write(chunk)
                    target.flush()
                    if not size:
                        raise ApiError(status_code=415, code="INVALID_AUDIO", message="빈 녹음 파일은 저장할 수 없습니다.")
                    target.close()
                    self.validate(temporary, upload.content_type)
                    published = None
                    try:
                        with self.database.connect() as connection:
                            connection.execute("BEGIN IMMEDIATE")
                            previous = connection.execute("SELECT * FROM recordings WHERE teacher_id=? AND upload_key=?",
                                                          (teacher.teacher_id, upload.upload_key)).fetchone() if upload.upload_key else None
                            if previous:
                                if (previous["digest"] != digest.hexdigest() or previous["title"] != upload.title
                                    or previous["recorded_at"] != upload.recorded_at.isoformat()
                                    or previous["duration_seconds"] != upload.duration_seconds
                                    or previous["content_type"] != upload.content_type or previous["deleted"]):
                                    raise ApiError(status_code=409, code="UPLOAD_CONFLICT", message="같은 업로드 키의 내용이 다르거나 삭제된 녹음입니다.")
                                return row_record(previous)
                            record = Recording(str(uuid4()), teacher.teacher_id, upload.title, upload.recorded_at,
                                               upload.duration_seconds, size, upload.content_type, RecordingStatus.QUEUED, datetime.now(timezone.utc))
                            published = self.path(record.recording_id)
                            temporary.replace(published)
                            connection.execute("INSERT INTO recordings VALUES (?,?,?,?,?,?,?,?,?,0,?,?)",
                                               (record.recording_id, record.teacher_id, record.title, record.recorded_at.isoformat(),
                                                record.duration_seconds, record.size_bytes, record.content_type, record.status.value,
                                                record.created_at.isoformat(), upload.upload_key, digest.hexdigest()))
                        return record
                    except BaseException:
                        if published:
                            published.unlink(missing_ok=True)
                        raise
                finally:
                    target.close()
                    temporary.unlink(missing_ok=True)
        return await to_thread(save)

    async def list(self, *, teacher, query):
        def read():
            with self.database.connect() as connection:
                rows = connection.execute("SELECT * FROM recordings WHERE teacher_id=? AND deleted=0", (teacher.teacher_id,)).fetchall()
            items = [row_record(row) for row in rows]
            items = [r for r in items if (not query.date_from or r.recorded_at.astimezone(ZoneInfo("Asia/Seoul")).date() >= query.date_from)
                     and (not query.date_to or r.recorded_at.astimezone(ZoneInfo("Asia/Seoul")).date() <= query.date_to)]
            items.sort(key=lambda r: (r.recorded_at, r.recording_id), reverse=query.order == "desc")
            return RecordingPage(tuple(items[query.offset:query.offset + query.limit]), len(items))
        return await to_thread(read)

    async def get(self, *, teacher, recording_id):
        def read():
            with self.database.connect() as connection:
                row = connection.execute("SELECT * FROM recordings WHERE teacher_id=? AND recording_id=? AND deleted=0",
                                         (teacher.teacher_id, recording_id)).fetchone()
            if not row:
                raise missing()
            return row_record(row)
        return await to_thread(read)

    async def open_audio(self, *, teacher, recording_id):
        record = await self.get(teacher=teacher, recording_id=recording_id)
        path = self.path(record.recording_id)
        if not await to_thread(path.is_file):
            raise missing()
        async def chunks():
            handle = await to_thread(path.open, "rb")
            try:
                while data := await to_thread(handle.read, 64 * 1024):
                    yield data
            finally:
                handle.close()
        return RecordingAudio(teacher.teacher_id, record.content_type, record.size_bytes, chunks())

    async def delete(self, *, teacher, recording_id):
        def remove():
            with self.database.connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute("SELECT * FROM recordings WHERE teacher_id=? AND recording_id=?",
                                         (teacher.teacher_id, recording_id)).fetchone()
                if not row:
                    raise missing()
                # Pending deletion stays inaccessible, but can be retried after IO failure.
                connection.execute("UPDATE recordings SET deleted=1 WHERE recording_id=?", (recording_id,))
                connection.execute("DELETE FROM recording_transcripts WHERE recording_id=?", (recording_id,))
            self.path(recording_id).unlink(missing_ok=True)
            with self.database.connect() as connection:
                connection.execute("UPDATE recordings SET deleted=2 WHERE recording_id=?", (recording_id,))
        await to_thread(remove)
