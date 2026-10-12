from uuid import UUID

import asyncpg

DATASET_SQL = """
    SELECT id, name, status, error, schema_name, is_demo, created_at, expires_at
    FROM public.datasets WHERE id = $1
"""
FILES_SQL = """
    SELECT id, original_name, size_bytes, table_name, row_count, rows_loaded
    FROM public.dataset_files WHERE dataset_id = $1 ORDER BY original_name
"""
TABLES_SQL = """
    SELECT id, table_name, original_file, row_count, description, description_edited
    FROM public.catalog_tables WHERE dataset_id = $1 ORDER BY table_name
"""
COLUMNS_SQL = """
    SELECT id, table_id, ordinal, column_name, original_header, data_type,
           null_pct, distinct_count, coerced_count, min_value, max_value,
           top_values, sample_values, is_candidate_key, is_percent,
           date_format, description
    FROM public.catalog_columns
    WHERE table_id = ANY($1::uuid[])
    ORDER BY ordinal
"""
RELATIONSHIPS_SQL = """
    SELECT from_table, from_column, to_table, to_column, overlap, method
    FROM public.catalog_relationships WHERE dataset_id = $1
"""


async def get_dataset_catalog(conn: asyncpg.Connection, dataset_id: UUID) -> dict | None:
    dataset = await conn.fetchrow(DATASET_SQL, dataset_id)
    if dataset is None:
        return None
    files = await conn.fetch(FILES_SQL, dataset_id)
    tables = await conn.fetch(TABLES_SQL, dataset_id)
    columns = await conn.fetch(COLUMNS_SQL, [t["id"] for t in tables])
    relationships = await conn.fetch(RELATIONSHIPS_SQL, dataset_id)
    return {
        "dataset": dict(dataset),
        "files": [dict(r) for r in files],
        "tables": [dict(r) for r in tables],
        "columns": [dict(r) for r in columns],
        "relationships": [dict(r) for r in relationships],
    }
