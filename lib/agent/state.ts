export interface CatalogColumn {
  tableName: string;
  columnName: string;
  dataType: string;
  description: string | null;
  isCandidateKey: boolean;
  nullPct: number | null;
  distinctCount: number | null;
  minValue: string | null;
  maxValue: string | null;
  topValues: { value: string; count: number }[] | null;
  dateFormat: string | null;
  isPercent: boolean;
}

export interface CatalogTable {
  tableName: string;
  rowCount: number | null;
  description: string | null;
  columns: CatalogColumn[];
}

export interface CatalogRelationship {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export interface TraceEvent {
  node: string;
  ms: number;
  note?: string;
}

export interface GuardState {
  sql: string | null;
  report: { stage: string; pass: boolean; reason?: string }[];
  repairAttempts: number;
  repairHistory: { sql: string; category: string; reason: string }[];
}

export interface AgentResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  elapsedMs: number;
}

export interface AgentState {
  question: string;
  datasetId: string;
  schemaName: string;
  catalog: CatalogTable[];
  relationships: CatalogRelationship[];
  slice: CatalogTable[] | null;
  answer: string | null;
  sql: string | null;
  result: AgentResult | null;
  guard: GuardState;
  trace: TraceEvent[];
  status: "working" | "clarify" | "answered" | "rejected" | "failed";
  error: string | null;
}

export type RepairCategory =
  | "syntax"
  | "unknown-identifier"
  | "type-mismatch"
  | "timeout"
  | "permission"
  | "guardrail"
  | "empty";

export function repairCategory(reason: string): RepairCategory {
  const r = reason.toLowerCase();
  if (
    r.includes("does not exist") ||
    r.includes("column") ||
    r.includes("off-limits") ||
    r.includes("unknown identifier")
  ) {
    return "unknown-identifier";
  }
  if (r.includes("syntax")) return "syntax";
  if (r.includes("type") || r.includes("cast")) return "type-mismatch";
  if (r.includes("timeout") || r.includes("canceling statement") || r.includes("query timed out")) {
    return "timeout";
  }
  if (r.includes("permission") || r.includes("denied")) return "permission";
  if (r.includes("not-read-only") || r.includes("stacked") || r.includes("too-expensive") || r.includes("limit-exceeded")) {
    return "guardrail";
  }
  if (r.includes("explain-failed")) return "syntax";
  return "syntax";
}

export const MAX_REPAIR_ATTEMPTS = 3;
export const MAX_GRAPH_STEPS = 12;
export const AGENT_DAILY_CAP = Number(process.env.AGENT_DAILY_CAP ?? 25);
