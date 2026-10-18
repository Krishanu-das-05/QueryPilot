# LLD — Ingestion pipeline (Weekend 1, shipped)

Status: implemented & verified end-to-end on Supabase.
Entry point: `POST /api/datasets/[id]/ingest/next` → `runIngestStep()` in
`lib/ingest/pipeline.ts`.

## 1. State machine

```
uploaded ─┐
          ├─ profiling step (1 file/call) ──→ loading ─┐
          │   parses, infers, stores profile jsonb      │ load step (≤20k rows/call)
          │   when all files done: build catalog        │ idempotent DDL → inserts → grants/indexes/ANALYZE
          ▼                                             ▼
      describing (1 table/call, LLM descriptions) ─→ ready
      any uncaught step error ─→ failed (+ error msg, trunc 500 chars)
```

Progress persistence (so any step resumes after a crash):
- per-file profile: `dataset_files.profile` (jsonb) + `row_count`
- load position: `dataset_files.rows_loaded`
- catalog written before `status='loading'`; DDL is idempotent and re-run each load call
- describe pending marker: `catalog_tables.description IS NULL`

## 2. Module map (`lib/ingest/`)

| Module | Pure? | Responsibility |
|---|---|---|
| `headers.ts` | yes | snake_case/symbols/digit `c_`/reserved `_col`/63-char cap/dedupe `_2`; keeps original |
| `nulls.ts` | yes | null-token set, trimmed case-insensitive match |
| `numbers.ts` | yes | ₹$€£/Rs./INR strip, comma & Indian-grouping strip, `(1,200)`→−1200, `12%`→0.12+flag |
| `dates.ts` | yes | 6 date formats + timestamps; dd/mm default, mm/dd iff some second component > 12; calendar-valid; format string output |
| `types.ts` | yes | ≤1000 sampled non-null values; ≥95% wins; order boolean→integer→decimal→date→timestamp→text; `coerceValue()` canonicalizer |
| `profile.ts` | yes | per-column stats (null_pct[0–100,2dp], distinct, min/max, top-10 (text), 5 samples, coerced_count, is_candidate_key), distinct-value sets capped at 5000 |
| `relationships.ts` | yes | FK-name conventions + identical names, type compat (numeric-numeric allowed), ≥90% overlap, method `name+overlap` |
| `parse.ts` | no (IO) | UTF-8 w/ Windows-1252 fallback; papaparse CSV; exceljs first-sheet XLSX (dates→ISO) |
| `tableName.ts` | yes | file→safe table name (`t_` digit prefix), deduped |
| `describe.ts` | no (LLM) | one call/table; 429/5xx → 2 retries w/ backoff → fallback model; invalid JSON → 1 corrective retry; zod contract; returns null on total failure |
| `pipeline.ts` | no (DB) | step machine above; all identifiers quoted (`sql()`/`quoteIdent`); `quoteIdent` for DDL column lists |

## 3. Loading details (verified in production DB)

- `shortid` = first 8 hex of dataset uuid → schema `ds_<shortid>`, role `ds_<shortid>_r`.
- DDL per load call (idempotent): `CREATE SCHEMA IF NOT EXISTS`; role via DO-block with **literal** identifier (bound params inside DO break pooled connections — fixed in 8e31ffc); `GRANT USAGE`; `GRANT ds_*_r TO qp_query`; `CREATE TABLE IF NOT EXISTS` with PG types (boolean/bigint/numeric/date/timestamp/text).
- Inserts: batches of 1,000 via `sql(batch, ...cols)`; canonical string values (`true/false`, numeric text, ISO dates) — PG casts.
- Finish: `GRANT SELECT ON ALL TABLES IN SCHEMA` → indexes on candidate keys + FK columns → `ANALYZE` per table.
- Describing failure → empty descriptions, dataset still `ready`.

## 4. Error taxonomy

| Failure | Outcome |
|---|---|
| file unreadable/parse error | dataset `failed`, message truncated 500 |
| unprofiled 0 files | proceeds to loading with empty catalog (allowed) |
| pooler/DDL idempotence notices | logged, harmless |
| LLM unreachable / retries exhausted / bad JSON | descriptions empty; ingestion completes |
| LLM transient inside one table | that table empty; others still described |

## 5. Known limits (deliberate, Weekend 1)

- Re-downloads the file each load step (≤10MB bound makes this acceptable).
- Distinct-value sets capped at 5,000 → very high-cardinality FK detection skips.
- Numbers through JS `Number` (2^53 precision boundary) — acceptable for spreadsheets.
- No expiry sweep for `expires_at` yet (schema/role cleanup TODO).

## 6. Tests

`tests/` — headers, nulls, numbers, dates+ambiguity, types/threshold, profile
stats, candidate keys, relationships; eval `evals/messy-csv` (10 files, 39
columns, currently 100% type accuracy vs a 90% gate); integration on real
Postgres (migrations, 3-file load, grants incl. `qp_query` auth, RLS check).
