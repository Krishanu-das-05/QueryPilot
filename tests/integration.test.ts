/**
 * Integration test against a real Postgres. Skipped unless TEST_DATABASE_URL
 * is set (locally there is no Postgres; CI uses a postgres:16 service).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runIngestStep } from "@/lib/ingest/pipeline";
import { applyMigrations } from "@/lib/migrate";

const URL = process.env.TEST_DATABASE_URL;
const EVALS = join(__dirname, "..", "evals", "messy-csv");

describe.skipIf(!URL)("integration: full ingest on real Postgres", () => {
  const sql = postgres(URL!, { prepare: false, max: 3 });
  let datasetId = "";
  let schemaName = "";
  let roleName = "";

  beforeAll(async () => {
    await applyMigrations({
      url: URL!,
      qpQueryPassword: process.env.QP_QUERY_PASSWORD ?? "integration-ci-password",
    });

    const [ds] = await sql<{ id: string }[]>`
      INSERT INTO datasets (name, status) VALUES ('integration-test', 'uploaded')
      RETURNING id
    `;
    datasetId = ds!.id;

    const files = [
      { name: "01-mixed-dates.csv", table: "01_mixed_dates" },
      { name: "09-customers.csv", table: "customers" },
      { name: "10-orders.csv", table: "orders" },
    ];
    for (const f of files) {
      await sql`
        INSERT INTO dataset_files (dataset_id, storage_path, original_name, size_bytes, table_name)
        VALUES (${datasetId}, ${f.name}, ${f.name}, 1000, ${f.table})
      `;
    }
  });

  afterAll(async () => {
    try {
      if (datasetId) {
        await sql`DELETE FROM datasets WHERE id = ${datasetId}`;
      }
      if (schemaName) {
        await sql`DROP SCHEMA IF EXISTS ${sql(schemaName)} CASCADE`;
      }
      if (roleName) {
        await sql.unsafe(`DROP ROLE IF EXISTS "${roleName}"`);
      }
    } finally {
      await sql.end();
    }
  });

  async function runUntilDone(): Promise<void> {
    const getContent = async (file: { storage_path: string }) =>
      new Uint8Array(readFileSync(join(EVALS, file.storage_path)));
    let status = "";
    for (let i = 0; i < 60 && status !== "ready" && status !== "failed"; i += 1) {
      const step = await runIngestStep(datasetId, { sql, getContent });
      status = step.status;
    }
    expect(status).toBe("ready");
  }

  it("ingests end to end", { timeout: 120000 }, async () => {
    await runUntilDone();
    const [ds] = await sql<{ schema_name: string; role_name: string }[]>`
      SELECT schema_name, role_name FROM datasets WHERE id = ${datasetId}
    `;
    schemaName = ds!.schema_name;
    roleName = ds!.role_name;
  });

  it("creates catalog tables and rows with correct counts", async () => {
    const tables = await sql<{ table_name: string; row_count: number }[]>`
      SELECT table_name, row_count FROM catalog_tables
      WHERE dataset_id = ${datasetId} ORDER BY table_name
    `;
    const byName = Object.fromEntries(tables.map((t) => [t.table_name, t.row_count]));
    expect(byName["01_mixed_dates"]).toBe(10);
    expect(byName["customers"]).toBe(12);
    expect(byName["orders"]).toBe(16);
  });

  it("loads the data with inferred types", async () => {
    const cols = await sql<{ column_name: string; data_type: string }[]>`
      SELECT c.column_name, c.data_type
      FROM catalog_columns c
      JOIN catalog_tables t ON t.id = c.table_id
      WHERE t.dataset_id = ${datasetId} AND t.table_name = '01_mixed_dates'
      ORDER BY c.ordinal
    `;
    const types = Object.fromEntries(cols.map((c) => [c.column_name, c.data_type]));
    expect(types).toEqual({
      order_date: "date",
      ship_date: "date",
      paid_on: "date",
      created_at: "timestamp",
    });

    const rows = await sql<
      { order_date: string; ship_date: string; created_at: string }[]
    >`
      SELECT order_date::text, ship_date::text, created_at::text
      FROM ${sql(schemaName)}.${sql("01_mixed_dates")} ORDER BY order_date LIMIT 1
    `;
    expect(rows[0]!.order_date).toBe("2024-01-15");
    expect(rows[0]!.ship_date).toBe("2024-01-20"); // 20/01/2024 read dd/mm
  });

  it("detects the customers.id <- orders.customer_id relationship", async () => {
    const rels = await sql<
      { from_table: string; from_column: string; to_table: string; to_column: string }[]
    >`
      SELECT from_table, from_column, to_table, to_column
      FROM catalog_relationships WHERE dataset_id = ${datasetId}
    `;
    expect(rels).toContainEqual({
      from_table: "orders",
      from_column: "customer_id",
      to_table: "customers",
      to_column: "id",
    });
  });

  it("grants SELECT to the dataset role; qp_query reads only via SET ROLE", async () => {
    const [roleCheck] = await sql<{ ok: boolean }[]>`
      SELECT has_table_privilege(${roleName},
        ${schemaName + ".orders"}, 'SELECT') AS ok
    `;
    expect(roleCheck!.ok).toBe(true);

    const [qpCheck] = await sql<{ ok: boolean }[]>`
      SELECT has_table_privilege('qp_query',
        ${schemaName + ".orders"}, 'SELECT') AS ok
    `;
    expect(qpCheck!.ok).toBe(false);

    // qp_query itself authenticates and reads through the role
    const qpUrl = new globalThis.URL(URL as string);
    qpUrl.username = "qp_query";
    qpUrl.password = process.env.QP_QUERY_PASSWORD ?? "integration-ci-password";
    const qpSql = postgres(qpUrl.toString(), { prepare: false, max: 1 });
    try {
      const rejected = await qpSql`
        SELECT count(*)::int AS n FROM ${qpSql(schemaName)}.${qpSql("orders")}
      `.then(
        () => null,
        (err: { code?: string }) => err.code,
      );
      expect(rejected).toBe("42501");

      const [row] = await qpSql.begin("read only", async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE "${roleName.replaceAll('"', '""')}"`);
        return tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM ${tx(schemaName)}.${tx("orders")}
        `;
      });
      expect(row!.n).toBe(16);
    } finally {
      await qpSql.end();
    }
  });

  it("RLS is enabled on public tables", async () => {
    const rows = await sql<{ relrowsecurity: boolean }[]>`
      SELECT relrowsecurity FROM pg_class
      WHERE relnamespace = 'public'::regnamespace
        AND relname IN ('datasets', 'dataset_files', 'catalog_tables',
                        'catalog_columns', 'catalog_relationships')
    `;
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });
});
