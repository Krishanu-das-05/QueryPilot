# ADR 0002: Resumable, step-bounded ingestion runs

## Context

Uploads arrive as raw files in object storage and must be parsed, profiled,
loaded into Postgres, and described by an LLM. A serverless request has a hard
time budget; a multi-file ingest can easily exceed it. Crashes mid-ingest must
not leave orphaned partial state, and a UI must be able to show honest
progress.

## Decision

Ingestion is a status machine on `datasets.status`:

```
uploaded -> profiling -> loading -> describing -> ready (or failed)
```

`POST /api/datasets/[id]/ingest/next` performs exactly ONE bounded step and
returns `{status, progress}`; the UI calls it in a loop until `ready`/`failed`:

- **profiling**: one file per call (parse + infer + stats, stored as JSONB).
- **loading**: max 20,000 rows per call, inserted in batches of 1,000; position
  is persisted in `dataset_files.rows_loaded`, so any call can resume after a
  crash. Schema/role/table DDL is idempotent (`IF NOT EXISTS`, `CREATE ROLE`
  guarded by a `pg_roles` check) and re-run at the start of every load call.
- **describing**: one table per call; pending = `description IS NULL`.

## Consequences

- No step assumes it can finish everything in one call; every step is
  restartable because progress lives in Postgres, not in memory.
- The same `ingest/next` loop works in a browser poller, a cron job, or a
  queue worker without code changes.
- Extra latency: files are downloaded/parsed once per load step instead of
  being streamed. Bounded by the 10 MB file limit; acceptable for Weekend 1.
- A failed step marks the dataset `failed` with an error message instead of
  retrying forever; the operator sees the failure in the UI.
