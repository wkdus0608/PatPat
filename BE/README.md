# PatPat Backend

Python/FastAPI 서버다. 테스트 계정 인증·세션·아동 명단은 SQLite에 저장한다. 녹음·전사·일지 업무는 계약 단계이며 기본 서비스는 501이다.

## 실행

`BE/`에서 Python 3.11 이상을 사용한다.

```sh
python -m venv .venv
source .venv/bin/activate
python -m pip install -e ".[test]"
python -m app.manage create-teacher --login-id teacher-demo --display-name "가상 교사"
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Windows에서는 가상 환경 활성화에 `.venv\Scripts\activate`를 사용한다. 계정 생성 시 비밀번호를 두 번 입력하며, 기본 계정·비밀번호는 자동 생성하지 않는다. 재등록은 기존 계정을 덮어쓰지 않는다.

- 기본 DB: `BE/data/patpat.sqlite3`. 서버 재시작 후에도 계정·세션·명단을 유지한다.
- `PATPAT_DATABASE_PATH`: DB 파일 위치. 상대 경로는 실행 디렉터리 기준이다.
- `PATPAT_SESSION_TTL_SECONDS`: 세션 유효기간, 기본 604800초(7일).
- `PATPAT_CORS_ORIGINS`: 웹 접근을 허용할 origin의 쉼표 목록. 기본은 `http://localhost:8081,http://127.0.0.1:8081`이다.
- 설정은 환경변수에서 읽는다. `.env` 파일은 자동으로 읽지 않는다.

앱의 `EXPO_PUBLIC_API_BASE_URL`을 이 서버 주소에 맞춘다. 휴대전화에서는 `localhost` 대신 같은 네트워크에 있는 개발 PC의 주소를 사용한다. `/health`, `/docs`, `/openapi.json`으로 상태와 계약을 확인한다.

## 인증·명단

로그인·내 계정·현재 세션 로그아웃과 아동 목록·등록·이름 수정·비활성화를 제공한다. 회원가입·아동 삭제·재활성화 API는 없다. 다른 교사의 자료는 404이며 비활성화 후에도 아동 ID를 보존한다.

비밀번호는 Argon2id 해시, 접근 토큰은 SHA-256 해시만 DB에 저장한다. 토큰은 7일 후 만료하며 자동 갱신하지 않는다. 실제 정보·DB·비밀번호·토큰은 저장소와 테스트에 넣지 않는다.

## 검사

```sh
python -m pytest -q
python -m compileall -q app
```

계약 테스트는 대체 서비스를, `tests/test_database_integration.py`는 임시 SQLite와 실제 인증·명단 서비스를 사용한다. 후자는 재시작·만료·로그아웃·교사 분리·고정 ID·동시 등록을 확인한다. 외부 AI와 실기기 검증은 포함하지 않는다.

앱과 실제 서버 사이의 통합 검사는 FE에서 `pnpm test:integration`을 실행한다. BE 가상 환경이 필요하며 `PATPAT_TEST_PYTHON`으로 실행할 Python 경로를 바꿀 수 있다. 가상 계정과 임시 DB로 검사한 뒤 서버와 파일을 정리한다.

전체 API는 [API_CONTRACT.md](docs/API_CONTRACT.md), 명단은 [CHILDREN.md](docs/CHILDREN.md)를 따른다.
