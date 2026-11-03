**1. 문제**

여러 아동의 알림장·관찰일지를 쓰는 어린이집 담임 교사가, 같은 활동이라도 아이별 말·행동·반응을 떠올려 문장을 달리 쓰는 일을 보육 시간 안에 끝내지 못해 기록을 퇴근 후로 미루거나 아이별 내용을 공통문으로 대신하게 된다. (상세: `PROBLEM.md`)


**2. 타깃 사용자**

여러 아동을 담당하며 알림장 또는 관찰일지를 직접 작성하는 어린이집 담임 보육교사(알림장을 매일 쓰지 않는 기관 포함). 비대상: 원장·행정 담당자, 보호자.

**3. 핵심 기능 (한 문장)**

현재 MVP: 앱 녹음 업로드 → 서버에서 외부 STT로 전사(가명 처리 생략) → 선택 녹음과 전체 아동 명단으로 공통/아이별 관찰일지 초안 → 교사 검토·수정·확정 → 앱의 복사·OS 공유. 현재 구현 단계는 이 흐름의 API 계약과 검증 구조이며 DB·파일 저장·외부 API는 미연결이다.

**4. 범위**

현재 관찰일지 MVP는 사전 테스트 계정, 서버 실명 명단/고정 아동 ID, 녹음 업로드/비공개 재생/삭제, 외부 STT, 선택 녹음 기반 초안, 직접 수정/확정, AI 수정 후보, 이전 기록 조회, 확정문 복사/OS 공유를 대상으로 한다. 사용자의 MVP 변경 결정에 따라 가명 처리는 생략한다. 자세한 실행 가능한 계약은 5-1~5-4절과 `BE/docs/API_CONTRACT.md`를 따른다.

아래 두 목록은 초기 장기 설계 범위다. 알림장·텍스트 직접 관찰 입력·로컬 전사/가명 처리·실명 복원은 현재 MVP의 구현/검증 범위에 포함하지 않는다. 자동 발송·사진·공개 공유 링크·외부 플랫폼 연동은 계속 비포함이다.

- 포함: 음성·텍스트 관찰 입력·누적 저장, 로컬 AI 전사·가명 처리와 로컬 실명 복원, 관찰의 아동·활동별 분류(공통/개별/공동/불명확), 대상일(알림장)·대상 기간(관찰일지)의 관찰 선택, 공통 문장/아이별 문장 분리 초안, 문장별 근거 관찰 연결, 근거 없는 아동 "확인 필요" 표시, 알림장의 부상·다툼 특이사항 분리, 관찰일지의 표준보육과정 4단계 구분, 교사 검토·확정, 임시저장·이어쓰기
- 비포함: 자동 발송, 외부 알림장 앱 연동, 사진 정리·분류, 상담·발달 기록, 실명·원본 음성·실명 매핑의 외부 전송

**5. 인터페이스**

현재 앱 연결 정본은 아래 **5-1~5-4절의 `/api/v1` API**다. 다음 세 업무 API는 초기 장기 설계 기록이며 현재 구현 계약을 대체하지 않는다. 예를 들어 현재 초안 요청은 child_ids/observation_ids/record_type 없이 recording_ids만 받는다.

- `POST /observations` — body: `{child_ids[], text | audio}` → `{observations: [{observation_id, child_ids[], activity, text, observation_type, scope, sensitive}]}`
- `POST /drafts` — body: `{record_type, child_ids[], observation_ids[]}` → `{common_text, records: [{record_id, child_id, individual_sentences: [{text, observation_ids[], content_kind}], special_notes: [{text, sensitive}], missing_evidence, status}]}`
- `POST /records/{record_id}/confirm` — body: `{edited_text}` → `{status: "완료"}`
- `GET /health` — `{status: "ok"}` (구현됨)
- 값: `record_type` = 알림장 | 관찰일지 / `scope` = common | individual | joint | unresolved / `status` = 작성중 | 검토중 | 완료 / `content_kind` = 관찰 | 배움 읽기 | 놀이 지원 | 지원 계획(관찰일지만) / `special_notes`는 알림장만. 아동은 가명 코드 `child_id`(C01 등)로 다루고 실명 매핑은 로컬에만 둔다.

