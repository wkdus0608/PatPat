"""B6: observation-journal rows built from confirmed notices (fictional data only)."""
from app.ai.fake import DEFAULT_HANDLERS
from app.ai.types import AITask, AIUnavailable
from app.journal.service import plan_rows
from tests.flow_helpers import V2, add_children, fill, get_session, open_session, running_env

NAMES = ["다온", "이든", "서윤"]


def day(env, ids=None, date="2026-11-06", extra=None, *, prepare_journals=False):
    """A class day: shared note + 다온 and 이든 with their own notes, 서윤 without."""
    ids = ids or dict(zip(NAMES, add_children(env, NAMES)))
    session = open_session(env, date)
    fill(env, session, None, "바깥놀이터에서 낙엽을 모았어요.", ("자연탐구",), place="바깥놀이터", time_text="10:30~11:00")
    fill(env, session, "다온", "다온이는 낙엽을 두 손 가득 모았어요.", ("자연탐구", "신체운동·건강"))
    fill(env, session, "이든", "이든이는 미끄럼틀을 여러 번 탔어요.", ("신체운동·건강",), place="미끄럼틀", time_text="11:10")
    if extra:
        extra(session)
    query = "?prepare_journals=true" if prepare_journals else ""
    job = env.client.post(f"{V2}/sessions/{session['session_id']}/generate{query}", headers=env.headers)
    assert job.status_code == 202 and job.json()["status"] == "completed", job.text
    notices = {n["child_name"]: n for n in get_session(env, session["session_id"])["notices"]}
    return ids, session, notices


def confirm(env, notice_id, version, **options):
    response = env.client.post(
        f"{V2}/notices/{notice_id}/confirm", headers=env.headers, json={"expected_version": version, **options},
    )
    assert response.status_code == 200, response.text
    return response.json()


def unconfirm(env, notice_id, version):
    response = env.client.post(
        f"{V2}/notices/{notice_id}/unconfirm", headers=env.headers, json={"expected_version": version},
    )
    assert response.status_code == 200, response.text
    return response.json()


