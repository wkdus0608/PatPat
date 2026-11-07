"""Additive schema extensions for the notice-first flow.

The legacy tables are created by `Database.initialize` and tracked with
`PRAGMA user_version` (still 2). Existing code inserts into those tables with
positional VALUES, so the new features never ALTER them: they only add tables,
tracked by name in `schema_extensions`.
"""
import sqlite3

from app.core.timeutil import now_iso

MIGRATIONS: tuple[tuple[str, str], ...] = (
    (
        "001_profiles",
        """
        CREATE TABLE teacher_documents (
            teacher_id TEXT NOT NULL REFERENCES teachers(teacher_id),
            kind TEXT NOT NULL CHECK(kind IN ('writing_examples','record_format')),
            text TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (teacher_id, kind)
        );
        CREATE TABLE child_profiles (
            child_id TEXT PRIMARY KEY REFERENCES children(child_id),
            characteristics TEXT,
            gender TEXT,
            birth_date TEXT,
            classroom_id TEXT,
            updated_at TEXT NOT NULL
        );
        """,
    ),
    (
        "002_sessions",
        """
        CREATE TABLE classrooms (
            classroom_id TEXT PRIMARY KEY,
            teacher_id TEXT NOT NULL REFERENCES teachers(teacher_id),
            name TEXT NOT NULL,
            age_label TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        );
        CREATE INDEX classrooms_teacher ON classrooms(teacher_id);
        CREATE TABLE writing_sessions (
            session_id TEXT PRIMARY KEY,
            teacher_id TEXT NOT NULL REFERENCES teachers(teacher_id),
            classroom_id TEXT NOT NULL REFERENCES classrooms(classroom_id),
            target_date TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('writing','analyzing','asking','drafting','reviewing','failed')),
            snapshot TEXT,
            common_paragraph TEXT,
            review_json TEXT,
            rules_hash TEXT,
            model TEXT,
            error_code TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(teacher_id, classroom_id, target_date)
        );
        CREATE TABLE input_blocks (
            block_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES writing_sessions(session_id),
            child_id TEXT REFERENCES children(child_id),
            text TEXT NOT NULL DEFAULT '',
            areas TEXT NOT NULL DEFAULT '[]',
            place TEXT,
            time_text TEXT,
            absent INTEGER NOT NULL DEFAULT 0 CHECK(absent IN (0,1)),
            updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX input_blocks_child ON input_blocks(session_id, child_id) WHERE child_id IS NOT NULL;
        CREATE UNIQUE INDEX input_blocks_common ON input_blocks(session_id) WHERE child_id IS NULL;
        CREATE TABLE review_flags (
            flag_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES writing_sessions(session_id),
            seq INTEGER NOT NULL,
            kind TEXT NOT NULL,
            child_ids TEXT NOT NULL DEFAULT '[]',
            question TEXT NOT NULL,
            options TEXT NOT NULL DEFAULT '[]',
            answer TEXT,
            status TEXT NOT NULL CHECK(status IN ('open','answered','skipped')),
            created_at TEXT NOT NULL
        );
        CREATE INDEX review_flags_session ON review_flags(session_id, seq);
        CREATE TABLE jobs (
            job_id TEXT PRIMARY KEY,
            teacher_id TEXT NOT NULL REFERENCES teachers(teacher_id),
            kind TEXT NOT NULL,
            ref_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
            error_code TEXT,
            error_message TEXT,
            result TEXT,
            created_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT
        );
        CREATE INDEX jobs_ref ON jobs(ref_id);
        """,
    ),
    (
        "003_notices",
        """
        CREATE TABLE notices (
            notice_id TEXT PRIMARY KEY,
            teacher_id TEXT NOT NULL REFERENCES teachers(teacher_id),
            session_id TEXT NOT NULL REFERENCES writing_sessions(session_id),
            child_id TEXT NOT NULL REFERENCES children(child_id),
            target_date TEXT NOT NULL,
            version INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('작성중','검토중','완료')),
            generated_text TEXT NOT NULL,
            edited_text TEXT NOT NULL,
            needs_check INTEGER NOT NULL DEFAULT 0,
            incident INTEGER NOT NULL DEFAULT 0,
            warnings TEXT NOT NULL DEFAULT '[]',
            rules_hash TEXT,
            model TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            confirmed_at TEXT,
            UNIQUE(session_id, child_id)
        );
        CREATE INDEX notices_teacher_child ON notices(teacher_id, child_id, target_date);
        CREATE TABLE notice_history (
            notice_id TEXT NOT NULL REFERENCES notices(notice_id),
            version INTEGER NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('generated','regenerated','manual_edit','confirm','adopt_revision')),
            text TEXT NOT NULL,
            status TEXT NOT NULL,
            revision_id TEXT,
            created_at TEXT NOT NULL,
            PRIMARY KEY (notice_id, version)
        );
        CREATE TABLE notice_revisions (
            revision_id TEXT PRIMARY KEY,
            notice_id TEXT NOT NULL REFERENCES notices(notice_id),
            teacher_id TEXT NOT NULL REFERENCES teachers(teacher_id),
            base_version INTEGER NOT NULL,
            instruction TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
            candidate_text TEXT,
            error_code TEXT,
            job_id TEXT,
            created_at TEXT NOT NULL,
            adopted_at TEXT
        );
        CREATE INDEX notice_revisions_notice ON notice_revisions(notice_id);
        """,
    ),
    (
        "004_journal",
        """
        CREATE TABLE journal_entries (
            entry_id TEXT PRIMARY KEY,
            teacher_id TEXT NOT NULL REFERENCES teachers(teacher_id),
            child_id TEXT NOT NULL REFERENCES children(child_id),
            session_id TEXT NOT NULL REFERENCES writing_sessions(session_id),
            block_id TEXT NOT NULL REFERENCES input_blocks(block_id),
            notice_id TEXT NOT NULL REFERENCES notices(notice_id),
            block_kind TEXT NOT NULL CHECK(block_kind IN ('common','individual')),
            observed_date TEXT NOT NULL,
            place TEXT,
            time_text TEXT,
            areas TEXT NOT NULL DEFAULT '[]',
            content TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL CHECK(status IN ('pending','ready','edited','failed')),
            error_code TEXT,
            included INTEGER NOT NULL DEFAULT 1 CHECK(included IN (0,1)),
            version INTEGER NOT NULL DEFAULT 1,
            source_notice_version INTEGER NOT NULL DEFAULT 1,
            source_hash TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(child_id, block_id)
        );
        CREATE INDEX journal_child_date ON journal_entries(teacher_id, child_id, observed_date);
        """,
    ),
    (
        "005_quick_notes",
        """
        CREATE TABLE quick_notes (
            note_id TEXT PRIMARY KEY,
            teacher_id TEXT NOT NULL REFERENCES teachers(teacher_id),
            note_date TEXT NOT NULL,
            child_id TEXT REFERENCES children(child_id),
            text TEXT NOT NULL,
            recording_id TEXT,
            imported_session_id TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX quick_notes_teacher_date ON quick_notes(teacher_id, note_date);
        """,
    ),
    (
        "006_ai_calls",
        """
        CREATE TABLE ai_calls (
            call_id TEXT PRIMARY KEY,
            teacher_id TEXT NOT NULL,
            session_id TEXT,
            task TEXT NOT NULL,
            model TEXT,
            rules_hash TEXT,
            status TEXT NOT NULL CHECK(status IN ('ok','error')),
            error_code TEXT,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            latency_ms INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );
        CREATE INDEX ai_calls_session ON ai_calls(session_id);
        """,
    ),
    (
        "007_teacher_onboarding",
        """
        CREATE TABLE teacher_onboarding (
            teacher_id TEXT PRIMARY KEY REFERENCES teachers(teacher_id),
            step INTEGER NOT NULL CHECK(step BETWEEN 1 AND 5)
        );
        """,
    ),
    (
        "008_notice_unconfirm",
        """
        ALTER TABLE notices ADD COLUMN withdrawn INTEGER NOT NULL DEFAULT 0 CHECK(withdrawn IN (0,1));
        CREATE TABLE notice_history_next (
            notice_id TEXT NOT NULL REFERENCES notices(notice_id),
            version INTEGER NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('generated','regenerated','manual_edit','confirm','unconfirm','adopt_revision')),
            text TEXT NOT NULL,
            status TEXT NOT NULL,
            revision_id TEXT,
            created_at TEXT NOT NULL,
            PRIMARY KEY (notice_id, version)
        );
        INSERT INTO notice_history_next SELECT notice_id, version, kind, text, status, revision_id, created_at FROM notice_history;
        DROP TABLE notice_history;
        ALTER TABLE notice_history_next RENAME TO notice_history;
        """,
    ),
    (
        "009_writing_preferences_and_journal_source",
        """
        CREATE TABLE teacher_writing_preferences (
            teacher_id TEXT PRIMARY KEY REFERENCES teachers(teacher_id),
            places TEXT NOT NULL DEFAULT '[]',
            times TEXT NOT NULL DEFAULT '[]'
        );
        ALTER TABLE journal_entries ADD COLUMN from_inputs INTEGER NOT NULL DEFAULT 0 CHECK(from_inputs IN (0,1));
        """,
    ),
    (
        "010_journal_day_edits",
        """
        CREATE TABLE journal_day_edits (
            teacher_id TEXT NOT NULL REFERENCES teachers(teacher_id),
            child_id TEXT NOT NULL REFERENCES children(child_id),
            observed_date TEXT NOT NULL,
            content TEXT NOT NULL,
            version INTEGER NOT NULL,
            PRIMARY KEY (teacher_id, child_id, observed_date)
        );
        """,
    ),
)


def _statements(script: str):
    for statement in script.split(";"):
        statement = statement.strip()
        if statement:
            yield statement


def apply_extensions(connection: sqlite3.Connection) -> None:
    """Run inside the caller's transaction; each migration is applied once."""
    connection.execute(
        "CREATE TABLE IF NOT EXISTS schema_extensions (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
    )
    applied = {row[0] for row in connection.execute("SELECT name FROM schema_extensions")}
    for name, script in MIGRATIONS:
        if name in applied:
            continue
        for statement in _statements(script):
            connection.execute(statement)
        connection.execute("INSERT INTO schema_extensions VALUES (?, ?)", (name, now_iso()))