**5-1. MVP 테스트 계정 인증 계약 (BE-01)**

BE 작업 계획의 테스트 계정 로그인·교사별 접근 경계를 구체화한다. 아래 필드는 인증을 위한 서버 설계이며 관찰·일지 입력 필드를 변경하지 않는다. 이번 작업은 API 규격과 서비스·저장소 인터페이스까지이며, 계정 DB·비밀번호 검증·토큰 발급은 연결하지 않는다.

- `POST /api/v1/auth/login` — JSON `{login_id, password}` → `{access_token, token_type: "bearer", expires_in, teacher: {teacher_id, display_name}}`. `expires_in`은 초 단위의 양수다. 두 입력값은 비어 있지 않은 문자열이며, `teacher_id` 등 추가 필드는 거부한다. 사전에 준비한 테스트 계정만 허용하고 회원가입 API는 제공하지 않는다.
- `GET /api/v1/auth/me` — `Authorization: Bearer <access_token>` → `{teacher_id, display_name}`. 업무 API의 소유자는 요청 본문이나 쿼리가 아닌 검증된 인증 컨텍스트의 `teacher_id`로 결정한다.
- 로그인 실패는 `401 INVALID_CREDENTIALS`, 인증 누락·잘못된 인증 방식은 `401 UNAUTHENTICATED`, 만료·변조 등 토큰 검증 실패는 `401 INVALID_TOKEN`으로 정의한다. 인증 오류에는 `WWW-Authenticate: Bearer`를 보존한다. 응답은 BE의 공통 오류 형식을 따른다.
- 다른 교사의 리소스는 `404 NOT_FOUND`로 처리한다. 후속 기능은 인증된 교사 ID로 저장소 조회·쓰기를 제한하고, 소유권 검사도 적용한다.
- 기본 실행에서는 로그인과 토큰 확인 서비스가 `501 NOT_IMPLEMENTED`를 반환한다. 인증 헤더의 누락·형식과 요청 모델 검증은 실행하며, 테스트에서는 가짜 서비스를 주입해 정상·실패 계약을 확인한다. 이 결과는 실제 계정·토큰 검증 완료를 뜻하지 않는다.
- 비밀번호는 저장소 인터페이스에서 해시로만 표현하고, 비밀번호·토큰은 오류 응답에 복사하지 않는다. 상세 계약과 연결 지점은 `BE/docs/API_CONTRACT.md`의 인증 절과 `BE/app/auth/`를 따른다.


**5-2. MVP 명단·녹음·외부 전사 계약 (BE-02~04)**

2026-11-02 사용자가 BE-02~04의 동시 진행을 요청해 BE 작업 계획을 구체화한다. 이번 범위도 API·모델·인터페이스·테스트까지다. 실제 DB·비공개 원음 저장소·외부 STT 호출은 연결하지 않는다. 이 절은 기존 로컬 전사·가명 처리 계약에 대한 사용자의 MVP 변경 결정(외부 STT 사용, 가명 처리 생략)을 해당 작업에 적용한다. 기존 생성 품질 골든 케이스의 판정 조건은 변경하지 않는다.

