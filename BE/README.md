# PatPat Backend

FastAPI backend contracts for the PatPat MVP. This package provides the health
endpoint, shared error responses, background job status values, OpenAPI, and
the BE-01 test-account authentication contract.

## Run locally

```sh
python -m venv .venv
# macOS / Linux
source .venv/bin/activate
# Windows PowerShell: .venv\Scripts\Activate.ps1
python -m pip install -e .
uvicorn app.main:app --reload
```

OpenAPI UI is available at `/docs`; the OpenAPI JSON document is available at
`/openapi.json`. `GET /health` returns `{"status":"ok"}`. Requests to unbuilt
`/api/v1` endpoints return the common `NOT_IMPLEMENTED` error response.

## Test-account authentication (BE-01)

- `POST /api/v1/auth/login` accepts JSON `login_id` and `password`.
- `GET /api/v1/auth/me` requires `Authorization: Bearer <access_token>`.
- Future business routes use `CurrentTeacher` and the authenticated
  `teacher_id` for ownership. Other teachers' resources return `404`.

The default authentication service returns `501 NOT_IMPLEMENTED` for login and
token verification. Missing or malformed Bearer headers return `401`; invalid
login request bodies return `422`. No working account or token is bundled.
The server has no database, file storage, password verification, token issuance,
speech-to-text, or AI integration yet. Normal responses and service failure
mapping are contracts for the later implementation.

See [the authentication contract](docs/AUTH.md) for request/response examples,
service/repository interfaces, and the teacher access boundary. Examples use
fictional credentials and tokens.

## Contract tests

Install the optional test dependencies and run the focused API contract suite:

```sh
python -m pip install -e ".[test]"
python -m pytest
```

Authentication success/failure contract tests inject a stub service into a fresh
app instance. They do not verify real passwords, token expiry, or database access.
