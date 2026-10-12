"""Column profiling (mirrors lib/ingest/profile.ts): stats per column —
null_pct, distinct, min/max, top-10 (text), 5 samples, coerced_count,
is_candidate_key; canonical distinct sets (capped) for relationship matching."""

import math
from dataclasses import dataclass, field

from .nulls import is_null_token
from .types import ColumnType, coerce_value, infer_type

TOP_VALUES_LIMIT = 10
SAMPLES_LIMIT = 5
DISTINCT_CAP = 5000


def _as_text(x: float) -> str:
    return str(int(x)) if x.is_integer() else repr(x)


@dataclass
class ColumnProfile:
    ordinal: int
    column_name: str
    original_header: str
    data_type: ColumnType
    date_format: str | None
    is_percent: bool
    is_candidate_key: bool
    row_count: int
    null_count: int
    null_pct: float
    distinct_count: int
    coerced_count: int
    min_value: str | None
    max_value: str | None
    top_values: list[dict]
    sample_values: list[str]
    distinct_values: list[str] | None


@dataclass
class TableProfile:
    columns: list[ColumnProfile] = field(default_factory=list)
    row_count: int = 0


def profile_table(sanitized: list[dict[str, str]], rows: list[list[str]]) -> TableProfile:
    row_count = len(rows)
    columns: list[ColumnProfile] = []

    for ordinal, col in enumerate(sanitized):
        non_null: list[str] = []
        null_count = 0
        for r in rows:
            raw = r[ordinal] if ordinal < len(r) else ""
            if is_null_token(raw):
                null_count += 1
            else:
                non_null.append(raw.strip())

        inferred = infer_type(non_null)

        canonical: list[str] = []
        coerced_count = 0
        for trimmed in non_null:
            c = coerce_value(trimmed, inferred.type, inferred.date_format)
            if not c.ok:
                coerced_count += 1
            elif c.value is not None:
                canonical.append(c.value)

        counts: dict[str, int] = {}
        for v in canonical:
            counts[v] = counts.get(v, 0) + 1
        distinct_count = len(counts)

        min_value = max_value = None
        top_values: list[dict] = []
        if inferred.type in ("integer", "decimal"):
            nums = [float(v) for v in canonical]
            if nums:
                min_value = _as_text(min(nums))
                max_value = _as_text(max(nums))
        elif inferred.type in ("date", "timestamp"):
            if canonical:
                min_value = min(canonical)
                max_value = max(canonical)
        elif inferred.type == "text":
            top_values = [
                {"value": v, "count": c}
                for v, c in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[
                    :TOP_VALUES_LIMIT
                ]
            ]

        sample_vals: list[str] = []
        seen: set[str] = set()
        for trimmed in non_null:
            key = trimmed[:200]
            if key not in seen:
                seen.add(key)
                sample_vals.append(key)
                if len(sample_vals) >= SAMPLES_LIMIT:
                    break

        columns.append(
            ColumnProfile(
                ordinal=ordinal,
                column_name=col["name"],
                original_header=col["original"],
                data_type=inferred.type,
                date_format=inferred.date_format,
                is_percent=inferred.is_percent,
                is_candidate_key=(
                    row_count > 0 and null_count == 0 and distinct_count == row_count
                ),
                row_count=row_count,
                null_count=null_count,
                null_pct=(
                    0.0
                    if row_count == 0
                    else math.floor(null_count / row_count * 10000 + 0.5) / 100
                ),
                distinct_count=distinct_count,
                coerced_count=coerced_count,
                min_value=min_value,
                max_value=max_value,
                top_values=top_values,
                sample_values=sample_vals,
                distinct_values=(list(counts.keys()) if distinct_count <= DISTINCT_CAP else None),
            )
        )

    return TableProfile(columns=columns, row_count=row_count)