- BE-02: `GET /api/v1/children?include_inactive=false`, `POST /api/v1/children`의 `{name}`, `PATCH /api/v1/children/{child_id}`의 `{name}`, `POST /api/v1/children/{child_id}/deactivate`. 아동 응답은 `{child_id, name, is_active}`, 목록은 `{items: [...]}`. 이름은 비어 있지 않은 문자열이며 고정 ID는 실명과 연결한다. 비활성화 시 과거 기록과 ID를 보존한다.
- BE-03: `POST /api/v1/recordings`는 multipart의 `file`, `title`, 시간대 포함 `recorded_at`, 양수 `duration_seconds`를 받는다. 등록 응답은 201. 목록·상세·인증된 재생·삭제는 각각 `GET /recordings`, `GET /recordings/{recording_id}`, `GET /recordings/{recording_id}/audio`, `DELETE /recordings/{recording_id}`(204)이다(모두 `/api/v1` 아래). 메타데이터는 ID·제목·녹음 시각·길이·바이트 수·MIME·상태·생성 시각을 포함한다. 오디오 MIME 검증은 실제 파일 내용 검증을 대신하지 않는다.
- 녹음 상태 값은 `대기`, `전사중`, `완료`, `실패`다. 원음 삭제는 재생과 신규 작성 선택을 막고 이미 만든 일지와 근거 스냅샷은 보존한다. 저장소 경로·공개 URL은 응답에 포함하지 않는다.
- BE-04: `POST /api/v1/recordings/{recording_id}/transcriptions`(본문 생략 또는 빈 객체)는 202와 `{job_id, recording_id, status}`를 반환하는 비동기 계약이다. `GET /api/v1/transcription-jobs/{job_id}` 및 `GET /api/v1/recordings/{recording_id}/transcriptions/latest`로 작업 상태·전사문·연결된 관찰 ID를 조회한다. 작업 상태는 공통 `queued/running/completed/failed`다. 실패 시 안전한 실패 단계·코드·재시도 가능 여부를 제공한다.
- 전사는 대기 또는 실패 녹음에만 요청한다. 이미 실행 중이거나 완료한 녹음의 재요청은 409, 다른 교사·삭제·없는 녹음은 404로 처리한다. 실패 후 재시도는 새 작업 ID를 만들고 기존 실패 이력을 보존한다. 작업 생성과 중복 방지 상태 변경은 후속 저장소 구현에서 원자적으로 수행한다. 전사 완료 녹음만 후속 초안 생성에 선택할 수 있다.
- 외부 STT 클라이언트는 서버 비공개 원음을 받아 전사문을 반환하는 교체 가능한 인터페이스다. 실제 원음·실명·키는 저장소나 테스트에 추가하지 않는다. STT 자체는 아동 분류·관찰 추출·일지 생성을 수행하지 않으며 연결 관찰 ID는 후속 추출 단계에서 채운다.
- 모든 경로는 `CurrentTeacher` 인증을 요구하고 소유자는 인증에서만 결정한다. 저장소의 모든 조회·쓰기에 교사 범위를 전달한다. 기본 인증 서비스가 연결되지 않은 현재는 토큰 확인부터 501이다. 인증 대체 서비스를 주입해도 기본 업무 서비스는 501을 반환한다.
- 새 모델 필드는 명단 설정·원음 관리·비동기 전사 요청을 추적하기 위한 서버 설계다. 상세 계약은 `BE/docs/CHILDREN.md`, `RECORDINGS.md`, `TRANSCRIPTIONS.md`를 따른다.


**5-3. MVP 초안·직접 수정·AI 재요청 계약 (BE-05~07)**

기존 BE 구조 작업을 이어 API·모델·서비스/저장소/AI 인터페이스와 구조 검사를 제공한다. 기본 서비스는 501이며 실제 DB·작업 큐·외부 AI는 연결하지 않는다. 이 절의 새 ID·버전·스냅샷은 선택 근거 보존과 동시 수정 충돌 방지를 위한 서버 설계다. 기존 5-2절과 생성 품질 골든 케이스는 보존한다.

