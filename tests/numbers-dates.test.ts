import { describe, expect, it } from "vitest";
import { detectDateType, parseDateValue } from "@/lib/ingest/dates";
import { isNullToken } from "@/lib/ingest/nulls";
import { parseNumber } from "@/lib/ingest/numbers";

describe("isNullToken", () => {
  it("accepts every junk token, case-insensitive and trimmed", () => {
    for (const t of ["", "-", "--", "na", "n/a", "null", "none", "nil", "#n/a"]) {
      expect(isNullToken(t), t).toBe(true);
    }
    expect(isNullToken(" NA ")).toBe(true);
    expect(isNullToken("N/A")).toBe(true);
    expect(isNullToken("Null")).toBe(true);
    expect(isNullToken(null)).toBe(true);
  });

  it("rejects real values", () => {
    for (const t of ["0", "-5", "navy", "numbers", "nulla"]) {
      expect(isNullToken(t), t).toBe(false);
    }
  });
});

describe("parseNumber", () => {
  it("handles currency symbols and codes", () => {
    expect(parseNumber("₹1,00,000")?.value).toBe(100000);
    expect(parseNumber("Rs. 2,50,000")?.value).toBe(250000);
    expect(parseNumber("INR 75,000")?.value).toBe(75000);
    expect(parseNumber("$1,234.56")?.value).toBe(1234.56);
    expect(parseNumber("€500")?.value).toBe(500);
    expect(parseNumber("£9.99")?.value).toBe(9.99);
  });

  it("handles Indian comma grouping", () => {
    expect(parseNumber("1,00,000")?.value).toBe(100000);
    expect(parseNumber("12,34,567")?.value).toBe(1234567);
    expect(parseNumber("1,234")?.value).toBe(1234);
  });

  it("parses parentheses as negative", () => {
    expect(parseNumber("(1,200)")).toEqual({
      value: -1200,
      isPercent: false,
      isInteger: true,
    });
    expect(parseNumber("(₹500)")?.value).toBe(-500);
  });

  it("parses percents into fractions and flags them", () => {
    expect(parseNumber("12%")).toEqual({ value: 0.12, isPercent: true, isInteger: false });
    expect(parseNumber("50%")?.value).toBe(0.5);
    expect(parseNumber("-5%")?.value).toBe(-0.05);
  });

  it("rejects non-numbers", () => {
    expect(parseNumber("abc")).toBeNull();
    expect(parseNumber("12x")).toBeNull();
    expect(parseNumber("2024-01-01")).toBeNull();
  });

  it("marks integers vs decimals", () => {
    expect(parseNumber("42")?.isInteger).toBe(true);
    expect(parseNumber("42.5")?.isInteger).toBe(false);
  });
});

describe("parseDateValue", () => {
  it("parses yyyy-mm-dd", () => {
    expect(parseDateValue("2024-03-15")?.iso).toBe("2024-03-15");
  });

  it("defaults ambiguous d/m to dd/mm", () => {
    expect(parseDateValue("05/01/2024")?.iso).toBe("2024-01-05");
    expect(parseDateValue("05-01-2024")?.format).toBe("dd-mm-yyyy");
  });

  it("parses unambiguous dd/mm", () => {
    expect(parseDateValue("20/01/2024")?.iso).toBe("2024-01-20");
  });

  it("parses mm/dd when preferMdY is set", () => {
    expect(parseDateValue("01/05/2024", true)?.iso).toBe("2024-01-05");
    expect(parseDateValue("12/25/2024", true)?.format).toBe("mm/dd/yyyy");
  });

  it("parses dd-Mon-yyyy and dd Mon yyyy", () => {
    expect(parseDateValue("22-Jan-2024")?.iso).toBe("2024-01-22");
    expect(parseDateValue("22-Jan-2024")?.format).toBe("dd-Mon-yyyy");
    expect(parseDateValue("4 March 2024")?.iso).toBe("2024-03-04");
  });

  it("parses timestamps", () => {
    const p = parseDateValue("2024-01-15 09:30:00");
    expect(p?.hasTime).toBe(true);
    expect(p?.iso).toBe("2024-01-15T09:30:00");
  });

  it("rejects impossible dates", () => {
    expect(parseDateValue("31/02/2024")).toBeNull();
    expect(parseDateValue("2024-13-01")).toBeNull();
  });
});

describe("detectDateType ambiguity rule", () => {
  it("defaults a fully ambiguous column to dd/mm", () => {
    const d = detectDateType(["05/01/2024", "06/02/2024", "07/03/2024"]);
    expect(d?.type).toBe("date");
    expect(d?.format).toBe("dd/mm/yyyy");
  });

  it("switches to mm/dd only when some value's second part > 12", () => {
    const d = detectDateType(["01/13/2024", "05/06/2024"]);
    expect(d?.format).toBe("mm/dd/yyyy");
  });

  it("keeps dd/mm when values prove day-first", () => {
    const d = detectDateType(["20/01/2024", "05/02/2024"]);
    expect(d?.format).toBe("dd/mm/yyyy");
  });

  it("detects timestamps", () => {
    const d = detectDateType(["2024-01-15 09:30:00", "2024-01-16 10:00:00"]);
    expect(d?.type).toBe("timestamp");
  });
});
