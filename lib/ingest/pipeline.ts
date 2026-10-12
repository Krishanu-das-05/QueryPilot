import type postgres from "postgres";
import { getAdminDb } from "../db";
import { getSupabaseAdmin } from "../supabase-admin";
import { describeTable } from "./describe";
import { sanitizeHeaders } from "./headers";
import { parseTabularFile } from "./parse";
import { profileTable, type ColumnProfile } from "./profile";
import { detectRelationships } from "./relationships";
import { coerceValue, type ColumnType } from "./types";

export const ROWS_PER_STEP = 20000;
export const INSERT_BATCH = 1000;

export type DatasetStatus =
  | "uploaded"
  | "profiling"
  | "loading"
  | "describing"
  | "ready"
  | "failed";

export interface StepResult {
  status: DatasetStatus;
  progress: number;
}

interface DatasetRow {
  id: string;
  status: DatasetStatus;
  schema_name: string | null;
  role_name: string | null;
}

interface FileRow {
  id: string;
  dataset_id: string;
  storage_path: string;
  original_name: string;
  size_bytes: number;
  table_name: string;
  row_count: number | null;
  rows_loaded: number;
  profile: StoredProfile | null;
}

interface StoredProfile {
  rowCount: number;
  columns: ColumnProfile[];
}

export interface IngestDeps {
  sql?: postgres.Sql;
  getContent?: (file: { storage_path: string }) => Promise<Uint8Array>;
}

function shortId(uuid: string): string {
  return uuid.replaceAll("-", "").slice(0, 8);
}

const PG_TYPES: Record<ColumnType, string> = {
  boolean: "boolean",
  integer: "bigint",
  decimal: "numeric",
  date: "date",
  timestamp: "timestamp",
  text: "text",
};

async function defaultGetContent(file: { storage_path: string }): Promise<Uint8Array> {
  const { data, error } = await getSupabaseAdmin()
    .storage.from("uploads")
    .download(file.storage_path);
  if (error || !data) {
    throw new Error(`could not download uploaded file (${error?.message ?? "empty"})`);
  }
  return new Uint8Array(await data.arrayBuffer());
}

async function markFailed(
  sql: postgres.Sql,
  datasetId: string,
  message: string,
): Promise<StepResult> {
  await sql`
    UPDATE datasets SET status = 'failed', error = ${message.slice(0, 500)}
    WHERE id = ${datasetId}
  `;
  return { status: "failed", progress: 0 };
}

/** Advance ingestion by exactly one bounded step. */
export async function runIngestStep(
  datasetId: string,
  deps: IngestDeps = {},
): Promise<StepResult> {
  const sql = deps.sql ?? getAdminDb();
  const getContent = deps.getContent ?? defaultGetContent;

  const [ds] = await sql<DatasetRow[]>`
    SELECT id, status, schema_name, role_name FROM datasets WHERE id = ${datasetId}
  `;
  if (!ds) throw new Error("dataset not found");
  if (ds.status === "ready" || ds.status === "failed") {
    return { status: ds.status, progress: ds.status === "ready" ? 100 : 0 };
  }

  try {
    switch (ds.status) {
      case "uploaded":
      case "profiling":
        return await profilingStep(sql, ds, getContent);
      case "loading":
        return await loadingStep(sql, ds, getContent);
      case "describing":
        return await describingStep(sql, ds);
    }
  } catch (err) {
    return markFailed(sql, datasetId, err instanceof Error ? err.message : "unknown error");
  }
}

/* ------------------------------------------------------------------ */
/* profiling                                                           */
/* ------------------------------------------------------------------ */

