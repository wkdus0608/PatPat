# BE-02 아동 명단 계약

## 현재 범위

설정 탭에서 전체 아동 명단을 관리하는 API·입출력 모델·서비스/저장소 인터페이스다. 기본 앱은 실제 인증 서비스와 SQLite 저장소를 사용한다. 등록·이름 수정·비활성화는 DB에 반영하고 서버 재시작 후에도 명단을 유지한다.

MVP에서는 서버에 이름과 고정 `child_id`를 연결한다. 이 ID는 가명 처리용 코드가 아니라 아동·과거 관찰·일지를 연결하는 식별자다. 이름이 같아도 별개의 아동일 수 있으므로 이름 자체로 아동을 합치거나 같은 ID를 재사용하지 않는다. 이후 일지를 작성할 때 명단의 아동을 다시 선택하는 절차를 요구하지 않는다.

## API

모든 경로는 `/api/v1` 아래에 있고 `Authorization: Bearer <access_token>` 인증이 필요하다.

| 요청 | 입력 | 향후 정상 응답 |
|---|---|---|
| `GET /children` | `include_inactive=false`(기본값) | `200 {items: [ChildResponse]}` |
| `POST /children` | JSON `{name}` | `201 ChildResponse` |
| `PATCH /children/{child_id}` | JSON `{name}` | `200 ChildResponse` |
| `POST /children/{child_id}/deactivate` | 본문 없음 | `200 ChildResponse` (`is_active: false`) |

`ChildResponse`는 `child_id`, `name`, `is_active`를 가진다. 소유 교사 ID는 공개 응답이나 쓰기 입력에 포함하지 않는다. 명단이 비어 있으면 `items: []`다. 기본 목록은 활성 아동만 포함하고 `include_inactive=true`일 때 비활성 아동도 포함한다.

등록·수정의 `name`은 비어 있지 않은 엄격한 문자열이다. 숫자나 null을 이름으로 바꾸지 않으며 공백만 있는 이름도 거부한다. 공백만 있는 값이 아니라면 원문을 그대로 전달한다. `teacher_id`, `child_id`, `is_active` 등 정의되지 않은 본문 필드는 거부한다. 이름 수정과 비활성화는 별도 작업이다.

아래는 실제 계정이나 실제 아동 정보가 아닌 문서용 가상 예시다.

```http
POST /api/v1/children
Authorization: Bearer example-access-token
Content-Type: application/json
```

```json
{"name": "가상 아동 A"}
```

후속 서비스 연결 후의 정상 응답 계약:

```json
{"child_id": "C-DEMO-01", "name": "가상 아동 A", "is_active": true}
```

아래는 서비스 상태가 없는 독립 라우터 테스트에서 사용하는 미구현 대체 서비스의 응답이다. 실제 앱의 기본 명단 서비스와 구분한다.

```json
{
  "error": {
    "code": "NOT_IMPLEMENTED",
    "message": "아동 명단 서비스가 아직 연결되지 않았습니다.",
    "details": {"feature": "BE-02", "operation": "create"}
  }
}
```

## 이름 수정·비활성화와 과거 기록

이름을 수정해도 `child_id`는 유지한다. 비활성화는 물리 삭제가 아니며 반복 요청해도 같은 ID의 비활성 상태를 반환하는 계약이다. 과거 관찰·일지의 ID 참조는 유지한다. 현재 API는 재활성화나 아동 삭제를 제공하지 않는다.

SQLite 저장소가 고정 ID·등록 순서·비활성 상태를 보존한다. 실제 일지 저장소와의 과거 기록 연결은 후속 범위다.

## 교사 소유권과 오류

라우터는 BE-01의 `CurrentTeacher`로 받은 컨텍스트를 서비스에 전달한다. 클라이언트의 `teacher_id` 쿼리는 소유자 결정에 사용하지 않으며 본문에 넣으면 422다. 저장소의 모든 메서드는 명시적인 `teacher_id` 인자를 요구한다. 후속 서비스는 이 값으로 읽기·쓰기 자체를 제한하고, 다른 교사의 ID를 지정하면 존재하지 않는 ID와 동일하게 `404 NOT_FOUND`를 반환해야 한다.

라우터는 서비스가 반환한 아동의 내부 `teacher_id`를 추가로 검사해 다른 교사의 행이 응답에 섞이지 않게 한다. 이 응답 검사는 쓰기 이전의 저장소 범위 검사를 대신하지 않는다.

| HTTP 상태 | 코드 | 조건 |
|---|---|---|
| `401` | `UNAUTHENTICATED` / `INVALID_TOKEN` | 인증 헤더 누락·형식 오류 또는 인증 서비스의 토큰 거부 |
| `404` | `NOT_FOUND` | 아동이 없거나 다른 교사의 아동 |
| `422` | `VALIDATION_ERROR` | 잘못된 이름·추가 본문 필드·잘못된 목록 필터 |
| `501` | `NOT_IMPLEMENTED` | 독립 라우터에 서비스가 주입되지 않은 경우 |

명단 기본 서비스는 `details.feature: "BE-02"`와 `operation: "list" | "create" | "rename" | "deactivate"`를 반환한다. 사용자 이름이나 요청 본문을 오류에 복사하지 않는다.

## 연결 지점과 검증

- `app/children/router.py`: 인증된 HTTP 계약과 응답 소유권 확인
- `schemas.py`, `models.py`: HTTP 모델과 내부 불변 `Child` 모델
- `service.py`: `ChildrenService` 인터페이스·SQLite 구현·미구현 대체 서비스
- `repository.py`: 교사 범위를 필수로 받는 인터페이스와 `SQLiteChildrenRepository`
- `dependencies.py`: `get_children_service()` 교체 지점

테스트는 인증·명단 서비스를 가짜 구현으로 교체해 요청 검증, 인증 누락, 교사 범위 전달, 다른 소유자 거부, 비활성 필터·빈 목록·고정 ID, OpenAPI 오류 모델을 확인한다. 별도 `test_database_integration.py`에서 실제 임시 SQLite의 저장·재연결·교사 분리를 확인한다. 실제 아동 정보와 과거 일지 FK 연결은 검증하지 않았다.

2026-11-02 `python -m pytest -q tests/test_children.py`를 실행해 30개 계약 테스트가 통과했다. 이 테스트 앱은 아동 라우터만 연결하며 전체 앱의 기능 라우터 연결은 통합 단계에서 별도로 확인한다.
