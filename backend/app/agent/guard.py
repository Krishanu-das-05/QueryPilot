import json
from collections.abc import Awaitable, Callable, Sequence

from .sql_text import SqlLexError, Token, tokenize
from .state import ExplainResult, GuardOutcome, GuardStageResult

DENYLIST = frozenset(
    {
        "insert",
        "update",
        "delete",
        "merge",
        "drop",
        "alter",
        "grant",
        "revoke",
        "copy",
        "do",
        "call",
        "execute",
        "truncate",
        "create",
        "comment",
        "listen",
        "notify",
        "unlisten",
        "pg_sleep",
        "lo_export",
        "lo_import",
        "set",
        "reset",
        "lock",
        "vacuum",
        "reindex",
        "cluster",
        "refresh",
        "prepare",
        "deallocate",
        "discard",
        "savepoint",
        "release",
        "security_barrier",
        "dblink",
    }
)
DANGEROUS_FUNCTIONS = frozenset(
    {
        "set_config",
        "pg_reload_conf",
        "pg_rotate_logfile",
        "pg_terminate_backend",
        "pg_cancel_backend",
        "pg_sleep",
        "pg_sleep_for",
        "pg_sleep_until",
    }
)
DANGEROUS_PREFIXES = ("dblink", "lo_", "pg_read_", "pg_ls_", "pg_stat_file")
BLOCKED_QUALIFIERS = frozenset({"pg_catalog", "information_schema", "pg_toast"})
ROW_LIMIT = 1000
COST_ROW_CAP = 200000

_QUERY_STARTS = ("select", "with", "values")
_JOIN_WORDS = frozenset({"join", "left", "right", "full", "inner", "cross", "natural"})
_CLAUSE_WORDS = frozenset(
    {
        "where",
        "group",
        "having",
        "window",
        "order",
        "limit",
        "offset",
        "fetch",
        "union",
        "intersect",
        "except",
        "for",
        "returning",
        "on",
        "using",
    }
)
_NON_ALIAS_WORDS = _CLAUSE_WORDS | _JOIN_WORDS | {"as", "lateral", "only", "tablesample"}
_TABLE_FUNCTION_NAME = "function-relation"
Explainer = Callable[[str], Awaitable[ExplainResult]]


