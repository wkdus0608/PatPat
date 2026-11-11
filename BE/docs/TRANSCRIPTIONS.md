# BE-04 외부 전사 계약

앱에서 사용하는 전사는 v2의 녹음 기반 작성 흐름에 연결한다. 아래 v1 절은 기존 BE-04의 입출력과 상태 계약이며 기본 서비스는 501이다. 모든 경로는 BE-01 Bearer 인증으로 교사를 결정한다. 문서와 테스트의 값은 가상 데이터다.

## 앱의 전사 흐름 v2

`POST /api/v2/sessions/{session_id}/recording-drafts`에 교사가 선택한 `recording_ids`를 보낸다. 서버는 교사의 녹음과 작성일을 확인하고 성공한 전사문이 있으면 재사용한다. 실패한 녹음과 오류 코드는 작업 응답의 `failed_recordings`에 표시한다. 교사는 실패한 녹음만 재시도하거나 명시적으로 제외할 수 있다.

`main` `66021b9`에서 서버는 다음 순서로 전사 클라이언트를 정한다.

1. 테스트에서 `create_app(speech_to_text=...)`로 주입한 클라이언트를 사용한다.
2. `PATPAT_STT_URL`이 있으면 외부 STT로 원음을 보낸다. 공급자에 따라 `PATPAT_STT_API_KEY`와 `PATPAT_STT_MODEL`을 서버에 설정한다. 요청은 multipart `file`과 `response_format=json`을 보내고 응답의 문자열 `text`를 읽는다.
3. 외부 STT 주소 없이 `PATPAT_AI_PROVIDER=fake`와 `PATPAT_DEMO_TRANSCRIPT`를 함께 설정하면 고정 전사문을 사용한다. 전사 클라이언트가 없고 재사용할 전사문도 없으면 해당 녹음을 `STT_NOT_CONFIGURED`로 표시한다.

원음은 전사에만 사용한다. 전사가 끝난 뒤 별도 검토 단계에서 전사문을 바탕으로 관찰을 추출한다. 자동 테스트는 주입한 STT로 재시도와 성공 결과 재사용을 검사한다. 실제 공급자의 호출 성공 여부와 전사 품질은 별도 검증이 필요하다.

## 기존 API 계약 v1

| 요청 | 정상 응답 계약 |
|---|---|
| `POST /api/v1/recordings/{recording_id}/transcriptions` | 202 `{job_id, recording_id, status}` |
| `GET /api/v1/transcription-jobs/{job_id}` | 200 작업 상태·결과 |
| `GET /api/v1/recordings/{recording_id}/transcriptions/latest` | 200 최신 시도 상태·결과 |

요청 본문은 생략하거나 `{}`를 제출한다. `teacher_id`, 전사문 등 추가 입력은 422로 거부한다. 접수 상태는 `queued` 또는 이미 실행이 시작된 `running`이다. 정상 응답에는 `Cache-Control: no-store`를 붙인다. 작업 ID와 녹음 ID는 서로 다른 식별자다.

```json
{"job_id":"job-demo-02","recording_id":"recording-demo-01","status":"queued"}
```

완료 응답 예시:

```json
{
  "job_id":"job-demo-02",
  "recording_id":"recording-demo-01",
  "status":"completed",
  "text":"가상 전사문",
  "observation_ids":[],
  "failure":null
}
```

실패 응답 예시:

```json
{
  "job_id":"job-demo-02",
  "recording_id":"recording-demo-01",
  "status":"failed",
  "text":null,
  "observation_ids":[],
  "failure":{"stage":"stt","code":"STT_UNAVAILABLE","retryable":true}
}
```

전사문은 완료 때만 제공하며 무음의 빈 전사문도 허용한다. 실패 정보는 실패 상태에만 필수다. 실패 단계는 `stt`(외부 전사), `persist`(결과 저장)다. 오류 코드는 서버가 정한 안전한 값으로 매핑하고 공급자 오류 원문·키·파일 경로를 노출하지 않는다. STT 단계는 전사문만 만들며 아동 분류·관찰 추출을 수행하지 않는다. `observation_ids`는 이후 추출된 근거와 연결할 자리이며, 그전에는 빈 목록이다.

## 녹음과 작업 상태 연결

| 시점 | 녹음 상태 | 작업 상태 |
|---|---|---|
| 업로드 후, 전사 미요청 | 대기 | 작업 없음 |
| 원자적으로 전사 예약 | 전사중 | queued |
| 작업자 실행 | 전사중 | running |
| 결과 저장 완료 | 완료 | completed |
| 외부 호출·저장 실패 | 실패 | failed |

대기 녹음의 최초 요청과 재시도 가능한 실패 녹음만 예약한다. 전사중·완료 녹음의 재요청은 409다. 실패 후에는 새 작업 ID를 만들고 이전 시도와 실패 이력을 보존한다. `retryable:false`인 실패는 서비스/저장소에서 재요청을 거부해야 한다. `ensure_transcription_allowed`는 소유권·삭제·녹음 상태의 사전 검사이며, 원자적 예약·실패 원인별 재시도 판단을 대신하지 않는다.

다른 교사·없는 자료·삭제된 녹음과 그 전사 작업의 조회는 404다. 작업이 아직 없는 최신 결과 조회도 404다. 인증 누락은 401, 잘못된 요청은 422, 미연결 서비스는 501이다. 후속 BE-05에서는 완료 녹음만 생성 근거로 선택할 수 있다.

## 연결 지점과 후속 구현의 책임

- `get_transcription_service()`에서 기본 `UnimplementedTranscriptionService`를 실제 구현으로 교체한다. `request/get/latest`는 모두 인증된 `TeacherContext`를 받는다. 라우터도 반환된 작업의 교사 소유권을 검사한다.
- `TranscriptionRepository.reserve(teacher_id, recording_id)`는 교사·삭제 상태·재시도 가능 여부를 확인하고 작업 생성과 녹음 상태 변경을 한 트랜잭션으로 처리한다. 중복·경합은 409로 거부한다. 모든 저장소 메서드는 교사 ID를 요구한다.
- `claim(teacher_id, job_id)`는 교사·삭제 상태와 현재 시도를 재검사하고 `queued → running`으로 원자적으로 전환한다. 중복 작업자가 같은 시도를 실행하지 않도록 한 작업자만 가져갈 수 있다.
- `finish`는 실행 중인 현재 시도만 반영하고 작업/녹음 상태를 함께 갱신한다. 삭제 상태와 현재 작업 ID를 다시 확인해 삭제된 자료나 오래된 시도를 되살리지 않는다.
- `SpeechToTextClient.transcribe(audio, content_type)`는 서버 비공개 원음의 비동기 스트림을 받아 전사문을 반환한다. v2는 위의 서버 설정으로 이 인터페이스의 외부 STT 구현을 사용한다.
- 작업자는 외부 호출 전과 결과 반영 전에 소유권·삭제 상태를 재확인한다. 원음 스트림은 BE-03 비공개 저장소에서 열고 작업 종료·실패·취소 시 닫는다. 파일·전사문 삭제와 기존 일지 근거 스냅샷 보존을 구분한다.

## 기존 v1 계약 검증

가짜 인증/업무 서비스로 요청·상태·결과 계약, 현재 교사 전달, 상태 충돌과 삭제·소유권, 재시도 새 ID/이력, 응답 모델의 상태 정합성, 전체 앱 OpenAPI 통합을 확인한다. 실제 DB 트랜잭션·작업 큐 경합·원음 보관/삭제·외부 STT 품질/재시도는 검증하지 않았다.
