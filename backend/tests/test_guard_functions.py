import pytest

from app.agent.guard import guard_read_only, guard_sql, guard_table_allowlist
from app.agent.state import ExplainResult

SCHEMA = "ds_a"
TABLES = ["orders", "customers"]


async def _ok_explain(sql: str) -> ExplainResult:
    return ExplainResult(ok=True, plan_rows=1)


BENIGN_NAMES = [
    "comment",
    "set",
    "release",
    "copy",
    "execute",
    "lock",
    "do",
    "call",
    "prepare",
    "deallocate",
    "notify",
    "reset",
    "listen",
    "vacuum",
    "cluster",
    "discard",
    "savepoint",
    "refresh",
    "reindex",
    "merge",
    "grant",
    "security_barrier",
]


@pytest.mark.parametrize("name", BENIGN_NAMES)
def test_benign_unquoted_names_pass_stage_two(name):
    assert guard_read_only(" ".join(["SELECT", name, "FROM orders"])).passed


@pytest.mark.parametrize("name", BENIGN_NAMES)
def test_benign_quoted_names_pass_stage_two(name):
    assert guard_read_only(" ".join(["SELECT", f'"{name}"', "FROM orders"])).passed


@pytest.mark.parametrize("name", BENIGN_NAMES)
async def test_benign_quoted_table_and_column_names_pass_the_full_guard(name):
    sql = " ".join(["SELECT", f'"{name}"."set"', "AS", '"release"', "FROM", f'"{name}"'])
    outcome = await guard_sql(sql, schema_name=SCHEMA, table_names=[name], explain=_ok_explain)
    assert outcome.ok is True


@pytest.mark.parametrize(
    "call",
    [
        "pg_sleep(1)",
        "PG_SLEEP(1)",
        '"pg_sleep"(1)',
        '"PG_SLEEP" (1)',
        "pg_sleep /* gap */ (1)",
        "pg_sleep   (1)",
        "pg_sleep_for('1 second')",
        "pg_sleep_until(now())",
        "set_config('a', 'b', false)",
        "pg_reload_conf()",
        "pg_rotate_logfile()",
        "pg_terminate_backend(1)",
        "pg_cancel_backend(1)",
        "pg_read_file('x')",
        "pg_read_binary_file('x')",
        "pg_ls_dir('.')",
        "pg_stat_file('x')",
        "dblink('x', 'y')",
        "dblink_exec('x', 'y')",
        "lo_import('x')",
        "lo_export(1, 'x')",
        "pg_advisory_lock(1)",
        "pg_advisory_xact_lock(1)",
        '"pg_advisory_lock"(1)',
        "pg_catalog.pg_sleep(1)",
        'pg_catalog."pg_sleep"(1)',
    ],
)
def test_dangerous_function_calls_are_blocked_quoted_or_not(call):
    stage = guard_read_only(" ".join(["SELECT", call, "FROM orders"]))
    assert stage.passed is False
    assert stage.reason.startswith("not-read-only:")


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT pg_read_file FROM orders",
        'SELECT "pg_sleep" FROM orders',
        'SELECT "pg_sleep(1)" FROM orders',
        "SELECT pg_sleep AS x FROM orders",
        "SELECT 'pg_sleep(1)' FROM orders",
        "SELECT $q$pg_sleep(1)$q$ FROM orders",
        r"SELECT E'pg_sleep(1)' FROM orders",
    ],
)
def test_names_and_literals_without_a_call_are_not_function_tokens(sql):
    assert guard_read_only(sql).passed


def test_with_only_a_dangerous_name_inside_a_literal_is_harmless():
    assert guard_read_only("SELECT 'x' || 'pg_sleep(1)' FROM orders").passed


def test_stacked_statement_is_rejected_by_stage_two_on_its_own():
    stage = guard_read_only("SELECT 1 FROM orders; SELECT 2")
    assert stage.passed is False
    assert stage.reason == "stacked-statements:2"


@pytest.mark.parametrize("newline", ["\r", "\n", "\r\n"])
def test_stack_hidden_after_a_comment_is_rejected_by_stage_two(newline):
    stage = guard_read_only(f"SELECT 1 LIMIT 5 -- note{newline}; SELECT 2")
    assert stage.passed is False
    assert stage.reason == "stacked-statements:2"


