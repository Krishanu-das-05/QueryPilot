import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  executeAsQueryRole,
  explainAsQueryRole,
  getQueryDb,
} from "@/lib/agent/deps";
import { guardSql, guardTableAllowlist } from "@/lib/agent/guard";
import { runIngestStep } from "@/lib/ingest/pipeline";
import { applyMigrations } from "@/lib/migrate";

const TEST_URL = process.env.TEST_DATABASE_URL;
const CONTENT = new TextEncoder().encode("id\n1\n2\n3\n");

interface Fixture {
  id: string;
  schema: string | null;
  role: string | null;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function countSql(schema: string): string {
  return `SELECT count(*)::int AS n FROM ${quoteIdent(schema)}."records"`;
}

describe("production TypeScript cross-dataset guard", () => {
  it("rejects a second dataset in a comma-separated FROM list at stage 3", () => {
    const result = guardTableAllowlist(
      'SELECT a.id, b.id FROM "ds_a"."records" a, "ds_b"."records" b',
      { schemaName: "ds_a", tableNames: ["records"] },
    );
    expect(result).toMatchObject({ stage: "table-allowlist", pass: false });
  });
});

describe.skipIf(!TEST_URL)("production TypeScript database isolation", () => {
  let admin: postgres.Sql | undefined;
  let query: postgres.Sql | undefined;
  const fixtures: Fixture[] = [];
  let a: { schema: string; role: string };
  let b: { schema: string; role: string };

  beforeAll(async () => {
    if (!TEST_URL) throw new Error("TEST_DATABASE_URL is required");
    const target = new URL(TEST_URL);
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(target.hostname)) {
      throw new Error("Isolation tests require the disposable local CI database");
    }
    const password = process.env.QP_QUERY_PASSWORD;
    if (!password) throw new Error("QP_QUERY_PASSWORD is required for isolation tests");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("OPENROUTER_MODEL", "");
    await applyMigrations({ url: TEST_URL, qpQueryPassword: password });
    admin = postgres(TEST_URL, { prepare: false, max: 2, onnotice: () => {} });

    for (const name of ["a", "b"]) {
      const fixture: Fixture = { id: randomUUID(), schema: null, role: null };
      fixtures.push(fixture);
      await admin`
        INSERT INTO datasets (id, name, status)
        VALUES (${fixture.id}, ${`isolation-${name}`}, 'uploaded')
      `;
      await admin`
        INSERT INTO dataset_files
          (dataset_id, storage_path, original_name, size_bytes, table_name)
        VALUES (${fixture.id}, ${`${fixture.id}/records.csv`},
          'records.csv', ${CONTENT.length}, 'records')
      `;
      let status = "uploaded";
      for (let step = 0; step < 30 && status !== "ready" && status !== "failed"; step += 1) {
        status = (await runIngestStep(fixture.id, {
          sql: admin,
          getContent: async () => CONTENT,
        })).status;
      }
      const [stored] = await admin<{ schema_name: string; role_name: string }[]>`
        SELECT schema_name, role_name FROM datasets WHERE id = ${fixture.id}
      `;
      fixture.schema = stored?.schema_name ?? null;
      fixture.role = stored?.role_name ?? null;
      expect(status).toBe("ready");
      expect(fixture.schema).toBeTruthy();
      expect(fixture.role).toBeTruthy();
    }
    a = { schema: fixtures[0]!.schema!, role: fixtures[0]!.role! };
    b = { schema: fixtures[1]!.schema!, role: fixtures[1]!.role! };
    const restricted = new URL(TEST_URL);
    restricted.username = "qp_query";
    restricted.password = password;
    vi.stubEnv("DATABASE_URL_QUERY", restricted.toString());
    query = getQueryDb();
    const [identity] = await query<{ identity: string }[]>`
      SELECT session_user AS identity
    `;
    expect(identity?.identity).toBe("qp_query");
  });

  afterAll(async () => {
    try {
      if (admin) {
        for (const fixture of fixtures) {
          const [stored] = await admin<{ schema_name: string | null; role_name: string | null }[]>`
            SELECT schema_name, role_name FROM datasets WHERE id = ${fixture.id}
          `;
          await admin`DELETE FROM datasets WHERE id = ${fixture.id}`;
          const schema = stored?.schema_name ?? fixture.schema;
          const role = stored?.role_name ?? fixture.role;
          if (schema) await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`;
          if (role) await admin.unsafe(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
        }
      }
    } finally {
      try {
        if (query) await query.end();
      } finally {
        if (admin) await admin.end();
        vi.unstubAllEnvs();
      }
    }
  });

  it("denies inherited access but allows execution after selecting role A", async () => {
    await expect(query!.unsafe(countSql(a.schema))).rejects.toMatchObject({ code: "42501" });
    const result = await executeAsQueryRole(a.schema, a.role, countSql(a.schema));
    expect(result.rows).toEqual([[3]]);
  });

  it("denies dataset B through the direct executor scoped to A", async () => {
    await expect(
      executeAsQueryRole(a.schema, a.role, countSql(b.schema)),
    ).rejects.toThrow("permission denied");
  });

  it("rejects the real comma-join before EXPLAIN rather than relying on DB denial", async () => {
    const sql = `SELECT a.id, b.id FROM ${quoteIdent(a.schema)}."records" a, ${quoteIdent(b.schema)}."records" b`;
    const explain = vi.fn((text: string) => explainAsQueryRole(a.schema, a.role, text));
    const outcome = await guardSql(sql, {
      schemaName: a.schema,
      tableNames: ["records"],
      explain,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.report.find((stage) => !stage.pass)?.stage).toBe("table-allowlist");
    expect(explain).not.toHaveBeenCalled();
  });

  it("denies INSERT and leaves the original rows unchanged", async () => {
    const sql = `INSERT INTO ${quoteIdent(a.schema)}."records" ("id") VALUES (99)`;
    await expect(executeAsQueryRole(a.schema, a.role, sql)).rejects.toThrow();
    let sqlstate: string | undefined;
    try {
      await query!.begin("read only", async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(a.role)}`);
        await tx.unsafe(sql);
      });
    } catch (error) {
      sqlstate = (error as { code?: string }).code;
    }
    expect(["42501", "25006"]).toContain(sqlstate);
    const [row] = await admin!.unsafe<{ n: number }[]>(countSql(a.schema));
    expect(row?.n).toBe(3);
  });

  it("scopes EXPLAIN to the selected dataset role", async () => {
    expect((await explainAsQueryRole(a.schema, a.role, countSql(a.schema))).ok).toBe(true);
    expect(await explainAsQueryRole(a.schema, a.role, countSql(b.schema))).toMatchObject({
      ok: false,
      error: "permission denied",
    });
  });

  it("restores role, search path, and timeout after success and failure", async () => {
    const baselineSql = "SELECT current_user AS role, current_setting('search_path') AS path, current_setting('statement_timeout') AS timeout";
    const before = await query!.unsafe(baselineSql);
    expect(before[0]?.role).toBe("qp_query");
    await executeAsQueryRole(a.schema, a.role, countSql(a.schema));
    await expect(executeAsQueryRole(a.schema, a.role, countSql(b.schema))).rejects.toThrow();
    expect(await query!.unsafe(baselineSql)).toEqual(before);
    await expect(query!.unsafe(countSql(a.schema))).rejects.toMatchObject({ code: "42501" });
  });
});
