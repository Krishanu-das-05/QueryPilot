import { describe, expect, it } from "vitest";
import {
  guardReadOnly,
  guardRowLimit,
  guardSingleStatement,
  guardSql,
  guardTableAllowlist,
  ROW_LIMIT,
} from "@/lib/agent/guard";
import { extractRelations, splitStatements } from "@/lib/agent/sql-text";

const DEPS = { schemaName: "ds_abcd1234", tableNames: ["customers", "orders"] };

describe("stage 1: single statement", () => {
  it("accepts one statement", () => {
    expect(guardSingleStatement("SELECT 1").pass).toBe(true);
    expect(guardSingleStatement("SELECT 1;").pass).toBe(true);
  });
  it("rejects stacked statements", () => {
    expect(guardSingleStatement("SELECT 1; SELECT 2").pass).toBe(false);
    expect(guardSingleStatement("SELECT 1; DROP TABLE x").reason).toContain("stacked");
  });
  it("ignores semicolons inside strings", () => {
    expect(guardSingleStatement("SELECT * FROM t WHERE a = 'x;y'").pass).toBe(true);
    expect(splitStatements("SELECT ';'")).toHaveLength(1);
  });
  it("rejects empty input", () => {
    expect(guardSingleStatement("   ").pass).toBe(false);
  });
});

describe("stage 2: read-only", () => {
  // statements not led by SELECT/WITH are blocked as "not-select"
  const nonSelect = [
    "DELETE FROM customers",
    "DROP TABLE customers",
    "SET statement_timeout = '5s'",
    "COPY customers FROM STDIN",
    "DO $$ BEGIN RAISE NOTICE 'x'; END $$",
  ];
  for (const sql of nonSelect) {
    it(`blocks (not-select): ${sql.slice(0, 40)}`, () => {
      const r = guardReadOnly(sql);
      expect(r.pass).toBe(false);
      expect(r.reason).toBe("not-select");
    });
  }

  // SELECT-led statements blocked by the keyword denylist
  const denylisted: [string, string][] = [
    ["WITH t AS (SELECT 1) DELETE FROM customers", "delete"],
    ["SELECT 1; INSERT INTO orders VALUES (1)", "insert"],
    ["SELECT * FROM orders; -- comment\nDROP TABLE x", "drop"],
    ["SELECT pg_sleep(10)", "pg_sleep"],
    ["SELECT * FROM orders WHERE id = (SELECT lo_export(x,'/tmp/y') FROM t)", "lo_export"],
  ];
  for (const [sql, tag] of denylisted) {
    it(`blocks (not-read-only): ${sql.slice(0, 40)}`, () => {
      const r = guardReadOnly(sql);
      expect(r.pass).toBe(false);
      expect(r.reason).toContain(tag);
    });
  }

  it("allows plain SELECT and WITH SELECT", () => {
    expect(guardReadOnly("SELECT * FROM customers").pass).toBe(true);
    expect(guardReadOnly("WITH t AS (SELECT 1 AS x) SELECT * FROM t").pass).toBe(true);
  });
  it("allows pg_catalog reads at stage 2 (blocked later by stage 3 allowlist)", () => {
    expect(guardReadOnly("SELECT * FROM pg_catalog.pg_tables").pass).toBe(true);
    expect(
      guardTableAllowlist("SELECT * FROM pg_catalog.pg_tables", DEPS).pass,
    ).toBe(false);
  });
  it("doesn't trip on keywords inside string literals", () => {
    expect(guardReadOnly("SELECT * FROM customers WHERE name = 'delete me'").pass).toBe(true);
    expect(guardReadOnly("SELECT * FROM customers WHERE note LIKE '%drop%'").pass).toBe(true);
  });
  it("doesn't trip on column names containing keywords", () => {
    expect(guardReadOnly("SELECT updated_at FROM orders").pass).toBe(true);
    expect(guardReadOnly("SELECT c.delete_count FROM x c").pass).toBe(true);
  });
});

