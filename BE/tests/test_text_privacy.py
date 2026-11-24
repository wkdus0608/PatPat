from app.ai.types import AITask
from tests.flow_helpers import V2, add_children, fill, get_session, open_session, running_env


def test_text_generation_uses_aliases_across_questions_and_both_drafts(tmp_path):
    ids = []

    def review(request):
        first = request.payload["roster"][0]
        return {"flags": [{"kind": "missing_fact", "child_ids": [first["child_id"]],
                          "question": first["name"] + "가 어떤 블록을 쌓았나요?", "options": []}],
                "joint_events": [], "incident_child_ids": []}

    def individual(request):
        return {"text": request.payload["name"] + "가 빨간 블록 두 개를 쌓았어요."}

    handlers = {AITask.REVIEW: review, AITask.INDIVIDUAL: individual}
    with running_env(tmp_path, ai_handlers=handlers) as env:
        ids.extend(add_children(env, ["가상하린", "가상지우"]))
        session = open_session(env)
        session_id = session["session_id"]
        token = f"⟦C:{ids[0]}⟧"
        fill(env, session, "가상하린", f"{token}가 가상지우에게 블록 두 개를 건넸어요.")
        client, headers = env.client, env.headers
        client.put(f"{V2}/teacher/documents/writing_examples", headers=headers,
                   json={"text": "가상하린과 가상지우가 함께했어요."})
        result = client.post(f"{V2}/sessions/{session_id}/generate", params={"protect_text": True, "prepare_journals": True},
                             headers=headers)
        assert result.status_code == 202, result.text
        flag, = get_session(env, session_id)["flags"]
        assert flag["child_ids"] == [ids[0]]
        assert token in flag["question"]
        answer = client.post(f"{V2}/sessions/{session_id}/answers", headers=headers,
                             json={"answers": [{"flag_id": flag["flag_id"], "answer": "가상하린은 빨간 블록을 사용했어요."}]})
        assert answer.json()["status"] == "completed", answer.text
        notice, = get_session(env, session_id)["notices"]
        detail = client.get(f"{V2}/notices/{notice['notice_id']}", headers=headers).json()
        assert token in detail["text"]
        calls = env.app.state.ai_client.calls
        assert any(call.task == AITask.JOURNAL_INDIVIDUAL for call in calls)
        for call in calls:
            complete_input = call.user_text + repr(call.payload)
            for value in [*ids, "가상하린", "가상지우", "가상 교사 A", "⟦C:"]:
                assert value not in complete_input


def test_standalone_journal_draft_uses_alias_and_keeps_peer_generic(tmp_path):
    with running_env(tmp_path) as env:
        first, peer = add_children(env, ["가상하린", "가상지우"])

        def write(request):
            assert "가상하린" not in request.user_text and "가상지우" not in request.user_text
            alias = request.payload["name"]
            assert alias.startswith("C") and alias in request.payload["text"]
            peer_alias = request.payload["text"].split(" ")[1].split("에게")[0]
            return {"content": f"{alias}가 {peer_alias}에게 블록을 건넴.", "learning": [], "incident": ""}

        env.app.state.ai_client.handlers[AITask.JOURNAL_INDIVIDUAL] = write
        route = f"{V2}/children/{first}/journal/draft"
        response = env.client.post(route, params={"protect_text": True}, headers=env.headers,
                                   json={"content": f"⟦C:{first}⟧가 ⟦C:{peer}⟧에게 블록을 건넸어요."})
        assert response.status_code == 202, response.text
        assert response.json()["result"]["content"] == f"⟦C:{first}⟧가 또래에게 블록을 건넴."
