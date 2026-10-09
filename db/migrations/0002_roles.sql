-- 0002_roles.sql — restricted LOGIN role used (from next weekend) to run agent SQL.
-- The migrate script substitutes :QP_QUERY_PASSWORD with the password from the
-- QP_QUERY_PASSWORD env var at run time, so no password lives in this file.
-- Idempotent: creates the role if missing, always (re)sets the password.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qp_query') THEN
    CREATE ROLE qp_query LOGIN PASSWORD :QP_QUERY_PASSWORD;
  END IF;
END
$$;

ALTER ROLE qp_query WITH LOGIN PASSWORD :QP_QUERY_PASSWORD;

-- Safety belt: qp_query must have NO default privileges anywhere. Per-dataset
-- SELECT is granted explicitly at ingest time via the ds_<shortid>_r role.
REVOKE ALL ON SCHEMA public FROM qp_query;
