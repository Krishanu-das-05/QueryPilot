import time
from collections.abc import Sequence
from typing import Any

import asyncpg

from ..db import quote_ident
from .guard import ROW_LIMIT, plan_rows_from_payload
from .state import AgentResult, ExplainResult

SAFE_MESSAGES = {
    "unknown-identifier": "unknown identifier",
    "syntax": "syntax error",
    "type-mismatch": "type mismatch",
    "timeout": "query timed out",
    "permission": "permission denied",
    "internal": "query failed",
}
CATEGORY_BY_SQLSTATE = {
    "42P01": "unknown-identifier",
    "42703": "unknown-identifier",
    "42601": "syntax",
    "42804": "type-mismatch",
    "42883": "type-mismatch",
    "22P02": "type-mismatch",
    "57014": "timeout",
    "42501": "permission",
    "25006": "permission",
}
INFRA_ERRORS = (asyncpg.PostgresError, asyncpg.InterfaceError, OSError, TimeoutError, ValueError)


class QueryExecutionError(Exception):
    def __init__(self, category: str, sqlstate: str | None = None) -> None:
        super().__init__(SAFE_MESSAGES[category])
        self.category = category
        self.sqlstate = sqlstate


def _to_query_error(exc: BaseException) -> QueryExecutionError:
    if isinstance(exc, asyncpg.PostgresError):
        sqlstate = getattr(exc, "sqlstate", None)
        if isinstance(sqlstate, str):
            return QueryExecutionError(CATEGORY_BY_SQLSTATE.get(sqlstate, "internal"), sqlstate)
        return QueryExecutionError("internal")
    if isinstance(exc, TimeoutError):
        return QueryExecutionError("timeout")
    if isinstance(exc, PermissionError):
        return QueryExecutionError("permission")
    return QueryExecutionError("internal")


async def _scope(conn: Any, schema_name: str, role_name: str) -> None:
    await conn.execute("SET LOCAL ROLE " + quote_ident(role_name))
    await conn.execute("SET LOCAL statement_timeout = '5s'")
    await conn.execute("SET LOCAL search_path = " + quote_ident(schema_name))


async def _rollback(tx: Any) -> None:
    try:
        await tx.rollback()
    except INFRA_ERRORS as exc:
        raise _to_query_error(exc) from None


async def explain_as_query_role(
    pool: asyncpg.Pool,
    schema_name: str,
    role_name: str,
    sql_text: str,
    *,
    params: Sequence[object] = (),
) -> ExplainResult:
    try:
        async with pool.acquire() as conn:
            tx = conn.transaction(readonly=True)
            await tx.start()
            try:
                await _scope(conn, schema_name, role_name)
                payload = await conn.fetchval("EXPLAIN (FORMAT JSON) " + sql_text, *params)
            finally:
                await _rollback(tx)
    except QueryExecutionError as exc:
        return ExplainResult(ok=False, error=str(exc), category=exc.category)
    except INFRA_ERRORS as exc:
        error = _to_query_error(exc)
        return ExplainResult(ok=False, error=str(error), category=error.category)
    return ExplainResult(ok=True, plan_rows=plan_rows_from_payload(payload))


async def execute_as_query_role(
    pool: asyncpg.Pool,
    schema_name: str,
    role_name: str,
    sql_text: str,
    *,
    params: Sequence[object] = (),
) -> AgentResult:
    started = time.monotonic()
    try:
        async with pool.acquire() as conn:
            tx = conn.transaction(readonly=True)
            await tx.start()
            try:
                await _scope(conn, schema_name, role_name)
                prepared = await conn.prepare(sql_text, name="")
                columns = [attribute.name for attribute in prepared.get_attributes()]
                cursor = await prepared.cursor(*params)
                records = await cursor.fetch(ROW_LIMIT + 1)
            finally:
                await _rollback(tx)
    except INFRA_ERRORS as exc:
        raise _to_query_error(exc) from None
    rows = [list(record.values()) for record in records[:ROW_LIMIT]]
    return AgentResult(
        columns=columns,
        rows=rows,
        truncated=len(records) > ROW_LIMIT,
        elapsed_ms=int((time.monotonic() - started) * 1000),
    )
