"""FK detection by name convention + >=90% value overlap
(mirrors lib/ingest/relationships.ts)."""

from __future__ import annotations

import math
from dataclasses import dataclass

from .profile import TableProfile

OVERLAP_THRESHOLD = 0.90


@dataclass(frozen=True)
class DetectedRelationship:
    from_table: str
    from_column: str
    to_table: str
    to_column: str
    overlap: float
    method: str = "name+overlap"


def _singular(table: str) -> str:
    return table[:-1] if table.endswith("s") and len(table) > 1 else table


def _compatible(a: ColumnTypeAlias, b: ColumnTypeAlias) -> bool:
    if a == b:
        return True
    return a in {"integer", "decimal"} and b in {"integer", "decimal"}


ColumnTypeAlias = str


def detect_relationships(
    tables: dict[str, TableProfile],
) -> list[DetectedRelationship]:
    found: list[DetectedRelationship] = []
    seen: set[tuple] = set()

    for child_name, child in tables.items():
        for parent_name, parent in tables.items():
            if parent_name == child_name:
                continue
            parent_keys = [c for c in parent.columns if c.is_candidate_key and c.distinct_values]
            if not parent_keys:
                continue
            for cc in child.columns:
                if not cc.distinct_values:
                    continue
                for pk in parent_keys:
                    name_matches = (
                        cc.column_name == pk.column_name
                        or cc.column_name == f"{parent_name}_{pk.column_name}"
                        or cc.column_name == f"{_singular(parent_name)}_{pk.column_name}"
                    )
                    if not name_matches or not _compatible(cc.data_type, pk.data_type):
                        continue
                    parent_set = set(pk.distinct_values or [])
                    hits = sum(1 for v in cc.distinct_values if v in parent_set)
                    overlap = hits / len(cc.distinct_values)
                    if overlap < OVERLAP_THRESHOLD:
                        continue
                    sig = (child_name, cc.column_name, parent_name, pk.column_name)
                    if sig in seen:
                        continue
                    seen.add(sig)
                    found.append(
                        DetectedRelationship(
                            from_table=child_name,
                            from_column=cc.column_name,
                            to_table=parent_name,
                            to_column=pk.column_name,
                            overlap=math.floor(overlap * 1000 + 0.5) / 1000,
                        )
                    )
    return found
