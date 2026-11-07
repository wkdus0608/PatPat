"""Plain-text forms of the journal for copy and paste into a daycare's own 관찰일지 form."""

from app.journal.days import READY_STATUSES, day_text, group_days

FIELDS = ("관찰일", "관찰장소", "관찰시간", "관찰영역", "관찰내용")


def _values(entry: dict) -> list[str]:
    return [
        entry["observed_date"],
        entry["place"] or "",
        entry["time_text"] or "",
        ", ".join(entry["areas"]),
        entry["content"],
    ]


def exportable(entries: list[dict]) -> tuple[list[dict], int]:
    """Rows to hand out, and how many wanted ones are not ready yet (still being written or failed)."""
    ready, skipped = [], 0
    for group in group_days(entries).values():
        if group[0]["day_content"] is not None:
            day = day_text(group)
            ready.append({**day, "place": ", ".join(day["places"]), "time_text": ", ".join(day["times"])})
        else:
            published = [entry for entry in group if entry["status"] in READY_STATUSES]
            ready.extend(published)
            skipped += len(group) - len(published)
    return ready, skipped


def as_text(child: dict, entries: list[dict]) -> str:
    lines = [f"이름: {child['name']}", f"성별: {child['gender'] or ''}", f"생년월일: {child['birth_date'] or ''}"]
    previous_date = None
    for entry in entries:
        lines.append("")
        if entry["observed_date"] != previous_date:
            previous_date = entry["observed_date"]
            lines.append(f"[{previous_date}]")
        for label, value in list(zip(FIELDS, _values(entry)))[1:]:
            lines.append(f"{label}: {value}")
    return "\n".join(lines) + "\n"


def as_tsv(entries: list[dict]) -> str:
    def cell(value: str) -> str:
        return " ".join(value.replace("\t", " ").split())

    rows = ["\t".join(FIELDS)] + ["\t".join(cell(value) for value in _values(entry)) for entry in entries]
    return "\n".join(rows) + "\n"
