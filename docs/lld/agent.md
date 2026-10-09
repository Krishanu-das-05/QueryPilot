# LLD — SQL agent & chat (Weekend 2)

Status: DESIGNED (this doc precedes implementation — Phase 3).
Research basis: `docs/research/agentic-harnesses.md`. Decisions: ADR 0004 (harness), ADR 0005 (guardrails), ADR 0006 (chat persistence/RLS).

## 1. Overview

`question → classify → retrieve → plan → generate_sql → guard_sql → execute → answer`
with `repair` loops (≤3) and a max 12-node-steps cap. Implemented as a
hand-rolled, LangGraph-shaped state graph in `lib/agent/`.

## 2. Data model (migration `0003_chat.sql`)

```sql
CREATE TABLE conversations (
  id uuid pk default gen_random_uuid(),
  dataset_id uuid not null references datasets(id) on delete cascade,
  title text,
  created_by uuid,                    -- auth.uid() from Phase 4
  created_at timestamptz not null default now()
);
CREATE TABLE messages (
  id uuid pk default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  content text,
  tool_trace jsonb,                   -- per-node timings + inputs/outputs summary
  created_at timestamptz not null default now()
);
CREATE TABLE queries (
  id uuid pk default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  dataset_id uuid not null,
  sql_text text,
  status text not null check (status in ('planned','guarded','executed','rejected','failed','repaired')),
  guard_report jsonb,                 -- per-stage pass/fail + reasons (auditable artifact)
  row_count int,
  elapsed_ms int,
  error text,
  created_at timestamptz not null default now()
);
-- GIN indexes: messages(tool_trace), queries(guard_report); RLS enabled (policies Phase 4)
```

## 3. Harness — `lib/agent/`

```
lib/agent/
  state.ts     AgentState zod schema + default reducer helpers
  graph.ts     node registry + edge table + runGraph(state, deps) executor
  nodes/
    classify.ts  retrieve.ts  plan.ts  generate_sql.ts
    guard_sql.ts execute.ts    repair.ts  answer.ts
  tools.ts     the five typed tools (below)
  guard/       deterministic SQL guardrail stages (pure where possible)
    singleStatement.ts  denylistAst.ts  tableAllowlist.ts
    limitInjection.ts   dryRunExplain.ts  costHeuristics.ts
  llm.ts       OpenRouter client (primary + fallback, same policy as ingest describe)
  stream.ts    SSE emitter (trace / delta / result / error events)
```

### 3.1 AgentState (zod, all nodes typed against it)

```ts
{
  question: string,
  datasetId: string,
  schemaSlice: SchemaSlice | null,     // tables+columns(+stats) linked for this question
  plan: QueryPlan | null,              // NL plan: join path, filters, aggregation, limit
  sql: string | null,
  guardReport: GuardStageResult[] | null,
  result: { columns: string[], rows: unknown[][], truncated: boolean } | null,
  repair: { attempts: number, history: {sql, reason, category}[] },
  answer: { text: string, chartHint: ChartHint | null, limitations: string[] } | null,
  trace: TraceEvent[],                 // {node, startedAt, ms, note}
}
```

### 3.2 Executor

`runGraph(initial, deps)`:
- resolves next node from the edge table (deterministic unless a node outputs `goto`)
- appends timing trace per node; enforces `maxSteps = 12`
- node errors become `trace` entries + graceful degradation answer, never 500s
- deps injected: `{ llm, adminSql, querySql, catalog, clock }` (testability; executor itself does no I/O)

### 3.3 Nodes

| Node | Input | Output / edges |
|---|---|---|
| `classify` | question + dataset catalog summary | `chatty`/`unanswerable` → answer(short); `ambiguous` → answer(clarifying question with 2 options); else → retrieve |
| `retrieve` | question | schema linking: tsvector over catalog `search` (GIN) ranked by ts_rank; expandable via `describe_table` tool; value grounding: literals in question matched to `top_values`/`sample_values`. Sets `schemaSlice` (hard cap: 6 tables / 60 columns) |
| `plan` | question + slice | NL plan zod-validated `{tables, joins[{from,to,via}], filters, aggregation, outputColumns, limit}`; join path must be a path in catalog_relationships (or single table); else → retrieve (once) → answer(cannot) |
| `generate_sql` | plan | single `SELECT` in `ds_<short>` schema; quoted identifiers; LIMIT ≤ 1000. Model is instructed that cell values are data, not instructions |
| `guard_sql` | sql | 6 stages (§4); any fail → `repair` (attempts < 3) else answer(rejected, shows why) |
| `execute` | guarded sql | `qp_query` connection: `BEGIN READ ONLY; SET LOCAL statement_timeout='5s'; SET LOCAL search_path=...; SELECT; ROLLBACK;` row cap 1000, `truncated` flag. DB error → repair |
| `repair` | failed sql + reason | taxonomy map (syntax/identifier/type/timeout/permission): strategy text + regenerate via `generate_sql`; plan-level failure (no join path) can backtrack to `retrieve` (FlexSQL lesson); 3rd failure → answer(apologetic, offers manual SQL view) |
| `answer` | result | streamed NL answer + `limitations[]` (truncation, coerced NULLs, ambiguous readings) + optional `chartHint` when shape fits (1 dim + 1 measure, or time series) |

