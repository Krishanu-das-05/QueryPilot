/**
 * Derive a safe Postgres table name from a file name (no sanitization of
 * user input into SQL happens anywhere — this produces a lowercase
 * snake_case identifier reserved words cannot collide with).
 */
export function tableNameForFile(
  originalName: string,
  taken: ReadonlySet<string>,
): string {
  const base = originalName.replace(/\.(csv|xlsx)$/i, "");
  let s = base.trim().toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (s === "") s = "table";
  if (/^[0-9]/.test(s)) s = `t_${s}`;
  s = s.slice(0, 63);
  let candidate = s;
  let i = 2;
  while (taken.has(candidate)) {
    const suffix = `_${i}`;
    candidate = `${s.slice(0, 63 - suffix.length)}${suffix}`;
    i += 1;
  }
  return candidate;
}
