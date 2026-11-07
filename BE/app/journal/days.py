"""A teacher can edit a day's combined text while its source rows keep their observation metadata."""
import hashlib
import json

from app.rules.loader import AREAS

READY_STATUSES = ("ready", "edited")


def group_days(entries: list[dict]) -> dict[tuple[str, str], list[dict]]:
    groups: dict[tuple[str, str], list[dict]] = {}
    for entry in entries:
        if entry["included"] and entry["notice_status"] == "완료":
            groups.setdefault((entry["child_id"], entry["observed_date"]), []).append(entry)
    return groups


def day_text(entries: list[dict]) -> dict:
    first = entries[0]
    ready = [entry for entry in entries if entry["status"] in READY_STATUSES]
    edited = first["day_content"]
    sources = entries if edited is not None else ready
    areas = {area for entry in sources for area in entry["areas"]}
    return {
        "child_id": first["child_id"],
        "child_name": first["child_name"],
        "observed_date": first["observed_date"],
        "content": edited if edited is not None else "\n\n".join(entry["content"] for entry in ready if entry["content"]),
        "areas": [area for area in AREAS if area in areas],
        "places": list(dict.fromkeys(entry["place"] for entry in sources if entry["place"])),
        "times": list(dict.fromkeys(entry["time_text"] for entry in sources if entry["time_text"])),
    }


def editable_day(entries: list[dict]) -> dict:
    edit_version = entries[0]["day_version"] or 0
    source_versions = sorted((entry["entry_id"], entry["version"], entry["notice_version"]) for entry in entries)
    revision = hashlib.sha256(json.dumps([edit_version, source_versions]).encode()).hexdigest()
    return {
        **day_text(entries),
        "edit_version": edit_version,
        "revision": revision,
        "editable": all(entry["status"] != "pending" for entry in entries),
    }
