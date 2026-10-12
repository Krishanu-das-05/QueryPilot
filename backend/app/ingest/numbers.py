"""Human-formatted number parsing (mirrors lib/ingest/numbers.ts):
₹ $ € £ "Rs." "INR" stripped, spaces/commas stripped (handles 1,00,000),
"(1,200)" -> -1200, "12%" -> 0.12 with is_percent."""

import math
import re
from dataclasses import dataclass

_PAREN = re.compile(r"^\((.*)\)$")
_CURRENCY_CODE = re.compile(r"(?:rs\.?|inr)", re.IGNORECASE)
_NUMERIC = re.compile(r"^[+-]?(?:\d+|\d*\.\d+)$")


@dataclass(frozen=True)
class ParsedNumber:
    value: float
    is_percent: bool
    is_integer: bool


def parse_number(raw: str) -> ParsedNumber | None:
    s = raw.strip()

    negative = False
    m = _PAREN.match(s)
    if m:
        negative = True
        s = m.group(1).strip()

    s = _CURRENCY_CODE.sub("", s)
    s = re.sub(r"[₹$€£,\s]", "", s).strip()

    is_percent = False
    if s.endswith("%"):
        is_percent = True
        s = s[:-1].strip()

    if not _NUMERIC.match(s):
        return None

    try:
        value = float(s)
    except ValueError:
        return None
    if not math.isfinite(value):
        return None
    if negative:
        value = -value
    if is_percent:
        value = value / 100

    return ParsedNumber(
        value=value,
        is_percent=is_percent,
        is_integer=value.is_integer(),
    )
