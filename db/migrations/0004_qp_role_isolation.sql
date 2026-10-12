-- 0004_qp_role_isolation.sql — real per-dataset isolation for the agent role.
--
-- Before this migration, ds_*_r was granted to qp_query with the default
-- INHERIT TRUE, so qp_query could read EVERY dataset's tables without ever
-- having to SET ROLE. After it, membership alone grants nothing: the
-- executor must SET LOCAL ROLE ds_<shortid>_r for the dataset it's working
-- on, and that role only has SELECT on its own schema.
--
-- Idempotent: ALTER ROLE and REVOKE/GRANT are safely re-appliable.

ALTER ROLE qp_query NOINHERIT;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT rolname FROM pg_roles WHERE rolname LIKE 'ds\_%\_r' ESCAPE '\'
  LOOP
    EXECUTE format('REVOKE %I FROM qp_query', r.rolname);
    EXECUTE format('GRANT %I TO qp_query WITH INHERIT FALSE, SET TRUE', r.rolname);
  END LOOP;
END
$$;
