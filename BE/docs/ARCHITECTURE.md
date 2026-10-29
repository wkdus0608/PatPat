# BE 공통 기반과 인증 계약

## 현재 구성

BE-00은 FastAPI 실행 기반과 공통 HTTP 계약을 제공한다. BE-01은 테스트 계정 인증 계약과 교사별 접근 경계를 추가한다. 업무 API가 추가될 때 기능별 `APIRouter`와 해당 기능의 요청·응답 모델을 만들고 `app/api/v1/router.py`에 연결한다. 업무 처리, 저장소, 외부 API 연결은 기능 서비스 계층에서 분리한다.

- `app/main.py`: `create_app()` 앱 팩토리와 라우터, 공통 오류 처리 등록
- `app/api/health.py`: `GET /health`
- `app/api/common_responses.py`: reusable error response models for feature OpenAPI entries
- `app/api/v1/router.py`: v1 기능 라우터 등록 지점
- `app/api/v1/not_implemented.py`: 아직 연결되지 않은 `/api/v1/*` 경로의 501 응답
- `app/core/config.py`: 환경 변수 기반 앱 설정
- `app/core/errors.py`, `exception_handlers.py`: 공통 오류 형식과 HTTP 변환
- `app/core/jobs.py`: 비동기 작업 상태 값
- `app/schemas/`: 공통 API 입출력 모델
- `app/auth/`: 로그인·내 계정 API, 인증 서비스/저장소 인터페이스와 현재 교사 의존성. 상세는 [AUTH.md](AUTH.md)를 따른다.

## API 계약

상태 확인은 `GET /health`에서 `{"status":"ok"}`를 반환한다. OpenAPI 스키마와 Swagger UI는 FastAPI 기본 경로 `/openapi.json`, `/docs`에 제공한다.

오류는 다음 모양으로 반환한다.

```json
{
  "error": {
    "code": "NOT_IMPLEMENTED",
    "message": "이 기능은 아직 구현되지 않았습니다.",
    "details": {"path": "/api/v1/children"}
  }
}
```

검증 오류는 `422 VALIDATION_ERROR`, 미지원 업무 경로는 `501 NOT_IMPLEMENTED`로 응답한다. 상세 정보에 원 요청의 값이나 녹음 내용을 복사하지 않는다.

`POST /api/v1/auth/login`과 `GET /api/v1/auth/me`는 정상 응답 모델을 OpenAPI에 정의한다. 기본 인증 서비스는 `501`을 반환한다. 내 계정 조회에서 인증 헤더가 없거나 형식이 틀리면 `401`이며, 인증 오류의 `WWW-Authenticate: Bearer` 헤더를 공통 오류 처리에서도 유지한다. 검증된 `TeacherContext.teacher_id`로 후속 업무의 소유자를 결정하고 다른 교사의 자료는 `404`로 처리한다. 아직 구현하지 않은 업무 경로의 기존 `501` 계약은 유지한다.

## 제품 처리 결정

- MVP는 앱에서 녹음하고 서버에 원음을 업로드한 뒤 외부 STT API로 전사한다.
- MVP에서는 가명 처리하지 않는다. 외부 일지 생성 AI에는 전사문과 서버에 등록된 아동 명단을 전달한다.
- 생성 결과는 명단의 `child_id`와 선택된 관찰 ID를 참조한다. 불분명한 대상은 임의로 배정하지 않고 확인이 필요한 상태로 둔다.
- 교사가 검토·확정하기 전까지 일지는 완료 상태가 아니다.
- 후속 단계에서 기기 내 전사를 검토할 수 있도록 STT 연결은 교체 가능한 서비스 경계로 둔다.

## 상태 값

공통 비동기 작업 상태는 `queued`, `running`, `completed`, `failed`다. 녹음 처리와 일지 상태는 각 기능 작업에서 별도로 정한다.

## 현재 범위

계정 검증·토큰 발급/검증·DB·파일 저장·STT·관찰 추출·일지 생성 기능은 연결되어 있지 않다. 인증 API와 접근 경계는 서비스 주입으로 연결할 수 있는 계약까지 제공한다. 구체적인 업무 경로는 기능별 작업에서 추가한다. 설정은 `.env` 파일을 직접 읽지 않으며, 키나 실제 아동·기관 정보를 저장소에 넣지 않는다.
