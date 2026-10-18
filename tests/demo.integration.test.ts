import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEMO_DATASET_IDS } from "@/lib/demo";
import { reserveDemoQuestion } from "@/lib/demo-question";
import { applyMigrations } from "@/lib/migrate";

const URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL)("global demo cap on real PostgreSQL", () => {
  let sql: postgres.Sql | undefined;
  const created: string[] = [];

  beforeAll(async () => {
    if (!URL || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(new globalThis.URL(URL).hostname)) {
      throw new Error("Demo integration requires the disposable CI database");
    }
    await applyMigrations({ url: URL, qpQueryPassword: process.env.QP_QUERY_PASSWORD });
    sql = postgres(URL, { prepare: false, max: 3, onnotice: () => {} });
    vi.stubEnv("DEMO_DAILY_CAP", "1");
    for (const id of DEMO_DATASET_IDS) {
      await sql`
        INSERT INTO datasets (id, name, status, is_demo)
        VALUES (${id}, 'synthetic cap fixture', 'ready', true)
      `;
      created.push(id);
    }
  });

  afterAll(async () => {
    try {
      if (sql) {
        for (const id of created) await sql`DELETE FROM datasets WHERE id = ${id}`;
      }
    } finally {
      if (sql) await sql.end();
      vi.unstubAllEnvs();
    }
  });

  it("atomically allows only one concurrent question across both demos", async () => {
    const results = await Promise.all(DEMO_DATASET_IDS.map(
      (id) => reserveDemoQuestion(sql!, id, "Count the synthetic rows"),
    ));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.status === 429)).toHaveLength(1);
    const [count] = await sql!<{ n: number }[]>`
      SELECT count(*)::int AS n FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.dataset_id IN ${sql!([...DEMO_DATASET_IDS])} AND m.role = 'user'
    `;
    expect(count?.n).toBe(1);
  });
});
