> 스펙 주도 개발(SDD). 이 문서가 "무엇을 만들지"의 단일 진실 공급원이다.

**1. 문제**
여러 아동의 알림장·관찰일지를 쓰는 어린이집 담임 교사가, 같은 활동이라도 아이별 말·행동·반응을 떠올려 문장을 달리 쓰는 일을 보육 시간 안에 끝내지 못해 기록을 퇴근 후로 미루거나 아이별 내용을 공통문으로 대신하게 된다. (상세: `PROBLEM.md`)


**2. 타깃 사용자**
여러 아동을 담당하며 알림장 또는 관찰일지를 직접 작성하는 어린이집 담임 보육교사(알림장을 매일 쓰지 않는 기관 포함). 비대상: 원장·행정 담당자, 보호자.

**3. 핵심 기능 (한 문장)**
틈날 때 남긴 음성·텍스트 관찰 → 로컬 전사·가명 처리 → **공통 문장과 근거 있는 아이별 문장으로 나뉜 알림장·관찰일지 초안** 생성 → 교사 검토·확정.

**4. 범위**

- 포함: 음성·텍스트 관찰 입력·누적 저장, 로컬 AI 전사·가명 처리와 로컬 실명 복원, 관찰의 아동·활동별 분류(공통/개별/공동/불명확), 대상일(알림장)·대상 기간(관찰일지)의 관찰 선택, 공통 문장/아이별 문장 분리 초안, 문장별 근거 관찰 연결, 근거 없는 아동 "확인 필요" 표시, 알림장의 부상·다툼 특이사항 분리, 관찰일지의 표준보육과정 4단계 구분, 교사 검토·확정, 임시저장·이어쓰기
- 비포함: 자동 발송, 외부 알림장 앱 연동, 사진 정리·분류, 상담·발달 기록, 실명·원본 음성·실명 매핑의 외부 전송

**5. 인터페이스**

- `POST /observations` — body: `{child_ids[], text | audio}` → `{observations: [{observation_id, child_ids[], activity, text, observation_type, scope, sensitive}]}`
- `POST /drafts` — body: `{record_type, child_ids[], observation_ids[]}` → `{common_text, records: [{record_id, child_id, individual_sentences: [{text, observation_ids[], content_kind}], special_notes: [{text, sensitive}], missing_evidence, status}]}`
- `POST /records/{record_id}/confirm` — body: `{edited_text}` → `{status: "완료"}`
- `GET /health` — `{status: "ok"}` (예정)
- 값: `record_type` = 알림장 | 관찰일지 / `scope` = common | individual | joint | unresolved / `status` = 작성중 | 검토중 | 완료 / `content_kind` = 관찰 | 배움 읽기 | 놀이 지원 | 지원 계획(관찰일지만) / `special_notes`는 알림장만. 아동은 가명 코드 `child_id`(C01 등)로 다루고 실명 매핑은 로컬에만 둔다.

**6. 수용 기준 (테스트로 검증 — Definition of Done)**

각 AC는 EARS 문형 “[조건]일 때, PatPat은 [동작]한다”로 쓰고, 조건 자리의 유형을 [ ]에 표시한다.

- AC1 [상시 적용]: PatPat은 항상 선택한 관찰의 사실만 빠짐없이 쓴다 — 근거 관찰 없는 문장, 입력에 없는 사실, 빠진 필수 사실이 있으면 실패하고, 관찰이 0건인 아동은 "확인 필요"로 표시한다.
- AC2 [상시 적용]: PatPat은 항상 한 아동의 기록에 다른 아동의 관찰을 넣지 않는다 — 누구 일인지 불명확한 관찰은 어느 기록에도 넣지 않는다.
- AC3 [이벤트 기반]: 여러 아동의 초안을 요청하면, PatPat은 공통 문장과 아이별 문장을 나눠 응답한다 — 관찰이 다른 두 아동의 문장이 같으면 실패.
- AC4 [예외 대응]: 부상·다툼 관찰이 있으면, PatPat은 이를 특이사항(`special_notes`)으로 분리하고 사실을 바꾸지 않는다.
- AC5 [상시 적용]: PatPat은 항상 교사가 확정하기 전에는 기록을 완료하거나 발송하지 않는다.
- AC6 [상시 적용]: PatPat은 항상 가명 처리된 텍스트만 외부 AI에 보낸다 — 외부 요청에 실명·원본 음성·매핑표가 있으면 실패.
- AC7 [이벤트 기반]: `GET /health` 요청이 오면, PatPat은 200과 `{"status":"ok"}`를 반환한다(예정).

> AC1~AC6의 골든 케이스: `docs/golden_cases.yaml`(이 SPEC에 맞춰 다시 작성 예정).
