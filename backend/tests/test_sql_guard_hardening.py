import pytest

from app.agent.guard import (
    guard_read_only,
    guard_row_limit,
    guard_single_statement,
    guard_table_allowlist,
)
from app.agent.sql_text import MAX_SQL_DEPTH, MAX_SQL_LENGTH, SqlLexError, tokenize

SCHEMA = "ds_a"
TABLES = ["orders", "customers"]


def allowed(sql: str) -> bool:
    return guard_table_allowlist(sql, SCHEMA, TABLES).passed


@pytest.mark.parametrize("newline", ["\r", "\n", "\r\n"])
def test_line_comment_ends_on_cr_or_lf_so_a_following_statement_is_stacked(newline):
    stage = guard_single_statement(f"SELECT 1 LIMIT 5 -- note{newline}; SELECT 2")
    assert stage.passed is False
    assert stage.reason == "stacked-statements:2"


def test_escaped_cr_inside_an_e_string_is_string_not_comment():
    assert guard_single_statement("SELECT E'x\\r; y' FROM orders").passed


def test_literal_cr_inside_a_plain_string_is_string_not_comment():
    assert guard_single_statement("SELECT 'a\r;b' FROM orders").passed


def test_sql_length_boundary():
    prefix = "SELECT id FROM orders "
    at_limit = prefix + " " * (MAX_SQL_LENGTH - len(prefix))
    assert len(at_limit) == MAX_SQL_LENGTH
    assert guard_single_statement(at_limit).passed
    over = at_limit + " "
    assert guard_single_statement(over).reason == "lexical-error"


def _nested_select(depth: int) -> str:
    parenthesized = "(" * depth + "1" + ")" * depth
    return " ".join(["SELECT", parenthesized, "FROM orders"])


def test_paren_depth_boundary():
    assert guard_single_statement(_nested_select(MAX_SQL_DEPTH)).passed
    assert guard_single_statement(_nested_select(MAX_SQL_DEPTH + 1)).reason == "lexical-error"


def test_unbalanced_parentheses_fail_in_the_lexer():
    assert guard_single_statement("SELECT 1) FROM orders").reason == "lexical-error"
    with pytest.raises(SqlLexError):
        tokenize("SELECT (1 FROM orders")


def test_parentheses_inside_strings_and_comments_do_not_count_toward_depth():
    literal = "SELECT '" + "(" * 200 + "' FROM orders"
    commented = "SELECT 1 /* " + "(" * 200 + " */ FROM orders"
    assert guard_single_statement(literal).passed
    assert guard_single_statement(commented).passed


@pytest.mark.parametrize(
    "sql",
    [
        'SELECT "pg_sleep"(1) FROM orders',
        'SELECT "PG_SLEEP"(1) FROM orders',
        'SELECT "pg_sleep_for"(1) FROM orders',
        'SELECT "pg_sleep_until"(1) FROM orders',
        "SELECT \"pg_read_file\"('x') FROM orders",
        "SELECT \"set_config\"('a', 'b', false) FROM orders",
        "SELECT pg_sleep_until(1) FROM orders",
        "SELECT pg_sleep_for('1 second') FROM orders",
    ],
)
def test_dangerous_functions_are_blocked_even_when_quoted(sql):
    assert guard_read_only(sql).passed is False


def test_unicode_escape_notation_is_rejected_at_the_lexer():
    for sql in ('SELECT U&"pg_sl\\0065ep"(1) FROM orders', "SELECT U&'pg_sleep' FROM orders"):
        assert guard_read_only(sql).reason == "lexical-error"


def test_plain_unicode_quoted_alias_remains_supported():
    assert guard_read_only('SELECT id AS "ñame" FROM orders').passed
    assert allowed('SELECT id AS "ñame" FROM orders')


def test_quoted_denylist_word_column_remains_allowed():
    assert guard_read_only('SELECT "delete" FROM orders').passed


def test_long_dollar_quoted_text_mentioning_a_function_is_harmless():
    assert guard_read_only("SELECT $q$pg_sleep(1)$q$ FROM orders").passed


def test_bound_alias_wildcard_is_allowed():
    assert allowed("SELECT o.* FROM orders o")