async function profilingStep(
  sql: postgres.Sql,
  ds: DatasetRow,
  getContent: IngestDeps["getContent"] & object,
): Promise<StepResult> {
  const files = await sql<FileRow[]>`
    SELECT id, dataset_id, storage_path, original_name, size_bytes, table_name,
           row_count, rows_loaded, profile
    FROM dataset_files WHERE dataset_id = ${ds.id} ORDER BY original_name
  `;

  const pending = files.find((f) => f.profile === null);
  if (pending) {
    const content = await getContent(pending);
    const parsed = await parseTabularFile(pending.original_name, content);
    const headers = sanitizeHeaders(parsed.headers);
    const profile = profileTable(headers, parsed.rows);
    const stored: StoredProfile = { rowCount: profile.rowCount, columns: profile.columns };
    await sql`
      UPDATE dataset_files
      SET profile = ${sql.json(stored as unknown as postgres.JSONValue)},
          row_count = ${profile.rowCount}
      WHERE id = ${pending.id}
    `;
    await sql`UPDATE datasets SET status = 'profiling' WHERE id = ${ds.id}`;
    const done = files.filter((f) => f.profile !== null).length + 1;
    return {
      status: "profiling",
      progress: files.length === 0 ? 100 : Math.round((done / files.length) * 100),
    };
  }

  // All files profiled -> build the catalog.
  const profiles = files.map((f) => ({
    tableName: f.table_name,
    columns: f.profile?.columns ?? [],
  }));
  const relationships = detectRelationships(
    profiles.map((p) => ({
      tableName: p.tableName,
      columns: p.columns.map((c) => ({
        ...c,
        distinctValues: Array.isArray(c.distinctValues) ? c.distinctValues : null,
      })),
    })),
  );

  for (const file of files) {
    const profile = file.profile;
    if (!profile) continue;
    const [table] = await sql<{ id: string }[]>`
      INSERT INTO catalog_tables (dataset_id, table_name, original_file, row_count)
      VALUES (${ds.id}, ${file.table_name}, ${file.original_name}, ${profile.rowCount})
      RETURNING id
    `;
    if (!table) throw new Error("failed to create catalog table row");
    for (const col of profile.columns) {
      await sql`
        INSERT INTO catalog_columns (
          table_id, ordinal, column_name, original_header, data_type, null_pct,
          distinct_count, coerced_count, min_value, max_value, top_values,
          sample_values, is_candidate_key, is_percent, date_format
        ) VALUES (
          ${table.id}, ${col.ordinal}, ${col.columnName}, ${col.originalHeader},
          ${col.dataType}, ${col.nullPct}, ${col.distinctCount}, ${col.coercedCount},
          ${col.minValue}, ${col.maxValue},
          ${sql.json(col.topValues as unknown as postgres.JSONValue)},
          ${sql.json(col.sampleValues as unknown as postgres.JSONValue)},
          ${col.isCandidateKey}, ${col.isPercent}, ${col.dateFormat}
        )
      `;
    }
  }
  for (const rel of relationships) {
    await sql`
      INSERT INTO catalog_relationships
        (dataset_id, from_table, from_column, to_table, to_column, overlap, method)
      VALUES
        (${ds.id}, ${rel.fromTable}, ${rel.fromColumn}, ${rel.toTable},
         ${rel.toColumn}, ${rel.overlap}, ${rel.method})
    `;
  }

  const schema = `ds_${shortId(ds.id)}`;
  const role = `${schema}_r`;
  await sql`
    UPDATE datasets SET status = 'loading', schema_name = ${schema}, role_name = ${role}
    WHERE id = ${ds.id}
  `;
  return { status: "loading", progress: 0 };
}

/* ------------------------------------------------------------------ */
/* loading                                                             */
/* ------------------------------------------------------------------ */

