# PatPat Backend

BE-00~10 API contracts are complete. Latest validation: **187 contract tests passed**
on 2026-11-02. Concrete business services remain unconnected (501).

FastAPI backend contracts for the PatPat MVP. This package provides the health
endpoint, shared error responses, background job status values, OpenAPI, and
the BE-01 authentication and BE-02~04 roster, recordings, and STT contracts.

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

See [the authentication contract](../docs/SPEC.md) for request/response examples,
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

## Roster, recordings, and transcription (BE-02~04)

- [Children](docs/CHILDREN.md): roster list/create/rename/deactivate with stable IDs.
- [Recordings](docs/RECORDINGS.md): multipart upload, list/detail, private audio, delete.
- [Transcriptions](docs/TRANSCRIPTIONS.md): asynchronous request/retry and job/result lookup.

All business routes require `CurrentTeacher`. Default authentication and business
services return 501 until concrete implementations are connected. Tests inject
fictional services; no external STT or production storage is exercised.
Multipart parsing uses `python-multipart` as required by the
[FastAPI file upload documentation](https://fastapi.tiangolo.com/tutorial/request-files/).

On 2026-11-02 the combined contract suite passed 100 tests. BE-00 fallback tests
now target an unknown future route because children/recordings are registered.

## Journal writing (BE-05~07)

- [Writing contracts](docs/WRITING.md): selected-recording drafts, exact teacher
  edits/confirmation, separate AI candidates and explicit adoption.
- Modules: `app/drafts`, `app/records`, `app/revisions`, shared `app/writing`.
- Immutable snapshots, evidence/child ID checks, expected-version conflicts, and
  pure edit/adoption transitions are implemented. Default business services still
  return 501. Database, job queue, and external diary AI are not connected.
- Combined contract tests: 161 passed on 2026-11-02. This does not evaluate AI
  factual quality or claim semantic golden-case success.

## Previous records, sharing, and integrated contract (BE-08~10)

Read [API_CONTRACT.md](docs/API_CONTRACT.md) for the complete endpoint index,
calendar-date filters, pagination, state/ID relationships, and unimplemented work.
List services now receive a query object and return a page with a filtered total.
Record detail exposes read-only `can_share`/`share_text`; only confirmed text can
be copied/shared by the app. No public share or delivery endpoint is added.

BE-00~10 describes completed API contracts and validation structure. A working
MVP still needs concrete authentication, persistence, private audio, queue, STT,
and diary AI implementations. See the integrated contract for validation limits.
