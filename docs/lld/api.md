# LLD — API surface

Conventions: all routes `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`;
request bodies zod-validated; write routes gated (passphrase until Phase 4,
then Google session + RLS); error bodies `{error: string}` with safe messages
(no stack traces, no internal paths).

## Shipped (Weekend 1)

| Method & path | Body → Response | Notes |
|---|---|---|
| `POST /api/datasets` | `{name}` → `{id}` | status starts `uploaded` |
| `GET /api/datasets` | → `[{id,name,status,error,is_demo,created_at,expires_at}]` | newest first (Phase 4: mine only) |
| `POST /api/datasets/[id]/upload-url` | `{fileName,size}` → `{path,token}` | validates ext (csv/xlsx), ≤10MB, ≤5 files; browser uploads direct to Storage via `uploadToSignedUrl` |
| `POST /api/datasets/[id]/files` | `{storagePath,originalName,sizeBytes}` → `{id,tableName}` | re-validates limits; storagePath must be under `id/`; derives deduped snake table name |
| `POST /api/datasets/[id]/ingest/next` | `{}` → `{status,progress}` | one bounded step (LLD-ingestion) |
| `GET /api/datasets/[id]` | → `{dataset,files,tables,columns,relationships}` | shared `lib/catalog.ts` |
| `PATCH /api/datasets/[id]` | `{tableId? xor columnId?, description}` → `{ok}` | sets `description_edited` (tables); refreshes tsvector |

## Weekend 2 (designed; see lld/agent.md)

| Method & path | Body → Response | Notes |
|---|---|---|
| `POST /api/datasets/[id]/chat` | `{conversationId?, message}` → **SSE stream** | events: trace/sql/rows/delta/done/error |
| `GET /api/datasets/[id]/conversations` | → `[{id,title,created_at}]` | |
| `GET /api/conversations/[id]` | → `{messages[], queries[]}` | |

## Phase 4 (auth)

- `GET /auth/callback` (code exchange), `POST /api/auth/signout`.
- All user-visible reads scoped by RLS on user's JWT; ingestion internals stay
  service-role. `x-upload-passphrase` gate removed (flag-gated for rollback).

## Auth matrix

| Route class | Role required |
|---|---|
| datasets/files/catalog reads | authenticated owner (Phase 4); open during W1–3 (private project) |
| all writes (create/upload/files/ingest/patch/chat) | passphrase (W1–3) → owner session (Phase 4) |
| ingest DDL + pipeline reads | server-only admin role (RLS bypass), never exposed to client |
| agent SQL execution | `qp_query` role, dataset-granted, READ ONLY txn — see ADR 0005 |
