import { describe, expect, it, vi } from "vitest";
import { guardSql, guardTableAllowlist } from "@/lib/agent/guard";

const DEPS = { schemaName: "ds_a", tableNames: ["records", "other_records"] };

describe("stage 3 scoped relation parsing", () => {
  it.each([
    "SELECT * FROM ds_a.records a, ds_b.records b",
    'SELECT * FROM "ds_a"."records" a, "ds_b"."records" b',
    "SELECT * FROM ds_a.records a,\n/* next relation */ ds_b.records b",
    "SELECT * FROM ds_a.records a JOIN ds_a.other_records c ON a.id=c.id, ds_b.records b",
    "SELECT (SELECT count(*) FROM ds_a.records a, ds_b.records b) AS n",
    "SELECT * FROM (SELECT * FROM ds_a.records a, ds_b.records b) nested",
    "WITH chosen AS (SELECT * FROM ds_a.records a, ds_b.records b) SELECT * FROM chosen",
    'WITH "chosen" AS (SELECT * FROM "ds_b"."records") SELECT * FROM "chosen"',
    "WITH first AS (SELECT * FROM ds_a.records), second AS (SELECT * FROM ds_b.records) SELECT * FROM second",
    "WITH chosen AS (WITH nested AS (SELECT * FROM ds_b.records) SELECT * FROM nested) SELECT * FROM chosen",
    "SELECT * FROM ds_a.records a, missing b",
    "SELECT * FROM ds_a.missing",
    "SELECT * FROM pg_catalog.pg_tables",
    'SELECT * FROM "DS_A"."records"',
    "WITH missing AS (SELECT * FROM missing) SELECT * FROM missing",
    "SELECT * FROM ds_a.records UNION ALL SELECT * FROM ds_b.records",
  ])("rejects out-of-scope sources before EXPLAIN: %s", async (sql) => {
    const explain = vi.fn(async () => ({ ok: true, planRows: 1 }));
    const result = guardTableAllowlist(sql, DEPS);
    expect(result.pass).toBe(false);
    const outcome = await guardSql(sql, { ...DEPS, explain });
    expect(outcome.ok).toBe(false);
    expect(outcome.report.find((stage) => !stage.pass)?.stage).toBe("table-allowlist");
    expect(explain).not.toHaveBeenCalled();
  });

  it.each([
    "SELECT * FROM records a, other_records b",
    "SELECT * FROM ds_a.records a, ds_a.other_records b",
    'SELECT "from".id FROM "ds_a"."records" AS "from", "ds_a"."other_records" b',
    "SELECT coalesce(a.id, 0), a.id FROM records a",
    "SELECT EXTRACT(MONTH FROM created_at) FROM records",
    "SELECT id FROM records WHERE id IS DISTINCT FROM 2",
    "SELECT 'FROM ds_b.records, evil' AS note FROM records",
    "SELECT $tag$FROM ds_b.records, evil$tag$ AS note FROM records",
    "SELECT (SELECT count(*) FROM other_records) AS n FROM records",
    "SELECT * FROM (SELECT * FROM ds_a.records) nested, ds_a.other_records b",
    "WITH chosen AS (SELECT * FROM ds_a.records) SELECT * FROM chosen",
    'WITH "chosen"(id) AS (SELECT id FROM "ds_a"."records") SELECT * FROM "chosen"',
    "WITH chosen AS NOT MATERIALIZED (SELECT * FROM records) SELECT * FROM chosen",
    "WITH first AS (SELECT * FROM records), second AS (SELECT * FROM first) SELECT * FROM second",
    "WITH RECURSIVE chosen AS (SELECT id FROM records UNION ALL SELECT id FROM chosen) SELECT * FROM chosen",
    "WITH records AS (SELECT * FROM ds_a.records) SELECT * FROM records",
    "SELECT a.id FROM records a WHERE EXISTS (SELECT 1 FROM other_records b WHERE b.id=a.id)",
    "SELECT * FROM (VALUES (1)) AS constants(id), records",
  ])("accepts dataset sources and scoped CTEs: %s", (sql) => {
    expect(guardTableAllowlist(sql, DEPS).pass).toBe(true);
  });

  it("preserves commas, dots and escaped quotes inside quoted identifiers", () => {
    expect(guardTableAllowlist(
      'SELECT * FROM "ds_a"."records,items" a, "ds_a"."a""b" b, "ds_a"."a.b" c',
      { schemaName: "ds_a", tableNames: ["records,items", 'a"b', "a.b"] },
    ).pass).toBe(true);
  });

  it.each([
    'SELECT * FROM "ds_a"."records',
    "SELECT * FROM (SELECT * FROM records",
    "SELECT * FROM records,",
    "SELECT * FROM records /* unclosed",
  ])("fails closed for malformed relation syntax: %s", (sql) => {
    expect(guardTableAllowlist(sql, DEPS).pass).toBe(false);
  });
});