def test_stack_hidden_inside_a_string_closure_is_still_a_real_stack():
    stage = guard_read_only("SELECT 'a'; DELETE FROM orders -- x")
    assert stage.passed is False
    assert stage.reason == "stacked-statements:2"


def test_semicolons_inside_a_string_literal_are_data():
    assert guard_read_only("SELECT 'x''; DELETE' FROM orders").passed


def test_unicode_escape_notation_still_fails_closed_at_the_lexer():
    assert guard_read_only('SELECT U&"pg_sl\\0065ep"(1) FROM orders').reason == "lexical-error"


TERMINAL_DML = [
    "WITH x AS (SELECT 1) DELETE FROM orders",
    "WITH x AS (SELECT 1) INSERT INTO orders VALUES (1)",
    "WITH x AS (SELECT 1) UPDATE orders SET id = 1",
]


@pytest.mark.parametrize("sql", TERMINAL_DML)
def test_terminal_dml_after_a_with_header_is_rejected_at_stage_two(sql):
    stage = guard_read_only(sql)
    assert stage.passed is False
    assert stage.reason == "not-select:with-command"


@pytest.mark.parametrize("sql", TERMINAL_DML)
async def test_terminal_dml_never_reaches_explain_even_when_explain_would_pass(sql):
    calls: list[str] = []

    async def explain(text: str) -> ExplainResult:
        calls.append(text)
        return ExplainResult(ok=True, plan_rows=1)

    outcome = await guard_sql(sql, schema_name=SCHEMA, table_names=TABLES, explain=explain)
    assert outcome.ok is False
    assert outcome.report[-1].stage == "read-only"
    assert calls == []


def test_values_as_the_main_statement_after_a_with_header_is_rejected():
    stage = guard_read_only("WITH x AS (SELECT 1) VALUES (1)")
    assert stage.passed is False
    assert stage.reason == "not-select:with-command"


def test_unsupported_with_header_is_rejected_at_stage_two():
    stage = guard_read_only("WITH x AS (DELETE FROM orders RETURNING id) SELECT id FROM x")
    assert stage.passed is False
    assert stage.reason == "not-select:unsupported-with"


@pytest.mark.parametrize(
    "sql",
    [
        "WITH x(a) AS (SELECT id FROM orders) SELECT x.a FROM x",
        "WITH x AS NOT MATERIALIZED (SELECT id FROM orders) SELECT x.id FROM x",
        "WITH RECURSIVE r AS (SELECT id FROM orders UNION ALL SELECT r.id FROM r) "
        "SELECT r.id FROM r",
        "WITH x AS (SELECT id FROM orders) SELECT (SELECT count(*) FROM x) AS n",
        "SELECT * FROM (VALUES (1)) v(a)",
        "SELECT o.id FROM orders o "
        "WHERE EXISTS (SELECT 1 FROM customers c WHERE c.id = o.customer_id)",
    ],
)
def test_legitimate_select_forms_pass_stage_two(sql):
    assert guard_read_only(sql).passed


async def test_benign_quoted_cte_names_and_columns_pass_the_full_guard():
    sql = " ".join(
        [
            "WITH",
            '"comment" AS (SELECT 1 AS "set")',
            'SELECT "comment"."set" AS "release" FROM "comment"',
        ]
    )
    outcome = await guard_sql(sql, schema_name=SCHEMA, table_names=TABLES, explain=_ok_explain)
    assert outcome.ok is True


async def test_benign_unquoted_cte_names_pass_the_full_guard():
    sql = "WITH release AS (SELECT 1 AS copy) SELECT copy FROM release"
    outcome = await guard_sql(sql, schema_name=SCHEMA, table_names=TABLES, explain=_ok_explain)
    assert outcome.ok is True


def test_data_modifying_cte_body_is_rejected_by_the_schema_walker():
    sql = "WITH d AS (DELETE FROM orders RETURNING id) SELECT id FROM d"
    assert guard_table_allowlist(sql, SCHEMA, TABLES).passed is False
