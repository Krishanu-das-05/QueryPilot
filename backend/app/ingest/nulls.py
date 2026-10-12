"""Null tokens: '', '-', '--', 'na', 'n/a', 'null', 'none', 'nil', '#n/a'
— case-insensitive, trimmed (mirrors lib/ingest/nulls.ts)."""

NULL_TOKENS = frozenset({"", "-", "--", "na", "n/a", "null", "none", "nil", "#n/a"})


def is_null_token(value: str | None) -> bool:
    if value is None:
        return True
    return value.strip().lower() in NULL_TOKENS
