# QueryPilot

QueryPilot is an agentic data analyst over user-uploaded spreadsheets — RAG for
tables. Upload CSVs or Excel files; QueryPilot profiles every column, infers the
real types behind messy formatting, loads the data into an isolated database
schema per dataset, finds relationships between your tables, and builds a
searchable catalog that an SQL agent uses to answer questions.

**Current status: Weekend 1** — ingestion pipeline, data catalog, and the app.
The SQL agent and Google auth land next weekend; uploads are temporarily gated
by a shared passphrase.

## Local setup

Prereqs: Node 22+, a Supabase project.

1. `npm ci`
2. `cp .env.example .env.local` and fill in the values (see below).
3. `npm run migrate` — applies `db/migrations/*.sql` (idempotent).
4. `npm run setup-storage` — creates the private `uploads` bucket (idempotent).
5. `npm run dev` — open http://localhost:3000, go to "New dataset", upload.

## Environment variables

See `.env.example`. Highlights:

- `DATABASE_URL_ADMIN` — Supabase **transaction pooler** (port 6543), user
  `postgres.<ref>`. All server-side DB work uses this.
- `DATABASE_URL_QUERY` — same host, user `qp_query.<ref>` (used from next weekend).
- `QP_QUERY_PASSWORD` — password of the `qp_query` role; consumed **only** by
  the migrate script, which substitutes it into migration 0002 at run time. It
  never lives in the repo.
- `UPLOAD_PASSPHRASE` — temporary gate on all write API routes until auth.

`.env.local` is gitignored; never commit real values anywhere (including
migration files). Postgres connections always use `prepare: false` (required
by the transaction pooler).

## How ingestion works

Status machine on the dataset: `uploaded → profiling → loading → describing →
ready` (or `failed`). `POST /api/datasets/[id]/ingest/next` performs one
bounded step; the UI loops it. See `docs/adr/0002-resumable-runs.md`.

Parsing rules (pure functions in `lib/ingest/`, unit-tested):

- **Headers**: snake_case, symbols stripped, `c_` prefix if digit-leading,
  `_col` suffix on SQL reserved words, deduped `_2`, `_3`, max 63 chars. The
  original header is kept on every column.
- **Nulls**: `''`, `-`, `--`, `na`, `n/a`, `null`, `none`, `nil`, `#n/a` —
  case-insensitive, trimmed — become NULL.
- **Types**: inferred on up to 1,000 sampled non-null values; a type wins at
  ≥95% parse, tried in order boolean → integer → decimal → date → timestamp →
  text. Booleans are `true/false`, `yes/no`, `y/n`, and `1/0` only when the
  column contains nothing else. Values that fail to parse in a typed column
  become NULL and increment `coerced_count`.
- **Numbers**: ₹ $ € £ "Rs." "INR", spaces and commas stripped (Indian grouping
  like `1,00,000` handled); `(1,200)` → −1200; `12%` → 0.12 with `is_percent`.
- **Dates**: `yyyy-mm-dd`, `dd/mm/yyyy`, `dd-mm-yyyy`, `mm/dd/yyyy`,
  `dd-Mon-yyyy`, `dd Mon yyyy` (plus timestamp variants). Ambiguous d/m order
  defaults to `dd/mm`; the column switches to `mm/dd` only if some value's
  second part > 12. Detected format is stored in `date_format`.
- **Encoding**: UTF-8, falling back to Windows-1252.
- **Stats**: per column — null %, distinct count, min/max (numeric/date),
  top 10 values (text), 5 samples, `is_candidate_key` (distinct == rows and no
  nulls).
- **Relationships**: a child column whose name matches a parent candidate key
  (`orders.customer_id` ↔ `customers.id`, or identical names) with compatible
  type, accepted when ≥90% of the child's distinct values exist in the parent
  key (`method = 'name+overlap'`).
- **Load**: per dataset — `ds_<shortid>` schema, `ds_<shortid>_r` NOLOGIN role
  (granted to `qp_query`, see `docs/adr/0003-per-dataset-roles.md`), typed
  tables, batches of 1,000 rows, ≤20,000 rows per ingest step, then grants,
  indexes on candidate keys & relationship columns, ANALYZE. All identifiers
  are quoted safely; user strings are never interpolated into SQL.
- **Describe**: one OpenRouter call per table (primary model, fallback on
  429/5xx after 2 retries with backoff). Output JSON validated with zod; on
  failure descriptions stay empty and the dataset is still marked ready. Cell
  values are treated as untrusted data in prompts. Then `search` tsvectors are
  filled from names + descriptions.

Limits: CSV/XLSX only, ≤10 MB per file, ≤5 files per dataset — validated on the
server. Browsers upload straight to Storage with signed URLs; files never pass
through a Next.js route.

## Tests

- `npm test` — unit tests + the messy-csv eval (10 handcrafted files in
  `evals/messy-csv/`); the eval prints type accuracy and fails below 90%.
- Integration (`tests/integration.test.ts`) runs only when `TEST_DATABASE_URL`
  is set — no local Postgres needed. CI runs it against a `postgres:16`
  service container.

Also: `npm run lint`, `npm run typecheck`, `npm run build`.

## Security notes

- RLS is enabled on all public tables with no permissive policies; everything
  is done server-side through the admin connection until auth lands.
- `qp_query` has no privileges by default; per-dataset read access is granted
  explicitly at ingest time.
- Known transitive advisories (documented, no fixed version on the npm
  registry, none reachable from user-controlled input at runtime):
  `braces`/`micromatch`/`fast-glob` DoS (build/lint tooling only),
  `postcss-selector-parser` quadratic parsing (build-time only),
  `uuid <11.1.1` buffer bounds flag (write paths of `exceljs`, which we never
  invoke — we only read XLSX). Re-run `npm audit` on every dependency change.
- XLSX is parsed with `exceljs` rather than the `xlsx`/SheetJS npm package,
  because the registry version of `xlsx` (0.18.5) carries unresolved advisories
  and the fixed distribution channel was unavailable. See the PR notes.
