"""Successful transcripts are reusable across writing attempts for the same private audio."""
from asyncio import run
from contextlib import aclosing

from app.auth.models import TeacherContext
from app.core.database import Database
from app.core.errors import ApiError
from app.recordings.service import RecordingService
from app.transcriptions.client import SpeechToTextClient


class RecordingTranscripts:
    def __init__(self, database: Database, recordings: RecordingService, client: SpeechToTextClient | None):
        self.database = database
        self.recordings = recordings
        self.client = client

    def recover(self) -> None:
        with self.database.connect() as connection:
            connection.execute("UPDATE recording_transcripts SET status='failed' WHERE status='running'")

    @staticmethod
    def _require_recording(connection, teacher_id: str, recording_id: str) -> None:
        if not connection.execute(
            "SELECT 1 FROM recordings WHERE recording_id=? AND teacher_id=? AND deleted=0", (recording_id, teacher_id),
        ).fetchone():
            raise ApiError(status_code=404, code="NOT_FOUND", message="녹음을 찾을 수 없어요.")

    def text(self, teacher: TeacherContext, recording_id: str) -> str:
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._require_recording(connection, teacher.teacher_id, recording_id)
            row = connection.execute(
                "SELECT status, text FROM recording_transcripts WHERE recording_id=?", (recording_id,),
            ).fetchone()
            if row and row["status"] == "ready":
                return row["text"]
            if self.client is None:
                raise ApiError(status_code=503, code="STT_NOT_CONFIGURED", message="음성 전사 서비스가 연결되면 사용할 수 있어요.")
            if row and row["status"] == "running":
                raise ApiError(status_code=409, code="STT_IN_PROGRESS", message="이 녹음의 전사가 진행 중이에요.")
            connection.execute(
                "INSERT INTO recording_transcripts(recording_id, status) VALUES (?,'running') "
                "ON CONFLICT(recording_id) DO UPDATE SET status='running', text=NULL", (recording_id,),
            )
        try:
            text = run(self._transcribe(teacher, recording_id)).strip()
            if not text:
                raise ApiError(status_code=422, code="NO_SPEECH", message="녹음에서 음성을 확인하지 못했어요.")
            with self.database.connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                self._require_recording(connection, teacher.teacher_id, recording_id)
                connection.execute(
                    "UPDATE recording_transcripts SET status='ready', text=? WHERE recording_id=?", (text, recording_id),
                )
            return text
        except Exception:
            with self.database.connect() as connection:
                connection.execute("UPDATE recording_transcripts SET status='failed' WHERE recording_id=?", (recording_id,))
            raise

    async def _transcribe(self, teacher: TeacherContext, recording_id: str) -> str:
        audio = await self.recordings.open_audio(teacher=teacher, recording_id=recording_id)
        async with aclosing(audio.chunks) as chunks:
            return (await self.client.transcribe(audio=chunks, content_type=audio.content_type)).text
