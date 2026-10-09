export const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

export interface ParsedDateTime {
  /** Canonical ISO value: yyyy-mm-dd, or yyyy-mm-ddThh:mm[:ss] for timestamps. */
  iso: string;
  /** Human-readable format name, e.g. "dd/mm/yyyy", "dd-Mon-yyyy hh:mm:ss". */
  format: string;
  hasTime: boolean;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1000 || y > 9999) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

function build(y: number, m: number, d: number): string | null {
  return isRealDate(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
}

function parseTime(
  raw: string,
): { time: string; formatSuffix: string } | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(
    raw.trim(),
  );
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] !== undefined ? Number(m[3]) : null;
  if (h > 23 || min > 59 || (sec !== null && sec > 59)) return null;
  const time = sec === null ? `${pad(h)}:${pad(min)}` : `${pad(h)}:${pad(min)}:${pad(sec)}`;
  return { time, formatSuffix: sec === null ? "hh:mm" : "hh:mm:ss" };
}

/**
 * Parse one date (or timestamp) value.
 * `preferMdY` implements the ambiguity rule at the column level: the caller
 * sets it when SOME value in the column has a second component > 12, proving
 * the column is month-first. Alone, a value defaults to dd/mm.
 */
export function parseDateValue(raw: string, preferMdY = false): ParsedDateTime | null {
  const s0 = raw.trim();
  if (s0 === "") return null;

  // split optional time component (separator: space or T)
  let datePart = s0;
  let timePart: { time: string; formatSuffix: string } | null = null;
  const timeSplit = /^(.+?)[T ](\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)$/.exec(s0);
  if (timeSplit && timeSplit[1] !== undefined && timeSplit[2] !== undefined) {
    datePart = timeSplit[1];
    timePart = parseTime(timeSplit[2]);
    if (timePart === null) return null;
  }
  const s = datePart.trim();

  let iso: string | null = null;
  let format: string | null = null;

  // yyyy-mm-dd
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m && m[1] && m[2] && m[3]) {
    iso = build(Number(m[1]), Number(m[2]), Number(m[3]));
    format = "yyyy-mm-dd";
  }

  // nn/nn/nnnn or nn-nn-nnnn (ambiguous day/month order)
  if (iso === null) {
    m = /^(\d{1,2})([/-])(\d{1,2})\2(\d{4})$/.exec(s);
    if (m && m[1] && m[2] && m[3] && m[4]) {
      const a = Number(m[1]);
      const b = Number(m[3]);
      const y = Number(m[4]);
      const sep = m[2];
      const day = preferMdY ? b : a;
      const month = preferMdY ? a : b;
      iso = build(y, month, day);
      format = preferMdY ? `mm${sep}dd${sep}yyyy` : `dd${sep}mm${sep}yyyy`;
    }
  }

  // dd-Mon-yyyy / dd/Mon/yyyy / dd Mon yyyy
  if (iso === null) {
    const withSep = /^(\d{1,2})([/-])([A-Za-z]+)\2(\d{4})$/.exec(s);
    const withSpace = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(s);
    const dayS = withSep?.[1] ?? withSpace?.[1];
    const monS = withSep?.[3] ?? withSpace?.[2];
    const yearS = withSep?.[4] ?? withSpace?.[3];
    const sep = withSep?.[2] ?? " ";
    if (dayS && monS && yearS) {
      const month = MONTHS[monS.toLowerCase()];
      if (month !== undefined) {
        iso = build(Number(yearS), month, Number(dayS));
        format = `dd${sep}Mon${sep}yyyy`;
      }
    }
  }

  if (iso === null || format === null) return null;
  if (timePart !== null) {
    return {
      iso: `${iso}T${timePart.time}`,
      format: `${format} ${timePart.formatSuffix}`,
      hasTime: true,
    };
  }
  return { iso, format, hasTime: false };
}

export interface DetectedDate {
  type: "date" | "timestamp";
  format: string;
}

/**
 * Detect the column-level date format from samples, applying the ambiguity
 * rule: default dd/mm, switch the whole column to mm/dd only if some value's
 * second component is > 12. Returns null when values are not dates.
 */
export function detectDateType(values: string[]): DetectedDate | null {
  if (values.length === 0) return null;

  let mdY = false;
  for (const v of values) {
    const datePart = v.trim().split(/[T ]/)[0] ?? "";
    const m = /^(\d{1,2})[/-](\d{1,2})[/-]\d{4}$/.exec(datePart);
    if (m && m[1] && m[2] && Number(m[1]) <= 12 && Number(m[2]) > 12) {
      mdY = true;
      break;
    }
  }

  let sawTime = false;
  const formats = new Map<string, number>();
  let parsed = 0;
  for (const v of values) {
    const p = parseDateValue(v, mdY);
    if (p === null) continue;
    parsed += 1;
    if (p.hasTime) sawTime = true;
    formats.set(p.format, (formats.get(p.format) ?? 0) + 1);
  }
  if (parsed === 0) return null;

  let bestFormat = "";
  let bestCount = -1;
  for (const [f, c] of formats) {
    if (c > bestCount) {
      bestFormat = f;
      bestCount = c;
    }
  }
  return { type: sawTime ? "timestamp" : "date", format: bestFormat };
}
