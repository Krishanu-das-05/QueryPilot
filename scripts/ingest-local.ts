/**
 * Phase-0 end-to-end check: ingest the customers/orders eval pair into the
 * real database WITHOUT going through Supabase Storage (service key not yet
 * provided). Reads file bytes from disk and injects them into the pipeline.
 * Prints the resulting catalog and access checks. Never prints secrets.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { runIngestStep } from "../lib/ingest/pipeline";
import { loadEnvLocal, requireEnv } from "./env";

loadEnvLocal();

const EVALS = join(process.cwd(), "evals", "messy-csv");
// table names mirror what the app would derive from realistic file names
const FILES = [
  { source: "09-customers.csv", table: "customers" },
  { source: "10-orders.csv", table: "orders" },
];

async function main(): Promise<void> {
  const sql = postgres(requireEnv("DATABASE_URL_ADMIN"), {
    prepare: false,
    max: 3,
  });
  let datasetId = "";
  try {
    const [ds] = await sql<{ id: string; name: string }[]>`
      INSERT INTO datasets (name, status) VALUES ('customers-orders (local e2e)', 'uploaded')
      RETURNING id, name
    `;
    datasetId = ds!.id;

    for (const f of FILES) {
      const buf = readFileSync(join(EVALS, f.source));
      await sql`
        INSERT INTO dataset_files (dataset_id, storage_path, original_name, size_bytes, table_name)
        VALUES (${datasetId}, ${f.source}, ${f.source}, ${buf.length}, ${f.table})
      `;
    }

    const getContent = async (file: { storage_path: string }) =>
      new Uint8Array(readFileSync(join(EVALS, file.storage_path)));

    let last = "";
    for (let i = 0; i < 60; i += 1) {
      const step = await runIngestStep(datasetId, { sql, getContent });
      console.log(`step ${i}: ${step.status} ${step.progress}%`);
      last = step.status;
      if (last === "ready" || last === "failed") break;
    }
    console.log(`\n=== final status: ${last} ===\n`);
    if (last !== "ready") {
      const [d] = await sql`SELECT error FROM datasets WHERE id = ${datasetId}`;
      console.log("error:", d?.error);
      return;
    }

    const tables = await sql`
      SELECT table_name, original_file, row_count, description
      FROM catalog_tables WHERE dataset_id = ${datasetId} ORDER BY table_name
    `;
    for (const t of tables) {
      console.log(`table ${t.table_name} (${t.original_file}, ${t.row_count} rows)`);
      if (t.description) console.log(`  desc: ${t.description}`);
      const cols = await sql`
        SELECT ordinal, column_name, original_header, data_type, date_format,
               is_percent, null_pct, distinct_count, coerced_count,
               min_value, max_value, is_candidate_key
        FROM catalog_columns c
        JOIN catalog_tables t2 ON t2.id = c.table_id
        WHERE t2.dataset_id = ${datasetId} AND t2.table_name = ${t.table_name}
        ORDER BY ordinal
      `;
      for (const c of cols) {
        const bits = [
          c.data_type,
          c.date_format ? `[${c.date_format}]` : "",
          c.is_percent ? "(%)" : "",
          c.is_candidate_key ? "KEY" : "",
          `null ${c.null_pct}%`,
          `distinct ${c.distinct_count}`,
          c.coerced_count ? `coerced ${c.coerced_count}` : "",
          c.min_value !== null ? `${c.min_value}–${c.max_value}` : "",
        ].filter(Boolean);
        console.log(`  ${c.column_name} (${c.original_header}): ${bits.join(" ")}`);
      }
    }

    const rels = await sql`
      SELECT from_table, from_column, to_table, to_column, overlap, method
      FROM catalog_relationships WHERE dataset_id = ${datasetId}
    `;
    console.log("\nrelationships:");
    for (const r of rels) {
      console.log(
        `  ${r.from_table}.${r.from_column} -> ${r.to_table}.${r.to_column} overlap ${Math.round(Number(r.overlap) * 100)}% (${r.method})`,
      );
    }

    const [dsRow] = await sql<{ schema_name: string; role_name: string }[]>`
      SELECT schema_name, role_name FROM datasets WHERE id = ${datasetId}
    `;
    const checks = await sql<{ ok_role: boolean; ok_qp: boolean }[]>`
      SELECT
        has_table_privilege(${dsRow!.role_name}, ${dsRow!.schema_name + ".orders"}, 'SELECT') AS ok_role,
        has_table_privilege('qp_query', ${dsRow!.schema_name + ".orders"}, 'SELECT') AS ok_qp
    `;
    console.log(
      `\ngrants: ${dsRow!.role_name} SELECT=${checks[0]!.ok_role}, qp_query SELECT=${checks[0]!.ok_qp}`,
    );

    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(dsRow!.schema_name)}.${sql("orders")}
    `;
    console.log(`rows in ${dsRow!.schema_name}.orders: ${count!.n}`);

    // qp_query authenticating and reading through its granted role
    const qpUrl = requireEnv("DATABASE_URL_QUERY");
    const qp = postgres(qpUrl, { prepare: false, max: 1 });
    try {
      const [qn] = await qp<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${qp(dsRow!.schema_name)}.${qp("customers")}
      `;
      console.log(`qp_query SELECT customers: ${qn!.n} rows`);
      const [tot] = await qp<{ total: number }[]>`
        SELECT round(sum(amount))::int AS total FROM ${qp(dsRow!.schema_name)}.${qp("orders")}
        WHERE status = 'delivered'
      `;
      console.log(`qp_query aggregate (delivered total): ${tot?.total ?? 0}`);
    } finally {
      await qp.end();
    }
  } finally {
    await sql.end();
  }
  console.log("\nE2E OK — dataset id:", datasetId);
}

main().catch((err) => {
  console.error("E2E failed:", err instanceof Error ? err.message : "unknown");
  process.exit(1);
});
