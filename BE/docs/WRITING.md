# BE-05~07 관찰일지 작성 계약

범위는 API·입출력 모델·서비스/저장소/AI 클라이언트 인터페이스와 순수 구조/상태 검사다. 기본 인증과 업무 서비스는 501이며 실제 계정·DB·작업 큐·외부 AI 공급자는 연결하지 않았다. 정상·실패 흐름 테스트는 가상 데이터와 대체 서비스를 사용한다. 이번 MVP는 관찰일지 유형만 다루며 사용자가 지정한 외부 STT·가명 처리 생략 결정을 따른다.

## API

모든 경로의 접두사는 `/api/v1`이다. 모든 경로가 Bearer 인증을 요구하고 교사 소유자는 `CurrentTeacher`에서만 결정한다. 정상 본문 응답은 `Cache-Control: no-store`다.

| 작업 | 경로 | 요청 | 정상 응답 계약 |
|---|---|---|---|
| BE-05 | POST `/drafts` | `{recording_ids: [...]}` | 202 `{draft_id, job_id, status}` |
| BE-05 | GET `/drafts/{draft_id}` | 없음 | 200 상태·명단/녹음 ID·완료 결과/실패 |
| BE-06 | GET `/records/{record_id}` | 없음 | 200 일지 상세 |
| BE-06 | PATCH `/records/{record_id}` | `{edited_text, expected_version}` | 200 수정된 일지 |
| BE-06 | POST `/records/{record_id}/confirm` | `{edited_text, expected_version}` | 200 확정된 일지 |
| BE-06 | GET `/records/{record_id}/history` | 없음 | 200 `{items: [...]}` 버전 순 이력 |
| BE-07 | POST `/records/{record_id}/revisions` | `{instruction, expected_version}` | 202 `{revision_id, job_id, record_id, status}` |
| BE-07 | GET `/records/{record_id}/revisions/{revision_id}` | 없음 | 200 작업/후보/실패 |
| BE-07 | POST `/records/{record_id}/revisions/{revision_id}/adopt` | `{expected_version}` | 200 채택 후 일지 |

`recording_ids`는 1개 이상이며 중복·빈 ID·잘못된 타입은 422다. 명단·관찰·교사 ID는 생성 요청으로 받지 않는다. 쓰기/재요청의 `expected_version`은 1 이상의 정수이며 숫자 문자열과 bool을 허용하지 않는다. 요청 모델은 정의하지 않은 필드를 거부한다. 본문과 수정 지시는 비어 있거나 공백뿐이면 422이며, 유효한 문자열의 공백·줄바꿈은 정규화하지 않는다.

## BE-05 선택 녹음으로 초안 생성

요청/접수 예시는 문서용 가상 값이다.

```json
{"recording_ids":["R1","R2"]}
```

```json
{"draft_id":"D1","job_id":"DJ1","status":"queued"}
```

서버는 교사의 전체 활성 명단을 서버 순서대로 읽고 선택한 전사 완료 녹음의 전사문을 고정한다. 다른 교사·없는 자료·삭제된 녹음은 404, 전사 미완료나 활성 명단이 없는 경우는 409로 처리할 서비스 계약이다. `validate_recording_selection`은 선택 ID/소유권/삭제/완료 상태를 검사한다. 이름 변경·비활성화·나중에 추가된 녹음이 기존 생성 범위에 섞이지 않게 스냅샷을 보존한다. 이후 원음이 삭제되더라도 이미 생성된 일지의 근거 스냅샷은 남긴다.

작업은 `queued → running → completed/failed`다. 작업자 흐름은 고정 전사문·명단 → 관찰 추출 → 관찰 ID/대상/선택 범위 검증 → 초안 생성 → 참조/구조 검사 → 서버 일지 ID 배정 → 결과·일지·최초 이력의 원자적 저장이다. 초기 일지는 version 1, 검토중이며 확정 시각이 없다. DB 커밋 전에는 완료 결과를 공개하지 않는다. 실패 시 `extraction/generation/validation/persist` 단계와 안전한 실패 코드·재시도 가능 여부를 제공한다. 실제 재시도 큐·공급자 오류 매핑은 미구현이다.

