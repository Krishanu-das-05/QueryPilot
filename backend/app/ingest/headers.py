"""Header sanitization: snake_case, symbols stripped, c_ prefix for digit
leading names, _col suffix on SQL reserved words, 63-char cap, _2/_3 dedupe.
Original headers are always kept alongside (mirrors lib/ingest/headers.ts)."""

import re

RESERVED_WORDS = frozenset(
    """
all analyse analyze and any array as asc asymmetric both case cast check
collate column constraint create current_catalog current_date current_role
current_time current_timestamp current_user default deferrable desc distinct
do else end except false fetch for foreign from grant group having in
initially intersect into lateral leading limit localtime localtimestamp not
null offset on only or order placing primary references returning select
session_user some symmetric table then to trailing true union unique user
using variadic when where window with
""".split()
)

MAX_LEN = 63


def _sanitize_one(raw: str) -> str:
    s = raw.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "_", s).strip("_")
    if re.match(r"^[0-9]", s):
        s = f"c_{s}"
    if s in RESERVED_WORDS:
        s = f"{s}_col"
    if s == "":
        s = "column"
    return s[:MAX_LEN]


def sanitize_headers(raw_headers: list[str]) -> list[dict[str, str]]:
    """Returns [{name, original}] with deduped, safe identifiers."""
    used: dict[str, int] = {}
    out: list[dict[str, str]] = []
    for raw in raw_headers:
        base = _sanitize_one(raw)
        seen = used.get(base, 0)
        used[base] = seen + 1
        name = base
        if seen > 0:
            suffix = seen + 1
            while True:
                tail = f"_{suffix}"
                name = f"{base[: MAX_LEN - len(tail)]}{tail}"
                if name not in used:
                    break
                suffix += 1
            used[name] = 1
        out.append({"name": name, "original": raw})
    return out
