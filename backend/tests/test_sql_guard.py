import pytest

from app.agent.guard import (
    guard_read_only,
    guard_row_limit,
    guard_single_statement,
    guard_sql,
    guard_table_allowlist,
)
from app.agent.sql_text import SqlLexError, tokenize
from app.agent.state import ExplainResult

SCHEMA = "ds_a"
TABLES = ["orders", "customers"]


def allowed(sql: str) -> bool:
    return guard_table_allowlist(sql, SCHEMA, TABLES).passed


def test_lexer_treats_quoted_keywords_as_identifiers():
    tokens = tokenize('SELECT "from" FROM orders')
    assert [(t.kind, t.value) for t in tokens] == [
        ("ident", "select"),
        ("qident", "from"),
        ("ident", "from"),
        ("ident", "orders"),
    ]


def test_lexer_does_not_join_tokens_across_comments():
    tokens = tokenize("SEL/**/ECT 1")
    assert [t.value for t in tokens] == ["sel", "ect", "1"]
    assert guard_read_only("SEL/**/ECT 1").passed is False


def test_lexer_keeps_escaped_quotes_inside_quoted_identifiers():
    (token,) = tokenize('"a""b"')
    assert (token.kind, token.value) == ("qident", 'a"b')


def test_lexer_handles_nested_block_comments():
    tokens = tokenize("SELECT 1 /* a /* nested */ still comment */ FROM orders")
    assert [t.value for t in tokens] == ["select", "1", "from", "orders"]


def test_lexer_treats_dollar_quoted_bodies_as_one_string():
    tokens = tokenize("SELECT $tag$x;y$tag$ FROM orders")
    assert [t.kind for t in tokens] == ["ident", "string", "ident", "ident"]


def test_lexer_rejects_unclosed_quotes_comments_and_dollar_strings():
    for sql in (
        "SELECT 'abc FROM orders",
        "SELECT 1 /* open",
        'SELECT "open FROM orders',
        "SELECT $t$ open",
    ):
        with pytest.raises(SqlLexError):
            tokenize(sql)


def test_single_statement_allows_semicolons_inside_literals():
    for sql in (
        "SELECT 'a;b' FROM orders",
        "SELECT $$x;y$$ FROM orders",
        r"SELECT E'a\';b' FROM orders",
    ):
        assert guard_single_statement(sql).passed, sql


def test_single_statement_allows_one_trailing_semicolon_only():
    assert guard_single_statement("SELECT 1 FROM orders;").passed
    stage = guard_single_statement("SELECT 1; SELECT 2")
    assert stage.passed is False
    assert stage.reason == "stacked-statements:2"


def test_single_statement_ignores_semicolons_inside_nested_comments():
    assert guard_single_statement("SELECT 1 /* a /* ; */ ; */ FROM orders").passed


def test_unclosed_literal_fails_closed_at_stage_one():
    stage = guard_single_statement("SELECT 'abc FROM orders")
    assert stage.passed is False
    assert stage.reason == "lexical-error"


def test_read_only_requires_select_or_with_first():
    assert guard_read_only("SELECT 1 FROM orders").passed
    assert guard_read_only("WITH x AS (SELECT 1) SELECT * FROM x").passed
    assert guard_read_only("DELETE FROM orders").reason == "not-select"


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT pg_read_file('x') FROM orders",
        "SELECT pg_catalog.pg_sleep(1) FROM orders",
        "SELECT 1 FROM orders; UPDATE orders SET id = 1",
    ],
)
def test_dangerous_keywords_and_functions_are_blocked(sql):
    assert guard_read_only(sql).passed is False


async def _must_not_explain(sql: str) -> ExplainResult:
    raise AssertionError("explain must not run for an unsupported CTE source")


async def test_data_modifying_cte_is_refused_at_stage_two_before_explain():
    outcome = await guard_sql(
        "WITH d AS (DELETE FROM orders RETURNING id) SELECT id FROM d",
        schema_name="ds_a",
        table_names=["orders"],
        explain=_must_not_explain,
    )
    assert outcome.ok is False
    assert outcome.report[-1].stage == "read-only"
    assert outcome.report[-1].reason == "not-select:unsupported-with"


