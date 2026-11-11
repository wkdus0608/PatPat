**1. 문제**

여러 아동의 기록을 쓰는 어린이집 담임 교사 일부는 아이별 놀이·행동·반응을 떠올리거나 글로 옮기는 데 부담을 겪고, 개별 내용을 공통문으로 대신하거나 기록을 퇴근 후에 작성한다(로그 4, 6, 9). 자세한 근거는 [PROBLEM.md](PROBLEM.md)에 정리한다.


**2. 타깃 사용자**

여러 아동을 담당하며 알림장 또는 관찰일지를 직접 작성하는 어린이집 담임 보육교사(알림장을 매일 쓰지 않는 기관 포함). 비대상: 원장·행정 담당자, 보호자.

**3. 핵심 기능 (한 문장)**

교사가 텍스트나 녹음으로 입력한 관찰을 바탕으로 공통 활동과 아이별 사실을 담은 알림장 초안을 검토·수정·확정하고, 연결 관찰일지를 조회·편집하거나 Word로 출력한다.

**4. 범위**

- 현재 구현 범위는 반·아동 명단 설정, 기기 녹음 저장과 서버 업로드·재생, 날짜와 반별 작성 세션, 반 공통·아동별 텍스트 입력, 같은 날짜의 녹음 선택, 추가 확인 질문, 아동별 알림장 초안·수정·확정·확정 취소다. 서버에 저장된 작성 세션과 입력을 다시 불러올 수 있다.
- 관찰일지 초안은 알림장 검토 과정에서 함께 준비할 수 있다. 확정된 알림장에 연결된 관찰일지는 아동·날짜별로 조회·편집하고 보관함에서 열 수 있다. 본문을 고쳐 알림장을 다시 확정할 때는 교사가 연결된 관찰일지의 갱신 여부를 선택한다.
- 관찰일지 파일은 Word(`.docx`)로 출력한다. 교사가 등록한 양식의 서식을 유지하면서 선택한 아동·기간의 저장된 내용을 채운다.
- 민감한 상황은 부상·다툼 등의 당사자와 경위를 교사가 확인하고 초안을 검토·수정한다. 서버는 근거 없는 감정 표현이나 교사 주도 표현의 일부 패턴에 대해 경고를 반환한다. 경고의 범위는 해당 패턴으로 한정된다.
- 서버는 선택 원음을 설정된 외부 STT API로 전사한다. 성공한 결과는 재사용하고, 교사는 실패한 녹음을 재시도하거나 제외할 수 있다. 원음은 STT에만 전달하며 텍스트 AI에는 작업에 따라 전사문·교사 입력·아동 정보를 전달한다.
- 독립 관찰일지 작성, 문장별 근거 ID와 5-3절의 초기 API 응답 구조는 남은 구현이다. 기존 판정 기준은 6절을 따른다.
- 범위 밖은 기기 내 전사·전체 가명 처리와 실명 복원, 보호자 자동 발송, 외부 알림장 앱 연동, 사진 정리·분류, 상담·발달 기록이다. 기기 내 전사와 가명 처리는 후속 설계에 해당한다.

**5. 인터페이스**

현재 앱은 로그인·명단·녹음에 v1을, 계정 가입·초기 설정과 작성 업무에 v2를 사용한다. 상세 계약은 [백엔드 API 계약](../BE/docs/API_CONTRACT.md)을 따른다.

**5-1. 계정·명단·녹음**

| 기능 | 현재 요청과 결과 |
| --- | --- |
| 가입·로그인 | `POST /api/v2/auth/signup`에 `login_id`, `display_name`, `password`를 제출해 계정을 만든다. `POST /api/v1/auth/login`은 `login_id`, `password`를 받아 Bearer 토큰과 교사 정보를 반환한다. |
| 세션·명단 | `GET /api/v1/auth/me`로 교사 정보를 조회하고 `POST /api/v1/auth/logout`으로 세션을 폐기한다. `/api/v1/children`에서 명단을 관리하며, 서버의 고정 `child_id`는 아동이 비활성화된 뒤에도 유지한다. |
| 원음 | `POST /api/v1/recordings`에 파일·제목·시작 시각·길이를 전송하고 녹음 ID와 메타데이터를 받는다. 녹음 목록을 조회하거나 소유 교사의 인증으로 원음을 재생한다. |

서버는 계정·세션·명단을 SQLite에 저장하고 교사별로 자료 접근을 제한한다. 비밀번호는 Argon2id 해시로, 세션 토큰은 SHA-256 해시로 보관한다.

**5-2. 알림장 작성·관찰일지 v2**

아래 경로는 `/api/v2` 아래에 있다.