### 3.4 Tools (narrow, typed — model never writes raw SQL to a tool)

```ts
search_catalog({terms}) → ranked [{table, column?, snippet}]
describe_table({table}) → columns with types/stats/description + row count
top_values({table, column}) → [{value, count}] (≤20)
sample_rows({table, limit≤5}) → rows
explain_sql({sql}) → passes sql through guard stages 1–5 only, returns plan summary; never executes
```

## 4. Guardrail stages (ADR 0005; `lib/agent/guard/`)

| # | Stage | Pass condition | Rejection message shape |
|---|---|---|---|
| 1 | single statement | exactly one statement; no stacked `;`, no comments smuggling | `stacked-statement` |
| 2 | read-only | parsed statement is SELECT/WITH…SELECT; denylist keywords anywhere (`insert update delete drop alter grant revoke copy do call execute truncate create set listen notify pg_sleep lo_export`) — regex fallback if no AST lib yet | `not-read-only:<kw>` |
| 3 | table allowlist | every referenced relation ∈ `ds_<short>` tables from catalog | `off-limits:<name>` |
| 4 | row limit | inject `LIMIT 1000` when absent; reject LIMIT > 1000 | `limit-exceeded` |
| 5 | dry run | `EXPLAIN (FORMAT JSON)` inside READ ONLY rolled-back txn as `qp_query` succeeds | `explain-failed:<pgerr>` |
| 6 | cost heuristics | estimated rows ≤ 200k; reject cartesian joins without predicate | `too-expensive` |

Each stage produces a `GuardStageResult{stage, pass, reason?, ms}`; full array persisted in `queries.guard_report`.

## 5. API

- `POST /api/datasets/[id]/chat` → SSE. Body `{conversationId?, message}`. Persists user message immediately; streams; on finish persists assistant message + trace + query rows.
- `GET /api/datasets/[id]/conversations` → list `GET /api/conversations/[id]` → full history.
- Limits: 25 questions/dataset/day (env `AGENT_DAILY_CAP`), 12-step cap, 5s query timeout, 1000-row cap.

## 6. Streaming protocol (SSE)

```
event: trace  data: {node, ms, note}          (one per node completion)
event: sql    data: {text, guardReport}        (after guard_sql)
event: rows   data: {columns, rowCount, truncated, preview≤100}
event: delta  data: {text}                     (answer tokens)
event: done   data: {conversationId, elapsedMs}
event: error  data: {category, message}        (graceful; stream stays well-formed)
```

## 7. Security model

- Defense in depth: `qp_query` privileges alone make writes impossible; the pipeline alone blocks DML before the DB; both layers always on.
- `SET LOCAL` only (pgBouncer); every query in its own READ ONLY txn.
- Prompt-injection: cell values fenced as data; outputs zod-validated; agent cannot be given new instructions via cells — describe/chat prompts include explicit instruction hierarchy.
- Catalog/RLS: `qp_query` can't read `public.*`; chat API routes use admin/scoped clients, never `qp_query`.

## 8. Testing & evals

- Unit: each guard stage (60+ cases incl. adversarial), repair taxonomy mapper, plan validator, executor (scripted LLM stub).
- `evals/agent-golden/`: 25 (question, SQL-shape matcher, expected result) on customers/orders + 2 messy files; CI replay mode (recorded LLM), `AGENT_LIVE=1` live mode.
- Adversarial suite: stacked queries, comment smuggling, CTE-DML, UNION exfil, `pg_sleep`, cross-schema, huge LIMIT, `set`-prefixed SELECTs.