def test_quoted_denylist_words_are_harmless_identifiers():
    assert guard_read_only('SELECT "delete" FROM orders').passed


def test_allowlist_accepts_qualified_join_on_the_dataset_schema():
    assert allowed(
        'SELECT o.id FROM "ds_a"."orders" o JOIN "ds_a"."customers" c ON c.id = o.customer_id'
    )


def test_allowlist_accepts_comma_joins_within_the_dataset():
    assert allowed("SELECT o.id, c.id FROM ds_a.orders o, ds_a.customers c")


def test_allowlist_blocks_a_comma_join_into_another_dataset():
    stage = guard_table_allowlist("SELECT a.id FROM ds_a.orders a, ds_b.orders b", SCHEMA, TABLES)
    assert stage.passed is False
    assert stage.reason.startswith("off-limits")


def test_allowlist_blocks_an_unknown_unqualified_second_relation():
    stage = guard_table_allowlist("SELECT o.id FROM orders o, secret s", SCHEMA, TABLES)
    assert stage.passed is False
    assert stage.reason == "off-limits:secret"


def test_allowlist_accepts_subqueries_in_the_select_list():
    assert allowed("SELECT (SELECT count(*) FROM orders) AS n")


def test_allowlist_allows_a_cte_reference_but_checks_its_source():
    assert allowed("WITH x AS (SELECT id FROM orders) SELECT x.id FROM x")
    assert not allowed("WITH x AS (SELECT id FROM secret) SELECT x.id FROM x")


def test_quoted_keyword_column_and_alias_pass_the_allowlist():
    assert allowed('SELECT o."select" AS "from" FROM orders o')


def test_extract_from_inside_parentheses_is_not_a_relation():
    assert allowed("SELECT EXTRACT(MONTH FROM order_date) AS m FROM orders")


def test_function_argument_commas_are_not_relations():
    assert allowed("SELECT coalesce(id, customer_id) FROM orders")


def test_qualified_function_or_type_outside_the_dataset_is_blocked():
    assert not allowed("SELECT public.now() FROM orders")
    assert not allowed("SELECT pg_catalog.lower('a') FROM orders")
    assert not allowed("SELECT id::public.thing FROM orders")


def test_qualified_function_inside_the_dataset_schema_is_allowed():
    assert allowed("SELECT ds_a.coalesce(id) FROM orders")


def test_information_schema_and_catalog_qualifiers_are_always_blocked():
    assert not allowed("SELECT information_schema.tables.table_name FROM orders")
    assert not allowed("SELECT pg_catalog.x FROM orders AS pg_catalog")


def test_escaped_quoted_identifiers_pass():
    assert allowed('SELECT "a""b" FROM orders')


def test_unclosed_parenthesis_fails_closed():
    assert not allowed("SELECT (1 FROM orders")


def test_nested_comment_payload_does_not_hide_a_stacked_statement():
    assert guard_single_statement("SELECT 1 /* x /* y */ */; SELECT 2").passed is False


def test_row_limit_keeps_a_valid_top_level_limit():
    stage, sql = guard_row_limit("SELECT id FROM orders LIMIT 1000")
    assert stage.passed
    assert sql == "SELECT id FROM orders LIMIT 1000"


def test_row_limit_rejects_oversized_all_and_non_integer_values():
    assert guard_row_limit("SELECT id FROM orders LIMIT 1001")[0].passed is False
    assert guard_row_limit("SELECT id FROM orders LIMIT ALL")[0].passed is False
    assert guard_row_limit("SELECT id FROM orders LIMIT 'x'")[0].passed is False
    assert guard_row_limit("SELECT id FROM orders LIMIT -5")[0].passed is False
    assert guard_row_limit("SELECT id FROM orders LIMIT $1")[0].passed is False


