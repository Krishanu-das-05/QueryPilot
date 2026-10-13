import re
from dataclasses import dataclass


class SqlLexError(ValueError):
    pass


@dataclass(frozen=True)
class Token:
    kind: str
    value: str
    start: int
    end: int


MAX_SQL_LENGTH = 20000
MAX_SQL_DEPTH = 64
_OP_CHARS = frozenset("+-*/<>=~!@#%^&|?")
_PUNCT = frozenset("(),;.[]")
_DOLLAR_TAG = re.compile(r"\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$")
_PARAMETER = re.compile(r"\$[0-9]+")
_NUMBER = re.compile(r"(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")


def _is_ident_start(char: str) -> bool:
    return char.isalpha() or char == "_"


def _is_ident_part(char: str) -> bool:
    return char.isalnum() or char in "_$"


def _skip_block_comment(sql: str, start: int) -> int:
    depth = 0
    i = start
    while i < len(sql):
        if sql.startswith("/*", i):
            depth += 1
            i += 2
        elif sql.startswith("*/", i):
            depth -= 1
            i += 2
            if depth == 0:
                return i
        else:
            i += 1
    raise SqlLexError("unclosed comment")


def _read_quoted(sql: str, start: int, quote: str, backslash_escapes: bool) -> int:
    i = start + 1
    while i < len(sql):
        char = sql[i]
        if backslash_escapes and char == "\\":
            i += 2
            continue
        if char == quote:
            if i + 1 < len(sql) and sql[i + 1] == quote:
                i += 2
                continue
            return i + 1
        i += 1
    raise SqlLexError("unclosed quote")


def _read_dollar_quoted(sql: str, start: int) -> int | None:
    match = _DOLLAR_TAG.match(sql, start)
    if match is None:
        return None
    tag = match.group(0)
    close = sql.find(tag, match.end())
    if close == -1:
        raise SqlLexError("unclosed dollar quote")
    return close + len(tag)


def tokenize(sql: str) -> list[Token]:
    tokens: list[Token] = []
    if len(sql) > MAX_SQL_LENGTH:
        raise SqlLexError("sql too long")
    depth = 0
    i = 0
    n = len(sql)
    while i < n:
        char = sql[i]
        if char.isspace():
            i += 1
            continue
        if sql.startswith("--", i):
            i += 2
            while i < n and sql[i] not in "\r\n":
                i += 1
            continue
        if sql.startswith("/*", i):
            i = _skip_block_comment(sql, i)
            continue
        if char == "'":
            prefix = tokens[-1] if tokens else None
            escapes = (
                prefix is not None
                and prefix.kind == "ident"
                and prefix.value == "e"
                and prefix.end == i
            )
            end = _read_quoted(sql, i, "'", escapes)
            start = i
            if escapes:
                start = prefix.start
                tokens.pop()
            tokens.append(Token("string", sql[start:end], start, end))
            i = end
            continue
        if char == '"':
            end = _read_quoted(sql, i, '"', False)
            raw = sql[i + 1 : end - 1]
            if raw == "":
                raise SqlLexError("empty quoted identifier")
            tokens.append(Token("qident", raw.replace('""', '"'), i, end))
            i = end
            continue
        if char == "$":
            end = _read_dollar_quoted(sql, i)
            if end is not None:
                tokens.append(Token("string", sql[i:end], i, end))
                i = end
                continue
            parameter = _PARAMETER.match(sql, i)
            if parameter is None:
                raise SqlLexError("unexpected dollar sign")
            tokens.append(Token("param", parameter.group(0), i, parameter.end()))
            i = parameter.end()
            continue
        if char.isdigit() or (char == "." and i + 1 < n and sql[i + 1].isdigit()):
            number = _NUMBER.match(sql, i)
            if number is None:
                raise SqlLexError("malformed number")
            tokens.append(Token("number", number.group(0), i, number.end()))
            i = number.end()
            continue
        if _is_ident_start(char):
            j = i + 1
            while j < n and _is_ident_part(sql[j]):
                j += 1
            word = sql[i:j]
            if word.lower() == "u" and j + 1 < n and sql[j] == "&" and sql[j + 1] in "'\"":
                raise SqlLexError("unicode escape notation is not supported")
            tokens.append(Token("ident", word.lower(), i, j))
            i = j
            continue
        if sql.startswith("::", i):
            tokens.append(Token("op", "::", i, i + 2))
            i += 2
            continue
        if char in _PUNCT:
            if char == "(":
                depth += 1
                if depth > MAX_SQL_DEPTH:
                    raise SqlLexError("nesting too deep")
            elif char == ")":
                depth -= 1
                if depth < 0:
                    raise SqlLexError("unbalanced parentheses")
            tokens.append(Token("punct", char, i, i + 1))
            i += 1
            continue
        if char in _OP_CHARS:
            j = i
            while (
                j < n
                and sql[j] in _OP_CHARS
                and not sql.startswith("--", j)
                and not sql.startswith("/*", j)
            ):
                j += 1
            tokens.append(Token("op", sql[i:j], i, j))
            i = j
            continue
        raise SqlLexError("unsupported character")
    if depth != 0:
        raise SqlLexError("unbalanced parentheses")
    return tokens