describe("stage 3: table allowlist", () => {
  it("accepts relations in the dataset schema", () => {
    expect(
      guardTableAllowlist(
        'SELECT * FROM "ds_abcd1234"."orders" o JOIN "ds_abcd1234"."customers" c ON c.id = o.customer_id',
        DEPS,
      ).pass,
    ).toBe(true);
    expect(guardTableAllowlist("SELECT * FROM orders", DEPS).pass).toBe(true);
  });
  it("rejects other schemas and unknown tables", () => {
    const cross = guardTableAllowlist("SELECT * FROM public.datasets", DEPS);
    expect(cross.pass).toBe(false);
    expect(cross.reason).toContain("off-limits");
    expect(guardTableAllowlist("SELECT * FROM ds_deadbeef.orders", DEPS).pass).toBe(false);
    expect(guardTableAllowlist("SELECT * FROM secrets", DEPS).pass).toBe(false);
  });
  it("catches UNION exfil into other tables", () => {
    const r = guardTableAllowlist(
      "SELECT id FROM orders UNION ALL SELECT id FROM public.pg_shadow",
      DEPS,
    );
    expect(r.pass).toBe(false);
  });
  it("relation extraction handles quoted + unquoted", () => {
    const rels = extractRelations('FROM "ds_x"."t1" a JOIN t2 b ON a.id=b.id, FROM t3');
    expect(rels.map((r) => r.table)).toContain("t1");
    expect(extractRelations('FROM "t1" JOIN t2 ON true').map((r) => r.table)).toEqual([
      "t1",
      "t2",
    ]);
  });
});

describe("stage 4: row limit", () => {
  it("injects LIMIT when absent", () => {
    const r = guardRowLimit("SELECT * FROM orders");
    expect(r.pass).toBe(true);
    expect(r.sql).toContain(`LIMIT ${ROW_LIMIT}`);
  });
  it("rejects oversized LIMIT", () => {
    expect(guardRowLimit("SELECT * FROM orders LIMIT 999999").pass).toBe(false);
  });
  it("ignores LIMIT inside strings", () => {
    const r = guardRowLimit("SELECT * FROM orders WHERE note = 'LIMIT 999999'");
    expect(r.pass).toBe(true);
    expect(r.sql).toContain(`LIMIT ${ROW_LIMIT}`);
  });
});

describe("full pipeline", () => {
  it("passes a valid query through all stages (with stubbed explain)", async () => {
    const out = await guardSql(
      'SELECT c.name, sum(o.amount) FROM "ds_abcd1234"."customers" c JOIN "ds_abcd1234"."orders" o ON c.id = o.customer_id GROUP BY c.name',
      { ...DEPS, explain: async () => ({ ok: true, planRows: 100 }) },
    );
    expect(out.ok).toBe(true);
    expect(out.report.map((r) => r.pass)).toEqual([true, true, true, true, true, true]);
    expect(out.sql).toContain("LIMIT 1000");
  });

  it("rejects expensive plans", async () => {
    const out = await guardSql("SELECT * FROM orders", {
      ...DEPS,
      explain: async () => ({ ok: true, planRows: 5_000_000 }),
    });
    expect(out.ok).toBe(false);
    expect(out.report.find((r) => r.stage === "cost")?.reason).toContain("too-expensive");
  });

  it("rejects when EXPLAIN errors", async () => {
    const out = await guardSql("SELECT * FROM orders", {
      ...DEPS,
      explain: async () => ({ ok: false, error: "permission denied" }),
    });
    expect(out.ok).toBe(false);
    expect(out.report.find((r) => r.stage === "dry-run")?.reason).toContain("explain-failed");
  });

  it("every stage reports even on early failure", async () => {
    const out = await guardSql("DELETE FROM orders", { ...DEPS });
    expect(out.ok).toBe(false);
    expect(out.report.length).toBeGreaterThanOrEqual(2);
  });
});
