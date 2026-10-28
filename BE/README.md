# PatPat Backend

FastAPI backend foundation for the PatPat MVP. This package currently provides
the health endpoint, shared error responses, background job status values, and
an OpenAPI document. Business endpoints are added in the feature tasks.

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

The server has no database, file storage, account, speech-to-text, or AI
integration in this foundation task.

## Contract tests

Install the optional test dependencies and run the focused API contract suite:

```sh
python -m pip install -e ".[test]"
python -m pytest
```
