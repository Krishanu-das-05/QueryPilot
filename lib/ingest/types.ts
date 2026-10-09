import { detectDateType, parseDateValue } from "./dates";
import { isNullToken } from "./nulls";
import { parseNumber } from "./numbers";

export const COLUMN_TYPES = [
  "boolean",
  "integer",
  "decimal",
  "date",
  "timestamp",
  "text",
] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export interface InferredType {
  type: ColumnType;
  isPercent: boolean;
  dateFormat: string | null;
}

const TYPE_THRESHOLD = 0.95;
const SAMPLE_SIZE = 1000;

const BOOL_WORDS = new Set(["true", "false", "yes", "no", "y", "n"]);

/** Deterministic, evenly spaced sample of up to n values. */
export function sampleValues<T>(values: T[], n = SAMPLE_SIZE): T[] {
  if (values.length <= n) return values;
  const result: T[] = [];
  const stride = values.length / n;
  for (let i = 0; i < n; i += 1) {
    const v = values[Math.floor(i * stride)];
    if (v !== undefined) result.push(v);
  }
  return result;
}

/**
 * Infer the column type from up to 1,000 sampled NON-NULL values.
 * A type wins when >= 95% of the sample parses, tried in order:
 * boolean -> integer -> decimal -> date -> timestamp -> text.
 *
 * boolean: true/false, yes/no, y/n. A pure 1/0 column is boolean only when it
 * contains nothing else.
 */
export function inferType(nonNullValues: string[]): InferredType {
  const values = sampleValues(nonNullValues);
  if (values.length === 0) return { type: "text", isPercent: false, dateFormat: null };
  const n = values.length;

  // boolean
  const allZeroOne = values.every((v) => {
    const t = v.trim().toLowerCase();
    return t === "0" || t === "1";
  });
  const wordCount = values.filter((v) => BOOL_WORDS.has(v.trim().toLowerCase())).length;
  if (allZeroOne || wordCount / n >= TYPE_THRESHOLD) {
    return { type: "boolean", isPercent: false, dateFormat: null };
  }

  // integer / decimal
  let intCount = 0;
  const numbers = values.map((v) => parseNumber(v));
  let numCount = 0;
  let percentCount = 0;
  for (const p of numbers) {
    if (p !== null) {
      numCount += 1;
      if (p.isInteger) intCount += 1;
      if (p.isPercent) percentCount += 1;
    }
  }
  if (intCount / n >= TYPE_THRESHOLD) {
    return { type: "integer", isPercent: false, dateFormat: null };
  }
  if (numCount / n >= TYPE_THRESHOLD) {
    return {
      type: "decimal",
      isPercent: percentCount / numCount >= TYPE_THRESHOLD,
      dateFormat: null,
    };
  }

  // date / timestamp (detection applies the dd/mm vs mm/dd ambiguity rule)
  const detected = detectDateType(values);
  if (detected) {
    const parseCount = values.filter(
      (v) => parseDateValue(v, detected.format.startsWith("mm")) !== null,
    ).length;
    if (parseCount / n >= TYPE_THRESHOLD) {
      return {
        type: detected.type,
        isPercent: false,
        dateFormat: detected.format,
      };
    }
  }

  return { type: "text", isPercent: false, dateFormat: null };
}

export interface CoercedValue {
  ok: boolean;
  /** Canonical string form ready for SQL insert (null = SQL NULL). */
  value: string | null;
}

const BOOL_TRUE = new Set(["true", "yes", "y"]);
const BOOL_FALSE = new Set(["false", "no", "n"]);

/**
 * Coerce a single raw value to the canonical form for an inferred column
 * type. Null tokens always become NULL. Values that fail to parse in a typed
 * column become NULL and are counted as coerced (ok=false).
 */
export function coerceValue(
  raw: string,
  type: ColumnType,
  dateFormat: string | null,
): CoercedValue {
  if (isNullToken(raw)) return { ok: true, value: null };
  const s = raw.trim();

  switch (type) {
    case "boolean": {
      const t = s.toLowerCase();
      if (BOOL_TRUE.has(t)) return { ok: true, value: "true" };
      if (BOOL_FALSE.has(t)) return { ok: true, value: "false" };
      if (t === "1") return { ok: true, value: "true" };
      if (t === "0") return { ok: true, value: "false" };
      return { ok: false, value: null };
    }
    case "integer":
    case "decimal": {
      const p = parseNumber(s);
      if (p === null) return { ok: false, value: null };
      if (type === "integer" && !p.isInteger) return { ok: false, value: null };
      return { ok: true, value: String(p.value) };
    }
    case "date": {
      const mdY = dateFormat !== null && dateFormat.startsWith("mm");
      const p = parseDateValue(s, mdY);
      if (p === null || p.hasTime) return { ok: false, value: null };
      return { ok: true, value: p.iso };
    }
    case "timestamp": {
      const mdY = dateFormat !== null && dateFormat.startsWith("mm");
      const p = parseDateValue(s, mdY);
      if (p === null) return { ok: false, value: null };
      return { ok: true, value: p.hasTime ? p.iso : `${p.iso}T00:00` };
    }
    case "text":
      return { ok: true, value: s };
  }
}