| 기능 | 현재 요청과 결과 |
| --- | --- |
| 입력 저장·이어쓰기 | `POST /sessions`에 `target_date`, `classroom_id`를 제출해 작성 세션을 연다. `PATCH /sessions/{session_id}/blocks/{block_id}`로 반 공통·아동별 입력을 저장하고 `GET /sessions/{session_id}`로 세션 상태와 저장된 입력을 불러온다. |
| 선택 녹음으로 초안 작성 | `POST /sessions/{session_id}/recording-drafts`에 `recording_ids`를 제출한다. 선택한 녹음의 전사 상태와 검토·생성 진행 상태를 반환한다. 이미 작성된 알림장의 새 후보는 교사가 아동별로 반영할 때 본문을 교체한다. |
| 검토·초안 생성 | `POST /sessions/{session_id}/generate?manual_areas=true&prepare_journals=true`로 작업을 시작한다. 필요한 추가 질문에 교사가 답하고 관찰영역은 직접 확인한다. 검토한 입력으로 알림장과 연결 관찰일지 초안을 준비할 수 있다. |
| 알림장 수정·확정 | `PATCH /notices/{notice_id}`에 `edited_text`, `expected_version`을 제출한다. `POST /notices/{notice_id}/confirm`은 저장된 버전을 확정하고, 필요하면 별도 관찰일지 작업을 시작한다. `POST /notices/{notice_id}/unconfirm`으로 확정을 취소할 수 있다. 재확정 시 `update_journal`로 일지 갱신 여부를 제출할 수 있다. |
| 관찰일지·보관함 | `GET /children/{child_id}/journal`로 아동의 날짜별 본문을 읽고, 같은 경로에 `PATCH`로 관찰일(`observed_date`)·본문(`content`)·`expected_revision`을 제출해 저장한다. `GET /journal/archive`에서 보관함을 조회한다. |
| 관찰일지 Word 출력 | `/teacher/journal-template`에서 교사 양식을 관리한다. `POST /children/{child_id}/journal/output`으로 기간별 미리보기를 만들고, `/children/{child_id}/journal/output/word`에서 Word 파일을 생성·다운로드한다. |

**5-3. 초기 관찰 기반 계약**

아래는 기존 골든 케이스가 사용하는 초기 계약이다. 현재 앱의 v2 요청·응답은 5-2절에 정리한다.

- `POST /observations` — body: `{child_ids[], text | audio}` → `{observations: [{observation_id, child_ids[], activity, text, observation_type, scope, sensitive}]}`
- `POST /drafts` — body: `{record_type, child_ids[], observation_ids[]}` → `{common_text, records: [{record_id, child_id, individual_sentences: [{text, observation_ids[], content_kind}], special_notes: [{text, sensitive}], missing_evidence, status}]}`
- `POST /records/{record_id}/confirm` — body: `{edited_text}` → `{status: "완료"}`
- 값: `record_type` = 알림장 | 관찰일지 / `scope` = common | individual | joint | unresolved / `status` = 작성중 | 검토중 | 완료 / `content_kind` = 관찰 | 배움 읽기 | 놀이 지원 | 지원 계획(관찰일지만) / `special_notes`는 알림장만. 아동은 가명 코드 `child_id`(C01 등)로 다루고 실명 매핑은 로컬에만 둔다.

**6. 수용 기준 (테스트로 검증 — Definition of Done)**

각 AC는 EARS 문형 “[조건]일 때, PatPat은 [동작]한다”로 쓰고, 조건 자리의 유형을 [ ]에 표시한다.

- AC1 [상시 적용]: PatPat은 항상 입력된 관찰 사실만을 바탕으로 누락 없이 작성한다 — 근거 관찰이 없는 문장, 입력에 없는 가공된 사실, 필수 관찰의 누락이 있으면 실패하며, 관찰이 0건인 아동은 "확인 필요(missing_evidence)"로 표시한다.
- AC2 [상시 적용]: PatPat은 항상 한 아동의 기록에 다른 아동의 관찰을 넣지 않는다 — 누구 일인지 불명확한 관찰은 어느 기록에도 넣지 않는다.
- AC3 [이벤트 기반]: 여러 아동의 초안을 요청받았을 때, PatPat은 공통 문장과 아이별 문장을 분리하여 응답한다 — 관찰이 다른 두 아동의 개별 문장이 동일하면 실패.
- AC4 [예외 대응]: 부상·다툼 관찰이 있으면, PatPat은 이를 특이사항(`special_notes`)으로 분리하고 사실을 바꾸지 않는다.
- AC5 [상시 적용]: PatPat은 항상 교사가 확정하기 전에는 기록을 완료하거나 발송하지 않는다.
- AC6 [상시 적용]: PatPat은 항상 가명 처리된 텍스트만 외부 AI에 보낸다 — 외부 요청에 실명·원본 음성·매핑표가 있으면 실패.
- AC7 [이벤트 기반]: `GET /health` 요청이 오면, PatPat은 200과 `{"status":"ok"}`를 반환한다.

기존 [골든 케이스](golden_cases.yaml)는 5-3절의 입력과 출력으로 AC1~AC4의 일부를 판정한다. GC-19는 관찰일지의 부상 사실을 관찰 본문에 보존하고 `special_notes`를 비운다고 명시한다. AC4의 특이사항 분리 형식은 알림장에 해당한다. AC6은 후속 로컬 전사·가명 처리 설계에 적용한다.

현재 v2와 연결한 의미 판정은 별도로 필요하다. 특히 공통 활동과 아이별 사실의 구분, 서로 다른 행동을 같은 내용의 표현만 바꾸어 썼는지 여부는 [스파이크의 의미 판정](spikes/unsupported_context_generation.md)을 참고한다. v2 경로를 문서화한 사실과 기존 수용 기준의 통과 여부는 구분한다.