def test_row_limit_ignores_nested_limits_when_adding_the_cap():
    stage, sql = guard_row_limit("SELECT (SELECT 1 LIMIT 5) AS x FROM orders")
    assert stage.passed
    assert sql == "SELECT (SELECT 1 LIMIT 5) AS x FROM orders LIMIT 1000"


def test_row_limit_strips_trailing_comment_before_appending_the_cap():
    stage, sql = guard_row_limit("SELECT id FROM orders -- note")
    assert stage.passed
    assert sql == "SELECT id FROM orders LIMIT 1000"


def test_row_limit_strips_trailing_semicolon_before_appending_the_cap():
    _, sql = guard_row_limit("SELECT id FROM orders;")
    assert sql == "SELECT id FROM orders LIMIT 1000"


def test_trailing_line_comment_does_not_hide_a_real_outer_limit():
    stage, sql = guard_row_limit("SELECT id FROM orders LIMIT 5 -- note")
    assert stage.passed
    assert sql == "SELECT id FROM orders LIMIT 5 -- note"


def test_fetch_first_grammar_fails_closed():
    assert guard_row_limit("SELECT id FROM orders FETCH FIRST 5 ROWS ONLY")[0].passed is False


async def test_full_guard_appends_the_cap_and_reaches_cost_check():
    async def explain(sql: str) -> ExplainResult:
        assert sql.endswith("LIMIT 1000")
        return ExplainResult(ok=True, plan_rows=10)

    outcome = await guard_sql(
        "SELECT id FROM orders", schema_name=SCHEMA, table_names=TABLES, explain=explain
    )
    assert outcome.ok is True
    assert outcome.sql == "SELECT id FROM orders LIMIT 1000"
    assert [r.stage for r in outcome.report] == [
        "single-statement",
        "read-only",
        "table-allowlist",
        "row-limit",
        "dry-run",
        "cost",
    ]


async def test_cost_rejects_a_nested_plan_estimate_above_the_cap():
    async def explain(sql: str) -> ExplainResult:
        return ExplainResult(ok=True, plan_rows=250001)

    outcome = await guard_sql(
        "SELECT id FROM orders", schema_name=SCHEMA, table_names=TABLES, explain=explain
    )
    assert outcome.ok is False
    assert outcome.report[-1].to_dict() == {
        "stage": "cost",
        "pass": False,
        "reason": "too-expensive:est-250001-rows",
    }


async def test_cost_allows_a_nested_plan_just_under_the_cap():
    async def explain(sql: str) -> ExplainResult:
        return ExplainResult(ok=True, plan_rows=200000)

    outcome = await guard_sql(
        "SELECT id FROM orders", schema_name=SCHEMA, table_names=TABLES, explain=explain
    )
    assert outcome.ok is True


async def test_missing_estimate_fails_closed_at_cost_stage():
    async def explain(sql: str) -> ExplainResult:
        return ExplainResult(ok=True, plan_rows=None)

    outcome = await guard_sql(
        "SELECT id FROM orders", schema_name=SCHEMA, table_names=TABLES, explain=explain
    )
    assert outcome.ok is False
    assert outcome.report[-1].stage == "cost"
    assert outcome.report[-1].passed is False


async def test_explain_failure_is_reported_without_raw_text():
    async def explain(sql: str) -> ExplainResult:
        return ExplainResult(ok=False, error="syntax error", category="syntax")

    outcome = await guard_sql(
        "SELECT id FROM orders", schema_name=SCHEMA, table_names=TABLES, explain=explain
    )
    assert outcome.ok is False
    assert outcome.report[-1].stage == "dry-run"
    assert outcome.report[-1].reason == "explain-failed:syntax error"


async def test_explain_is_never_called_when_the_allowlist_fails():
    calls: list[str] = []

    async def explain(sql: str) -> ExplainResult:
        calls.append(sql)
        return ExplainResult(ok=True, plan_rows=1)

    outcome = await guard_sql(
        "SELECT a.id, b.id FROM ds_a.orders a, ds_b.orders b",
        schema_name=SCHEMA,
        table_names=TABLES,
        explain=explain,
    )
    assert outcome.ok is False
    assert calls == []
