import json

import asyncpg
import pytest

from app import db as db_module
from app.agent.executor import (
    QueryExecutionError,
    execute_as_query_role,
    explain_as_query_role,
    plan_rows_from_payload,
)
from app.agent.state import ExplainResult
from tests.doubles import fake_secret


def db_error(sqlstate: str) -> asyncpg.PostgresError:
    error = asyncpg.PostgresError(fake_secret())
    error.sqlstate = sqlstate
    return error


class Attr:
    def __init__(self, name: str) -> None:
        self.name = name


class Row:
    def __init__(self, *values: object) -> None:
        self._values = list(values)

    def values(self):
        return list(self._values)


class FakeTransaction:
    def __init__(self, log: list, rollback_error: BaseException | None) -> None:
        self._log = log
        self._rollback_error = rollback_error

    async def start(self) -> None:
        self._log.append("start")

    async def rollback(self) -> None:
        self._log.append("rollback")
        if self._rollback_error is not None:
            raise self._rollback_error


class FakePrepared:
    def __init__(self, conn: "FakeConnection", names: list[str]) -> None:
        self._conn = conn
        self._names = names

    def get_attributes(self):
        return [Attr(name) for name in self._names]

    async def cursor(self, *params):
        self._conn.log.append(("cursor", params))
        if self._conn.cursor_error is not None:
            raise self._conn.cursor_error
        return FakeCursor(self._conn)


class FakeCursor:
    def __init__(self, conn: "FakeConnection") -> None:
        self._conn = conn

    async def fetch(self, count: int):
        self._conn.log.append(("fetch", count))
        return self._conn.records[:count]


class FakeConnection:
    def __init__(
        self,
        log: list,
        *,
        fetchval_result: object = None,
        fetchval_error: BaseException | None = None,
        prepare_error: BaseException | None = None,
        cursor_error: BaseException | None = None,
        rollback_error: BaseException | None = None,
        records: list | None = None,
        names: list[str] | None = None,
    ) -> None:
        self.log = log
        self.fetchval_result = fetchval_result
        self.fetchval_error = fetchval_error
        self.prepare_error = prepare_error
        self.cursor_error = cursor_error
        self.rollback_error = rollback_error
        self.records = records or []
        self.names = names or []

    def transaction(self, readonly: bool = False) -> FakeTransaction:
        self.log.append(("transaction", readonly))
        return FakeTransaction(self.log, self.rollback_error)

    async def execute(self, sql: str) -> None:
        self.log.append(("execute", sql))

    async def fetchval(self, sql: str, *args: object):
        self.log.append(("fetchval", sql, args))
        if self.fetchval_error is not None:
            raise self.fetchval_error
        return self.fetchval_result

    async def prepare(self, sql: str, *, name: str | None = None):
        self.log.append(("prepare", sql, name))
        if self.prepare_error is not None:
            raise self.prepare_error
        return FakePrepared(self, self.names)


class FakeAcquire:
    def __init__(self, conn: FakeConnection) -> None:
        self._conn = conn

    async def __aenter__(self) -> FakeConnection:
        return self._conn

    async def __aexit__(self, *_exc: object) -> bool:
        return False


class FakePool:
    def __init__(self, conn: FakeConnection) -> None:
        self.conn = conn
        self.acquired = 0

    def acquire(self) -> FakeAcquire:
        self.acquired += 1
        return FakeAcquire(self.conn)


SCOPE = [
    ("execute", 'SET LOCAL ROLE "ds_a_r"'),
    ("execute", "SET LOCAL statement_timeout = '5s'"),
    ("execute", 'SET LOCAL search_path = "ds_a"'),
]
PLAN = [{"Plan": {"Plan Rows": 3, "Plans": [{"Plan Rows": 250001}]}}]


async def explain(conn: FakeConnection, sql: str = "SELECT 1", params: tuple = ()):
    return await explain_as_query_role(FakePool(conn), "ds_a", "ds_a_r", sql, params=params)


async def execute(conn: FakeConnection, sql: str = "SELECT 1", params: tuple = (), role="ds_a_r"):
    return await execute_as_query_role(FakePool(conn), "ds_a", role, sql, params=params)


async def test_explain_runs_scoped_read_only_and_always_rolls_back():
    log: list = []
    conn = FakeConnection(log, fetchval_result=PLAN)
    result = await explain(conn)
    assert result == ExplainResult(ok=True, plan_rows=250001)
    assert log == [
        ("transaction", True),
        "start",
        *SCOPE,
        ("fetchval", "EXPLAIN (FORMAT JSON) SELECT 1", ()),
        "rollback",
    ]


