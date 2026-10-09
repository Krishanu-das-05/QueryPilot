export const NULL_TOKENS: readonly string[] = [
  "",
  "-",
  "--",
  "na",
  "n/a",
  "null",
  "none",
  "nil",
  "#n/a",
];

const NULL_SET = new Set(NULL_TOKENS);

/** Case-insensitive, trimmed null-token check. */
export function isNullToken(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  return NULL_SET.has(value.trim().toLowerCase());
}
