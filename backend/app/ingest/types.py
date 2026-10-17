"""Column type inference and value coercion (mirrors lib/ingest/types.ts).

A type wins on up to 1,000 sampled non-null values when >= 95% parse, in
order: boolean -> integer -> decimal -> date -> timestamp -> text.
boolean: true/false, yes/no, y/n; pure 1/0 columns only when nothing else.
"""

from dataclasses import dataclass
from typing import Literal

from .dates import detect_date_type, parse_date_value
from .nulls import is_null_token
from .numbers import parse_number

ColumnType = Literal["boolean", "integer", "decimal", "date", "timestamp", "text"]
COLUMN_TYPES: tuple[ColumnType, ...] = (
    "boolean",
    "integer",
    "decimal",
    "date",
    "timestamp",
    "text",
)

TYPE_THRESHOLD = 0.95
SAMPLE_SIZE = 1000

_BOOL_WORDS = {"true", "false", "yes", "no", "y", "n"}
_BOOL_TRUE = {"true", "yes", "y"}
_BOOL_FALSE = {"false", "no", "n"}


@dataclass(frozen=True)
class InferredType:
    type: ColumnType
    is_percent: bool
    date_format: str | None


def sample_values[T](values: list[T], n: int = SAMPLE_SIZE) -> list[T]:
    """Deterministic evenly-spaced sample of up to n values."""
    if len(values) <= n:
        return values
    stride = len(values) / n
    return [values[int(i * stride)] for i in range(n)]


def infer_type(non_null_values: list[str]) -> InferredType:
    values = sample_values(non_null_values)
    if not values:
        return InferredType(type="text", is_percent=False, date_format=None)
    n = len(values)

    # boolean
    all_zero_one = all(v.strip().lower() in {"0", "1"} for v in values)
    word_count = sum(1 for v in values if v.strip().lower() in _BOOL_WORDS)
    if all_zero_one or word_count / n >= TYPE_THRESHOLD:
        return InferredType(type="boolean", is_percent=False, date_format=None)

    # integer / decimal
    numbers = [parse_number(v) for v in values]
    num_count = sum(1 for p in numbers if p is not None)
    int_count = sum(1 for p in numbers if p is not None and p.is_integer)
    percent_count = sum(1 for p in numbers if p is not None and p.is_percent)
    if int_count / n >= TYPE_THRESHOLD:
        return InferredType(
            type="integer",
            is_percent=percent_count / num_count >= TYPE_THRESHOLD,
            date_format=None,
        )
    if num_count / n >= TYPE_THRESHOLD:
        return InferredType(
            type="decimal",
            is_percent=percent_count / num_count >= TYPE_THRESHOLD,
            date_format=None,
        )

    # date / timestamp
    detected = detect_date_type(values)
    if detected is not None:
        parse_count = sum(1 for v in values if parse_date_value(v, detected.prefer_mdy) is not None)
        if parse_count / n >= TYPE_THRESHOLD:
            return InferredType(
                type=detected.type,  # type: ignore[arg-type]
                is_percent=False,
                date_format=detected.format,
            )

    return InferredType(type="text", is_percent=False, date_format=None)


@dataclass(frozen=True)
class CoercedValue:
    ok: bool
    value: str | None  # canonical form for SQL insert (None = SQL NULL)


def coerce_value(raw: str, type: ColumnType, date_format: str | None) -> CoercedValue:
    if is_null_token(raw):
        return CoercedValue(ok=True, value=None)
    s = raw.strip()

    if type == "boolean":
        t = s.lower()
        if t in _BOOL_TRUE or t == "1":
            return CoercedValue(ok=True, value="true")
        if t in _BOOL_FALSE or t == "0":
            return CoercedValue(ok=True, value="false")
        return CoercedValue(ok=False, value=None)

    if type in ("integer", "decimal"):
        p = parse_number(s)
        if p is None or (type == "integer" and not p.is_integer):
            return CoercedValue(ok=False, value=None)
        text = str(int(p.value)) if p.is_integer else repr(p.value)
        return CoercedValue(ok=True, value=text)

    prefer_mdy = bool(date_format and date_format.startswith("mm"))
    if type == "date":
        p = parse_date_value(s, prefer_mdy)
        if p is None or p.has_time:
            return CoercedValue(ok=False, value=None)
        return CoercedValue(ok=True, value=p.iso)

    if type == "timestamp":
        p = parse_date_value(s, prefer_mdy)
        if p is None:
            return CoercedValue(ok=False, value=None)
        return CoercedValue(ok=True, value=p.iso if p.has_time else f"{p.iso}T00:00")

    return CoercedValue(ok=True, value=s)