- `POST /api/v1/drafts`는 `{recording_ids: [...]}`만 받아 202 `{draft_id, job_id, status}`를 반환하는 계약이다. 비어 있거나 중복인 선택은 422, 다른 교사·삭제·없는 녹음은 404, 전사 미완료는 409다. 서버는 생성 시작 시 교사의 전체 활성 명단과 선택 녹음의 전사문·관찰을 고정한다. 사용자가 아동·관찰을 추가 지정할 수 없다.
- `GET /api/v1/drafts/{draft_id}`는 작업 상태와 완료 시 아동별 `record_id`가 포함된 결과를 제공한다. 작업은 공통 queued/running/completed/failed, 일지는 작성중/검토중/완료로 구분한다. 공통 문장과 아동별 문장을 분리하고 원래 명단 순서로 반환한다. 모든 개별 문장의 observation_ids는 선택된 스냅샷의 해당 아동 individual/joint 근거만 참조한다. common/unresolved를 개별 근거로 대체하지 않는다. 대상 불명확·동명이인 관찰은 unresolved로 보존하고 어느 아동에도 임의 배정하지 않는다. 개별 근거가 없는 아동은 missing_evidence:true와 빈 개별 문장으로 표시한다. 관찰/배움 읽기/놀이 지원/지원 계획은 입력 관찰에 근거가 있는 항목만 허용한다.
- `GET /api/v1/records/{record_id}`, `PATCH /api/v1/records/{record_id}`의 `{edited_text, expected_version}`, `POST /api/v1/records/{record_id}/confirm`의 동일 본문, `GET /api/v1/records/{record_id}/history`를 정의한다. 저장·확정은 AI 없이 submitted edited_text를 공백·줄바꿈까지 그대로 보존한다. 빈/공백뿐인 본문은 422로 거부한다. 직접 저장은 검토중, 확정은 완료로 전환한다. 완료 후 다시 수정하면 검토중으로 되돌리고 확정 시각을 비운다. 과거 본문·상태·작업 종류와 버전은 이력으로 남긴다.
- `POST /api/v1/records/{record_id}/revisions`는 `{instruction, expected_version}`을 받아 202 `{revision_id, job_id, record_id, status}`를 반환한다. 서버가 현재 본문·해당 아동·기존 근거를 읽어 새 후보를 만든다. 기존 일지는 자동 변경하지 않는다. `GET /api/v1/records/{record_id}/revisions/{revision_id}`로 작업·후보를 확인하고, `POST /api/v1/records/{record_id}/revisions/{revision_id}/adopt`에 `{expected_version}`으로 채택한다. 채택은 AI 없이 후보 본문을 적용하고 검토중으로 전환한다. 실패 시 현재 본문을 보존한다.
- version은 1부터 시작한다. 직접 저장·확정·후보 채택은 expected_version 비교와 버전 증가·이력 기록을 원자적으로 처리한다. 재요청은 base_version을 고정하며 그 사이 본문이 바뀌면 채택은 409다. 다른 일지/다른 교사 후보는 404, 미완료 후보는 409다. 모든 조회·쓰기는 인증 교사 범위로 제한한다.
- AI 생성·재요청 결과의 사실 의미·누락·부상 보존은 구조 검사만으로 판정하지 않는다. 현재 테스트는 가상 데이터/대체 서비스로 계약·참조·상태 전환을 확인하며 골든 케이스의 실제 생성 품질·독립 의미 판정 완료로 보고하지 않는다. 상세는 `BE/docs/WRITING.md`를 따른다.


**5-4. MVP 이전 기록 조회·공유 계약 (BE-08~10)**

