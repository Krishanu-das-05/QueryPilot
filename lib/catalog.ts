import type postgres from "postgres";
import { getAdminDb } from "./db";

export async function getDatasetCatalog(id: string, sql?: postgres.Sql) {
  const db = sql ?? getAdminDb();
  const datasets = await db`
    SELECT id, name, status, error, schema_name, is_demo, created_at, expires_at
    FROM datasets WHERE id = ${id}
  `;
  const dataset = datasets[0] ?? null;
  if (!dataset) return null;

  const files = await db`
    SELECT id, original_name, size_bytes, table_name, row_count, rows_loaded
    FROM dataset_files WHERE dataset_id = ${id} ORDER BY original_name
  `;
  const tables = await db`
    SELECT id, table_name, original_file, row_count, description, description_edited
    FROM catalog_tables WHERE dataset_id = ${id} ORDER BY table_name
  `;
  const columns =
    tables.length === 0
      ? []
      : await db`
          SELECT id, table_id, ordinal, column_name, original_header, data_type,
                 null_pct, distinct_count, coerced_count, min_value, max_value,
                 top_values, sample_values, is_candidate_key, is_percent,
                 date_format, description
          FROM catalog_columns
          WHERE table_id IN ${db(tables.map((t) => t.id))}
          ORDER BY ordinal
        `;
  const relationships = await db`
    SELECT from_table, from_column, to_table, to_column, overlap, method
    FROM catalog_relationships WHERE dataset_id = ${id}
  `;
  return { dataset, files, tables, columns, relationships };
}
