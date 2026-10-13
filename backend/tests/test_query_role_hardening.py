import asyncio

import asyncpg
import pytest

from app.agent.executor import QueryExecutionError, execute_as_query_role, explain_as_query_role
from tests.doubles import fake_secret
from tests.test_query_role import FakeConnection, FakePool


class TimeoutPool:
    def acquire(self):
        raise TimeoutError(fake_secret())


async def test_acquire_timeout_is_a_safe_timeout_category():
    with pytest.raises(QueryExecutionError) as excinfo:
        await execute_as_query_role(TimeoutPool(), "ds_a", "ds_a_r", "SELECT 1")
    assert excinfo.value.category == "timeout"
    assert str(excinfo.value) == "query timed out"


async def test_client_timeout_during_execute_rolls_back_the_started_transaction():
    log: list = []
    conn = FakeConnection(log, prepare_error=TimeoutError(fake_secret()))
    with pytest.raises(QueryExecutionError) as excinfo:
        await execute_as_query_role(FakePool(conn), "ds_a", "ds_a_r", "SELECT 1")
    assert excinfo.value.category == "timeout"
    assert log[-1] == "rollback"


async def test_explain_timeout_is_reported_as_a_safe_timeout():
    log: list = []
    conn = FakeConnection(log, fetchval_error=TimeoutError(fake_secret()))
    result = await explain_as_query_role(FakePool(conn), "ds_a", "ds_a_r", "SELECT 1")
    assert result.ok is False
    assert result.category == "timeout"
    assert result.error == "query timed out"
    assert log[-1] == "rollback"


async def test_permission_error_from_the_restricted_login_is_a_safe_permission_category():
    secret = fake_secret()
    log: list = []
    conn = FakeConnection(log, prepare_error=PermissionError(secret))
    with pytest.raises(QueryExecutionError) as excinfo:
        await execute_as_query_role(FakePool(conn), "ds_a", "ds_a_r", "SELECT 1")
    assert excinfo.value.category == "permission"
    assert str(excinfo.value) == "permission denied"
    assert secret not in repr(excinfo.value)


async def test_cancellation_propagates_and_still_rolls_back():
    log: list = []
    conn = FakeConnection(log, prepare_error=asyncio.CancelledError())
    with pytest.raises(asyncio.CancelledError):
        await execute_as_query_role(FakePool(conn), "ds_a", "ds_a_r", "SELECT 1")
    assert log[-1] == "rollback"


async def test_sqlstate_remains_the_primary_mapping_over_exception_type():
    error = asyncpg.PostgresError(fake_secret())
    error.sqlstate = "42P01"
    log: list = []
    conn = FakeConnection(log, prepare_error=error)
    with pytest.raises(QueryExecutionError) as excinfo:
        await execute_as_query_role(FakePool(conn), "ds_a", "ds_a_r", "SELECT 1")
    assert excinfo.value.category == "unknown-identifier"
    assert excinfo.value.sqlstate == "42P01"