async def test_explain_failure_rolls_back_and_returns_safe_category():
    log: list = []
    conn = FakeConnection(log, fetchval_error=db_error("42P01"))
    result = await explain(conn)
    assert result.ok is False
    assert result.error == "unknown identifier"
    assert result.category == "unknown-identifier"
    assert log[-1] == "rollback"
    assert "FAKE-KEY" not in repr(result)


async def test_explain_infrastructure_error_is_internal_and_safe():
    log: list = []
    conn = FakeConnection(log, fetchval_error=OSError(fake_secret()))
    result = await explain(conn)
    assert result == ExplainResult(ok=False, error="query failed", category="internal")
    assert log[-1] == "rollback"


async def test_explain_binds_parameters_in_order():
    log: list = []
    conn = FakeConnection(log, fetchval_result=PLAN)
    await explain(conn, sql="SELECT $1, $2", params=(7, "x"))
    assert ("fetchval", "EXPLAIN (FORMAT JSON) SELECT $1, $2", (7, "x")) in log


async def test_role_identifier_is_quoted_with_doubled_quotes():
    log: list = []
    conn = FakeConnection(log, fetchval_result=PLAN)
    await explain_as_query_role(FakePool(conn), 'ds_a"x', 'ds_a"b_r', "SELECT 1")
    assert ("execute", 'SET LOCAL ROLE "ds_a""b_r"') in log
    assert ("execute", 'SET LOCAL search_path = "ds_a""x"') in log


async def test_repeated_runs_reset_the_role_on_each_transaction():
    log: list = []
    conn = FakeConnection(log, fetchval_result=PLAN)
    pool = FakePool(conn)
    await explain_as_query_role(pool, "ds_a", "ds_a_r", "SELECT 1")
    await explain_as_query_role(pool, "ds_b", "ds_b_r", "SELECT 1")
    roles = [
        entry[1]
        for entry in log
        if isinstance(entry, tuple)
        and entry[0] == "execute"
        and entry[1].startswith("SET LOCAL ROLE")
    ]
    assert roles == ['SET LOCAL ROLE "ds_a_r"', 'SET LOCAL ROLE "ds_b_r"']


async def test_execute_fetches_one_past_the_limit_and_reports_truncation():
    log: list = []
    records = [Row(i) for i in range(1001)]
    conn = FakeConnection(log, records=records, names=["n"])
    result = await execute(conn)
    assert ("fetch", 1001) in log
    assert len(result.rows) == 1000
    assert result.truncated is True
    assert result.columns == ["n"]


async def test_execute_reports_columns_even_with_zero_rows():
    log: list = []
    conn = FakeConnection(log, records=[], names=["n"])
    result = await execute(conn)
    assert result.columns == ["n"]
    assert result.rows == []
    assert result.truncated is False


async def test_execute_uses_unnamed_prepared_statement():
    log: list = []
    conn = FakeConnection(log, records=[], names=["n"])
    await execute(conn, sql="SELECT 1 AS n")
    assert ("prepare", "SELECT 1 AS n", "") in log


async def test_execute_binds_parameters_and_rolls_back_after_success():
    log: list = []
    conn = FakeConnection(log, records=[Row(1)], names=["n"])
    result = await execute(conn, sql="SELECT $1 AS n", params=(7,))
    assert ("cursor", (7,)) in log
    assert result.rows == [[1]]
    assert log[-1] == "rollback"


async def test_execute_elapsed_time_is_a_non_negative_integer():
    log: list = []
    conn = FakeConnection(log, records=[], names=["n"])
    result = await execute(conn)
    assert isinstance(result.elapsed_ms, int) and result.elapsed_ms >= 0


@pytest.mark.parametrize(
    ("sqlstate", "category", "message"),
    [
        ("42P01", "unknown-identifier", "unknown identifier"),
        ("42703", "unknown-identifier", "unknown identifier"),
        ("42601", "syntax", "syntax error"),
        ("42804", "type-mismatch", "type mismatch"),
        ("42883", "type-mismatch", "type mismatch"),
        ("22P02", "type-mismatch", "type mismatch"),
        ("57014", "timeout", "query timed out"),
        ("42501", "permission", "permission denied"),
        ("25006", "permission", "permission denied"),
        ("XX000", "internal", "query failed"),
    ],
)
async def test_each_sqlstate_maps_to_a_safe_category(sqlstate, category, message):
    log: list = []
    conn = FakeConnection(log, prepare_error=db_error(sqlstate))
    with pytest.raises(QueryExecutionError) as excinfo:
        await execute(conn)
    assert excinfo.value.category == category
    assert str(excinfo.value) == message
    assert excinfo.value.sqlstate == sqlstate
    assert excinfo.value.__cause__ is None
    assert excinfo.value.__suppress_context__ is True
    assert log[-1] == "rollback"


