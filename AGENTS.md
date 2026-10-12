# QueryPilot — agent notes

## Commands

- `npm run dev` / `npm run build` / `npm run lint` / `npm run typecheck`
- `npm test` — vitest: unit tests + `evals/messy-csv` eval (≥90% accuracy gate)
- `npm run migrate` — applies `db/migrations/*.sql` via `DATABASE_URL_ADMIN`
  (idempotent, needs `QP_QUERY_PASSWORD` for 0002)
- `npm run setup-storage` — creates the private `uploads` bucket
- Integration test only runs when `TEST_DATABASE_URL` is set:
  `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
  QP_QUERY_PASSWORD=... npx vitest run tests/integration.test.ts`

## Hard rules

- Never commit secrets. `.env.local` is gitignored; migration files contain
  placeholders only (`:QP_QUERY_PASSWORD` substituted by `lib/migrate.ts`).
- Postgres: always `prepare: false` (Supabase transaction pooler).
- Never interpolate raw user strings into SQL — quote identifiers via the
  postgres.js `sql()` helper or `quoteIdent`.
- ESLint is pinned to 9.x: eslint-plugin-react 7 (bundled by
  eslint-config-next) breaks on ESLint 10. Keep `eslint-config-next` and
  `next` versions in lockstep.
- XLSX parsing uses `exceljs` (not `xlsx`) due to unresolved npm advisories in
  `xlsx@0.18.5`.

## Architecture

- `lib/ingest/` — pure parsing/profiling functions + `pipeline.ts` step machine
  (`uploaded → profiling → loading → describing → ready`), one bounded step
  per `POST /api/datasets/[id]/ingest/next`.
- Per dataset: `ds_<shortid>` schema + `ds_<shortid>_r` NOLOGIN role granted to
  `qp_query`. See `docs/adr/`.
- RLS enabled on all public tables with no policies; server uses the admin
  connection only.

## Python backend (`backend/`)

Run these from `backend/` (the paths `app` and `tests` are relative to it):

- Tests: `.venv/Scripts/python -m pytest -q`
- Lint: `.venv/Scripts/python -m ruff check app tests`
- Format check: `.venv/Scripts/python -m ruff format --check app tests`
- Startup, manual only: `.venv/Scripts/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000`
- `.env.local` is read only by the default app's lifespan startup, and only when no
  explicit `Settings` were passed to `create_app`. Tests always pass explicit `Settings`.
- asyncpg uses `statement_cache_size=0` (set in `app/db.py`) because the Supabase
  transaction pooler requires it.
- The Python API is incremental: TS routes stay active and the Next frontend is not
  switched to Python until an explicit bridge is enabled.
- Opt-in Postgres tests (`tests/test_integration.py`) are skipped unless
  `TEST_DATABASE_URL` is set to a disposable database with `db/migrations` applied.
- Migrations: from `backend/`, `.venv/Scripts/python -m app.migrate` applies all pending
  `db/migrations/*.sql` files in filename order and records their ledger rows in
  `public.schema_migrations`, in ONE transaction under an advisory lock. A failure rolls
  back every pending file and ledger row. The `:QP_QUERY_PASSWORD`
  placeholder is filled from `QP_QUERY_PASSWORD`, which is needed only when a pending file
  uses it. The required env name is `DATABASE_URL_ADMIN`.
- CI: the `integration` job applies migrations with the Python runner before it runs the
  TypeScript integration test and the Python real-Postgres tests against the same database.
