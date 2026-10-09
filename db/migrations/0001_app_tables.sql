-- 0001_app_tables.sql — public catalog tables for QueryPilot (Weekend 1)

CREATE TABLE IF NOT EXISTS public.datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  schema_name text UNIQUE,
  role_name text UNIQUE,
  is_demo boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN
    ('uploaded', 'profiling', 'loading', 'describing', 'ready', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days'
);

CREATE TABLE IF NOT EXISTS public.dataset_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES public.datasets(id) ON DELETE CASCADE,
  storage_path text,
  original_name text,
  size_bytes integer,
  table_name text,
  row_count integer,
  rows_loaded integer NOT NULL DEFAULT 0,
  profile jsonb
);

CREATE TABLE IF NOT EXISTS public.catalog_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES public.datasets(id) ON DELETE CASCADE,
  table_name text,
  original_file text,
  row_count integer,
  description text,
  description_edited boolean NOT NULL DEFAULT false,
  search tsvector
);

CREATE TABLE IF NOT EXISTS public.catalog_columns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.catalog_tables(id) ON DELETE CASCADE,
  ordinal integer,
  column_name text,
  original_header text,
  data_type text,
  null_pct real,
  distinct_count integer,
  coerced_count integer,
  min_value text,
  max_value text,
  top_values jsonb,
  sample_values jsonb,
  is_candidate_key boolean,
  is_percent boolean,
  date_format text,
  description text,
  search tsvector
);

CREATE TABLE IF NOT EXISTS public.catalog_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES public.datasets(id) ON DELETE CASCADE,
  from_table text,
  from_column text,
  to_table text,
  to_column text,
  overlap real,
  method text
);

CREATE INDEX IF NOT EXISTS catalog_tables_search_idx
  ON public.catalog_tables USING gin (search);
CREATE INDEX IF NOT EXISTS catalog_columns_search_idx
  ON public.catalog_columns USING gin (search);

-- RLS is enabled now with NO policies: nothing is readable/writable via the
-- anon/authenticated roles. The server uses the admin (postgres) connection,
-- which bypasses RLS. Permissive policies arrive with auth next weekend.
ALTER TABLE public.datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dataset_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_columns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_relationships ENABLE ROW LEVEL SECURITY;
