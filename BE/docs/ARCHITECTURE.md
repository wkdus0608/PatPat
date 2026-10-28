# BE-00 공통 기반

## 현재 구성

BE-00은 FastAPI 실행 기반과 공통 HTTP 계약을 제공한다. 업무 API가 추가될 때 기능별 `APIRouter`와 해당 기능의 요청·응답 모델을 만들고 `app/api/v1/router.py`에 연결한다. 업무 처리, 저장소, 외부 API 연결은 기능 서비스 계층에서 분리한다.

- `app/main.py`: FastAPI 앱과 라우터, 공통 오류 처리 등록
- `app/api/health.py`: `GET /health`
- `app/api/common_responses.py`: reusable error response models for feature OpenAPI entries
- `app/api/v1/router.py`: v1 기능 라우터 등록 지점
- `app/api/v1/not_implemented.py`: 아직 연결되지 않은 `/api/v1/*` 경로의 501 응답
- `app/core/config.py`: 환경 변수 기반 앱 설정
- `app/core/errors.py`, `exception_handlers.py`: 공통 오류 형식과 HTTP 변환
- `app/core/jobs.py`: 비동기 작업 상태 값
- `app/schemas/`: 공통 API 입출력 모델

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

## 제품 처리 결정

- MVP는 앱에서 녹음하고 서버에 원음을 업로드한 뒤 외부 STT API로 전사한다.
- MVP에서는 가명 처리하지 않는다. 외부 일지 생성 AI에는 전사문과 서버에 등록된 아동 명단을 전달한다.
- 생성 결과는 명단의 `child_id`와 선택된 관찰 ID를 참조한다. 불분명한 대상은 임의로 배정하지 않고 확인이 필요한 상태로 둔다.
- 교사가 검토·확정하기 전까지 일지는 완료 상태가 아니다.
- 후속 단계에서 기기 내 전사를 검토할 수 있도록 STT 연결은 교체 가능한 서비스 경계로 둔다.

## 상태 값

공통 비동기 작업 상태는 `queued`, `running`, `completed`, `failed`다. 녹음 처리와 일지 상태는 각 기능 작업에서 별도로 정한다.

## 현재 범위

이 기반에는 계정, DB, 파일 저장, STT, 관찰 추출, 일지 생성 기능이 연결되어 있지 않다. 구체적인 업무 경로는 기능별 작업에서 추가한다. 설정은 `.env` 파일을 직접 읽지 않으며, 키나 실제 아동·기관 정보를 저장소에 넣지 않는다.