완료 조회 응답은 `draft_id`, `job_id`, `status`, `recording_ids`, `roster`, `result`, `failure`다. `result`는 다음 구조다.

```json
{
  "common_text":"공통 활동에 관한 가상 문장",
  "common_observation_ids":["O0"],
  "records":[
    {
      "record_id":"J1",
      "child_id":"C01",
      "individual_sentences":[
        {"text":"가상 개별 관찰","observation_ids":["O1"],"content_kind":"관찰"}
      ],
      "missing_evidence":false
    },
    {"record_id":"J2","child_id":"C02","individual_sentences":[],"missing_evidence":true}
  ],
  "unresolved_observation_ids":["U1"]
}
```

결과는 명단의 아동 순서를 유지하고 명단의 모든 아동을 정확히 한 번 포함한다. 공통 문장은 common 근거만, 개별 문장은 해당 아동의 individual/joint 근거만 사용한다. common을 개별 관찰로 바꾸거나 unresolved를 특정 아동에 배정하면 구조 검사에서 거부한다. 명단에는 있지만 개별 근거가 없는 아동은 `missing_evidence:true`와 빈 개별 문장이다. 동명이인/전사 오류의 대상 추측은 금지하며 불명확한 관찰 ID는 결과에 따로 남겨 앱에서 확인하도록 한다.

관찰·배움 읽기·놀이 지원·지원 계획은 입력 근거에서 확인한 항목만 허용한다. `content_kinds`는 스냅샷의 추출 근거 속성으로서 지원하지 않은 단계를 생성하는 것을 막는 서버 설계다. 부상·다툼은 관찰 문장에 사실을 보존한다. 이번 관찰일지 MVP에는 알림장용 special_notes와 다른 문서 유형을 추가하지 않는다.

## BE-06 직접 수정·저장·확정

상세 응답에는 `record_id`, `draft_id`, `child_id`, `version`, `status`, `edited_text`, 최초 생성의 `generated`, `created_at`, `confirmed_at`, `can_share`, `share_text`를 제공한다. created_at은 서버가 최초 생성 시 부여하고 이후 쓰기에 보존한다. 공유 필드는 완료 상태에서만 true/확정문이며 그 외에는 false/null이다. 목록/공유 확장은 [API_CONTRACT.md](API_CONTRACT.md)를 따른다. 작업 상태와 달리 일지 상태는 작성중·검토중·완료다. `generated`와 원래 근거 스냅샷은 변경하지 않고 교사 본문·과거 이력과 구분한다.

```json
{"edited_text":"  교사가 직접 쓴 글\n줄바꿈도 그대로  ","expected_version":1}
```

PATCH는 본문을 그대로 저장하고 검토중으로 전환한다. confirm도 제출 본문을 그대로 저장한 뒤 완료와 서버의 시간대 있는 확정 시각을 부여한다. 저장·확정은 AI를 호출하지 않는다. 확정 뒤 수정하면 다시 검토중이며 확정 시각을 비운다. 버전 비교·본문/상태 저장·버전 증가·수정 이력은 한 트랜잭션이어야 한다. 같은 expected_version을 사용한 두 쓰기가 함께 성공해서는 안 된다.

이력은 버전, 작업 종류(`generated/manual_edit/confirm/adopt_revision`), 그 버전의 본문·상태와 채택 시 revision_id를 보존한다. 순수 함수 `apply_manual_text`는 입력과 기존 근거를 보존한 새 객체를 만들며 저장/AI 부수효과가 없다. 실제 저장소의 동시성·이력 보존은 인터페이스 계약이며 아직 연결되지 않았다. 직접 작성 본문은 교사 검토 입력으로 취급하며 AI로 다시 교정하지 않는다.

## BE-07 AI 수정 후보·채택

```json
{"instruction":"문장을 간결하게 수정해 줘","expected_version":2}
```

