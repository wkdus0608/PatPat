"""Teacher/child profile data: child characteristics, teacher documents, classrooms."""
import json

from app.core.database import Database
from app.core.timeutil import new_id, now_iso


class ProfileStore:
    def __init__(self, database: Database):
        self.database = database

    def writing_preferences(self, teacher_id: str) -> dict:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT places, times FROM teacher_writing_preferences WHERE teacher_id=?", (teacher_id,),
            ).fetchone()
        return {key: json.loads(row[key]) if row else [] for key in ("places", "times")}

    def save_writing_preferences(self, teacher_id: str, places: list[str], times: list[str]) -> None:
        with self.database.connect() as connection:
            connection.execute(
                "INSERT INTO teacher_writing_preferences(teacher_id, places, times) VALUES (?,?,?) "
                "ON CONFLICT(teacher_id) DO UPDATE SET places=excluded.places, times=excluded.times",
                (teacher_id, json.dumps(places, ensure_ascii=False), json.dumps(times, ensure_ascii=False)),
            )

    def onboarding_step(self, teacher_id: str) -> int:
        with self.database.connect() as connection:
            progress = connection.execute(
                "SELECT step FROM teacher_onboarding WHERE teacher_id=?", (teacher_id,)
            ).fetchone()
            if progress is not None:
                return progress["step"]
            has_roster = connection.execute(
                "SELECT 1 FROM children WHERE teacher_id=? AND is_active=1 LIMIT 1", (teacher_id,)
            ).fetchone()
        return 5 if has_roster else 1

    def advance_onboarding(self, teacher_id: str, step: int) -> int:
        with self.database.connect() as connection:
            progress = connection.execute(
                "INSERT INTO teacher_onboarding(teacher_id, step) VALUES (?,?) "
                "ON CONFLICT(teacher_id) DO UPDATE SET step=MAX(teacher_onboarding.step, excluded.step) RETURNING step",
                (teacher_id, step),
            ).fetchone()
        return progress["step"]

    # --- ownership -----------------------------------------------------------------
    def owns_child(self, teacher_id: str, child_id: str) -> bool:
        with self.database.connect() as connection:
            return connection.execute(
                "SELECT 1 FROM children WHERE teacher_id=? AND child_id=?", (teacher_id, child_id)
            ).fetchone() is not None

    def get_child(self, teacher_id: str, child_id: str) -> dict | None:
        """Name plus the form-header details (gender, birth date); also for children removed from the roster."""
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT c.child_id, c.name, c.is_active, p.gender, p.birth_date FROM children c "
                "LEFT JOIN child_profiles p ON p.child_id = c.child_id WHERE c.teacher_id=? AND c.child_id=?",
                (teacher_id, child_id),
            ).fetchone()
        return dict(row) if row else None

    # --- child characteristics (free text) -------------------------------------------
    def get_characteristics(self, child_id: str) -> tuple[str | None, str | None]:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT characteristics, updated_at FROM child_profiles WHERE child_id=?", (child_id,)
            ).fetchone()
        return (row["characteristics"], row["updated_at"]) if row else (None, None)

    def set_characteristics(self, child_id: str, text: str) -> str:
        stamp = now_iso()
        with self.database.connect() as connection:
            connection.execute(
                "INSERT INTO child_profiles(child_id, characteristics, updated_at) VALUES (?,?,?) "
                "ON CONFLICT(child_id) DO UPDATE SET characteristics=excluded.characteristics, "
                "updated_at=excluded.updated_at",
                (child_id, text, stamp),
            )
        return stamp

    # --- child details (gender, birth date, classroom) -----------------------------
    def get_details(self, child_id: str) -> dict:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT gender, birth_date, classroom_id FROM child_profiles WHERE child_id=?", (child_id,)
            ).fetchone()
        return {
            "gender": row["gender"] if row else None,
            "birth_date": row["birth_date"] if row else None,
            "classroom_id": row["classroom_id"] if row else None,
        }

    def update_details(self, child_id: str, changes: dict) -> dict:
        allowed = {key: value for key, value in changes.items() if key in ("gender", "birth_date", "classroom_id")}
        stamp = now_iso()
        with self.database.connect() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO child_profiles(child_id, updated_at) VALUES (?,?)", (child_id, stamp)
            )
            for key, value in allowed.items():
                connection.execute(
                    f"UPDATE child_profiles SET {key}=?, updated_at=? WHERE child_id=?", (value, stamp, child_id)
                )
        return self.get_details(child_id)

    # --- teacher documents ---------------------------------------------------------------
    def get_document(self, teacher_id: str, kind: str) -> tuple[str | None, str | None]:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT text, updated_at FROM teacher_documents WHERE teacher_id=? AND kind=?", (teacher_id, kind)
            ).fetchone()
        return (row["text"], row["updated_at"]) if row else (None, None)

    def set_document(self, teacher_id: str, kind: str, text: str) -> str:
        stamp = now_iso()
        with self.database.connect() as connection:
            connection.execute(
                "INSERT INTO teacher_documents(teacher_id, kind, text, updated_at) VALUES (?,?,?,?) "
                "ON CONFLICT(teacher_id, kind) DO UPDATE SET text=excluded.text, updated_at=excluded.updated_at",
                (teacher_id, kind, text, stamp),
            )
        return stamp

    # --- classrooms --------------------------------------------------------------------------
    @staticmethod
    def _classroom(row) -> dict:
        return {
            "classroom_id": row["classroom_id"],
            "teacher_id": row["teacher_id"],
            "name": row["name"],
            "age_label": row["age_label"],
        }

    def list_classrooms(self, teacher_id: str) -> list[dict]:
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM classrooms WHERE teacher_id=? ORDER BY created_at, rowid", (teacher_id,)
            ).fetchall()
        return [self._classroom(row) for row in rows]

    def get_classroom(self, teacher_id: str, classroom_id: str) -> dict | None:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM classrooms WHERE teacher_id=? AND classroom_id=?", (teacher_id, classroom_id)
            ).fetchone()
        return self._classroom(row) if row else None

    def create_classroom(self, teacher_id: str, name: str, age_label: str) -> dict:
        classroom_id = new_id()
        with self.database.connect() as connection:
            connection.execute(
                "INSERT INTO classrooms(classroom_id, teacher_id, name, age_label, created_at) VALUES (?,?,?,?,?)",
                (classroom_id, teacher_id, name, age_label, now_iso()),
            )
        return self.get_classroom(teacher_id, classroom_id)

    def default_classroom(self, teacher_id: str) -> dict:
        """The teacher's first classroom; created lazily so the roster works before any class setup."""
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM classrooms WHERE teacher_id=? ORDER BY created_at, rowid LIMIT 1", (teacher_id,)
            ).fetchone()
            if row is None:
                classroom_id = new_id()
                connection.execute(
                    "INSERT INTO classrooms(classroom_id, teacher_id, name, age_label, created_at) VALUES (?,?,?,?,?)",
                    (classroom_id, teacher_id, "우리 반", "", now_iso()),
                )
                row = connection.execute("SELECT * FROM classrooms WHERE classroom_id=?", (classroom_id,)).fetchone()
        return self._classroom(row)

    def update_classroom(self, teacher_id: str, classroom_id: str, changes: dict) -> dict | None:
        if self.get_classroom(teacher_id, classroom_id) is None:
            return None
        with self.database.connect() as connection:
            for key in ("name", "age_label"):
                if changes.get(key) is not None:
                    connection.execute(
                        f"UPDATE classrooms SET {key}=? WHERE teacher_id=? AND classroom_id=?",
                        (changes[key], teacher_id, classroom_id),
                    )
        return self.get_classroom(teacher_id, classroom_id)