def journal(env, child_id, query="", headers=None):
    response = env.client.get(f"{V2}/children/{child_id}/journal{query}", headers=headers or env.headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_plan_rows_splits_the_confirmed_text_into_shared_and_own_rows():
    common = {"block_id": "c", "filled": True, "areas": ["자연탐구"], "place": "바깥", "time_text": "10:30", "child_id": None}
    child = {"block_id": "k", "filled": True, "areas": ["신체운동·건강"], "place": None, "time_text": "11:10", "child_id": "x"}
    both = plan_rows("공통 문단입니다.\n\n개별 문단입니다.\n\n둘째 개별 문단입니다.", child, common)
    assert [(r["block_kind"], r["text"]) for r in both] == [
        ("common", "공통 문단입니다."), ("individual", "개별 문단입니다.\n\n둘째 개별 문단입니다.")]
    assert both[1]["place"] == "바깥" and both[1]["time_text"] == "11:10"  # falls back to the shared place
    merged = plan_rows("하나로 합친 문단입니다.", child, common)
    assert len(merged) == 1 and merged[0]["block_kind"] == "individual" and merged[0]["areas"] == ["신체운동·건강", "자연탐구"]
    empty_child = {**child, "filled": False}
    assert [r["block_kind"] for r in plan_rows("공통 문단입니다.", empty_child, common)] == ["common"]
    assert [r["block_kind"] for r in plan_rows("개별 문단입니다.", child, {**common, "filled": False})] == ["individual"]
    assert plan_rows("글", {**child, "filled": False}, {**common, "filled": False}) == []
    same = plan_rows("공통  문단입니다.", child, common)[0]["source_hash"] == plan_rows("공통 문단입니다.", child, common)[0]["source_hash"]
    assert same  # whitespace alone does not change the source


def test_confirming_a_notice_adds_a_shared_row_and_an_own_row(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = day(env)
        result = confirm(env, notices["다온"]["notice_id"], 1)
        assert result["journal_job"]["status"] == "completed" and result["journal_job"]["result"]["generated"] == 2
        data = journal(env, ids["다온"])
        assert data["child"] == {"child_id": ids["다온"], "name": "다온", "gender": None, "birth_date": None}
        assert [(e["block_kind"], e["status"]) for e in data["items"]] == [("common", "ready"), ("individual", "ready")]
        shared, own = data["items"]
        assert shared["observed_date"] == "2026-11-06" and shared["areas"] == ["자연탐구"]
        assert shared["place"] == "바깥놀이터" and shared["time_text"] == "10:30~11:00" and "낙엽" in shared["content"]
        assert own["areas"] == ["신체운동·건강", "자연탐구"] and own["place"] == "바깥놀이터"  # place falls back to the shared one
        assert own["included"] is True and own["outdated"] is False and own["version"] == 2 and own["error_code"] is None
        assert journal(env, ids["이든"])["items"] == []  # nothing for children whose notice is not confirmed


def test_the_shared_row_is_written_once_for_the_whole_class(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = day(env)
        confirm(env, notices["다온"]["notice_id"], 1)
        second = confirm(env, notices["이든"]["notice_id"], 1)
        assert second["journal_job"]["result"] == {"generated": 1, "reused": 1, "failed": []}
        tasks = [c.task for c in env.app.state.ai_client.calls if c.task.value.startswith("journal")]
        assert tasks.count(AITask.JOURNAL_COMMON) == 1 and tasks.count(AITask.JOURNAL_INDIVIDUAL) == 2
        contents = {name: journal(env, ids[name])["items"][0]["content"] for name in ("다온", "이든")}
        assert contents["다온"] == contents["이든"]
        third = confirm(env, notices["서윤"]["notice_id"], 1)  # 서윤 only has the shared paragraph
        assert third["journal_job"]["result"]["reused"] == 1 and third["journal_job"]["result"]["generated"] == 0
        assert [e["block_kind"] for e in journal(env, ids["서윤"])["items"]] == ["common"]


def test_the_journal_prompt_uses_the_confirmed_text_and_the_class_age(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = day(env)
        env.client.patch(f"{V2}/classrooms/{session['classroom']['classroom_id']}", headers=env.headers, json={"age_label": "만 2세"})
        env.client.put(f"{V2}/children/{ids['다온']}/characteristics", headers=env.headers, json={"text": "말이 느린 편이에요."})
        env.client.patch(f"{V2}/notices/{notices['다온']['notice_id']}", headers=env.headers,
                         json={"edited_text": "공통 문단입니다.\n\n다온이는 낙엽을 세어 보았어요.", "expected_version": 1})
        confirm(env, notices["다온"]["notice_id"], 2)
        calls = {c.task: c for c in env.app.state.ai_client.calls if c.task.value.startswith("journal")}
        assert calls[AITask.JOURNAL_COMMON].payload["text"] == "공통 문단입니다."
        assert calls[AITask.JOURNAL_INDIVIDUAL].payload["text"] == "다온이는 낙엽을 세어 보았어요."
        assert calls[AITask.JOURNAL_INDIVIDUAL].payload["band"] == "2세" and calls[AITask.JOURNAL_INDIVIDUAL].payload["term"] == "영아"
        assert "말이 느린 편" in calls[AITask.JOURNAL_INDIVIDUAL].user_text
        assert not any(name in calls[AITask.JOURNAL_COMMON].user_text for name in NAMES)  # the shared row never names a child


def test_reconfirming_an_unchanged_notice_keeps_the_rows_and_a_changed_one_rewrites_only_what_changed(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = day(env)
        notice_id = notices["다온"]["notice_id"]
        confirm(env, notice_id, 1)
        before = journal(env, ids["다온"])["items"]
        calls_before = len(env.app.state.ai_client.calls)

        # reopen with an edit that only touches the child's own paragraph
        text = env.client.get(f"{V2}/notices/{notice_id}", headers=env.headers).json()["text"]
        shared = text.split("\n\n")[0]
        env.client.patch(f"{V2}/notices/{notice_id}", headers=env.headers,
                         json={"edited_text": shared + "\n\n다온이는 낙엽을 하나하나 세어 보았어요.", "expected_version": 2})
        stale = journal(env, ids["다온"])["items"]
        assert all(e["outdated"] for e in stale)  # the notice changed after the rows were made
        again = confirm(env, notice_id, 3)
        assert again["journal_job"]["result"] == {"generated": 1, "reused": 0, "failed": []}  # the shared row is kept as is
        after = journal(env, ids["다온"])["items"]
        assert [e["entry_id"] for e in after] == [e["entry_id"] for e in before]  # same rows, not new ones
        assert after[0]["content"] == before[0]["content"] and after[1]["content"] != before[1]["content"]
        assert all(not e["outdated"] and e["source_notice_version"] == 4 for e in after)
        assert [c.task for c in env.app.state.ai_client.calls[calls_before:]] == [AITask.JOURNAL_INDIVIDUAL]

        # editing the notice and then putting the very same text back generates nothing new
        same_text = shared + "\n\n다온이는 낙엽을 하나하나 세어 보았어요."
        env.client.patch(f"{V2}/notices/{notice_id}", headers=env.headers, json={"edited_text": "잠시 바꾼 글", "expected_version": 4})
        env.client.patch(f"{V2}/notices/{notice_id}", headers=env.headers, json={"edited_text": same_text, "expected_version": 5})
        calls_before = len(env.app.state.ai_client.calls)
        assert confirm(env, notice_id, 6)["journal_job"] is None
        assert len(env.app.state.ai_client.calls) == calls_before
        final = journal(env, ids["다온"])["items"]
        assert [e["content"] for e in final] == [e["content"] for e in after]
        assert all(not e["outdated"] and e["source_notice_version"] == 7 for e in final)


def test_reconfirming_an_edited_notice_requires_a_choice_and_only_refreshes_when_requested(tmp_path):
    with running_env(tmp_path) as env:
        ids, _, notices = day(env, prepare_journals=True)
        notice_id = notices["다온"]["notice_id"]
        path = f"{V2}/notices/{notice_id}"
        child_path = f"{V2}/children/{ids['다온']}/journal"
        first = confirm(env, notice_id, 1)
        assert first["journal_job"] is None
        same = unconfirm(env, notice_id, first["notice"]["version"])
        assert not same["needs_journal_update_choice"]
        restored = confirm(env, notice_id, same["version"])
        assert restored["journal_job"] is None
        confirm(env, notices["이든"]["notice_id"], 1)
        other = journal(env, ids["이든"])

        original_day = journal(env, ids["다온"])["days"][0]
        old_text = "교사가 직접 쓴 이전 관찰내용입니다."
        response = env.client.patch(child_path, headers=env.headers, json={"days": [{
            "observed_date": original_day["observed_date"], "expected_revision": original_day["revision"],
            "content": old_text,
        }]})
        assert response.status_code == 200
        undone = unconfirm(env, notice_id, restored["notice"]["version"])
        edited = env.client.patch(path, headers=env.headers, json={
            "expected_version": undone["version"], "edited_text": "다온이는 낙엽으로 그림을 그렸어요.",
        }).json()
        assert edited["needs_journal_update_choice"]
        assert env.client.get(path, headers=env.headers).json()["needs_journal_update_choice"]
        missing_choice = env.client.post(path + "/confirm", headers=env.headers, json={"expected_version": edited["version"]})
        assert missing_choice.status_code == 409 and missing_choice.json()["error"]["code"] == "JOURNAL_UPDATE_CHOICE_REQUIRED"
        kept = confirm(env, notice_id, edited["version"], update_journal=False)
        assert kept["journal_job"] is None and kept["notice"]["text"] == edited["text"]
        assert journal(env, ids["다온"])["days"][0]["content"] == old_text

        undone = unconfirm(env, notice_id, kept["notice"]["version"])
        edited = env.client.patch(path, headers=env.headers, json={
            "expected_version": undone["version"], "edited_text": "다온이는 낙엽을 크기별로 분류했어요.",
        }).json()
        refreshed = confirm(env, notice_id, edited["version"], update_journal=True)
        assert refreshed["journal_job"]["status"] == "completed"
        updated = journal(env, ids["다온"])
        assert updated["days"][0]["edit_version"] == 0 and "크기별로 분류" in updated["days"][0]["content"]
        assert [row["block_kind"] for row in updated["items"]] == ["individual"]
        assert updated["items"][0]["source_notice_version"] == refreshed["notice"]["version"]
        assert journal(env, ids["이든"]) == other
        archived = env.client.get(f"{V2}/journal/archive", headers=env.headers).json()
        assert archived[0]["content"] == updated["days"][0]["content"]
        exported = env.client.get(child_path + "/export", headers=env.headers).text
        assert "크기별로 분류" in exported and old_text not in exported
        calls = len(env.app.state.ai_client.calls)
        assert confirm(env, notice_id, edited["version"], update_journal=True)["journal_job"] is None
        assert len(env.app.state.ai_client.calls) == calls


def test_failed_refresh_keeps_the_complete_previous_journal(tmp_path):
    with running_env(tmp_path) as env:
        ids, _, notices = day(env, prepare_journals=True)
        notice_id = notices["다온"]["notice_id"]
        first = confirm(env, notice_id, 1)["notice"]
        before = journal(env, ids["다온"])
        undone = unconfirm(env, notice_id, first["version"])
        edited = env.client.patch(f"{V2}/notices/{notice_id}", headers=env.headers, json={
            "expected_version": undone["version"],
            "edited_text": "가을 놀이를 했어요.\n\n낙엽을 크기별로 분류했어요.",
        }).json()

        def down(_request):
            raise AIUnavailable("가상 테스트 오류")

        env.app.state.ai_client.handlers[AITask.JOURNAL_INDIVIDUAL] = down
        refreshed = confirm(env, notice_id, edited["version"], update_journal=True)
        assert refreshed["notice"]["status"] == "완료"
        assert refreshed["journal_job"]["status"] == "failed"
        assert journal(env, ids["다온"])["items"] == before["items"]
        assert journal(env, ids["다온"])["days"][0]["content"] == before["days"][0]["content"]


def test_rows_the_teacher_edited_are_never_overwritten(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = day(env)
        notice_id = notices["다온"]["notice_id"]
        confirm(env, notice_id, 1)
        own = journal(env, ids["다온"])["items"][1]
        edited = env.client.patch(f"{V2}/journal-entries/{own['entry_id']}", headers=env.headers,
                                  json={"expected_version": own["version"], "content": "교사가 직접 쓴 관찰내용입니다."})
        assert edited.status_code == 200 and edited.json()["status"] == "edited" and edited.json()["version"] == own["version"] + 1

        # the notice's own paragraph changes: the edited row stays and is flagged
        shared = env.client.get(f"{V2}/notices/{notice_id}", headers=env.headers).json()["text"].split("\n\n")[0]
        env.client.patch(f"{V2}/notices/{notice_id}", headers=env.headers,
                         json={"edited_text": shared + "\n\n다온이는 낙엽으로 그림을 그렸어요.", "expected_version": 2})
        confirm(env, notice_id, 3)
        kept = [e for e in journal(env, ids["다온"])["items"] if e["block_kind"] == "individual"][0]
        assert kept["content"] == "교사가 직접 쓴 관찰내용입니다." and kept["status"] == "edited" and kept["outdated"] is True

        # regenerating is the explicit way to replace it
        regenerated = env.client.post(f"{V2}/journal-entries/{own['entry_id']}/regenerate", headers=env.headers)
        assert regenerated.status_code == 202 and regenerated.json()["status"] == "completed"
        fresh = [e for e in journal(env, ids["다온"])["items"] if e["block_kind"] == "individual"][0]
        assert fresh["status"] == "ready" and "그림" in fresh["content"] and fresh["outdated"] is False


def test_an_edited_row_whose_paragraph_did_not_change_stays_current(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = day(env)
        notice_id = notices["다온"]["notice_id"]
        confirm(env, notice_id, 1)
        own = journal(env, ids["다온"])["items"][1]
        env.client.patch(f"{V2}/journal-entries/{own['entry_id']}", headers=env.headers,
                         json={"expected_version": own["version"], "place": "모래놀이터"})
        text = env.client.get(f"{V2}/notices/{notice_id}", headers=env.headers).json()["text"]
        parts = text.split("\n\n")
        env.client.patch(f"{V2}/notices/{notice_id}", headers=env.headers,
                         json={"edited_text": "새 공통 문단입니다.\n\n" + parts[1], "expected_version": 2})
        confirm(env, notice_id, 3)
        rows = {e["block_kind"]: e for e in journal(env, ids["다온"])["items"]}
        assert rows["individual"]["place"] == "모래놀이터" and rows["individual"]["outdated"] is False  # same paragraph
        assert "새 공통" in rows["common"]["content"]  # the shared row was untouched by the teacher, so it follows the text


def test_edit_validation_and_versions(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = day(env)
        confirm(env, notices["다온"]["notice_id"], 1)
        entry = journal(env, ids["다온"])["items"][1]
        url = f"{V2}/journal-entries/{entry['entry_id']}"
        send = lambda body, headers=None: env.client.patch(url, headers=headers or env.headers, json=body)
        assert send({"expected_version": entry["version"]}).status_code == 422  # nothing to change
        assert send({"expected_version": entry["version"], "content": None}).status_code == 422
        assert send({"expected_version": entry["version"], "content": "  "}).status_code == 422
        assert send({"expected_version": entry["version"], "areas": ["수학"]}).status_code == 422
        assert send({"expected_version": entry["version"], "included": None}).status_code == 422
        assert send({"expected_version": entry["version"], "status": "ready"}).status_code == 422
        assert send({"expected_version": entry["version"], "content": "가" * 3001}).status_code == 422
        assert send({"expected_version": entry["version"], "content": "글"}, env.headers_b).status_code == 404
        hidden = send({"expected_version": entry["version"], "included": False})
        assert hidden.status_code == 200 and hidden.json()["included"] is False and hidden.json()["status"] == "ready"
        stale = send({"expected_version": entry["version"], "content": "늦은 수정"})
        assert stale.status_code == 409 and stale.json()["error"]["code"] == "VERSION_CONFLICT"
        areas = send({"expected_version": hidden.json()["version"], "areas": ["자연탐구", "의사소통"], "time_text": "오전"})
        assert areas.json()["areas"] == ["의사소통", "자연탐구"] and areas.json()["status"] == "edited"
        cleared = send({"expected_version": areas.json()["version"], "place": None})
        assert cleared.json()["place"] is None and cleared.json()["time_text"] == "오전"


def test_a_row_being_written_cannot_be_edited(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = day(env)
        confirm(env, notices["다온"]["notice_id"], 1)
        entry = journal(env, ids["다온"])["items"][1]
        with env.app.state.database.connect() as connection:
            connection.execute("UPDATE journal_entries SET status='pending' WHERE entry_id=?", (entry["entry_id"],))
        busy = env.client.patch(f"{V2}/journal-entries/{entry['entry_id']}", headers=env.headers,
                                json={"expected_version": entry["version"], "content": "글"})
        assert busy.status_code == 409 and busy.json()["error"]["code"] == "ENTRY_BUSY"
        again = env.client.post(f"{V2}/journal-entries/{entry['entry_id']}/regenerate", headers=env.headers)
        assert again.status_code == 409 and again.json()["error"]["code"] == "ENTRY_BUSY"


def test_a_failed_row_can_be_retried_and_the_notice_stays_confirmed(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = day(env)

        def down(_request):
            raise AIUnavailable("AI 서비스에 연결할 수 없습니다.")

        env.app.state.ai_client.handlers[AITask.JOURNAL_COMMON] = down
        env.app.state.ai_client.handlers[AITask.JOURNAL_INDIVIDUAL] = down
        result = confirm(env, notices["다온"]["notice_id"], 1)
        assert result["notice"]["status"] == "완료"  # the notice is safe even though the journal could not be written
        assert result["journal_job"]["status"] == "failed" and result["journal_job"]["error_code"] == "AI_UNAVAILABLE"
        rows = journal(env, ids["다온"])["items"]
        assert [(e["status"], e["error_code"]) for e in rows] == [("failed", "AI_UNAVAILABLE")] * 2
        env.app.state.ai_client.handlers[AITask.JOURNAL_COMMON] = DEFAULT_HANDLERS[AITask.JOURNAL_COMMON]
        env.app.state.ai_client.handlers[AITask.JOURNAL_INDIVIDUAL] = DEFAULT_HANDLERS[AITask.JOURNAL_INDIVIDUAL]
        for row in rows:
            retried = env.client.post(f"{V2}/journal-entries/{row['entry_id']}/regenerate", headers=env.headers)
            assert retried.status_code == 202 and retried.json()["status"] == "completed"
        assert [e["status"] for e in journal(env, ids["다온"])["items"]] == ["ready", "ready"]


def test_journal_regeneration_needs_the_ai_and_a_confirmed_notice(tmp_path):
    with running_env(tmp_path, ai_provider="anthropic", anthropic_api_key="") as env:
        ids = dict(zip(NAMES, add_children(env, NAMES)))
        session = open_session(env)
        child_id = ids["다온"]
        notice = env.app.state.services.notices.save_generated(
            teacher_id=env.teacher_id, session_id=session["session_id"], child_id=child_id, target_date="2026-11-06",
            text="다온이는 낙엽을 모았어요.", needs_check=False, incident=False, warnings=[], rules_hash="x", model="fake")
        # confirm works without a key; the journal rows fail and wait for a retry
        confirmed = env.client.post(f"{V2}/notices/{notice['notice_id']}/confirm", headers=env.headers, json={"expected_version": 1})
        assert confirmed.status_code == 200 and confirmed.json()["notice"]["status"] == "완료"
        assert confirmed.json()["journal_job"] is None  # no block text, so no rows to make
        assert journal(env, child_id)["items"] == []


def test_export_gives_ready_included_rows_as_text_or_tsv(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = day(env)
        env.client.patch(f"{V2}/children/{ids['다온']}/details", headers=env.headers,
                         json={"gender": "여", "birth_date": "2023-05-01"})
        confirm(env, notices["다온"]["notice_id"], 1)
        entries = journal(env, ids["다온"])["items"]
        env.client.patch(f"{V2}/journal-entries/{entries[0]['entry_id']}", headers=env.headers,
                         json={"expected_version": entries[0]["version"], "included": False})
        text = env.client.get(f"{V2}/children/{ids['다온']}/journal/export", headers=env.headers)
        assert text.status_code == 200 and text.headers["content-type"].startswith("text/plain")
        assert text.headers["x-exported-count"] == "1" and text.headers["x-skipped-count"] == "0"
        assert text.text.startswith("이름: 다온\n성별: 여\n생년월일: 2023-05-01\n")
        assert "[2026-11-06]" in text.text and "관찰영역: 신체운동·건강, 자연탐구" in text.text and "관찰내용: " in text.text
        assert text.text.count("관찰내용:") == 1  # the hidden shared row is left out

        env.client.patch(f"{V2}/journal-entries/{entries[0]['entry_id']}", headers=env.headers,
                         json={"expected_version": entries[0]["version"] + 1, "included": True, "content": "줄\n바꿈\t탭"})
        tsv = env.client.get(f"{V2}/children/{ids['다온']}/journal/export?format=tsv", headers=env.headers)
        lines = tsv.text.strip("\n").split("\n")
        assert lines[0] == "관찰일\t관찰장소\t관찰시간\t관찰영역\t관찰내용" and len(lines) == 3
        assert lines[1].split("\t")[-1] == "줄 바꿈 탭" and all(len(line.split("\t")) == 5 for line in lines)
        assert env.client.get(f"{V2}/children/{ids['다온']}/journal/export?format=pdf", headers=env.headers).status_code == 422

        with env.app.state.database.connect() as connection:
            connection.execute("UPDATE journal_entries SET status='failed' WHERE entry_id=?", (entries[1]["entry_id"],))
        partial = env.client.get(f"{V2}/children/{ids['다온']}/journal/export", headers=env.headers)
        assert partial.headers["x-skipped-count"] == "1" and partial.headers["x-exported-count"] == "1"


def test_the_journal_can_be_cut_by_period_and_is_private(tmp_path):
    with running_env(tmp_path) as env:
        ids, day1, notices1 = day(env, date="2026-03-10")
        _, day2, notices2 = day(env, ids, date="2026-09-10")
        confirm(env, notices1["다온"]["notice_id"], 1)
        confirm(env, notices2["다온"]["notice_id"], 1)
        first_half = journal(env, ids["다온"], "?from=2026-03-01&to=2026-08-31")["items"]
        second_half = journal(env, ids["다온"], "?from=2026-09-01&to=2026-12-31")["items"]
        assert {e["observed_date"] for e in first_half} == {"2026-03-10"}
        assert {e["observed_date"] for e in second_half} == {"2026-09-10"}
        everything = journal(env, ids["다온"])["items"]
        assert [e["observed_date"] for e in everything] == ["2026-03-10"] * 2 + ["2026-09-10"] * 2
        assert env.client.get(f"{V2}/children/{ids['다온']}/journal", headers=env.headers_b).status_code == 404
        assert env.client.get(f"{V2}/children/{ids['다온']}/journal/export", headers=env.headers_b).status_code == 404
        assert env.client.get(f"{V2}/children/{ids['다온']}/journal").status_code == 401
        assert env.client.get(f"{V2}/children/{ids['다온']}/journal?from=bad", headers=env.headers).status_code == 422


def test_removing_a_child_from_the_roster_keeps_the_journal(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = day(env)
        confirm(env, notices["다온"]["notice_id"], 1)
        assert env.client.delete(f"{V2}/children/{ids['다온']}", headers=env.headers).status_code == 204
        assert len(journal(env, ids["다온"])["items"]) == 2


def test_editing_several_days_is_atomic_and_the_saved_text_appears_in_archive_and_export(tmp_path):
    with running_env(tmp_path) as env:
        first_date, second_date = "2026-11-06", "2026-11-08"
        ids, _, first = day(env, date=first_date)
        _, _, second = day(env, ids, date=second_date)
        child = ids["다온"]
        confirm(env, first["다온"]["notice_id"], 1)
        last_notice = confirm(env, second["다온"]["notice_id"], 1)["notice"]
        archive = f"{V2}/journal/archive"
        path = f"{V2}/children/{child}/journal"
        original = journal(env, child)
        first_day, second_day = original["days"]
        assert first_day["content"] == "\n\n".join(row["content"] for row in original["items"][:2])
        assert second_day["observed_date"] == second_date
        assert env.client.get(archive).status_code == 401
        assert env.client.get(archive, headers=env.headers_b).json() == []

        text_first = "  다온은 낙엽을 두 손으로 모았음.\n교사가 옆에서 관찰함.  "
        text_second = "다온은 모은 낙엽을 교사에게 보여 줌.\n\n색을 비교하는 모습이 관찰됨."
        updates = [
            {"observed_date": item["observed_date"], "expected_revision": item["revision"], "content": content}
            for item, content in zip((first_day, second_day), (text_first, text_second))
        ]
        stale = [updates[0], {**updates[1], "expected_revision": "0" * 64}]
        assert env.client.patch(path, headers=env.headers, json={"days": stale}).status_code == 409
        assert journal(env, child) == original  # the first date is rolled back as well
        assert env.client.patch(path, headers=env.headers_b, json={"days": updates}).status_code == 404

        response = env.client.patch(path, headers=env.headers, json={"days": updates})
        assert response.status_code == 200, response.text
        saved = response.json()
        assert [item["content"] for item in saved] == [text_first, text_second]
        assert all(item["edit_version"] == 1 for item in saved)
        assert env.client.patch(path, headers=env.headers, json={"days": updates}).json() == saved
        assert journal(env, child)["items"] == original["items"]
        assert journal(env, child, f"?from={second_date}")["days"] == saved[1:]

        archived = env.client.get(archive, headers=env.headers).json()
        assert [(item["child_id"], item["observed_date"], item["content"]) for item in archived] == [
            (child, first_date, text_first), (child, second_date, text_second),
        ]
        assert archived[0]["areas"] == original["items"][1]["areas"]
        output = env.client.get(path + "/export", headers=env.headers).text
        assert output.count(f"[{first_date}]") == 1 and output.count(f"[{second_date}]") == 1
        assert text_first in output and text_second in output

        notice_path = f"{V2}/notices/{last_notice['notice_id']}"
        undone = env.client.post(notice_path + "/unconfirm", headers=env.headers, json={
            "expected_version": last_notice["version"],
        }).json()
        assert env.client.get(archive, headers=env.headers).json() == archived[:1]
        confirm(env, last_notice["notice_id"], undone["version"])
        assert env.client.delete(f"{V2}/children/{child}", headers=env.headers).status_code == 204
        assert env.client.get(archive, headers=env.headers).json() == archived


def test_a_restart_fails_rows_that_were_still_being_written(tmp_path):
    with running_env(tmp_path) as env:
        ids, session, notices = day(env)
        confirm(env, notices["다온"]["notice_id"], 1)
        entry = journal(env, ids["다온"])["items"][1]
        with env.app.state.database.connect() as connection:
            connection.execute("UPDATE journal_entries SET status='pending' WHERE entry_id=?", (entry["entry_id"],))
            connection.execute("INSERT INTO jobs(job_id, teacher_id, kind, ref_id, status, created_at) VALUES ('j9', ?, 'journal', ?, 'running', '2026-11-06T00:00:00+00:00')",
                               (env.teacher_id, notices["다온"]["notice_id"]))
        assert env.app.state.services.jobs.recover() == 1
        row = journal(env, ids["다온"])["items"][1]
        assert row["status"] == "failed" and row["error_code"] == "SERVER_RESTART"
