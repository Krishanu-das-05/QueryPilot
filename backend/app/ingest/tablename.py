"""Safe table-name derivation from file names (mirrors lib/ingest/tableName.ts)."""

import re


def table_name_for_file(original_name: str, taken: set[str]) -> str:
    base = re.sub(r"\.(csv|xlsx)$", "", original_name, flags=re.IGNORECASE)
    s = re.sub(r"[^a-z0-9]+", "_", base.strip().lower()).strip("_")
    if s == "":
        s = "table"
    if re.match(r"^[0-9]", s):
        s = f"t_{s}"
    s = s[:63]
    candidate = s
    i = 2
    while candidate in taken:
        tail = f"_{i}"
        candidate = f"{s[: 63 - len(tail)]}{tail}"
        i += 1
    return candidate
