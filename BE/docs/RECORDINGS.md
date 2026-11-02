# BE-03 녹음 파일 관리 계약

이번 작업은 앱 연결용 API·입출력 모델·서비스/저장소 경계를 제공한다. 실제 DB·비공개 파일 저장소는 연결하지 않았으며 기본 서비스는 `501 NOT_IMPLEMENTED`를 반환한다. 모든 업무 경로는 BE-01의 Bearer 인증과 `CurrentTeacher`를 사용한다.

## API

| 경로 | 정상 응답 계약 | 설명 |
|---|---|---|
| `POST /api/v1/recordings` | `201 RecordingResponse` | multipart 원음 업로드 |
| `GET /api/v1/recordings` | `200 {items: [...]}` | 내 녹음 목록, 빈 경우 `items: []` |
| `GET /api/v1/recordings/{recording_id}` | `200 RecordingResponse` | 내 녹음 상세 |
| `GET /api/v1/recordings/{recording_id}/audio` | 인증된 오디오 스트림 | 공개 URL·서버 파일 경로 없음 |
| `DELETE /api/v1/recordings/{recording_id}` | `204`, 본문 없음 | 원음·재생 접근 제거, 이전 일지 보존 |

업로드 폼은 `file`, 비어 있지 않은 `title`, 시간대가 있는 `recorded_at`, 0보다 큰 유한수 `duration_seconds`를 각각 한 번 제출한다. 추가 필드와 중복 필드는 거부한다. `teacher_id`나 저장 경로를 앱이 지정할 수 없다. 업로드 파일의 원래 이름을 서버 파일 경로로 사용하지 않는다.

지원하는 선언 MIME은 `audio/mp4`, `audio/m4a`, `audio/x-m4a`, `audio/mpeg`, `audio/wav`, `audio/x-wav`, `audio/webm`, `audio/aac`다. 현재 검사는 선언된 MIME만 확인한다. 실제 바이트의 형식·용량 검증, 업로드 한도와 안전한 파일 저장은 후속 저장 구현의 책임이다. 녹음의 `duration_seconds`도 앱이 제출한 메타데이터이며 실제 길이 검증 완료를 뜻하지 않는다.

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

`size_bytes`와 `created_at`은 저장 서비스가 정하며 요청으로 받지 않는다. 녹음 상태는 `대기`, `전사중`, `완료`, `실패`다. 작업 상태(`queued/running/completed/failed`)와 구분한다. 상세·목록에는 원음 바이트·공개 URL·서버 경로·저장 키·교사 ID를 노출하지 않는다. 목록의 날짜 필터·정렬·페이지 조회는 BE-08에서 확장한다.

## 서비스와 저장소 연결

`get_recording_service()`의 기본 구현은 `UnimplementedRecordingService`다. 실제 구현이 준비되면 이 연결 지점에서 교체한다.

- `RecordingService.upload(teacher, upload)`: 메타데이터와 원음 스트림을 받고 저장 결과를 반환한다. `RecordingUpload.stream`은 현재 요청에서 사용할 바이너리 파일 스트림이다. 서비스는 요청 종료 전에 저장을 마쳐야 하며, 임시 업로드 스트림을 백그라운드 작업에 그대로 넘기지 않는다.
- `list/get/open_audio/delete`: 모두 인증된 `TeacherContext`를 명시적으로 받는다. 삭제·다른 소유자·존재하지 않는 원음의 조회/재생/삭제는 `404`로 처리한다.
- `RecordingRepository`: 생성·목록·상세·참조 조회·삭제 표시 모두 `teacher_id`로 범위를 제한한다.
- `PrivateAudioStorage`: 서버가 정한 녹음 ID로 비공개 저장·열기·삭제를 수행하며, 호출에 `teacher_id`가 반드시 필요하다. 스트림 완료·취소 시 파일 핸들을 정리해야 한다.
- `RecordingReference(recording_id, teacher_id, status, is_deleted)`: BE-04 전사 작업이 소유권·현재 상태·삭제 여부를 확인하는 불변 참조 계약이다.

재생 결과 `RecordingAudio`는 소유 교사 ID, MIME, 실제 바이트 크기, 비동기 바이트 반복자를 제공한다. 라우터는 소유권을 확인한 뒤 `Cache-Control: private, no-store`로 스트리밍한다. 재생은 전체 응답 계약이며 HTTP Range·부분 재생은 아직 정의하지 않았다.

## 삭제와 이후 작업

실제 삭제 구현은 원음과 재생 접근을 제거하고 목록·새 전사·새 일지 생성에서 해당 녹음을 제외해야 한다. 이미 생성된 일지와 근거 스냅샷은 유지한다. 삭제 처리와 전사 작업이 경합할 수 있으므로 BE-04 작업자는 외부 전사 요청 전과 결과 반영 전에 녹음의 소유권·삭제 상태를 재확인해야 한다. 저장소 원음 제거 실패는 삭제 성공으로 응답하지 않는다. 이 문서는 보존·삭제 계약이며 실제 파일 삭제나 기존 일지 보존을 검증한 결과가 아니다.

## 오류와 검증 범위

오류는 공통 `{error: {code, message, details}}` 형식이다. 인증 누락·잘못된 토큰은 `401`, 다른 교사/없는 자료는 `404`, 허용하지 않는 MIME은 `415 UNSUPPORTED_AUDIO_TYPE`, 잘못된 메타데이터·추가/중복 필드는 `422 VALIDATION_ERROR`, 기본 서비스 미연결은 `501 NOT_IMPLEMENTED`다. 전송된 파일·토큰·저장 경로를 오류 상세에 복사하지 않는다.

테스트는 가상 바이트와 대체 서비스를 사용해 인증·업로드 폼·현재 교사 전달·응답 구조·소유권·재생 스트림·삭제 응답·기본 501·OpenAPI를 확인한다. 실제 오디오 해독·파일 보관/삭제·DB 분리·전사 품질의 검증이 아니다.