def test_dataset_qualified_table_wildcard_is_allowed_when_allowlisted():
    assert allowed("SELECT ds_a.orders.* FROM orders")


def test_catalog_and_info_schema_wildcards_are_always_blocked():
    assert not allowed("SELECT pg_catalog.* FROM orders AS pg_catalog")
    assert not allowed("SELECT information_schema.* FROM orders")
    assert not allowed("SELECT pg_toast.* FROM orders")


def test_unknown_qualifier_wildcard_is_blocked():
    assert not allowed("SELECT zz.* FROM orders")


def test_malformed_star_in_the_middle_of_a_chain_fails_closed():
    assert not allowed("SELECT o.*.id FROM orders o")


def test_alias_equal_to_dataset_schema_allows_column_and_star():
    assert allowed("SELECT ds_a.id, ds_a.* FROM orders AS ds_a")
    assert allowed("SELECT ds_a.id FROM orders AS ds_a")


def test_public_alias_star_is_allowed_but_public_functions_and_types_are_not():
    assert allowed("SELECT public.* FROM orders AS public")
    assert not allowed("SELECT public.now() FROM orders AS public")
    assert not allowed("SELECT id::public.type FROM orders AS public")


def test_alias_named_like_the_schema_cannot_smuggle_a_foreign_from_item():
    assert not allowed("SELECT ds_a.id FROM ds_b.orders AS ds_a")


def test_row_limit_ignores_one_trailing_semicolon():
    stage, sql = guard_row_limit("SELECT id FROM orders LIMIT 5;")
    assert stage.passed
    assert sql == "SELECT id FROM orders LIMIT 5;"


def test_row_limit_accepts_a_trailing_comment_after_the_semicolon():
    stage, _ = guard_row_limit("SELECT id FROM orders LIMIT 5; -- note")
    assert stage.passed


def test_row_limit_accepts_a_trailing_line_comment_with_cr_terminator():
    stage, _ = guard_row_limit("SELECT id FROM orders LIMIT 5 -- note\r")
    assert stage.passed


def test_row_limit_rejects_stacks_even_when_called_alone():
    stage, _ = guard_row_limit("SELECT id FROM orders LIMIT 5; SELECT 2")
    assert stage.passed is False
    assert stage.reason == "stacked-statements:2"


def test_row_limit_keeps_nested_limits_from_suppressing_the_cap():
    _, sql = guard_row_limit("SELECT (SELECT 1 LIMIT 5) AS x FROM orders;")
    assert sql == "SELECT (SELECT 1 LIMIT 5) AS x FROM orders LIMIT 1000"


def test_row_limit_still_rejects_all_oversized_and_non_integer_values():
    assert guard_row_limit("SELECT id FROM orders LIMIT ALL")[0].passed is False
    assert guard_row_limit("SELECT id FROM orders LIMIT 1001;")[0].passed is False
    assert guard_row_limit("SELECT id FROM orders LIMIT 'x';")[0].passed is False


def test_qualified_join_on_then_comma_foreign_relation_is_blocked():
    sql = (
        "SELECT o.id FROM ds_a.orders o JOIN ds_a.customers c "
        "ON c.id = o.customer_id, ds_b.orders b"
    )
    assert not allowed(sql)


def test_cte_column_list_is_supported():
    assert allowed("WITH x(a) AS (SELECT id FROM orders) SELECT x.a FROM x")


def test_cte_not_materialized_is_supported():
    assert allowed("WITH x AS NOT MATERIALIZED (SELECT id FROM orders) SELECT x.id FROM x")


def test_recursive_cte_is_supported_and_its_body_is_checked():
    recursive = (
        "WITH RECURSIVE r AS (SELECT id FROM {} UNION ALL SELECT r.id FROM r) SELECT r.id FROM r"
    )
    assert allowed(recursive.format("orders"))
    assert not allowed(recursive.format("secret"))


def test_correlated_subquery_may_reference_the_outer_alias():
    sql = (
        "SELECT o.id FROM orders o "
        "WHERE EXISTS (SELECT 1 FROM customers c WHERE c.id = o.customer_id)"
    )
    assert allowed(sql)
