# BE-03 녹음 파일 관리 계약

SQLite와 서버 비공개 원음 저장소를 연결했다. 파일 검증은 서버의 `ffprobe`·`ffmpeg`를 사용한다. 모든 업무 경로는 BE-01의 Bearer 인증과 `CurrentTeacher`를 사용한다.

## API

| 경로 | 정상 응답 계약 | 설명 |
|---|---|---|
| `POST /api/v1/recordings` | `201 RecordingResponse` | multipart 원음 업로드 |
| `GET /api/v1/recordings` | `200 {items: [...], total, limit, offset}` | 내 녹음 목록, 빈 경우 `items: []` |
| `GET /api/v1/recordings/{recording_id}` | `200 RecordingResponse` | 내 녹음 상세 |
| `GET /api/v1/recordings/{recording_id}/audio` | 인증된 오디오 스트림 | 공개 URL·서버 파일 경로 없음 |
| `DELETE /api/v1/recordings/{recording_id}` | `204`, 본문 없음 | 원음·재생 접근 제거, 이전 일지 보존 |

업로드 폼은 `file`, 비어 있지 않은 `title`, 시간대가 있는 `recorded_at`, 0보다 큰 유한수 `duration_seconds`를 각각 한 번 제출한다. 추가 필드와 중복 필드는 거부한다. `teacher_id`나 저장 경로를 앱이 지정할 수 없다. 업로드 파일의 원래 이름을 서버 파일 경로로 사용하지 않는다.

지원하는 선언 MIME은 `audio/mp4`, `audio/m4a`, `audio/x-m4a`, `audio/mpeg`, `audio/wav`, `audio/x-wav`, `audio/webm`, `audio/aac`다. 실제 형식·오디오 트랙·길이·해독 가능 여부를 검사하고 MIME과 대조한다. 파일 크기 기본 상한은 100MiB다. 녹음의 `duration_seconds`도 앱이 제출한 메타데이터이며 실제 길이 검증 완료를 뜻하지 않는다.

문서용 가상 정상 응답:

```json
{
  "recording_id": "recording-demo-01",
  "title": "가상 녹음",
  "recorded_at": "2026-11-02T09:00:00+09:00",
  "duration_seconds": 5.5,
  "size_bytes": 256,
  "content_type": "audio/mp4",
  "status": "대기",
  "created_at": "2026-11-02T09:01:00+09:00"
}
```

`size_bytes`와 `created_at`은 저장 서비스가 정하며 요청으로 받지 않는다. 녹음 상태는 `대기`, `전사중`, `완료`, `실패`다. 작업 상태(`queued/running/completed/failed`)와 구분한다. 상세·목록에는 원음 바이트·공개 URL·서버 경로·저장 키·교사 ID를 노출하지 않는다. 목록은 BE-08에서 date_from/date_to, limit/offset/order 쿼리와 total/limit/offset 응답을 추가했다. 날짜는 Asia/Seoul의 recorded_at 기준이다. 상세는 [API_CONTRACT.md](API_CONTRACT.md)를 따른다.

## 서비스와 저장소 연결

`get_recording_service()`는 앱의 `SQLiteRecordingService`를 사용한다. DB 버전 1은 2로 이전하며 기존 계정·세션·명단을 보존한다.

- `RecordingService.upload(teacher, upload)`: 메타데이터와 원음 스트림을 받고 저장 결과를 반환한다. `RecordingUpload.stream`은 현재 요청에서 사용할 바이너리 파일 스트림이다. 서비스는 요청 종료 전에 저장을 마쳐야 하며, 임시 업로드 스트림을 백그라운드 작업에 그대로 넘기지 않는다.
- `list/get/open_audio/delete`: 모두 인증된 `TeacherContext`를 명시적으로 받는다. 삭제·다른 소유자·존재하지 않는 원음의 조회/재생/삭제는 `404`로 처리한다.
- `RecordingRepository`: 생성·목록·상세·참조 조회·삭제 표시 모두 `teacher_id`로 범위를 제한한다.
- `PrivateAudioStorage`: 서버가 정한 녹음 ID로 비공개 저장·열기·삭제를 수행하며, 호출에 `teacher_id`가 반드시 필요하다. 스트림 완료·취소 시 파일 핸들을 정리해야 한다.
- `RecordingReference(recording_id, teacher_id, status, is_deleted)`: BE-04 전사 작업이 소유권·현재 상태·삭제 여부를 확인하는 불변 참조 계약이다.

