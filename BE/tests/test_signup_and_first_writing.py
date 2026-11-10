from app.ai.types import AITask
from tests.flow_helpers import V2, add_children, fill, get_session, login, open_session, running_env


def test_signup_creates_a_separate_account_and_resumes_its_saved_setup(tmp_path):
    with running_env(tmp_path) as env:
        signup = f"{V2}/auth/signup"
        account = {"login_id": "가", "display_name": "가상 시연 교사", "password": "봄"}
        rejected = env.client.post(signup, json={**account, "password": ""})
        assert rejected.status_code == 422
        assert env.client.post(signup, json={**account, "login_id": " "}).status_code == 422
        created = env.client.post(signup, json=account)
        assert created.status_code == 201
        assert created.json()["teacher_id"] != env.teacher_id
        assert env.client.post(signup, json=account).status_code == 409

        headers = login(env.client, account["login_id"], account["password"])
        progress = f"{V2}/onboarding"
        assert env.client.get(progress).status_code == 401
        assert env.client.get(progress, headers=headers).json() == {"step": 1}
        assert env.client.put(progress, headers=headers, json={"step": 2}).json() == {"step": 2}
        add_children(env, ["다온"], headers=headers)
        assert env.client.get(progress, headers=env.headers).json() == {"step": 1}

        restored = login(env.client, account["login_id"], account["password"])
        assert env.client.get(progress, headers=restored).json() == {"step": 2}
        assert env.client.put(progress, headers=restored, json={"step": 3}).json() == {"step": 3}
        assert env.client.put(progress, headers=headers, json={"step": 2}).json() == {"step": 3}


def test_common_needs_no_area_and_waits_for_the_teachers_context(tmp_path):
    def review(_request):
        return {
            "flags": [{
                "kind": "missing_fact", "child_ids": [], "question": "낙엽을 어디에서 주웠나요?",
                "options": ["바깥놀이터", "공원"],
            }],
            "joint_events": [], "incident_child_ids": [],
        }

    def common(request):
        assert "바깥놀이터" in request.user_text
        return {"text": "[테스트 문장] 바깥놀이터에서 낙엽을 주웠어요."}

    with running_env(tmp_path, ai_handlers={AITask.REVIEW: review, AITask.COMMON: common}) as env:
        child_id = add_children(env, ["다온"])[0]
        session = open_session(env)
        sid = session["session_id"]
        fill(env, session, None, "낙엽을 주웠어요.", areas=())
        fill(env, session, "다온", "큰 낙엽을 들었어요.", areas=("자연탐구",))
        job = env.client.post(f"{V2}/sessions/{sid}/generate", headers=env.headers)
        assert job.status_code == 202 and job.json()["result"]["phase"] == "asking"
        assert not env.app.state.ai_client.calls_for(AITask.COMMON)

        flag = get_session(env, sid)["flags"][0]
        job = env.client.post(f"{V2}/sessions/{sid}/answers", headers=env.headers, json={
            "answers": [{"flag_id": flag["flag_id"], "answer": "바깥놀이터"}],
        })
        assert job.status_code == 202 and job.json()["result"]["phase"] == "reviewing"
        notice = get_session(env, sid)["notices"][0]
        path = f"{V2}/notices/{notice['notice_id']}"
        assert "바깥놀이터에서 낙엽을 주웠어요" in env.client.get(path, headers=env.headers).json()["text"]
        confirmed = env.client.post(path + "/confirm", headers=env.headers, json={"expected_version": notice["version"]})
        assert confirmed.status_code == 200
        journal = env.client.get(f"{V2}/children/{child_id}/journal", headers=env.headers).json()
        assert [(entry["block_kind"], entry["areas"]) for entry in journal["items"]] == [
            ("common", []), ("individual", ["자연탐구"]),
        ]
