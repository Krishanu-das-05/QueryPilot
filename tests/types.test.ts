import { describe, expect, it } from "vitest";
import { coerceValue, inferType } from "@/lib/ingest/types";

describe("inferType", () => {
  it("detects boolean word columns", () => {
    expect(inferType(["yes", "no", "YES", "No"]).type).toBe("boolean");
    expect(inferType(["true", "false", "TRUE"]).type).toBe("boolean");
    expect(inferType(["y", "n", "Y"]).type).toBe("boolean");
  });

  it("treats a pure 1/0 column as boolean only when it contains nothing else", () => {
    expect(inferType(["1", "0", "1", "0"]).type).toBe("boolean");
    expect(inferType(["0", "1", "2", "5", "1"]).type).toBe("integer");
  });

  it("detects integers and decimals", () => {
    expect(inferType(["1", "2", "300"]).type).toBe("integer");
    expect(inferType(["1.5", "2", "3.25"]).type).toBe("decimal");
  });

  it("flags percent columns", () => {
    const r = inferType(["12%", "8.5%", "20%"]);
    expect(r.type).toBe("decimal");
    expect(r.isPercent).toBe(true);
  });

  it("retains the percent flag for whole normalized ratios", () => {
    const r = inferType(["0%", "100%"]);
    expect(r).toEqual({ type: "integer", isPercent: true, dateFormat: null });
    expect(coerceValue("0%", r.type, null).value).toBe("0");
    expect(coerceValue("100%", r.type, null).value).toBe("1");
  });

  it("keeps fractional percent ratios decimal", () => {
    expect(inferType(["0%", "50%", "100%"])).toEqual({
      type: "decimal", isPercent: true, dateFormat: null,
    });
  });

  it("does not flag mostly plain integer values as a percent column", () => {
    expect(inferType(["10", "20", "100%"])).toEqual({
      type: "integer", isPercent: false, dateFormat: null,
    });
  });

  it("detects dates with formats", () => {
    const r = inferType(["2024-01-15", "2024-02-20"]);
    expect(r.type).toBe("date");
    expect(r.dateFormat).toBe("yyyy-mm-dd");
    expect(inferType(["20/01/2024", "05/02/2024"]).dateFormat).toBe("dd/mm/yyyy");
    expect(inferType(["22-Jan-2024", "15-Feb-2024"]).dateFormat).toBe("dd-Mon-yyyy");
  });

  it("detects timestamps", () => {
    expect(inferType(["2024-01-15 09:30:00", "2024-01-16 08:00:00"]).type).toBe(
      "timestamp",
    );
  });

  it("applies the 95% threshold", () => {
    // 96% numeric -> integer wins with 2 coerced later
    const mostly = [...Array(96).fill("42"), "oops", "bad"];
    expect(inferType(mostly).type).toBe("integer");
    // 94% numeric -> not enough -> text
    const notEnough = [...Array(94).fill("42"), ...Array(6).fill("oops")];
    expect(inferType(notEnough).type).toBe("text");
  });

  it("falls back to text", () => {
    expect(inferType(["Acme Corp", "Beta Ltd"]).type).toBe("text");
    expect(inferType([]).type).toBe("text");
  });
});

describe("coerceValue", () => {
  it("maps null tokens to NULL", () => {
    expect(coerceValue("NA", "integer", null)).toEqual({ ok: true, value: null });
  });

  it("normalizes booleans", () => {
    expect(coerceValue("YES", "boolean", null).value).toBe("true");
    expect(coerceValue("0", "boolean", null).value).toBe("false");
  });

  it("normalizes dates using the detected format", () => {
    expect(coerceValue("05/01/2024", "date", "dd/mm/yyyy").value).toBe("2024-01-05");
    expect(coerceValue("01/13/2024", "date", "mm/dd/yyyy").value).toBe("2024-01-13");
  });

  it("fails cleanly on unparseable typed values", () => {
    expect(coerceValue("oops", "integer", null)).toEqual({ ok: false, value: null });
    expect(coerceValue("not a date", "date", "yyyy-mm-dd").ok).toBe(false);
  });
});