async def test_execute_failure_never_exposes_raw_database_text():
    secret = fake_secret()
    error = asyncpg.PostgresError(secret)
    error.sqlstate = "42601"
    conn = FakeConnection([], prepare_error=error)
    with pytest.raises(QueryExecutionError) as excinfo:
        await execute(conn)
    assert secret not in str(excinfo.value)
    assert secret not in repr(excinfo.value)


async def test_cursor_failure_rolls_back_and_is_sanitized():
    log: list = []
    conn = FakeConnection(log, cursor_error=db_error("57014"))
    with pytest.raises(QueryExecutionError) as excinfo:
        await execute(conn)
    assert excinfo.value.category == "timeout"
    assert log[-1] == "rollback"


async def test_infrastructure_failure_during_execute_is_internal():
    conn = FakeConnection([], prepare_error=OSError(fake_secret()))
    with pytest.raises(QueryExecutionError) as excinfo:
        await execute(conn)
    assert excinfo.value.category == "internal"
    assert str(excinfo.value) == "query failed"


async def test_rollback_failure_is_sanitized():
    secret = fake_secret()
    conn = FakeConnection([], records=[], names=["n"], rollback_error=OSError(secret))
    with pytest.raises(QueryExecutionError) as excinfo:
        await execute(conn)
    assert excinfo.value.category == "internal"
    assert secret not in str(excinfo.value)


def test_plan_rows_takes_the_maximum_over_nested_plans():
    assert plan_rows_from_payload(PLAN) == 250001


def test_plan_rows_allows_a_child_just_under_the_cap():
    payload = [{"Plan": {"Plan Rows": 1000, "Plans": [{"Plan Rows": 200000}]}}]
    assert plan_rows_from_payload(payload) == 200000


def test_plan_rows_accepts_json_text_payloads():
    assert plan_rows_from_payload(json.dumps(PLAN)) == 250001


@pytest.mark.parametrize(
    "payload",
    [
        None,
        "not json",
        [],
        [{}],
        [{"Plan": {"Plan Rows": 5, "Plans": "oops"}}],
        [{"Plan": {"Plan Rows": 5, "Plans": [{"Plan Rows": 1}, "oops"]}}],
        [{"Plan": {"Plan Rows": "5"}}],
        [{"Plan": {"Plan Rows": -4}}],
    ],
)
def test_malformed_or_absent_estimates_return_none(payload):
    assert plan_rows_from_payload(payload) is None


def test_pool_creation_uses_the_restricted_settings(monkeypatch):
    seen: dict = {}

    async def fake_create_pool(**kwargs):
        seen.update(kwargs)
        return "POOL"

    monkeypatch.setattr(db_module.asyncpg, "create_pool", fake_create_pool)
    import asyncio

    assert asyncio.run(db_module.create_query_pool(fake_secret())) == "POOL"
    assert seen["min_size"] == 0
    assert seen["max_size"] == 3
    assert seen["statement_cache_size"] == 0
    assert seen["command_timeout"] == 30
    assert seen["init"] is db_module._init_query_connection


class ScalarConnection:
    def __init__(self, session_user: str) -> None:
        self.session_user = session_user
        self.codecs: list[str] = []

    async def fetchval(self, sql: str):
        assert sql == "SELECT session_user"
        return self.session_user

    async def set_type_codec(self, typename: str, **kwargs) -> None:
        self.codecs.append(typename)


async def test_query_init_rejects_a_non_restricted_login_without_leaking_it():
    conn = ScalarConnection("postgres")
    with pytest.raises(PermissionError) as excinfo:
        await db_module._init_query_connection(conn)
    assert "postgres" not in str(excinfo.value)
    assert conn.codecs == []


async def test_query_init_accepts_the_restricted_login_and_registers_jsonb():
    conn = ScalarConnection("qp_query")
    await db_module._init_query_connection(conn)
    assert conn.codecs == ["jsonb"]
