**1. 문제**

여러 아동의 알림장·관찰일지를 쓰는 어린이집 담임 교사가, 같은 활동이라도 아이별 말·행동·반응을 떠올려 문장을 달리 쓰는 일을 보육 시간 안에 끝내지 못해 기록을 퇴근 후로 미루거나 아이별 내용을 공통문으로 대신하게 된다. (상세: `PROBLEM.md`)


**2. 타깃 사용자**

여러 아동을 담당하며 알림장 또는 관찰일지를 직접 작성하는 어린이집 담임 보육교사(알림장을 매일 쓰지 않는 기관 포함). 비대상: 원장·행정 담당자, 보호자.

**3. 핵심 기능 (한 문장)**

틈날 때 남긴 음성·텍스트 관찰 → 로컬 전사·가명 처리 → 공통 문장 + 근거 있는 아이별 문장으로 나뉜 알림장·관찰일지 초안 생성 → 교사 검토·확정.
MVP 단계에선 로컬 전사와 가명처리는 제외된다. 외부 API에서 SST로 대체한다. 

**4. 범위**

- 포함: 음성·텍스트 관찰 입력·누적 저장, 로컬 AI 전사·가명 처리와 로컬 실명 복원, 관찰의 아동·활동별 분류(공통/개별/공동/불명확), 대상일(알림장)·대상 기간(관찰일지)의 관찰 선택, 공통 문장/아이별 문장 분리 초안, 문장별 근거 관찰 연결, 근거 없는 아동 "확인 필요" 표시, 알림장의 부상·다툼 특이사항 분리, 관찰일지의 표준보육과정 4단계 구분, 교사 검토·확정, 임시저장·이어쓰기
- 비포함: 자동 발송, 외부 알림장 앱 연동, 사진 정리·분류, 상담·발달 기록, 실명·원본 음성·실명 매핑의 외부 전송

**5. 인터페이스**

- `POST /observations` — body: `{child_ids[], text | audio}` → `{observations: [{observation_id, child_ids[], activity, text, observation_type, scope, sensitive}]}`
- `POST /drafts` — body: `{record_type, child_ids[], observation_ids[]}` → `{common_text, records: [{record_id, child_id, individual_sentences: [{text, observation_ids[], content_kind}], special_notes: [{text, sensitive}], missing_evidence, status}]}`
- `POST /records/{record_id}/confirm` — body: `{edited_text}` → `{status: "완료"}`
- `GET /health` — `{status: "ok"}` (예정)
- 값: `record_type` = 알림장 | 관찰일지 / `scope` = common | individual | joint | unresolved / `status` = 작성중 | 검토중 | 완료 / `content_kind` = 관찰 | 배움 읽기 | 놀이 지원 | 지원 계획(관찰일지만) / `special_notes`는 알림장만. 아동은 가명 코드 `child_id`(C01 등)로 다루고 실명 매핑은 로컬에만 둔다.

**5-1. MVP 로그인·명단·DB (BE-01~02)**

현재 MVP는 외부 STT 기반 관찰일지를 대상으로 한다. 아래 로그인·명단은 실제 구현 계약이며, 녹음·일지 서버 계약은 `BE/docs/API_CONTRACT.md`를 따른다. 5절의 초기 관찰 기반 인터페이스와 구분한다.

- 사전에 준비한 테스트 계정만 사용한다. `POST /api/v1/auth/login`의 `{login_id, password}` → `{access_token, token_type: "bearer", expires_in, teacher: {teacher_id, display_name}}`, `GET /api/v1/auth/me` → `{teacher_id, display_name}`. `POST /api/v1/auth/logout`은 현재 세션을 폐기하고 204를 반환한다.
- 계정·세션·명단은 서버 SQLite에 저장한다. 비밀번호는 Argon2id 해시, 토큰은 SHA-256 해시로만 보관한다. 세션은 기본 7일이며 자동 갱신하지 않는다. 계정은 서버 관리 명령으로 생성하고 회원가입 API는 두지 않는다.
- 업무 소유자는 Bearer 인증의 `teacher_id`로만 결정한다. 로그인 실패는 `401 INVALID_CREDENTIALS`, 인증 누락은 `401 UNAUTHENTICATED`, 만료·변조·폐기는 `401 INVALID_TOKEN`, 다른 교사 자료는 404다. 인증 오류는 `WWW-Authenticate: Bearer`를 유지한다.
- 명단은 `GET /api/v1/children?include_inactive=false`, `POST /api/v1/children`의 `{name}`, `PATCH /api/v1/children/{child_id}`의 `{name}`, `POST /api/v1/children/{child_id}/deactivate`를 사용한다. 응답은 `{child_id, name, is_active}`, 목록은 `{items: [...]}`다. 서버 고정 ID를 쓰며 동명이인을 허용하고 비활성화해도 ID를 보존한다.
- 앱은 상단 설정에서 명단과 로그아웃을 제공한다. Android·iOS는 기기 보안 저장소로 로그인 유지, 웹 미리보기는 실행 중에만 유지한다. 통신 실패 시 토큰을 보존하고, 401이면 지운 뒤 다시 로그인한다.
- 실제 DB 검증은 가상 계정·가상 아동으로 수행한다. 녹음 업로드·STT·일지 생성은 아직 미연결이다.


**6. 수용 기준 (테스트로 검증 — Definition of Done)**

각 AC는 EARS 문형 “[조건]일 때, PatPat은 [동작]한다”로 쓰고, 조건 자리의 유형을 [ ]에 표시한다.

- AC1 [상시 적용]: PatPat은 항상 입력된 관찰 사실만을 바탕으로 누락 없이 작성한다 — 근거 관찰이 없는 문장, 입력에 없는 가공된 사실, 필수 관찰의 누락이 있으면 실패하며, 관찰이 0건인 아동은 "확인 필요(missing_evidence)"로 표시한다.
- AC2 [상시 적용]: PatPat은 항상 한 아동의 기록에 다른 아동의 관찰을 넣지 않는다 — 누구 일인지 불명확한 관찰은 어느 기록에도 넣지 않는다.
- AC3 [이벤트 기반]: 여러 아동의 초안을 요청받았을 때, PatPat은 공통 문장과 아이별 문장을 분리하여 응답한다 — 관찰이 다른 두 아동의 개별 문장이 동일하면 실패.
- AC4 [예외 대응]: 부상·다툼 관찰이 있으면, PatPat은 이를 특이사항(`special_notes`)으로 분리하고 사실을 바꾸지 않는다.
- AC5 [상시 적용]: PatPat은 항상 교사가 확정하기 전에는 기록을 완료하거나 발송하지 않는다.
- AC6 [상시 적용]: PatPat은 항상 가명 처리된 텍스트만 외부 AI에 보낸다 — 외부 요청에 실명·원본 음성·매핑표가 있으면 실패.
- AC7 [이벤트 기반]: `GET /health` 요청이 오면, PatPat은 200과 `{"status":"ok"}`를 반환한다(예정).

> AC1~AC6의 골든 케이스: `docs/golden_cases.yaml`(이 SPEC에 맞춰 다시 작성 예정).
