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
