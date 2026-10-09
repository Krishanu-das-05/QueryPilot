import {
  containsKeyword,
  extractRelations,
  findLimit,
  splitStatements,
  stripCommentsAndStrings,
  stripTrailingSemicolon,
} from "./sql-text";

export const DENYLIST = [
  "insert", "update", "delete", "merge", "drop", "alter", "grant", "revoke",
  "copy", "do", "call", "execute", "truncate", "create", "comment", "listen",
  "notify", "unlisten", "pg_sleep", "lo_export", "lo_import", "set", "reset",
  "lock", "vacuum", "reindex", "cluster", "refresh", "prepare", "deallocate",
  "discard", "savepoint", "release", "security_barrier", "dblink",
] as const;

export const ROW_LIMIT = 1000;
export const COST_ROW_CAP = 200_000;

export interface GuardStageResult {
  stage: string;
  pass: boolean;
  reason?: string;
}

export interface GuardDeps {
  schemaName: string;
  tableNames: string[];
  /** runs EXPLAIN as qp_query and returns {planRows, ok, error} */
  explain?: (sql: string) => Promise<{ ok: boolean; error?: string; planRows?: number }>;
}

/** Stage 1 — single statement, no stacking/comment smuggling. */
export function guardSingleStatement(sql: string): GuardStageResult {
  const statements = splitStatements(sql);
  if (statements.length === 0) {
    return { stage: "single-statement", pass: false, reason: "empty-statement" };
  }
  if (statements.length > 1) {
    return {
      stage: "single-statement",
      pass: false,
      reason: `stacked-statements:${statements.length}`,
    };
  }
  return { stage: "single-statement", pass: true };
}

/** Stage 2 — read-only: SELECT/WITH only, denylist keywords anywhere. */
export function guardReadOnly(sql: string): GuardStageResult {
  const scrubbed = stripCommentsAndStrings(sql).trim();
  const first = /^(with\b|select\b)/i.test(scrubbed);
  if (!first) {
    return { stage: "read-only", pass: false, reason: "not-select" };
  }
  if (/^(insert|update|delete)\s+into?\b/i.test(scrubbed) && /^with/i.test(scrubbed)) {
    // WITH ... INSERT form
    return { stage: "read-only", pass: false, reason: "not-select:with-dml" };
  }
  const hit = containsKeyword(scrubbed, DENYLIST);
  if (hit) {
    return { stage: "read-only", pass: false, reason: `not-read-only:${hit}` };
  }
  return { stage: "read-only", pass: true };
}

/** Stage 3 — every referenced relation must live in the dataset schema. */
export function guardTableAllowlist(
  sql: string,
  deps: { schemaName: string; tableNames: string[] },
): GuardStageResult {
  const scrubbed = stripCommentsAndStrings(sql);
  const allowed = new Set(deps.tableNames.map((t) => t.toLowerCase()));
  for (const rel of extractRelations(scrubbed)) {
    if (rel.schema !== null && rel.schema.toLowerCase() !== deps.schemaName.toLowerCase()) {
      return { stage: "table-allowlist", pass: false, reason: `off-limits:${rel.schema}.${rel.table}` };
    }
    if (!allowed.has(rel.table.toLowerCase())) {
      return { stage: "table-allowlist", pass: false, reason: `off-limits:${rel.table}` };
    }
  }
  return { stage: "table-allowlist", pass: true };
}

/** Stage 4 — inject a cap if no LIMIT exists; reject oversized ones. */
export function guardRowLimit(sql: string): GuardStageResult & { sql: string } {
  const scrubbed = stripCommentsAndStrings(sql);
  const limit = findLimit(scrubbed);
  if (limit !== null && limit > ROW_LIMIT) {
    return { stage: "row-limit", pass: false, reason: `limit-exceeded:${limit}`, sql };
  }
  if (limit === null) {
    return {
      stage: "row-limit",
      pass: true,
      reason: `injected:limit-${ROW_LIMIT}`,
      sql: `${stripTrailingSemicolon(sql)} LIMIT ${ROW_LIMIT}`,
    };
  }
  return { stage: "row-limit", pass: true, sql };
}

/** Stage 5+6 — EXPLAIN dry run as qp_query + cost heuristics. */
export async function guardExplainAndCost(
  sql: string,
  explain: GuardDeps["explain"],
): Promise<GuardStageResult[]> {
  if (!explain) {
    return [
      { stage: "dry-run", pass: false, reason: "explain-unavailable" },
    ];
  }
  const res = await explain(sql);
  if (!res.ok) {
    return [
      { stage: "dry-run", pass: false, reason: `explain-failed:${res.error ?? "unknown"}` },
    ];
  }
  const results: GuardStageResult[] = [{ stage: "dry-run", pass: true }];
  if (res.planRows !== undefined && res.planRows > COST_ROW_CAP) {
    results.push({
      stage: "cost",
      pass: false,
      reason: `too-expensive:est-${res.planRows}-rows`,
    });
  } else {
    results.push({ stage: "cost", pass: true });
  }
  return results;
}

export interface GuardOutcome {
  ok: boolean;
  sql: string;
  report: GuardStageResult[];
}

/** Run the whole pipeline; short-circuits on first failure. */
export async function guardSql(sql: string, deps: GuardDeps): Promise<GuardOutcome> {
  const report: GuardStageResult[] = [];

  const s1 = guardSingleStatement(sql);
  report.push(s1);
  if (!s1.pass) return { ok: false, sql, report };

  const s2 = guardReadOnly(sql);
  report.push(s2);
  if (!s2.pass) return { ok: false, sql, report };

  const s3 = guardTableAllowlist(sql, deps);
  report.push(s3);
  if (!s3.pass) return { ok: false, sql, report };

  const s4 = guardRowLimit(sql);
  report.push({ stage: s4.stage, pass: s4.pass, reason: s4.reason });
  if (!s4.pass) return { ok: false, sql, report };

  const dryRunResults = await guardExplainAndCost(s4.sql, deps.explain);
  report.push(...dryRunResults);
  return {
    ok: dryRunResults.every((r) => r.pass),
    sql: s4.sql,
    report,
  };
}
