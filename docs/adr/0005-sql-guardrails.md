# ADR 0005: Six-stage deterministic SQL guardrail pipeline

## Context

The agent's worst-case action is a destructive runaway query or data exfil.
LLM output is untrusted text; nothing it emits may execute unchanged. The
user-supplied-data angle (cell contents are not instructions) is handled in
prompts, but prompt discipline is not a security control — code and database
privileges are.

## Decision

Every generated SQL passes six deterministic stages before execution (each
produces a typed rejection, fed to the repair loop; full report persisted to
`queries.guard_report`):

1. Single statement only (no stacking, no comment smuggling)
2. Read-only: SELECT/WITH only; keyword denylist anywhere in the statement
   (`insert update delete drop alter grant revoke copy do call execute
   truncate create set listen notify pg_sleep lo_export`)
3. Table allowlist: only relations inside the dataset's `ds_<shortid>` schema
4. Row limit: inject `LIMIT 1000` if absent; reject larger
5. Dry run: `EXPLAIN` as `qp_query` inside a READ ONLY rolled-back
   transaction (parse + permission check without execution, zero data read)
6. Cost heuristics: estimated row counts bounded; cartesian products refused

Independent second layer (ADR 0003): `qp_query` has no write privileges at
all, no catalog access, and is granted `SELECT` per dataset explicitly.
Executions run in `BEGIN READ ONLY` + `SET LOCAL statement_timeout='5s'`
(pgBouncer-safe: never bare `SET`).

Adversarial coverage is enforced by tests: stacked queries, CTE-wrapped DML,
UNION exfil into catalog, `pg_sleep`, cross-schema references, comment-obfus-
cated keywords, oversized LIMIT.

## Consequences

- A guardrail bug is contained by role privileges — defense in depth.
- Repairs are taxonomy-guided (SQL-of-Thought lesson): the reason returned
  shapes the fix the model attempts (≤3 attempts).
- Montioring: `queries.guard_report` gives an auditable trail of every
  generated query (OpenAI SchemaFlow's auditable-artifact pattern).
- AST-accurate stage 2 needs a Postgres parser; until one is adopted the
  denylist+EXPLAIN combo must catch (tests gate this). If
  `libpg-query`/sqlglot-for-node is later vetted in, stage 2 strengthens
  without interface changes.
