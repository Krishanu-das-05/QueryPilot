import type postgres from "postgres";
import type { CatalogRelationship, CatalogTable } from "./state";

export interface DatasetCatalog {
  schemaName: string;
  roleName: string;
  name: string;
  tables: CatalogTable[];
  relationships: CatalogRelationship[];
}

/** Load the full catalog for a dataset (bounded by ingest limits: ≤5 tables,
 * ≤~50 columns each) plus detected relationships. */
export async function loadCatalog(
  sql: postgres.Sql,
  datasetId: string,
): Promise<DatasetCatalog | null> {
  const datasets = await sql<{ schema_name: string; role_name: string; name: string }[]>`
    SELECT schema_name, role_name, name FROM datasets WHERE id = ${datasetId}
  `;
  const ds = datasets[0];
  if (!ds?.schema_name || !ds.role_name) return null;

  const tableRows = await sql<
    { id: string; table_name: string; row_count: number | null; description: string | null }[]
  >`
    SELECT id, table_name, row_count, description
    FROM catalog_tables WHERE dataset_id = ${datasetId} ORDER BY table_name
  `;
  const tables: CatalogTable[] = [];
  for (const t of tableRows) {
    const cols = await sql<
      {
        column_name: string;
        data_type: string;
        description: string | null;
        is_candidate_key: boolean | null;
        null_pct: number | null;
        distinct_count: number | null;
        min_value: string | null;
        max_value: string | null;
        top_values: { value: string; count: number }[] | null;
        date_format: string | null;
        is_percent: boolean | null;
      }[]
    >`
      SELECT column_name, data_type, description, is_candidate_key, null_pct,
             distinct_count, min_value, max_value, top_values, date_format, is_percent
      FROM catalog_columns WHERE table_id = ${t.id} ORDER BY ordinal
    `;
    tables.push({
      tableName: t.table_name,
      rowCount: t.row_count,
      description: t.description,
      columns: cols.map((c) => ({
        tableName: t.table_name,
        columnName: c.column_name,
        dataType: c.data_type,
        description: c.description,
        isCandidateKey: c.is_candidate_key ?? false,
        nullPct: c.null_pct,
        distinctCount: c.distinct_count,
        minValue: c.min_value,
        maxValue: c.max_value,
        topValues: c.top_values,
        dateFormat: c.date_format,
        isPercent: c.is_percent ?? false,
      })),
    });
  }

  const rels = await sql<
    { from_table: string; from_column: string; to_table: string; to_column: string }[]
  >`
    SELECT from_table, from_column, to_table, to_column
    FROM catalog_relationships WHERE dataset_id = ${datasetId}
  `;
  return {
    schemaName: ds.schema_name,
    roleName: ds.role_name,
    name: ds.name,
    tables,
    relationships: rels.map((r) => ({
      fromTable: r.from_table,
      fromColumn: r.from_column,
      toTable: r.to_table,
      toColumn: r.to_column,
    })),
  };
}