async function ensureLoadingInfra(sql: postgres.Sql, ds: DatasetRow): Promise<void> {
  if (!ds.schema_name || !ds.role_name) throw new Error("dataset missing schema/role");
  const schema = ds.schema_name;
  const role = ds.role_name;

  await sql`CREATE SCHEMA IF NOT EXISTS ${sql(schema)}`;
  // bound params inside DO blocks break on the transaction pooler
  // ("could not determine data type of parameter $1"); role names are
  // system-generated identifiers, escaped defensively here.
  const roleLit = `'${role.replaceAll("'", "''")}'`;
  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${roleLit}) THEN
        EXECUTE format('CREATE ROLE %I NOLOGIN', ${roleLit});
      END IF;
    END
    $$
  `);
  await sql`GRANT USAGE ON SCHEMA ${sql(schema)} TO ${sql(role)}`;
  // INHERIT FALSE: qp_query must SET ROLE to use this (see migration 0004)
  await sql`GRANT ${sql(role)} TO qp_query WITH INHERIT FALSE, SET TRUE`;

  const tables = await sql<{ id: string; table_name: string }[]>`
    SELECT id, table_name FROM catalog_tables WHERE dataset_id = ${ds.id}
  `;
  for (const t of tables) {
    const cols = await sql<{ column_name: string; data_type: ColumnType }[]>`
      SELECT column_name, data_type FROM catalog_columns
      WHERE table_id = ${t.id} ORDER BY ordinal
    `;
    if (cols.length === 0) continue;
    // identifiers are only ever quoted via sql(); types come from our type map
    await sql`
      CREATE TABLE IF NOT EXISTS ${sql(schema)}.${sql(t.table_name)} (
        ${sql.unsafe(
          cols.map((c) => `${quoteIdent(c.column_name)} ${PG_TYPES[c.data_type]}`).join(", "),
        )}
      )
    `;
  }
}

/** Identifiers never carry raw user strings at this point (all names are
 * sanitized); quote defensively anyway. */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function loadingStep(
  sql: postgres.Sql,
  ds: DatasetRow,
  getContent: IngestDeps["getContent"] & object,
): Promise<StepResult> {
  await ensureLoadingInfra(sql, ds);
  if (!ds.schema_name) throw new Error("dataset missing schema");
  const schema = ds.schema_name;

  const files = await sql<FileRow[]>`
    SELECT id, dataset_id, storage_path, original_name, size_bytes, table_name,
           row_count, rows_loaded, profile
    FROM dataset_files WHERE dataset_id = ${ds.id} ORDER BY original_name
  `;
  const totalRows = files.reduce((acc, f) => acc + (f.row_count ?? 0), 0);
  const loadedRows = () => files.reduce((acc, f) => acc + f.rows_loaded, 0);

  const file = files.find((f) => (f.row_count ?? 0) > f.rows_loaded);
  if (file && file.profile) {
    const content = await getContent(file);
    const parsed = await parseTabularFile(file.original_name, content);
    const headers = sanitizeHeaders(parsed.headers);
    const colNames = headers.map((h) => h.name);

    const start = file.rows_loaded;
    const end = Math.min(start + ROWS_PER_STEP, parsed.rows.length);
    for (let b = start; b < end; b += INSERT_BATCH) {
      const slice = parsed.rows.slice(b, b + INSERT_BATCH);
      const batch = slice.map((row) => {
        const obj: Record<string, string | null> = {};
        headers.forEach((h, i) => {
          const spec = file.profile?.columns[i];
          const raw = row[i] ?? "";
          const c = spec
            ? coerceValue(raw, spec.dataType, spec.dateFormat)
            : { value: raw, ok: true };
          obj[h.name] = c.value;
        });
        return obj;
      });
      if (batch.length > 0) {
        await sql`
          INSERT INTO ${sql(schema)}.${sql(file.table_name)} ${sql(batch, ...colNames)}
        `;
      }
    }
    await sql`
      UPDATE dataset_files SET rows_loaded = ${end} WHERE id = ${file.id}
    `;
    const nowLoaded = loadedRows() - file.rows_loaded + end;
    return {
      status: "loading",
      progress: totalRows === 0 ? 100 : Math.round((nowLoaded / totalRows) * 100),
    };
  }

  // everything loaded -> grants, indexes, analyze
  if (!ds.role_name) throw new Error("dataset missing role");
  await sql`GRANT SELECT ON ALL TABLES IN SCHEMA ${sql(schema)} TO ${sql(ds.role_name)}`;

  const keyCols = await sql<{ table_name: string; column_name: string }[]>`
    SELECT t.table_name, c.column_name
    FROM catalog_columns c
    JOIN catalog_tables t ON t.id = c.table_id
    WHERE t.dataset_id = ${ds.id} AND c.is_candidate_key
  `;
  const relCols = await sql<{ table_name: string; column_name: string }[]>`
    SELECT from_table AS table_name, from_column AS column_name
    FROM catalog_relationships WHERE dataset_id = ${ds.id}
  `;
  const indexTargets = new Map<string, Set<string>>();
  for (const { table_name, column_name } of [...keyCols, ...relCols]) {
    const set = indexTargets.get(table_name) ?? new Set<string>();
    set.add(column_name);
    indexTargets.set(table_name, set);
  }
  for (const [table, cols] of indexTargets) {
    for (const col of cols) {
      const idx = `ix_${table}_${col}`.slice(0, 63);
      await sql`
        CREATE INDEX IF NOT EXISTS ${sql(idx)}
        ON ${sql(schema)}.${sql(table)} (${sql(col)})
      `;
    }
  }
  const allTables = await sql<{ table_name: string }[]>`
    SELECT table_name FROM catalog_tables WHERE dataset_id = ${ds.id}
  `;
  for (const t of allTables) {
    await sql`ANALYZE ${sql(schema)}.${sql(t.table_name)}`;
  }

  await sql`UPDATE datasets SET status = 'describing' WHERE id = ${ds.id}`;
  return { status: "describing", progress: 100 };
}

/* ------------------------------------------------------------------ */
/* describing                                                          */
/* ------------------------------------------------------------------ */

async function describingStep(sql: postgres.Sql, ds: DatasetRow): Promise<StepResult> {
  const tables = await sql<
    { id: string; table_name: string; description: string | null }[]
  >`
    SELECT id, table_name, description FROM catalog_tables
    WHERE dataset_id = ${ds.id} ORDER BY table_name
  `;
  const pending = tables.filter((t) => t.description === null);
  const total = tables.length;

  const finishSearch = async (): Promise<void> => {
    await sql`
      UPDATE catalog_tables
      SET search = to_tsvector('english',
        coalesce(table_name, '') || ' ' || coalesce(description, ''))
      WHERE dataset_id = ${ds.id}
    `;
    await sql`
      UPDATE catalog_columns c
      SET search = to_tsvector('english',
        coalesce(c.column_name, '') || ' ' || coalesce(c.original_header, '')
        || ' ' || coalesce(c.description, ''))
      FROM catalog_tables t
      WHERE c.table_id = t.id AND t.dataset_id = ${ds.id}
    `;
  };

  if (pending.length === 0) {
    await finishSearch();
    await sql`UPDATE datasets SET status = 'ready' WHERE id = ${ds.id}`;
    return { status: "ready", progress: 100 };
  }

  const table = pending[0];
  if (!table) throw new Error("no pending table");

  const columns = await sql<
    {
      ordinal: number;
      column_name: string;
      original_header: string | null;
      data_type: ColumnType;
      null_pct: number | null;
      distinct_count: number | null;
      min_value: string | null;
      max_value: string | null;
      top_values: { value: string; count: number }[] | null;
      sample_values: string[] | null;
    }[]
  >`
    SELECT ordinal, column_name, original_header, data_type, null_pct,
           distinct_count, min_value, max_value, top_values, sample_values
    FROM catalog_columns WHERE table_id = ${table.id} ORDER BY ordinal
  `;

  let sampleRows: string[][] = [];
  if (ds.schema_name) {
    const rows = await sql.unsafe<Record<string, unknown>[]>(
      `SELECT * FROM ${quoteIdent(ds.schema_name)}.${quoteIdent(table.table_name)} LIMIT 5`,
    );
    sampleRows = rows.map((r) =>
      columns.map((c) => {
        const v = r[c.column_name];
        return v === null || v === undefined ? "" : String(v);
      }),
    );
  }

  // LLM failures (network, retries exhausted, bad JSON) must never fail the
  // dataset — descriptions stay empty and ingestion completes (per spec).
  let result: Awaited<ReturnType<typeof describeTable>> = null;
  try {
    result = await describeTable({
      tableName: table.table_name,
      columns: columns.map((c) => ({
        ordinal: c.ordinal,
        columnName: c.column_name,
        originalHeader: c.original_header ?? "",
        dataType: c.data_type,
        dateFormat: null,
        isPercent: false,
        isCandidateKey: false,
        rowCount: 0,
        nullCount: 0,
        nullPct: c.null_pct ?? 0,
        distinctCount: c.distinct_count ?? 0,
        coercedCount: 0,
        minValue: c.min_value,
        maxValue: c.max_value,
        topValues: c.top_values ?? [],
        sampleValues: c.sample_values ?? [],
        distinctValues: null,
      })),
      sampleRows,
    });
  } catch {
    result = null;
  }

  await sql`
    UPDATE catalog_tables SET description = ${result?.table_description ?? ""}
    WHERE id = ${table.id}
  `;
  for (const col of columns) {
    const desc = result?.columns[col.column_name] ?? "";
    if (desc !== "") {
      await sql`
        UPDATE catalog_columns SET description = ${desc}
        WHERE table_id = ${table.id} AND ordinal = ${col.ordinal}
      `;
    }
  }

  const done = total - pending.length + 1;
  return {
    status: "describing",
    progress: total === 0 ? 100 : Math.round((done / total) * 100),
  };
}
