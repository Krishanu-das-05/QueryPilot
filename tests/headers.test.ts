import { describe, expect, it } from "vitest";
import { sanitizeHeaders } from "@/lib/ingest/headers";

describe("sanitizeHeaders", () => {
  it("snake_cases and strips symbols", () => {
    expect(sanitizeHeaders(["Order ID", "Sales ($)", "Ship-Date!"]))
      .toEqual([
        { name: "order_id", original: "Order ID" },
        { name: "sales", original: "Sales ($)" },
        { name: "ship_date", original: "Ship-Date!" },
      ]);
  });

  it("prefixes c_ when a name starts with a digit", () => {
    expect(sanitizeHeaders(["2024 Revenue"])[0]?.name).toBe("c_2024_revenue");
  });

  it("dedupes with _2, _3", () => {
    const out = sanitizeHeaders(["Customer Name", "Customer Name", "customer name"]);
    expect(out.map((h) => h.name)).toEqual([
      "customer_name",
      "customer_name_2",
      "customer_name_3",
    ]);
  });

  it("suffixes _col on SQL reserved words", () => {
    const out = sanitizeHeaders(["order", "SELECT", "User", "table"]);
    expect(out.map((h) => h.name)).toEqual([
      "order_col",
      "select_col",
      "user_col",
      "table_col",
    ]);
  });

  it("falls back to 'column' for empty/symbol-only headers", () => {
    expect(sanitizeHeaders([""])[0]?.name).toBe("column");
    expect(sanitizeHeaders(["!!!"])[0]?.name).toBe("column");
  });

  it("truncates to 63 characters", () => {
    const [h] = sanitizeHeaders(["a".repeat(100)]);
    expect(h?.name.length).toBe(63);
  });

  it("keeps truncated dedupes within 63 characters", () => {
    const long = "b".repeat(62) + " 1";
    const out = sanitizeHeaders([long, long]);
    expect(out[0]?.name.length).toBeLessThanOrEqual(63);
    expect(out[1]?.name.length).toBeLessThanOrEqual(63);
    expect(out[0]?.name).not.toBe(out[1]?.name);
  });

  it("keeps the original header untouched", () => {
    const out = sanitizeHeaders(["  Weird Header 😀 "]);
    expect(out[0]?.original).toBe("  Weird Header 😀 ");
  });
});
