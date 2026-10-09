export interface ParsedNumber {
  value: number;
  isPercent: boolean;
  isInteger: boolean;
}

/**
 * Parse a human-formatted number:
 * - currency symbols/codes stripped: ₹ $ € £ "Rs." "INR" (case-insensitive)
 * - spaces and commas stripped (handles Indian grouping like 1,00,000)
 * - "(1,200)" is negative: -1200
 * - "12%" becomes 0.12 and is flagged as a percent
 * Returns null when the value is not numeric.
 */
export function parseNumber(raw: string): ParsedNumber | null {
  let s = raw.trim();

  let negative = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren && paren[1] !== undefined) {
    negative = true;
    s = paren[1].trim();
  }

  // currency codes first (before stripping symbols), then symbols
  s = s
    .replace(/(?:rs\.?|inr)/gi, "")
    .replace(/[₹$€£]/g, "")
    .replace(/[,\s]/g, "")
    .trim();

  let isPercent = false;
  if (s.endsWith("%")) {
    isPercent = true;
    s = s.slice(0, -1).trim();
  }

  if (!/^[+-]?(?:\d+|\d*\.\d+)$/.test(s)) return null;

  let value = Number(s);
  if (!Number.isFinite(value)) return null;
  if (negative) value = -value;
  if (isPercent) value = value / 100;

  return { value, isPercent, isInteger: Number.isInteger(value) };
}
