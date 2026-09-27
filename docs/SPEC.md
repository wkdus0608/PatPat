# 제품 스펙 (SPEC)

## 1. 문제
하루에 여러 아동(4명 이상)의 알림장·일지를 쓰는 어린이집 담임 교사가, 흩어진 관찰 근거에서 아이별 행동을 되찾아 공통 활동과 구분해 쓰는 일을 보육 시간 안에 끝내지 못해, 기록을 퇴근 후로 미루거나 아이별 내용을 공통문·일괄작성·생략으로 대신한다. (상세: PROBLEM.md)

## 2. 타깃 사용자
- **대상**: 하루 단위로 4명 이상 아동의 알림장 또는 관찰일지를 직접 작성하는 어린이집 담임 보육교사
- **비대상**: 원장·행정 담당자, 보호자

## 3. 핵심 기능 (한 문장)
교사가 보육 중에 남긴 짧은 관찰 메모(음성·텍스트) → 아동·활동별로 묶어 → 공통 활동 문장 + 근거가 연결된 아이별 관찰 문장으로 나뉜 알림장·일지 초안 → 교사가 검토·확정 후 복사·저장.

## 4. 범위
- **포함**: 음성·텍스트 관찰 입력, 관찰 구조화, 공통/아이별 문장 분리 초안, 문장별 근거 연결, 근거 없는 아동 "확인 필요" 표시, 민감 관찰 분리, 교사 검토·확정, 임시저장·이어쓰기
- **비포함**: 자동 발송, 외부 알림장 앱 연동, 사진 자동 분석, 발달 진단, 상담·발달 기록, 실명 저장, 결제, 다국어

## 5. 인터페이스
- `POST /observations` — body: `{child_ids[], text | audio}` → `{observations: [{observation_id, child_ids[], activity, text}]}`
- `POST /drafts` — body: `{record_type, child_ids[], observation_ids[]}` → `{common_text, records: [{record_id, child_id, individual_sentences: [{text, observation_ids[]}], special_notes: [{text, sensitive}], missing_evidence, status}]}`
- `POST /records/{record_id}/confirm` — body: `{edited_text}` → `{status: "완료"}`
- `GET /health` — `{status: "ok"}` (예정)

> 아동은 실명 대신 가명 코드(`child_id`, 예: `C01`)로만 다룬다. 보호자에게 보내는 엔드포인트는 만들지 않는다.

## 6. 수용 기준 (테스트로 검증 — Definition of Done)
각 AC는 EARS 문형 "[조건]일 때, PatPat은 [동작]한다"로 쓰고, 조건 자리의 유형을 [ ]에 표시한다.

- **AC1 [상시 적용]**: PatPat은 항상 아이별 문장마다 근거 관찰을 1개 이상 연결한다 — `observation_ids`가 비어 있는 아이별 문장은 없다.
- **AC2 [상시 적용]**: PatPat은 항상 입력에 없는 아동의 행동·발화·감정·부상을 생성하지 않는다 — 골든 케이스의 금지 사실(`forbidden_facts`)이 기록에 나오지 않는다.
- **AC3 [상시 적용]**: PatPat은 항상 한 아동의 기록에 다른 아동의 관찰을 넣지 않는다 — C01 기록에 C02에게만 연결된 관찰이 나오지 않는다.
- **AC4 [예외 대응]**: 어떤 아동의 관찰이 0건이면, PatPat은 그 아동의 개별 문장을 만들지 않고 `missing_evidence: true`로 표시한다.
- **AC5 [이벤트 기반]**: 여러 아동의 초안을 요청하면, PatPat은 공통 활동 문장(`common_text`)과 아이별 문장을 분리해 응답한다 — 관찰이 다른 두 아동의 개별 문장이 같으면 실패.
- **AC6 [이벤트 기반]**: 초안을 요청하면, PatPat은 입력한 관찰의 필수 사실(`required_facts`)을 해당 아동 기록에 모두 담는다.
- **AC7 [예외 대응]**: 부상·다툼 관찰이 입력되면, PatPat은 이를 `special_notes`에 `sensitive: true`로 분리하고 원래 사실(부위·상황·조치)을 바꾸지 않는다.
- **AC8 [상시 적용]**: PatPat은 항상 교사가 확정(`confirm`)하기 전의 기록을 완료로 바꾸거나 외부로 보내지 않는다.
- **AC9 [이벤트 기반]**: `GET /health` 요청이 오면, PatPat은 200과 `{"status":"ok"}`를 반환한다.

> AC1~AC8의 실행 가능한 골든 케이스: `docs/golden_cases.yaml` (추후 수정 필요 예정).