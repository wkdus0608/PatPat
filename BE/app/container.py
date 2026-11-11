"""Builds the notice-first services and mounts the /api/v2 sub-application."""
from fastapi import FastAPI

from app.ai.factory import create_ai_client
from app.ai.gateway import AIGateway
from app.api.v2 import build_v2_app
from app.auth.signup import build_signup_app
from app.core.config import Settings
from app.core.database import Database
from app.jobs.router import jobs_router
from app.jobs.runner import JobRunner
from app.journal.router import journal_router
from app.journal.service import JournalService
from app.journal.store import JournalStore
from app.notices.router import notices_router
from app.notices.service import NoticeService
from app.notices.store import NoticeStore
from app.pipeline.router import pipeline_router
from app.pipeline.recording_router import router as recording_drafts_router
from app.pipeline.recording_runs import RecordingDrafts
from app.pipeline.recording_store import RecordingDraftStore
from app.pipeline.service import PipelineService
from app.profile.router import profile_router
from app.profile.store import ProfileStore
from app.quicknotes.router import quicknotes_router
from app.quicknotes.store import QuickNoteStore
from app.rules.loader import load_rules
from app.services import Services
from app.sessions.router import sessions_router
from app.sessions.store import SessionStore
from app.transcriptions.cache import RecordingTranscripts
from app.transcriptions.client import DemoSpeechToTextClient, MultipartSpeechToTextClient, SpeechToTextClient
from app.usage.router import usage_router


def install_services(
    application: FastAPI, settings: Settings, database: Database, *, speech_to_text: SpeechToTextClient | None = None,
) -> None:
    rules = load_rules(settings.rules_path)  # raises if a rule file is missing: the server must not run without them
    ai_client = create_ai_client(settings)
    gateway = AIGateway(ai_client, database, rules.rules_hash)
    profile = ProfileStore(database)
    sessions = SessionStore(database, profile)
    notices = NoticeStore(database)
    jobs = JobRunner(database, inline=settings.jobs_inline, workers=max(2, settings.ai_parallelism))
    journal_store = JournalStore(database)
    journal = JournalService(
        rules=rules, store=journal_store, notices=notices, sessions=sessions, profile=profile, jobs=jobs, ai=gateway
    )
    pipeline = PipelineService(
        rules=rules, sessions=sessions, profile=profile, notices=notices, ai=gateway, jobs=jobs,
        journal=journal, parallelism=settings.ai_parallelism,
    )
    notice_service = NoticeService(rules=rules, store=notices, sessions=sessions, jobs=jobs, ai=gateway, journal=journal)
    if speech_to_text is None:
        if settings.stt_url:
            speech_to_text = MultipartSpeechToTextClient(settings.stt_url, settings.stt_api_key, settings.stt_model)
        elif settings.ai_provider == "fake" and settings.demo_transcript.strip():
            speech_to_text = DemoSpeechToTextClient(settings.demo_transcript)
    transcripts = RecordingTranscripts(database, application.state.recording_service, speech_to_text)
    recording_store = RecordingDraftStore(database, notices)
    recording_drafts = RecordingDrafts(recording_store, pipeline, transcripts)
    services = Services(
        settings=settings, database=database, rules=rules, profile=profile, sessions=sessions, ai=gateway,
        jobs=jobs, pipeline=pipeline, notices=notices, notice_service=notice_service, journal=journal,
        journal_store=journal_store, quicknote_store=QuickNoteStore(database), recording_drafts=recording_drafts,
    )

    v2 = build_v2_app(
        settings,
        [profile_router, sessions_router, pipeline_router, recording_drafts_router, notices_router, journal_router, quicknotes_router,
         usage_router, jobs_router],
    )
    v2.mount("/auth", build_signup_app(database))
    # Dependencies read request.app.state; inside the mounted app that is the sub-app's state,
    # so the auth/roster services of the main app are shared explicitly.
    for name in ("auth_service", "children_service"):
        setattr(v2.state, name, getattr(application.state, name))
    for target in (application.state, v2.state):
        target.services = services
        target.profile_store = profile
    application.state.ai_client = ai_client
    application.state.v2_app = v2
    # The main app's lifespan runs these (a mounted sub-app has no lifespan of its own).
    application.state.startup_hooks = [jobs.recover, transcripts.recover, recording_store.recover]
    application.state.shutdown_hooks = [jobs.shutdown]
    application.mount("/api/v2", v2)
