# ADR 0003: Per-dataset schemas and read-only roles

## Context

Next weekend an LLM-driven SQL agent will generate and execute queries over
user data. Generated SQL cannot be trusted a priori: it must be physically
impossible for the agent to write, to touch other tenants' datasets, or to
read the application's own catalog tables. No permissive policies exist on the
public schema (RLS is enabled with none granted).

## Decision

Each dataset gets an isolated schema and a companion NOLOGIN role, named from
the first 8 hex characters of the dataset UUID:

```
CREATE SCHEMA ds_<shortid>;
CREATE ROLE ds_<shortid>_r NOLOGIN;
GRANT USAGE ON SCHEMA ds_<shortid> TO ds_<shortid>_r;
GRANT SELECT ON ALL TABLES IN SCHEMA ds_<shortid> TO ds_<shortid>_r;
GRANT ds_<shortid>_r TO qp_query;
```

The agent connects as the single LOGIN role `qp_query`, which by default has
NO privileges on anything (created by migration 0002, password injected by the
migrate script from `QP_QUERY_PASSWORD`, never stored in SQL files). Access to
a dataset exists only because ingest explicitly granted it.

## Consequences

- Blast radius of a bad generated query is one dataset, read-only.
- New tables cannot appear inside a dataset schema at query time (CREATE is
  not granted), and other datasets are invisible.
- `SET ROLE ds_<shortid>_r` or direct `qp_query` connections both work for the
  Weekend-2 query layer; no DDL is needed to cut a dataset's access
  (`REVOKE ds_<shortid>_r FROM qp_query` suffices).
- Roles/schemas must be cleaned up when a dataset expires (a deletion sweep is
  still TODO for the expiry worker).
- Postgres has a finite role count comfort zone; this design assumes thousands,
  not millions, of datasets.