재생 결과 `RecordingAudio`는 소유 교사 ID, MIME, 실제 바이트 크기, 비동기 바이트 반복자를 제공한다. 라우터는 소유권을 확인한 뒤 `Cache-Control: private, no-store`로 스트리밍한다. 재생은 전체 응답 계약이며 HTTP Range·부분 재생은 아직 정의하지 않았다.

## 삭제와 이후 작업

실제 삭제 구현은 원음과 재생 접근을 제거하고 목록·새 전사·새 일지 생성에서 해당 녹음을 제외해야 한다. 이미 생성된 일지와 근거 스냅샷은 유지한다. 삭제 처리와 전사 작업이 경합할 수 있으므로 BE-04 작업자는 외부 전사 요청 전과 결과 반영 전에 녹음의 소유권·삭제 상태를 재확인해야 한다. 저장소 원음 제거 실패는 삭제 성공으로 응답하지 않는다. 원음 제거 실패 시 접근을 차단한 삭제 대기 상태로 남기고 같은 삭제 요청으로 재시도한다. 이미 완료한 삭제의 재요청도 204다.

## 오류와 검증 범위

오류는 공통 `{error: {code, message, details}}` 형식이다. 인증 누락·잘못된 토큰은 `401`, 다른 교사/없는 자료는 `404`, 허용하지 않는 MIME은 `415 UNSUPPORTED_AUDIO_TYPE`, 잘못된 메타데이터·추가/중복 필드는 `422 VALIDATION_ERROR`, 기본 서비스 미연결은 `501 NOT_IMPLEMENTED`다. 전송된 파일·토큰·저장 경로를 오류 상세에 복사하지 않는다.

테스트는 가상 바이트와 대체 서비스를 사용해 인증·업로드 폼·현재 교사 전달·응답 구조·소유권·재생 스트림·삭제 응답·기본 501·OpenAPI를 확인한다. 실제 오디오 해독·파일 보관/삭제·DB 분리·전사 품질의 검증이 아니다.


## 새로고침 동기화

새 녹음은 기기에 먼저 저장하고, 저장이 끝나면 연결되어 있을 때 바로 현재 교사의 미전송 파일을 순서대로 업로드한다(2026-11-04 사용자 결정: 연결 중에는 새로고침 없이 즉시 반영). 실패하면 10초부터 최대 5분까지 간격을 늘려 자동 재시도하고, 앱이 앞으로 돌아오면 즉시 다시 시도한다. 서버가 영구적으로 거절하는 파일(401·408·429를 제외한 4xx)은 앱 실행 중 반복 전송하지 않고 기기에 보존하며 다른 파일의 전송을 막지 않는다. 녹음보관함의 **새로고침**은 같은 업로드에 더해 서버 목록을 갱신한다. 보관함 화면 진입은 업로드하지 않는다. 기존 기기 파일은 재생만 유지한다.

같은 분에 다시 녹음하면 기존 파일을 보존한 채 `날짜_시-분_2.m4a`, `_3`…으로 순번을 붙여 저장한다(분당 최대 99개). 기기 저장 경로는 서버 주소·교사 ID를 `%`·`:`·`/` 없는 폴더명으로 바꿔 사용한다.

앱은 시작 시각·길이·업로드 키·서버 ID를 교사/서버별로 보관한다. 선택 헤더 `Idempotency-Key`(1~128자)를 앱에서는 항상 보낸다. 같은 교사의 같은 키·파일·메타데이터는 기존 결과를 반환하고 다른 내용이나 삭제된 업로드의 재사용은 409다. 전송 실패·응답 유실 후에도 같은 키로 재시도한다.

서버만 있는 녹음은 인증 다운로드 후 임시 파일로 재생하고 이탈 시 정리한다. 삭제 대상은 기기·서버·모두로 구분한다. 서버에서 삭제한 기기 사본은 새로고침 때 다시 업로드하지 않는다.

설정: `PATPAT_AUDIO_PATH`(기본 DB 옆 audio), `PATPAT_AUDIO_MAX_BYTES`(104857600), `PATPAT_AUDIO_VALIDATION_SECONDS`(검증 명령당 30초). 앱 전송 제한은 120초다. STT는 아직 연결하지 않으며 업로드 결과 상태는 `대기`다.


## 검증 기록 (2026-11-04)

실제 SQLite·임시 비공개 파일 영역·합성 WAV로 업로드·재생 바이트·재시작·교사 분리·동시 재전송·삭제·크기/형식 오류·파일 저장 실패·삭제 실패 복구를 확인했다. 기존 테스트의 DB 버전 기대값은 2로, 녹음 목록의 기본 서비스 기대값은 실제 빈 목록 200으로 변경했다. STT·생성 품질·실기기 검증은 포함하지 않는다.
