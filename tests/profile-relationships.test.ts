import { describe, expect, it } from "vitest";
import { sanitizeHeaders } from "@/lib/ingest/headers";
import { profileTable, type ColumnProfile } from "@/lib/ingest/profile";
import { detectRelationships } from "@/lib/ingest/relationships";

function profile(headers: string[], rows: string[][]) {
  return profileTable(sanitizeHeaders(headers), rows);
}

describe("profileTable", () => {
  it("marks candidate keys: distinct == row count and no nulls", () => {
    const p = profile(
      ["id", "name"],
      [
        ["1", "a"],
        ["2", "b"],
        ["3", "c"],
      ],
    );
    expect(p.columns[0]?.isCandidateKey).toBe(true);
    expect(p.columns[1]?.isCandidateKey).toBe(true);
  });

  it("no candidate key when there are duplicates or nulls", () => {
    const dup = profile(
      ["id"],
      [
        ["1"],
        ["1"],
      ],
    );
    expect(dup.columns[0]?.isCandidateKey).toBe(false);
    const nul = profile(
      ["id"],
      [
        ["1"],
        ["NA"],
      ],
    );
    expect(nul.columns[0]?.isCandidateKey).toBe(false);
  });

  it("computes null_pct, distinct, coercion, min/max", () => {
    const p = profile(
      ["score"],
      [["10"], ["20"], ["NA"], ["oops"]],
    );
    const c = p.columns[0]!;
    expect(c.nullPct).toBe(25);
    expect(c.distinctCount).toBe(3);
    // 2 of 3 non-null parse (66% < 95%) -> text, so no coercion
    expect(c.dataType).toBe("text");

    const numeric = profile(
      ["score"],
      [
        ...Array.from({ length: 19 }, (_, i) => [String(i + 1)]),
        ["oops"],
      ],
    );
    const nc = numeric.columns[0]!;
    expect(nc.dataType).toBe("integer");
    expect(nc.coercedCount).toBe(1);
    expect(nc.minValue).toBe("1");
    expect(nc.maxValue).toBe("19");
  });

  it("captures top values for text and samples", () => {
    const values = [
      ...Array(5).fill("red"),
      ...Array(3).fill("blue"),
      "green",
    ].map((v) => [v]);
    const p = profile(["color"], values);
    const c = p.columns[0]!;
    expect(c.topValues[0]).toEqual({ value: "red", count: 5 });
    expect(c.topValues[1]).toEqual({ value: "blue", count: 3 });
    expect(c.sampleValues.length).toBeGreaterThan(0);
    expect(c.sampleValues.length).toBeLessThanOrEqual(5);
  });
});

function col(partial: Partial<ColumnProfile>): ColumnProfile {
  return {
    ordinal: 0,
    columnName: "id",
    originalHeader: "id",
    dataType: "integer",
    dateFormat: null,
    isPercent: false,
    isCandidateKey: false,
    rowCount: 0,
    nullCount: 0,
    nullPct: 0,
    distinctCount: 0,
    coercedCount: 0,
    minValue: null,
    maxValue: null,
    topValues: [],
    sampleValues: [],
    distinctValues: null,
    ...partial,
  };
}

describe("detectRelationships", () => {
  const customers = {
    tableName: "customers",
    columns: [
      col({
        columnName: "id",
        isCandidateKey: true,
        distinctCount: 3,
        distinctValues: ["1", "2", "3"],
      }),
    ],
  };

  it("links orders.customer_id -> customers.id at >= 90% overlap", () => {
    const orders = {
      tableName: "orders",
      columns: [
        col({
          columnName: "customer_id",
          distinctValues: ["1", "2", "3"],
        }),
      ],
    };
    const rels = detectRelationships([orders, customers]);
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({
      fromTable: "orders",
      fromColumn: "customer_id",
      toTable: "customers",
      toColumn: "id",
      overlap: 1,
      method: "name+overlap",
    });
  });

  it("rejects below-90% overlap", () => {
    const orders = {
      tableName: "orders",
      columns: [
        col({
          columnName: "customer_id",
          distinctValues: ["1", "2", "3", "99", "98", "97", "96", "95", "94", "93"],
        }),
      ],
    };
    expect(detectRelationships([orders, customers])).toHaveLength(0);
  });

  it("matches identical column names", () => {
    const details = {
      tableName: "order_details",
      columns: [
        col({
          columnName: "order_id",
          distinctValues: ["10", "11"],
        }),
      ],
    };
    const orders = {
      tableName: "orders",
      columns: [
        col({
          columnName: "order_id",
          isCandidateKey: true,
          distinctValues: ["10", "11", "12"],
          distinctCount: 3,
        }),
      ],
    };
    const rels = detectRelationships([details, orders]);
    expect(rels[0]).toMatchObject({
      fromTable: "order_details",
      fromColumn: "order_id",
      toTable: "orders",
      toColumn: "order_id",
    });
  });

  it("requires compatible types", () => {
    const orders = {
      tableName: "orders",
      columns: [
        col({
          columnName: "customer_id",
          dataType: "text",
          distinctValues: ["1", "2", "3"],
        }),
      ],
    };
    expect(detectRelationships([orders, customers])).toHaveLength(0);
  });
});
