import postgres from "postgres";
import { env } from "../env";
import { ROW_LIMIT } from "./guard";
import type { AgentResult } from "./state";

let queryClient: postgres.Sql | null = null;

/** qp_query connection for agent SQL — near-zero privileges, READ ONLY
 * transactions, pgBouncer-safe (SET LOCAL only, never bare SET). */
export function getQueryDb(): postgres.Sql {
  if (!queryClient) {
    const url = env("DATABASE_URL_QUERY");
    if (!url) throw new Error("DATABASE_URL_QUERY is not configured");
    queryClient = postgres(url, { prepare: false, max: 3 });
  }
  return queryClient;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Stage 5/6: EXPLAIN (FORMAT JSON) in a READ ONLY, rolled-back transaction
 * as qp_query, with the session scoped to this dataset's role via
 * SET LOCAL ROLE (required after migration 0004 made grants INHERIT FALSE).
 * Zero data is read; parse + permission + cost info comes back. */
export async function explainAsQueryRole(
  schemaName: string,
  roleName: string,
  sqlText: string,
): Promise<{ ok: boolean; error?: string; planRows?: number }> {
  const sql = getQueryDb();
  try {
    let planRows: number | undefined;
    await sql.begin("read only", async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(roleName)}`);
      await tx.unsafe(`SET LOCAL statement_timeout = '5s'`);
      await tx.unsafe(`SET LOCAL search_path = ${quoteIdent(schemaName)}`);
      const rows = await tx.unsafe<{ "QUERY PLAN": unknown }[]>(
        `EXPLAIN (FORMAT JSON) ${sqlText}`,
      );
      const plan = rows[0]?.["QUERY PLAN"];
      const top = Array.isArray(plan) ? (plan[0] as Record<string, unknown>) : undefined;
      const node = top?.["Plan"] as Record<string, unknown> | undefined;
      const rows_ = node?.["Plan Rows"];
      if (typeof rows_ === "number") planRows = rows_;
      throw new ROLLBACK_SENTINEL();
    });
    return { ok: true, planRows };
  } catch (err) {
    if (err instanceof ROLLBACK_SENTINEL) return { ok: true };
    return { ok: false, error: (err as Error).message.slice(0, 200) };
  }
}

class ROLLBACK_SENTINEL extends Error {}

/** Execute guarded SQL as qp_query in READ ONLY with a 5s timeout and a row
 * cap of ROW_LIMIT, scoped to the dataset role via SET LOCAL ROLE.
 * `truncated` when the cap was hit. */
export async function executeAsQueryRole(
  schemaName: string,
  roleName: string,
  sqlText: string,
): Promise<AgentResult> {
  const sql = getQueryDb();
  const started = Date.now();
  let payload: AgentResult | null = null;
  try {
    await sql.begin("read only", async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(roleName)}`);
      await tx.unsafe(`SET LOCAL statement_timeout = '5s'`);
      await tx.unsafe(`SET LOCAL search_path = ${quoteIdent(schemaName)}`);
      const rows = await tx.unsafe<Record<string, unknown>[]>(sqlText);
      const columns = rows.length > 0 ? Object.keys(rows[0] ?? {}) : [];
      payload = {
        columns,
        rows: rows.slice(0, ROW_LIMIT).map((r) => columns.map((c) => r[c])),
        truncated: rows.length > ROW_LIMIT,
        elapsedMs: Date.now() - started,
      };
      throw new ROLLBACK_SENTINEL();
    });
  } catch (err) {
    if (!(err instanceof ROLLBACK_SENTINEL)) throw err;
  }
  if (!payload) throw new Error("execution produced no result");
  return payload;
}
