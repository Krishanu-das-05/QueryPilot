import { isNullToken } from "./nulls";
import { coerceValue, inferType, type ColumnType } from "./types";

export interface TopValue {
  value: string;
  count: number;
}

export interface ColumnProfile {
  ordinal: number;
  columnName: string;
  originalHeader: string;
  dataType: ColumnType;
  dateFormat: string | null;
  isPercent: boolean;
  isCandidateKey: boolean;
  rowCount: number;
  nullCount: number;
  nullPct: number;
  distinctCount: number;
  coercedCount: number;
  minValue: string | null;
  maxValue: string | null;
  topValues: TopValue[];
  sampleValues: string[];
  /** Distinct canonical values, capped; used for relationship detection. */
  distinctValues: string[] | null;
}

const TOP_VALUES_LIMIT = 10;
const SAMPLES_LIMIT = 5;
const DISTINCT_CAP = 5000;

export interface TableProfile {
  columns: ColumnProfile[];
  rowCount: number;
}

function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a, (c) => c.codePointAt(0) ?? 0);
  const right = Array.from(b, (c) => c.codePointAt(0) ?? 0);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/**
 * Profile one parsed table. `rows` are raw string cells (already decoded).
 * Pure function — unit-testable without a database.
 */
export function profileTable(
  sanitizedColumns: { name: string; original: string }[],
  rows: string[][],
): TableProfile {
  const rowCount = rows.length;
  const columns: ColumnProfile[] = sanitizedColumns.map((col, ordinal) => {
    const rawValues = rows.map((r) => r[ordinal] ?? "");
    const nonNull: { raw: string; trimmed: string }[] = [];
    let nullCount = 0;
    for (const raw of rawValues) {
      if (isNullToken(raw)) {
        nullCount += 1;
      } else {
        nonNull.push({ raw, trimmed: raw.trim() });
      }
    }

    const inferred = inferType(nonNull.map((v) => v.trimmed));

    // Coerce every non-null value; failures become NULL and count as coerced.
    const canonical: string[] = [];
    let coercedCount = 0;
    for (const { trimmed } of nonNull) {
      const c = coerceValue(trimmed, inferred.type, inferred.dateFormat);
      if (!c.ok) {
        coercedCount += 1;
      } else if (c.value !== null) {
        canonical.push(c.value);
      }
    }

    // distinct + top values
    const counts = new Map<string, { count: number; sample: string }>();
    for (let i = 0; i < canonical.length; i += 1) {
      const v = canonical[i];
      if (v === undefined) continue;
      const entry = counts.get(v);
      if (entry) {
        entry.count += 1;
      } else {
        counts.set(v, { count: 1, sample: nonNull[i]?.trimmed ?? v });
      }
    }
    const distinctCount = counts.size;

    let minValue: string | null = null;
    let maxValue: string | null = null;
    let topValues: TopValue[] = [];
    if (inferred.type === "integer" || inferred.type === "decimal") {
      const nums = canonical.map(Number);
      if (nums.length > 0) {
        minValue = String(Math.min(...nums));
        maxValue = String(Math.max(...nums));
      }
    } else if (inferred.type === "date" || inferred.type === "timestamp") {
      const sorted = [...canonical].sort();
      minValue = sorted[0] ?? null;
      maxValue = sorted[sorted.length - 1] ?? null;
    } else if (inferred.type === "text") {
      topValues = [...counts.entries()]
        .sort((a, b) => b[1].count - a[1].count || compareCodePoints(a[0], b[0]))
        .slice(0, TOP_VALUES_LIMIT)
        .map(([value, { count }]) => ({ value, count }));
    }

    const sampleValues: string[] = [];
    const seenSamples = new Set<string>();
    for (const { trimmed } of nonNull) {
      const key = trimmed.slice(0, 200);
      if (!seenSamples.has(key)) {
        seenSamples.add(key);
        sampleValues.push(key);
        if (sampleValues.length >= SAMPLES_LIMIT) break;
      }
    }

    const distinctValues =
      distinctCount <= DISTINCT_CAP ? [...counts.keys()] : null;

    return {
      ordinal,
      columnName: col.name,
      originalHeader: col.original,
      dataType: inferred.type,
      dateFormat: inferred.dateFormat,
      isPercent: inferred.isPercent,
      isCandidateKey: rowCount > 0 && nullCount === 0 && distinctCount === rowCount,
      rowCount,
      nullCount,
      nullPct: rowCount === 0 ? 0 : Math.round((nullCount / rowCount) * 10000) / 100,
      distinctCount,
      coercedCount,
      minValue,
      maxValue,
      topValues,
      sampleValues,
      distinctValues,
    };
  });

  return { columns, rowCount };
}
