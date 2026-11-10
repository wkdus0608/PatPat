"""How much AI the account has used: calls, tokens, and how well the cached rules block is being reused."""
from datetime import date, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from app.api.common_responses import COMMON_ERROR_RESPONSES
from app.auth.dependencies import CurrentTeacher
from app.children.router import private_response
from app.services import Services, get_services

usage_router = APIRouter(
    prefix="/usage",
    tags=["usage"],
    dependencies=[Depends(private_response)],
    responses={status: COMMON_ERROR_RESPONSES[status] for status in (401, 422, 500)},
)


class UsageRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    calls: int
    errors: int
    input_tokens: int = Field(description="캐시에 쓰지 않은 입력 토큰")
    cache_creation_input_tokens: int = Field(description="규칙 묶음을 캐시에 처음 올린 토큰(한 번 비싸게 셈)")
    cache_read_input_tokens: int = Field(description="캐시에서 읽은 토큰(싸게 셈)")
    output_tokens: int
    cache_hit_ratio: float | None = Field(description="입력 토큰 중 캐시에서 읽은 비율. 입력이 없으면 null")
    avg_latency_ms: int | None


class UsageByTask(UsageRow):
    task: str


class UsageResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date_from: str | None
    date_to: str | None
    totals: UsageRow
    by_task: list[UsageByTask]
    models: list[str]
    rules_hashes: list[str] = Field(description="이 기간에 쓰인 규칙 묶음의 해시. 둘 이상이면 중간에 규칙 파일이 바뀐 것입니다.")


_COLUMNS = (
    "COUNT(*) AS calls, SUM(status='error') AS errors, SUM(input_tokens) AS input_tokens, "
    "SUM(cache_creation_input_tokens) AS cache_creation_input_tokens, SUM(cache_read_input_tokens) AS cache_read_input_tokens, "
    "SUM(output_tokens) AS output_tokens, AVG(latency_ms) AS avg_latency_ms"
)


def _row(data) -> dict:
    values = {key: int(data[key] or 0) for key in (
        "calls", "errors", "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")}
    total_in = values["input_tokens"] + values["cache_creation_input_tokens"] + values["cache_read_input_tokens"]
    values["cache_hit_ratio"] = round(values["cache_read_input_tokens"] / total_in, 3) if total_in else None
    values["avg_latency_ms"] = int(data["avg_latency_ms"]) if data["avg_latency_ms"] is not None else None
    return values


@usage_router.get(
    "/ai",
    response_model=UsageResponse,
    summary="AI 사용량",
    description="내 계정의 AI 호출 수와 토큰입니다. 비용 상한과 모델을 정할 때 보는 숫자로, 금액은 계산하지 않습니다. "
    "cache_hit_ratio가 낮으면 규칙 묶음이 캐시에서 재사용되지 않고 있다는 뜻입니다.",
)
def ai_usage(
    teacher: CurrentTeacher,
    services: Annotated[Services, Depends(get_services)],
    date_from: date | None = None,
    date_to: date | None = None,
) -> UsageResponse:
    clauses, values = ["teacher_id=?"], [teacher.teacher_id]
    if date_from:
        clauses.append("created_at>=?")
        values.append(date_from.isoformat())
    if date_to:
        clauses.append("created_at<?")
        values.append((date_to + timedelta(days=1)).isoformat())
    where = " WHERE " + " AND ".join(clauses)
    with services.database.connect() as connection:
        totals = connection.execute(f"SELECT {_COLUMNS} FROM ai_calls{where}", values).fetchone()
        per_task = connection.execute(f"SELECT task, {_COLUMNS} FROM ai_calls{where} GROUP BY task ORDER BY MIN(rowid)", values).fetchall()
        models = [r[0] for r in connection.execute(f"SELECT DISTINCT model FROM ai_calls{where} AND model IS NOT NULL ORDER BY model", values)]
        hashes = [r[0] for r in connection.execute(
            f"SELECT DISTINCT rules_hash FROM ai_calls{where} AND rules_hash IS NOT NULL ORDER BY rules_hash", values)]
    return UsageResponse(
        date_from=date_from.isoformat() if date_from else None,
        date_to=date_to.isoformat() if date_to else None,
        totals=UsageRow(**_row(totals)),
        by_task=[UsageByTask(task=row["task"], **_row(row)) for row in per_task],
        models=models,
        rules_hashes=hashes,
    )
