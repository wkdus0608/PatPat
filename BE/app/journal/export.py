"""Plain-text forms of the journal for copy and paste into a daycare's own 관찰일지 form."""

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
    wanted = [entry for entry in entries if entry["included"]]
    ready = [entry for entry in wanted if entry["status"] in ("ready", "edited")]
    return ready, len(wanted) - len(ready)


def as_text(child: dict, entries: list[dict]) -> str:
    lines = [f"이름: {child['name']}", f"성별: {child['gender'] or ''}", f"생년월일: {child['birth_date'] or ''}"]
    for entry in entries:
        lines += ["", f"[{entry['observed_date']}]"]
        for label, value in list(zip(FIELDS, _values(entry)))[1:]:
            lines.append(f"{label}: {value}")
    return "\n".join(lines) + "\n"


def as_tsv(entries: list[dict]) -> str:
    def cell(value: str) -> str:
        return " ".join(value.replace("\t", " ").split())

    rows = ["\t".join(FIELDS)] + ["\t".join(cell(value) for value in _values(entry)) for entry in entries]
    return "\n".join(rows) + "\n"
