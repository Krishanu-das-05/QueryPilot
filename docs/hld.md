# QueryPilot — High-Level Design

Status: Weekends 1–2 (post W1 closure)
Audience: engineers implementing or reviewing the system
Companion docs: `docs/lld/*.md`, `docs/research/agentic-harnesses.md`, `docs/adr/*`

## 1. What QueryPilot is

An agentic data analyst over user-uploaded spreadsheets — "RAG for tables".
Users upload CSV/XLSX files; QueryPilot normalizes them into typed tables in
isolated Postgres schemas, builds a searchable catalog (profiles, stats,
descriptions, relationships), and lets the user question their data in plain
English through a guarded SQL agent. Answers stream back with the SQL, the
result grid, and a natural-language explanation.

## 2. Context diagram

```
                         ┌────────────────────────────┐
                         │           Browser          │
                         │  Next.js UI (app router)   │
                         └───────┬────────────▲───────┘
                 signed URL      │            │ SSE stream (chat)
                 upload/download │            │ JSON APIs
                                 ▼            │
┌─────────────┐        ┌──────────────────────┴─────────┐        ┌─────────────┐
│  Supabase   │        │      Next.js (Vercel/local)      │        │  OpenRouter │
│   Storage   │◄───────│  route handlers + server comps   │───────►│  (LLM API)  │
│  (uploads)  │        └───┬───────────────┬─────────────┘        └─────────────┘
└─────────────┘            │               │
                           ▼               ▼
                  ┌──────────────────────────────────┐
                  │        Supabase Postgres          │
                  │  public.* catalog (RLS on)        │
                  │  ds_<shortid>.* user data         │
                  │  roles: postgres / qp_query       │
                  └──────────────────────────────────┘
```

Trust boundaries:
1. **Browser ↔ Next.js** — authenticated later (Google), currently passphrase-gated writes.
2. **Next.js ↔ Postgres** — two privilege levels: admin (`postgres`, RLS bypass, for ingestion/DDL) and `qp_query` (near-zero privileges, per-dataset grants, for agent SQL).
3. **LLM boundary** — all generated SQL is untrusted text until the deterministic guardrail pipeline accepts it; cell values are untrusted data in prompts.

## 3. Components

| Component | Responsibility | Key tech | Docs |
|---|---|---|---|
| Web UI | upload wizard, ingest progress, catalog browsing/editing, chat | Next.js App Router, Tailwind, shadcn/ui, SSE | lld/api.md |
| API routes | dataset CRUD, signed upload URLs, ingest stepping, chat streaming, auth | Next.js route handlers, zod | lld/api.md |
| Ingestion pipeline | parse → normalize → profile → load → describe (bounded steps) | `lib/ingest/*`, postgres.js | lld/ingestion.md |
| SQL agent harness | question → grounded context → plan → SQL → guard → execute → repair → answer | hand-rolled state graph, OpenAI SDK | lld/agent.md |
| Guardrail pipeline | 6 deterministic stages rejecting unsafe SQL before it touches data | pure functions + EXPLAIN dry-run | ADR-0005 |
| Catalog | profiles, stats, descriptions, relationships, tsvector search | Postgres + GIN | lld/ingestion.md |
| Storage | private `uploads` bucket, signed URLs | Supabase Storage | — |
| Auth | Google OAuth, RLS policies, user scoping (Phase 4) | Supabase Auth | ADR-0006 |

## 4. Core data flows

### 4.1 Ingestion (Weekend 1, shipped)
`uploaded → profiling → loading → describing → ready|failed` — bounded steps
driven by `POST /api/datasets/[id]/ingest/next` (see ADR 0002). Data lands in
`ds_<shortid>` schema; a `ds_<shortid>_r` NOLOGIN role with SELECT is granted
to `qp_query` (ADR 0003).

### 4.2 Question answering (Weekend 2)
1. User message → `classify` (answerable?).
2. `retrieve`: schema linking via catalog tsvector + value grounding from
   profile stats.
3. `plan`: NL query plan against the linked schema slice.
4. `generate_sql`: single SELECT, qualified, quoted, LIMIT-capped.
5. `guard_sql`: 6-stage deterministic checks (ADR 0005).
6. `execute`: `qp_query` connection, READ ONLY txn, `SET LOCAL
   statement_timeout='5s'`, row cap.
7. `repair`: taxonomy-guided, ≤3 attempts.
8. `answer`: streamed NL answer + SQL + grid + chart hint; trace persisted.

### 4.3 Queries the agent CANNOT run
DML/DDL, cross-schema access, catalog reads, other datasets' data, stacked
queries, side-effect functions (`pg_sleep`, `copy`, `listen`). Enforced at two
layers: database privileges (`qp_query` owns nothing) AND guardrail pipeline
(AST/EXPLAIN checks). Defense in depth: each layer alone is sufficient.

## 5. Deployment view

- **App**: Vercel (Next.js), Node runtime for all DB/LLM routes.
- **DB**: Supabase Postgres; transaction pooler (6543) for the app, `prepare: false` everywhere.
- **Storage**: Supabase private bucket; browsers upload via signed URLs directly.
- **LLM**: OpenRouter (`OPENROUTER_MODEL` + fallback).
- **CI**: GitHub Actions (lint, typecheck, unit+eval, build, integration on postgres:16 service, agent golden evals).

## 6. Non-functional requirements

| NFR | Target | How |
|---|---|---|
| Chat first-token latency | p50 ≤ 3s | streaming from first LLM call; small context via schema linking |
| File limits | ≤10MB, ≤5 files/dataset | server validation + bucket policy |
| Query safety | zero writes possible | qp_query grants + read-only txn + guardrail AST |
| Query cost | ≤5s, ≤1000 rows | statement_timeout + LIMIT injection + row cap |
| LLM cost | ≤12 steps/question, 25 q/day/dataset | graph step cap + counters |
| Secret hygiene | no secrets in repo/chat/logs | env-only, gitignored, migration placeholders |
| Availability of ingest | resume after any crash | persisted progress per step (ADR 0002) |
| Observability | every agent step traced | `messages.tool_trace`, `queries.guard_report` |

## 7. What is deliberately out of scope (Weekends 1–2)

Multi-tenant billing, embeddings/vector search (tsvector suffices at this
scale), write-back to user data, dashboards, scheduled refresh, real-time collab.
