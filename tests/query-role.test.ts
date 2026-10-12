import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAsQueryRole, explainAsQueryRole } from "@/lib/agent/deps";
import { guardSql } from "@/lib/agent/guard";

const db = vi.hoisted(() => {
  const noRows = (): unknown[] => [];
  const state: {
    calls: string[];
    modes: string[];
    respond: (text: string) => unknown[];
  } = { calls: [], modes: [], respond: noRows };
  return state;
});

vi.mock("postgres", () => {
  const tx = {
    unsafe: async (text: string) => {
      db.calls.push(text);
      return db.respond(text);
    },
  };
  const sql = {
    begin: async (mode: string, fn: (t: typeof tx) => Promise<unknown>) => {
      db.modes.push(mode);
      return fn(tx);
    },
  };
  return { default: () => sql };
});

function planRows(rows: number): unknown[] {
  return [{ "QUERY PLAN": [{ Plan: { "Plan Rows": rows } }] }];
}

function dbError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

beforeEach(() => {
  vi.stubEnv("DATABASE_URL_QUERY", "postgres://qp_query@example.invalid/db");
  db.calls = [];
  db.modes = [];
  db.respond = () => [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("explainAsQueryRole", () => {
  it("returns the planner row estimate captured before the rollback", async () => {
    db.respond = (text) => (text.startsWith("EXPLAIN") ? planRows(250001) : []);
    const result = await explainAsQueryRole("ds_a", "ds_a_r", 'SELECT 1 FROM "ds_a"."orders"');
    expect(result).toEqual({ ok: true, planRows: 250001 });
    expect(db.modes).toEqual(["read only"]);
  });

  it("the cost guard rejects a planner estimate above the cap", async () => {
    db.respond = (text) => (text.startsWith("EXPLAIN") ? planRows(250001) : []);
    const outcome = await guardSql('SELECT * FROM "ds_a"."orders"', {
      schemaName: "ds_a",
      tableNames: ["orders"],
      explain: (q) => explainAsQueryRole("ds_a", "ds_a_r", q),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.report).toContainEqual({
      stage: "cost",
      pass: false,
      reason: "too-expensive:est-250001-rows",
    });
  });

  it("sets role, timeout and search_path before EXPLAIN, in that order", async () => {
    db.respond = (text) => (text.startsWith("EXPLAIN") ? planRows(1) : []);
    await explainAsQueryRole("ds_a", "ds_a_r", "SELECT 1");
    expect(db.calls).toEqual([
      'SET LOCAL ROLE "ds_a_r"',
      "SET LOCAL statement_timeout = '5s'",
      'SET LOCAL search_path = "ds_a"',
      "EXPLAIN (FORMAT JSON) SELECT 1",
    ]);
  });

  it("escapes double quotes in role and schema identifiers", async () => {
    db.respond = (text) => (text.startsWith("EXPLAIN") ? planRows(1) : []);
    await explainAsQueryRole('ds_a"x', 'ds_a"b_r', "SELECT 1");
    expect(db.calls[0]).toBe('SET LOCAL ROLE "ds_a""b_r"');
    expect(db.calls[2]).toBe('SET LOCAL search_path = "ds_a""x"');
  });

  it.each([
    ["42P01", "unknown identifier"],
    ["42703", "unknown identifier"],
    ["42601", "syntax error"],
    ["42501", "permission denied"],
    ["57014", "query timed out"],
    ["42804", "type mismatch"],
    ["42883", "type mismatch"],
    ["22P02", "type mismatch"],
    ["XX000", "query failed"],
  ])("maps SQLSTATE %s to a safe message with no raw text", async (code, safe) => {
    db.respond = (text) => {
      if (text.startsWith("EXPLAIN")) throw dbError(code, "FAKE-KEY-FOR-TESTING leaked detail");
      return [];
    };
    const result = await explainAsQueryRole("ds_a", "ds_a_r", "SELECT broken");
    expect(result).toEqual({ ok: false, error: safe });
    expect(JSON.stringify(result)).not.toContain("FAKE-KEY-FOR-TESTING");
  });
});

describe("executeAsQueryRole", () => {
  it("returns the rows captured before the rollback", async () => {
    db.respond = (text) => (text === "SELECT 1 AS n" ? [{ n: 1 }] : []);
    const result = await executeAsQueryRole("ds_a", "ds_a_r", "SELECT 1 AS n");
    expect(result).toMatchObject({ columns: ["n"], rows: [[1]], truncated: false });
    expect(db.calls.at(-1)).toBe("SELECT 1 AS n");
    expect(db.modes).toEqual(["read only"]);
  });

  it("rethrows execution failures as a sanitized error without a raw cause", async () => {
    db.respond = (text) => {
      if (text === "SELECT broken") throw dbError("42601", "FAKE-KEY-FOR-TESTING syntax detail");
      return [];
    };
    let caught: unknown;
    try {
      await executeAsQueryRole("ds_a", "ds_a_r", "SELECT broken");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("syntax error");
    expect((caught as Error).cause).toBeUndefined();
    expect(String(caught)).not.toContain("FAKE-KEY-FOR-TESTING");
  });
});
