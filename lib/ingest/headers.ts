const RESERVED_WORDS = new Set([
  "all", "analyse", "analyze", "and", "any", "array", "as", "asc",
  "asymmetric", "both", "case", "cast", "check", "collate", "column",
  "constraint", "create", "current_catalog", "current_date",
  "current_role", "current_time", "current_timestamp", "current_user",
  "default", "deferrable", "desc", "distinct", "do", "else", "end",
  "except", "false", "fetch", "for", "foreign", "from", "grant", "group",
  "having", "in", "initially", "intersect", "into", "lateral", "leading",
  "limit", "localtime", "localtimestamp", "not", "null", "offset", "on",
  "only", "or", "order", "placing", "primary", "references", "returning",
  "select", "session_user", "some", "symmetric", "table", "then", "to",
  "trailing", "true", "union", "unique", "user", "using", "variadic",
  "when", "where", "window", "with",
]);

const MAX_LEN = 63;

export interface SanitizedHeader {
  name: string;
  original: string;
}

function sanitizeOne(raw: string): string {
  let s = raw.trim().toLowerCase();
  // any run of non-alphanumeric characters collapses to a single underscore
  s = s.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (/^[0-9]/.test(s)) s = `c_${s}`;
  if (RESERVED_WORDS.has(s)) s = `${s}_col`;
  if (s === "") s = "column";
  return s.slice(0, MAX_LEN);
}

/**
 * Sanitize raw file headers into safe Postgres column names:
 * snake_case, symbols stripped, `c_` prefix for numeric-leading names,
 * `_col` suffix on SQL reserved words, max 63 chars, deduped with _2, _3...
 * The original header is always kept alongside.
 */
export function sanitizeHeaders(rawHeaders: string[]): SanitizedHeader[] {
  const used = new Map<string, number>();
  return rawHeaders.map((raw) => {
    const base = sanitizeOne(raw);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    let name = base;
    if (seen > 0) {
      let suffix = seen + 1;
      name = `${base.slice(0, MAX_LEN - String(suffix).length - 1)}_${suffix}`;
      while (used.has(name)) {
        suffix += 1;
        name = `${base.slice(0, MAX_LEN - String(suffix).length - 1)}_${suffix}`;
      }
      used.set(name, 1);
    }
    return { name, original: raw };
  });
}
