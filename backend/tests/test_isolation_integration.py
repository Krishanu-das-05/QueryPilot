import os
from pathlib import Path
from uuid import uuid4

import asyncpg
import pytest

from app.agent.executor import QueryExecutionError, execute_as_query_role
from app.agent.guard import guard_sql, guard_table_allowlist
from app.agent.state import ExplainResult
from app.db import _init_query_connection, create_admin_pool, qualified, statement
from tests.test_integration import (
    cleanup,
    count_rows,
    create_dataset,
    csv_ids,
    dataset_row,
    run_to_terminal,
)

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
QP_QUERY_PASSWORD = os.environ.get("QP_QUERY_PASSWORD")
MIGRATION_0004 = (
    Path(__file__).resolve().parents[2] / "db" / "migrations" / "0004_qp_role_isolation.sql"
)
BASELINE_SQL = (
    "SELECT current_user, current_setting('search_path') AS search_path, "
    "current_setting('statement_timeout') AS statement_timeout"
)
pytestmark = pytest.mark.skipif(
    not (TEST_DATABASE_URL and QP_QUERY_PASSWORD),
    reason="isolation tests need TEST_DATABASE_URL and QP_QUERY_PASSWORD (CI provides both)",
)


class Dataset:
    def __init__(self, dataset_id, schema: str, role: str) -> None:
        self.id = dataset_id
        self.schema = schema
        self.role = role


@pytest.fixture
async def pair():
    admin = await create_admin_pool(TEST_DATABASE_URL)
    query = await asyncpg.create_pool(
        dsn=TEST_DATABASE_URL,
        user="qp_query",
        password=QP_QUERY_PASSWORD,
        min_size=0,
        max_size=1,
        statement_cache_size=0,
        command_timeout=30,
        init=_init_query_connection,
    )
    ids = [uuid4(), uuid4()]
    datasets: list[Dataset] = []
    try:
        for dataset_id in ids:
            contents = await create_dataset(admin, dataset_id, [("data.csv", "data", csv_ids(3))])
            assert (await run_to_terminal(admin, dataset_id, contents))["status"] == "ready"
            async with admin.acquire() as conn:
                row = await dataset_row(conn, dataset_id)
            datasets.append(Dataset(dataset_id, row["schema_name"], row["role_name"]))
        yield datasets[0], datasets[1], admin, query
    finally:
        try:
            for dataset_id in ids:
                await cleanup(admin, dataset_id)
        finally:
            try:
                await query.close()
            finally:
                await admin.close()


async def test_restricted_login_without_role_scope_cannot_read_a_dataset(pair):
    a, _, _, query = pair
    sql = statement("SELECT count(*) FROM", qualified(a.schema, "data"))
    async with query.acquire() as conn:
        with pytest.raises(asyncpg.PostgresError) as excinfo:
            await conn.fetchval(sql)
    assert excinfo.value.sqlstate == "42501"
    result = await execute_as_query_role(query, a.schema, a.role, sql)
    assert result.rows == [[3]]


async def test_scoped_executor_cannot_read_the_other_dataset(pair):
    a, b, _, query = pair
    sql = statement("SELECT count(*) FROM", qualified(b.schema, "data"))
    with pytest.raises(QueryExecutionError) as excinfo:
        await execute_as_query_role(query, a.schema, a.role, sql)
    assert excinfo.value.sqlstate == "42501"


async def test_comma_join_across_datasets_is_stopped_before_explain(pair):
    a, b, _, query = pair
    sql = statement(
        "SELECT a.id, b.id FROM",
        qualified(a.schema, "data"),
        "a,",
        qualified(b.schema, "data"),
        "b",
    )
    assert guard_table_allowlist(sql, a.schema, ["data"]).passed is False

    calls: list[str] = []

    async def explain(text: str) -> ExplainResult:
        calls.append(text)
        return ExplainResult(ok=True, plan_rows=1)

    outcome = await guard_sql(sql, schema_name=a.schema, table_names=["data"], explain=explain)
    assert outcome.ok is False
    assert calls == []


async def test_direct_write_is_refused_and_leaves_the_dataset_untouched(pair):
    a, _, admin, query = pair
    sql = statement("INSERT INTO", qualified(a.schema, "data"), '("id") VALUES (99)')
    with pytest.raises(QueryExecutionError) as excinfo:
        await execute_as_query_role(query, a.schema, a.role, sql)
    assert excinfo.value.sqlstate in {"42501", "25006"}
    async with admin.acquire() as conn:
        assert await count_rows(conn, a.schema, "data") == 3


async def test_query_session_state_is_unchanged_after_scoped_runs(pair):
    a, b, _, query = pair
    async with query.acquire() as conn:
        before = tuple(await conn.fetchrow(BASELINE_SQL))
    await execute_as_query_role(
        query, a.schema, a.role, statement("SELECT count(*) FROM", qualified(a.schema, "data"))
    )
    with pytest.raises(QueryExecutionError):
        await execute_as_query_role(
            query, a.schema, a.role, statement("SELECT count(*) FROM", qualified(b.schema, "data"))
        )
    async with query.acquire() as conn:
        after = tuple(await conn.fetchrow(BASELINE_SQL))
    assert before == after
    assert before[0] == "qp_query"


async def test_isolation_migration_is_idempotent_and_keeps_qp_query_noninherit(pair):
    a, _, admin, _ = pair
    body = MIGRATION_0004.read_text(encoding="utf-8")
    async with admin.acquire() as conn:
        tx = conn.transaction()
        await tx.start()
        try:
            await conn.execute(body)
            await conn.execute(body)
            assert (
                await conn.fetchval("SELECT rolinherit FROM pg_roles WHERE rolname = 'qp_query'")
                is False
            )
            membership = await conn.fetchrow(
                """
                SELECT m.inherit_option, m.set_option FROM pg_auth_members m
                JOIN pg_roles r ON r.oid = m.roleid
                JOIN pg_roles q ON q.oid = m.member
                WHERE r.rolname = $1 AND q.rolname = 'qp_query'
                """,
                a.role,
            )
            assert (membership["inherit_option"], membership["set_option"]) == (False, True)
        finally:
            await tx.rollback()


async def test_zero_row_scoped_success_leaves_session_state_unchanged(pair):
    a, _, _, query = pair
    async with query.acquire() as conn:
        before = tuple(await conn.fetchrow(BASELINE_SQL))
    result = await execute_as_query_role(
        query,
        a.schema,
        a.role,
        statement("SELECT id FROM", qualified(a.schema, "data"), "WHERE id = 99"),
    )
    assert result.rows == []
    assert result.columns == ["id"]
    assert result.truncated is False
    async with query.acquire() as conn:
        after = tuple(await conn.fetchrow(BASELINE_SQL))
    assert before == after