class _Violation(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _is_word(token: Token, *words: str) -> bool:
    return token.kind == "ident" and token.value in words


def _is_punct(token: Token, value: str) -> bool:
    return token.kind == "punct" and token.value == value


def _is_join_start(token: Token) -> bool:
    return token.kind == "ident" and token.value in _JOIN_WORDS


def _statements(tokens: Sequence[Token]) -> list[list[Token]]:
    trimmed = list(tokens)
    if trimmed and _is_punct(trimmed[-1], ";"):
        trimmed.pop()
    groups: list[list[Token]] = [[]]
    for token in trimmed:
        if _is_punct(token, ";"):
            groups.append([])
        else:
            groups[-1].append(token)
    return [] if len(groups) == 1 and not groups[0] else groups


def _fail(stage: str, reason: str) -> GuardStageResult:
    return GuardStageResult(stage=stage, passed=False, reason=reason)


def _pass(stage: str, reason: str | None = None) -> GuardStageResult:
    return GuardStageResult(stage=stage, passed=True, reason=reason)


def guard_single_statement(sql: str) -> GuardStageResult:
    try:
        tokens = tokenize(sql)
    except SqlLexError:
        return _fail("single-statement", "lexical-error")
    statements = _statements(tokens)
    if not statements:
        return _fail("single-statement", "empty-statement")
    if len(statements) > 1:
        return _fail("single-statement", f"stacked-statements:{len(statements)}")
    return _pass("single-statement")


def guard_read_only(sql: str) -> GuardStageResult:
    try:
        tokens = tokenize(sql)
    except SqlLexError:
        return _fail("read-only", "lexical-error")
    if not tokens or not _is_word(tokens[0], "select", "with"):
        return _fail("read-only", "not-select")
    for index, token in enumerate(tokens):
        if token.kind == "ident":
            if token.value in DENYLIST or _is_dangerous_name(token.value):
                return _fail("read-only", f"not-read-only:{token.value}")
        elif token.kind == "qident":
            lowered = token.value.lower()
            called = index + 1 < len(tokens) and _is_punct(tokens[index + 1], "(")
            if called and _is_dangerous_name(lowered):
                return _fail("read-only", f"not-read-only:{lowered}")
    return _pass("read-only")


def _is_dangerous_name(name: str) -> bool:
    return name in DANGEROUS_FUNCTIONS or name.startswith(DANGEROUS_PREFIXES)


def _group_end(tokens: Sequence[Token], start: int) -> int:
    depth = 0
    for index in range(start, len(tokens)):
        if _is_punct(tokens[index], "("):
            depth += 1
        elif _is_punct(tokens[index], ")"):
            depth -= 1
            if depth == 0:
                return index
    raise _Violation("unsupported-syntax")


def _split_nested(tokens: Sequence[Token]) -> tuple[list[Token], list[list[Token]]]:
    flat: list[Token] = []
    nested: list[list[Token]] = []
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if (
            _is_punct(token, "(")
            and i + 1 < len(tokens)
            and _is_word(tokens[i + 1], *_QUERY_STARTS)
        ):
            close = _group_end(tokens, i)
            nested.append(list(tokens[i + 1 : close]))
            flat.append(Token("subquery", "", token.start, tokens[close].end))
            i = close + 1
        else:
            flat.append(token)
            i += 1
    return flat, nested


def _parse_ctes(flat: Sequence[Token]) -> tuple[set[str], int]:
    names: set[str] = set()
    if not flat or not _is_word(flat[0], "with"):
        return names, 0
    i = 1
    if i < len(flat) and _is_word(flat[i], "recursive"):
        i += 1
    while True:
        if i >= len(flat) or flat[i].kind not in ("ident", "qident"):
            raise _Violation("unsupported-syntax")
        names.add(flat[i].value)
        i += 1
        if i < len(flat) and _is_punct(flat[i], "("):
            i = _group_end(flat, i) + 1
        if i >= len(flat) or not _is_word(flat[i], "as"):
            raise _Violation("unsupported-syntax")
        i += 1
        if i < len(flat) and _is_word(flat[i], "not"):
            i += 1
        if i < len(flat) and _is_word(flat[i], "materialized"):
            i += 1
        if i >= len(flat) or flat[i].kind != "subquery":
            raise _Violation("unsupported-syntax")
        i += 1
        if i < len(flat) and _is_punct(flat[i], ","):
            i += 1
            continue
        return names, i


def _read_chain(tokens: Sequence[Token], i: int) -> tuple[list[Token], int]:
    parts = [tokens[i]]
    j = i + 1
    while j < len(tokens) and _is_punct(tokens[j], "."):
        if j + 1 >= len(tokens):
            raise _Violation("unsupported-syntax")
        following = tokens[j + 1]
        if following.kind in ("ident", "qident"):
            parts.append(following)
            j += 2
            continue
        if following.kind == "op" and following.value == "*":
            after = tokens[j + 2] if j + 2 < len(tokens) else None
            if after is not None and (_is_punct(after, ".") or _is_punct(after, "(")):
                raise _Violation("unsupported-syntax")
            parts.append(Token("wildcard", "*", following.start, following.end))
            j += 2
            break
        raise _Violation("unsupported-syntax")
    return parts, j


def _parse_alias(tokens: Sequence[Token], i: int, aliases: set[str], default: str | None) -> int:
    name = default
    if i < len(tokens) and _is_word(tokens[i], "as"):
        i += 1
        if i >= len(tokens) or tokens[i].kind not in ("ident", "qident"):
            raise _Violation("unsupported-syntax")
        name = tokens[i].value
        i += 1
    elif i < len(tokens) and (
        tokens[i].kind == "qident"
        or (tokens[i].kind == "ident" and tokens[i].value not in _NON_ALIAS_WORDS)
    ):
        name = tokens[i].value
        i += 1
    if name is not None:
        aliases.add(name)
    if i < len(tokens) and _is_punct(tokens[i], "("):
        i = _group_end(tokens, i) + 1
    return i


def _parse_item(
    tokens: Sequence[Token],
    i: int,
    visible: frozenset[str],
    schema: str,
    tables: frozenset[str],
    aliases: set[str],
) -> int:
    while i < len(tokens) and _is_word(tokens[i], "lateral", "only"):
        i += 1
    if i >= len(tokens):
        raise _Violation("unsupported-syntax")
    token = tokens[i]
    if token.kind == "subquery":
        return _parse_alias(tokens, i + 1, aliases, None)
    if token.kind not in ("ident", "qident"):
        raise _Violation("unsupported-syntax")
    parts, j = _read_chain(tokens, i)
    if j < len(tokens) and _is_punct(tokens[j], "("):
        raise _Violation(_TABLE_FUNCTION_NAME)
    names = [part.value for part in parts]
    if len(names) == 1:
        if names[0] not in visible and names[0] not in tables:
            raise _Violation(f"off-limits:{names[0]}")
    elif len(names) == 2:
        if names[0] != schema or names[1] not in tables:
            raise _Violation(f"off-limits:{names[0]}.{names[1]}")
    else:
        raise _Violation(f"off-limits:{'.'.join(names)}")
    return _parse_alias(tokens, j, aliases, names[-1])


def _skip_expression(tokens: Sequence[Token], i: int) -> int:
    depth = 0
    while i < len(tokens):
        token = tokens[i]
        if _is_punct(token, "("):
            depth += 1
        elif _is_punct(token, ")"):
            if depth == 0:
                return i
            depth -= 1
        elif depth == 0 and (
            _is_punct(token, ",")
            or _is_join_start(token)
            or (token.kind == "ident" and token.value in _CLAUSE_WORDS)
        ):
            return i
        i += 1
    return i


def _parse_from_clause(
    tokens: Sequence[Token],
    i: int,
    visible: frozenset[str],
    schema: str,
    tables: frozenset[str],
    aliases: set[str],
) -> int:
    i = _parse_item(tokens, i, visible, schema, tables, aliases)
    while i < len(tokens):
        token = tokens[i]
        if _is_punct(token, ","):
            i = _parse_item(tokens, i + 1, visible, schema, tables, aliases)
            continue
        if _is_join_start(token):
            while i < len(tokens) and not _is_word(tokens[i], "join"):
                i += 1
            if i >= len(tokens):
                raise _Violation("unsupported-syntax")
            i = _parse_item(tokens, i + 1, visible, schema, tables, aliases)
            if i < len(tokens) and _is_word(tokens[i], "on"):
                i = _skip_expression(tokens, i + 1)
            elif i < len(tokens) and _is_word(tokens[i], "using"):
                if i + 1 >= len(tokens) or not _is_punct(tokens[i + 1], "("):
                    raise _Violation("unsupported-syntax")
                i = _group_end(tokens, i + 1) + 1
            continue
        break
    return i


def _scan_from(
    tokens: Sequence[Token],
    start: int,
    visible: frozenset[str],
    schema: str,
    tables: frozenset[str],
) -> set[str]:
    aliases: set[str] = set()
    depth = 0
    i = start
    while i < len(tokens):
        token = tokens[i]
        if _is_punct(token, "("):
            depth += 1
        elif _is_punct(token, ")"):
            depth -= 1
        elif (
            depth == 0
            and _is_word(token, "from")
            and not (i > 0 and _is_word(tokens[i - 1], "distinct"))
        ):
            i = _parse_from_clause(tokens, i + 1, visible, schema, tables, aliases)
            continue
        i += 1
    return aliases


def _check_chain(
    names: list[str],
    followed_by_paren: bool,
    preceded_by_cast: bool,
    schema: str,
    tables: frozenset[str],
    bound: frozenset[str],
) -> None:
    if len(names) < 2:
        return
    first = names[0]
    if first in BLOCKED_QUALIFIERS:
        raise _Violation(f"off-limits:{first}")
    if len(names) > 3 or "*" in names[:-1]:
        raise _Violation(f"off-limits:{'.'.join(names)}")
    if len(names) == 3:
        if first == schema and names[1] in tables:
            return
        raise _Violation(f"off-limits:{'.'.join(names)}")
    qualifier, name = names
    if followed_by_paren or preceded_by_cast:
        if qualifier == schema:
            return
        raise _Violation(f"off-limits:{qualifier}.{name}")
    if name == "*":
        if qualifier in bound or qualifier in tables:
            return
        raise _Violation(f"off-limits:{qualifier}.{name}")
    if qualifier in bound or qualifier in tables:
        return
    if qualifier == schema and name in tables:
        return
    raise _Violation(f"off-limits:{qualifier}.{name}")


def _check_identifier_chains(
    tokens: Sequence[Token],
    schema: str,
    tables: frozenset[str],
    bound: frozenset[str],
) -> None:
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if token.kind in ("ident", "qident") and not (i > 0 and _is_punct(tokens[i - 1], ".")):
            parts, j = _read_chain(tokens, i)
            followed_by_paren = j < len(tokens) and _is_punct(tokens[j], "(")
            preceded_by_cast = i > 0 and tokens[i - 1].kind == "op" and tokens[i - 1].value == "::"
            _check_chain(
                [part.value for part in parts],
                followed_by_paren,
                preceded_by_cast,
                schema,
                tables,
                bound,
            )
            i = j
            continue
        i += 1


def _analyze_scope(
    tokens: Sequence[Token],
    visible: frozenset[str],
    outer_bound: frozenset[str],
    schema: str,
    tables: frozenset[str],
) -> None:
    depth = 0
    for token in tokens:
        if _is_punct(token, "("):
            depth += 1
        elif _is_punct(token, ")"):
            depth -= 1
            if depth < 0:
                raise _Violation("unsupported-syntax")
    if depth != 0:
        raise _Violation("unsupported-syntax")
    flat, nested = _split_nested(tokens)
    cte_names, start = _parse_ctes(flat)
    visible_here = visible | frozenset(cte_names)
    own_aliases = _scan_from(flat, start, visible_here, schema, tables)
    bound = outer_bound | frozenset(own_aliases) | frozenset(cte_names)
    _check_identifier_chains(flat, schema, tables, bound)
    for inner in nested:
        _analyze_scope(inner, visible_here, bound, schema, tables)


def guard_table_allowlist(
    sql: str, schema_name: str, table_names: Sequence[str]
) -> GuardStageResult:
    try:
        tokens = tokenize(sql)
    except SqlLexError:
        return _fail("table-allowlist", "lexical-error")
    try:
        _analyze_scope(tokens, frozenset(), frozenset(), schema_name, frozenset(table_names))
    except _Violation as violation:
        return _fail("table-allowlist", violation.reason)
    return _pass("table-allowlist")


def _top_level(tokens: Sequence[Token]) -> list[Token]:
    result: list[Token] = []
    depth = 0
    for token in tokens:
        if _is_punct(token, "("):
            depth += 1
        elif _is_punct(token, ")"):
            depth -= 1
        elif depth == 0:
            result.append(token)
    return result


def _sql_without_trailing_noise(tokens: Sequence[Token], sql: str) -> str:
    significant = list(tokens)
    if significant and _is_punct(significant[-1], ";"):
        significant.pop()
    return sql[: significant[-1].end]


def guard_row_limit(sql: str) -> tuple[GuardStageResult, str]:
    try:
        tokens = tokenize(sql)
    except SqlLexError:
        return _fail("row-limit", "lexical-error"), sql
    statements = _statements(tokens)
    if not statements:
        return _fail("row-limit", "empty-statement"), sql
    if len(statements) > 1:
        return _fail("row-limit", f"stacked-statements:{len(statements)}"), sql
    top = _top_level(statements[0])
    if any(_is_word(token, "fetch") for token in top):
        return _fail("row-limit", "limit-unsupported:fetch"), sql
    limits = [index for index, token in enumerate(top) if _is_word(token, "limit")]
    if len(limits) > 1:
        return _fail("row-limit", "limit-unsupported:multiple"), sql
    if not limits:
        capped = f"{_sql_without_trailing_noise(tokens, sql)} LIMIT {ROW_LIMIT}"
        return _pass("row-limit", f"injected:limit-{ROW_LIMIT}"), capped
    index = limits[0]
    value = top[index + 1] if index + 1 < len(top) else None
    if value is None or value.kind != "number" or not value.value.isdigit():
        return _fail("row-limit", "limit-unsupported"), sql
    if int(value.value) > ROW_LIMIT:
        return _fail("row-limit", f"limit-exceeded:{value.value}"), sql
    after = top[index + 2] if index + 2 < len(top) else None
    if after is not None and not _is_word(after, "offset"):
        return _fail("row-limit", "limit-unsupported"), sql
    return _pass("row-limit"), sql


def plan_rows_from_payload(payload: object) -> int | None:
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except ValueError:
            return None
    if not isinstance(payload, list) or not payload or not isinstance(payload[0], dict):
        return None
    root = payload[0].get("Plan")
    if not isinstance(root, dict):
        return None
    stack: list[dict] = [root]
    estimates: list[int] = []
    while stack:
        node = stack.pop()
        value = node.get("Plan Rows")
        if type(value) is int and value >= 0:
            estimates.append(value)
        children = node.get("Plans", [])
        if not isinstance(children, list) or not all(isinstance(child, dict) for child in children):
            return None
        stack.extend(children)
    return max(estimates) if estimates else None


async def guard_sql(
    sql: str,
    *,
    schema_name: str,
    table_names: Sequence[str],
    explain: Explainer,
) -> GuardOutcome:
    report: list[GuardStageResult] = []
    single = guard_single_statement(sql)
    report.append(single)
    if not single.passed:
        return GuardOutcome(ok=False, sql=sql, report=report)
    read_only = guard_read_only(sql)
    report.append(read_only)
    if not read_only.passed:
        return GuardOutcome(ok=False, sql=sql, report=report)
    allowlist = guard_table_allowlist(sql, schema_name, table_names)
    report.append(allowlist)
    if not allowlist.passed:
        return GuardOutcome(ok=False, sql=sql, report=report)
    row_limit, capped = guard_row_limit(sql)
    report.append(row_limit)
    if not row_limit.passed:
        return GuardOutcome(ok=False, sql=sql, report=report)
    dry_run = await explain(capped)
    if not dry_run.ok:
        report.append(_fail("dry-run", f"explain-failed:{dry_run.error or 'unknown'}"))
        return GuardOutcome(ok=False, sql=capped, report=report)
    report.append(_pass("dry-run"))
    if dry_run.plan_rows is None:
        report.append(_fail("cost", "estimate-unavailable"))
        return GuardOutcome(ok=False, sql=capped, report=report)
    if dry_run.plan_rows > COST_ROW_CAP:
        report.append(_fail("cost", f"too-expensive:est-{dry_run.plan_rows}-rows"))
        return GuardOutcome(ok=False, sql=capped, report=report)
    report.append(_pass("cost"))
    return GuardOutcome(ok=True, sql=capped, report=report)