- 기존 `GET /api/v1/recordings`를 확장하고 `GET /api/v1/records`를 추가한다. 공통 쿼리는 `date_from`, `date_to`(YYYY-MM-DD, 양 끝 포함), `limit`(기본 20, 1~100), `offset`(기본 0, 0 이상), `order`(desc 기본/asc)다. 일지는 추가로 `child_id`, `status`(작성중/검토중/완료)를 받는다. 잘못된 범위/값은 422다. 알려지지 않은 쿼리는 무시하며 teacher_id는 소유자를 바꾸지 않는다.
- 날짜 필터는 Asia/Seoul 달력 날짜다. 녹음은 recorded_at, 일지는 최초 created_at 기준으로 정렬/필터링한다. 동일 시각은 고정 ID로 같은 방향 정렬한다. 필터/교사 범위/정렬을 먼저 적용하고 그 다음 페이지를 자른다. 응답은 `{items, total, limit, offset}`이며 total은 필터 후 전체 수다. 빈 기록/빈 필터/범위 밖 페이지는 200과 빈 items다. 비활성 아동의 과거 일지도 고정 child_id로 조회할 수 있다.
- JournalRecord에 서버가 한 번 부여하는 시간대 포함 created_at을 추가한다. 생성 완료 저장에서 설정하고 직접 수정·확정·후보 채택 때 바꾸지 않는다. 과거 날짜 필터와 안정된 목록 순서를 위한 설계다. 실제 저장소는 아직 연결하지 않는다.
- 일지 상세 응답의 can_share와 share_text는 서버가 현재 상태에서 계산한다. 완료 상태에서만 true와 현재 확정된 edited_text를 그대로 제공하며, 나머지는 false/null이다. 수정·후보 채택으로 검토중이 되면 공유 가능 상태를 즉시 해제한다. 앱은 사용자의 복사/OS 공유 동작 직전에 상세를 새로 조회해 상태와 버전을 확인한다. 별도 공개 링크·공유/발송 API·AI 재가공은 없다.
- BE-10은 OpenAPI 전체 경로/인증/상태/오류·데이터 관계·변경 결정을 대조하는 계약 정리다. 기존 골든 케이스의 기대값은 바꾸지 않으며 현재 구현에 맞는 구조 검사와 외부 AI 의미 검증을 구분한다. 과거 로컬 전사/가명 처리·알림장 계약은 후속 범위로 명시하고 사용자가 확정한 관찰일지 MVP 규칙을 우선한다.


**6. 수용 기준 (테스트로 검증 — Definition of Done)**

아래는 기존 기준의 원문을 보존한다. 현재 MVP는 AC1/AC2/AC3/AC5/AC7을 적용한다. AC4의 special_notes는 알림장 후속 범위이며 관찰일지 부상/다툼 사실 보존은 AC1과 GC-19를 따른다. AC6의 로컬 가명 처리 조건은 사용자가 MVP에서 외부 STT와 가명 처리 생략으로 변경한 범위이므로 현재 MVP에는 적용하지 않는다. 후속 로컬 처리 전환 시 재검증한다. 기존 골든 케이스의 입력·기대값은 수정하지 않았고 실제 AI 의미 판정은 미실행이다.

각 AC는 EARS 문형 “[조건]일 때, PatPat은 [동작]한다”로 쓰고, 조건 자리의 유형을 [ ]에 표시한다.

- AC1 [상시 적용]: PatPat은 항상 입력된 관찰 사실만을 바탕으로 누락 없이 작성한다 — 근거 관찰이 없는 문장, 입력에 없는 가공된 사실, 필수 관찰의 누락이 있으면 실패하며, 관찰이 0건인 아동은 "확인 필요(missing_evidence)"로 표시한다.
- AC2 [상시 적용]: PatPat은 항상 한 아동의 기록에 다른 아동의 관찰을 넣지 않는다 — 누구 일인지 불명확한 관찰은 어느 기록에도 넣지 않는다.
- AC3 [이벤트 기반]: 여러 아동의 초안을 요청받았을 때, PatPat은 공통 문장과 아이별 문장을 분리하여 응답한다 — 관찰이 다른 두 아동의 개별 문장이 동일하면 실패.
- AC4 [예외 대응]: 부상·다툼 관찰이 있으면, PatPat은 이를 특이사항(`special_notes`)으로 분리하고 사실을 바꾸지 않는다.
- AC5 [상시 적용]: PatPat은 항상 교사가 확정하기 전에는 기록을 완료하거나 발송하지 않는다.
- AC6 [상시 적용]: PatPat은 항상 가명 처리된 텍스트만 외부 AI에 보낸다 — 외부 요청에 실명·원본 음성·매핑표가 있으면 실패.
- AC7 [이벤트 기반]: `GET /health` 요청이 오면, PatPat은 200과 `{"status":"ok"}`를 반환한다.

> AC1~AC6의 골든 케이스: `docs/golden_cases.yaml`(이 SPEC에 맞춰 다시 작성 예정).