재요청은 현재 버전을 검사하고 서버에서 읽은 본문·대상 아동·기존 근거를 `RevisionContext`로 고정한다. 클라이언트가 본문·아동 ID·근거 ID를 주입할 수 없다. 작업자가 실행될 때 현재 본문을 다시 읽어 요청 당시 본문을 바꿔치기하지 않는다. `build_revision_context`는 다른 아동만의 관찰과 unresolved를 외부 재요청 입력에서 제외한다. 공통/해당 아동의 individual/joint만 남기며 전체 원본 전사문을 재요청에 다시 보내지 않는다.

수정 작업은 queued/running/completed/failed다. 완료 후보에는 `candidate_text`, 근거 문장 `candidate`, 대상 child_id와 base_version이 있다. 실패에는 `revision/validation/persist` 실패 단계·코드·재시도 가능 여부만 제공하고 공급자 오류 원문을 복사하지 않는다. 새 요청은 별도 revision/job ID를 가진다. 재요청과 후보 조회만으로는 현재 일지의 본문·버전·완료 상태가 바뀌지 않는다. 실패해도 기존 일지를 보존한다.

채택은 완료 후보·대상 일지/아동/교사·현재 버전·후보 base_version을 모두 확인하고 정확한 후보 본문을 적용한다. 본문을 수정한 후 이전 후보를 채택하는 경우에는 expected_version이 최신이어도 base_version 불일치로 409다. 채택은 AI를 호출하지 않으며 상태를 검토중으로 되돌리고 확정 시각을 비운다. 이후 교사가 다시 확정해야 한다. 원래 generated/근거는 보존하고 새 후보의 근거와 채택 사실은 후보/이력으로 추적한다.

## 연결 지점

- `app/drafts/`: 생성 요청/조회 라우터, 모델, `DraftService`, `DraftRepository`.
- `app/records/`: 상세·수정·확정·이력, `RecordService`, `RecordRepository`.
- `app/revisions/`: 재요청·후보·채택, `RevisionService`, `RevisionRepository`.
- `app/writing/models.py`: 불변 명단/전사문/관찰 스냅샷, 근거 문장, 일지/작업/후보 모델.
- `app/writing/validation.py`: 선택·근거·버전·상태 검사와 부수효과 없는 수정/채택.
- `app/writing/client.py`: 관찰 추출·초안 생성·수정 후보를 위한 `DiaryAIClient` 인터페이스.

모든 저장소 메서드는 teacher_id를 요구한다. 작업 예약과 claim은 원자적으로 처리해 한 작업자만 queued 작업을 가져가며, complete/fail은 현재 running 작업에만 적용한다. 생성 완료 저장 시 원래 명단/전사문은 유지하고 선택 범위가 검증된 추출 관찰을 추가한다. AI 생성 결과에 서버 record_id를 맡기지 않는다. 기본 서비스 의존성을 실제 구현으로 교체할 때 이 계약을 지켜야 한다.

## 오류와 검증 결과

인증 오류는 401, 타 교사·없는 자료·다른 일지의 후보는 404, 미완료 녹음·버전 충돌·오래되거나 미완료인 후보는 409, 잘못된 입력은 422, 미연결 서비스는 501이다. 순수 구조 검사는 잘못된 생성 참조를 `INVALID_GENERATION_RESULT`로 거부한다. 실제 작업자는 이를 validation 실패로 기록하고 결과를 공개하지 않아야 한다. 원문·토큰·수정 지시를 공통 오류 상세에 넣지 않는다.

2026-11-02 `BE/`에서 `python -m pytest -q`로 기존 BE-00~04를 포함한 161개 테스트가 통과했다. 인증·요청·기본 501·응답·근거 참조·아동 분리 구조·버전 충돌·정확한 문구·후보 격리와 채택 후 재검토를 확인했다.

이 결과는 실제 DB·작업 큐·외부 AI 호출·생성 사실의 의미 검증·골든 케이스 품질 통과를 뜻하지 않는다. 참조가 올바르더라도 문장에 근거 없는 감정/발화가 생기거나 부상 사실의 의미가 변할 수 있으므로, 실제 AI 연결 후 기존 골든 케이스와 독립 의미 판정이 별도로 필요하다. 기존 골든 케이스와 기대값은 변경하지 않았다.
