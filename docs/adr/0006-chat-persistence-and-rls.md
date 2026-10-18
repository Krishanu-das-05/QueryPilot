# ADR 0006: Chat persistence model and auth-triggered RLS policies

## Context

Chat needs durable conversations/messages and an audit trail of generated
queries. Meanwhile the Weekend-1 model ("RLS on, no policies, server does
everything via admin") only works because the app is single-user pre-auth.
Phase 4 adds Google auth and true multi-user expectations.

## Decision

- Persist chat as `conversations` / `messages` / `queries` (migration 0003),
  tied to `dataset_id`, with `created_by` filled from `auth.uid()` once Phase 4
  lands. Assistant messages carry `tool_trace` (full node trace); queries carry
  `guard_report`. These two JSON blobs are the observability story — no
  separate telemetry system this weekend.
- Phase 4 migration adds `datasets.user_id uuid` (default `auth.uid()` on
  insert; existing rows stay NULL = unowned/demo) and enables policies:
  - `datasets`: select/insert/update where `auth.uid() = user_id`
  - `dataset_files`, `catalog_*`, `conversations`, `messages`, `queries`:
    visibility via EXISTS against the owning dataset
  - Storage: `uploads/<user-prefix>/...` path-scoped policies
- Server roles split stays: ingestion/DDL = service role (RLS bypass,
  server-only); user-visible reads = user's JWT client (RLS-enforced);
  agent SQL = `qp_query` (dataset-granted role, see ADR 0003/0005).
- The `UPLOAD_PASSPHRASE` gate is retired once auth ships (kept behind an env
  flag for one release for rollback).

## Consequences

- RLS is the single source of authorization truth for reads — the app can't
  accidentally leak cross-user data even with a buggy route.
- Admin/service key never ships to the browser; only `NEXT_PUBLIC_` anon key.
- Deleting a dataset cascades chat history (dataset-scoped privacy) — desired.
- Unowned (NULL user_id) pre-auth datasets: visible to no one over RLS until
  claimed via a one-off claim flow (accept; W1 data is for a single user).
